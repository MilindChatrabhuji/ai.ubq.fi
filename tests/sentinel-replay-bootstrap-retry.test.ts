import { test } from "bun:test";
import { openKv, type AtomicOperation, type Kv, type KvEntryMaybe, type KvKey, type KvListIterator, type KvListOptions, type KvListSelector } from "#kv";
import assert from "node:assert/strict";
import { bootstrapBeforeMutation, runBootstrapBatch } from "../src/sentinel/replay-retention-bootstrap.ts";
import { reclaimExpiredSentinelReplays, reserveSentinelReplayCapacity } from "../src/sentinel/replay-retention.ts";
import { decryptExportedSentinelReplay, listEncryptedSentinelReplaysByRequestId } from "../src/sentinel/replay-read.ts";
import { persistEncryptedSentinelReplay } from "../src/sentinel/replay-store.ts";
import {
  BOOTSTRAP_BATCH_ENTRIES,
  BOOTSTRAP_OWNER_SCAN_ENTRIES,
  readLedger,
  SENTINEL_REPLAY_ACCOUNTING_PREFIX,
  SENTINEL_REPLAY_ACCOUNTING_REASON,
  SENTINEL_REPLAY_BUDGET_LEDGER_KEY,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  sentinelReplayAccountingKey,
  sentinelReplayManifestCharge,
  sentinelReplayStatusMetadataBytes,
  type SentinelReplayAccountingRow,
  type SentinelReplayBudgetLedger,
} from "../src/sentinel/replay-retention-schema.ts";
import {
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_MANIFEST_PREFIX,
  SENTINEL_REPLAY_REQUEST_PREFIX,
  SENTINEL_REPLAY_STATUS_TTL_MS,
  SENTINEL_REPLAY_TTL_MS,
  type AcceptedSentinelReplayInput,
  type SentinelFailureObservation,
  type SentinelReplayManifest,
} from "../src/sentinel/replay-model.ts";
import { base64UrlEncode } from "../src/utils.ts";

const now = 1_702_000_000_000;
const budget = 4 * 1_024 * 1_024;
const history = {
  evicted_bytes: 17,
  evicted_records: 1,
  expired_bytes: 29,
  expired_records: 2,
  status_pruned_records: 3,
  last_eviction_at_ms: now - 3,
  last_warning_at_ms: now - 2,
  last_full_at_ms: now - 1,
  last_skip_reason: "fixture_history",
};
const corruptKey = [...SENTINEL_REPLAY_MANIFEST_PREFIX, now + 10_000, "f".repeat(64), "corrupt"];

const manifestFor = (index: number): SentinelReplayManifest => ({
  version: 1,
  capture_id: `bootstrap-retry-${index}`,
  fingerprint: index.toString(16).padStart(64, "0"),
  case_group_digest: "c".repeat(64),
  captured_at_ms: now + index,
  expires_at_ms: now + index + SENTINEL_REPLAY_TTL_MS,
  algorithm: "AES-256-GCM",
  compression: "gzip",
  iv: base64UrlEncode(new Uint8Array(12)),
  chunk_count: 1,
  ciphertext_bytes: 100,
});
const manifestKey = (manifest: SentinelReplayManifest): KvKey => [
  ...SENTINEL_REPLAY_MANIFEST_PREFIX,
  manifest.captured_at_ms,
  manifest.fingerprint,
  manifest.capture_id,
];
const accountingFor = (manifest: SentinelReplayManifest): SentinelReplayAccountingRow => ({
  version: 1,
  capture_id: manifest.capture_id,
  request_id: "",
  fingerprint: manifest.fingerprint,
  bytes: sentinelReplayManifestCharge(manifest),
  state: "stored",
  fence: 1,
  created_at_ms: manifest.captured_at_ms,
  expires_at_ms: manifest.expires_at_ms,
  status_expires_at_ms: manifest.captured_at_ms + SENTINEL_REPLAY_STATUS_TTL_MS,
  stage: 0,
});
const seedManifest = async (kv: Kv, manifest: SentinelReplayManifest, accounted: boolean): Promise<void> => {
  await kv.set(manifestKey(manifest), manifest);
  await kv.set([...SENTINEL_REPLAY_CHUNK_PREFIX, manifest.capture_id, 0], new Uint8Array(manifest.ciphertext_bytes));
  if (accounted) await kv.set(sentinelReplayAccountingKey(manifest.captured_at_ms, manifest.capture_id), accountingFor(manifest));
};
const runBatch = async (kv: Kv): Promise<SentinelReplayBudgetLedger> => {
  const state = await readLedger(kv, budget);
  if (state.kind === "corrupt") throw new Error("unexpected corrupt fixture ledger");
  return await runBootstrapBatch(kv, state.ledger, state.versionstamp, budget, now);
};
const finishSweep = async (kv: Kv): Promise<SentinelReplayBudgetLedger> => {
  for (let pass = 0; pass < 200; pass += 1) {
    const ledger = await runBatch(kv);
    if (ledger.bootstrap_cursor === null) return ledger;
  }
  throw new Error("bounded fixture sweep did not finish");
};
const liveCounters = (ledger: SentinelReplayBudgetLedger) => ({
  stored_bytes: ledger.stored_bytes,
  reserved_bytes: ledger.reserved_bytes,
  records: ledger.records,
  status_records: ledger.status_records,
  metadata_bytes: ledger.metadata_bytes,
});
const assertHistory = (ledger: SentinelReplayBudgetLedger): void => {
  for (const [key, value] of Object.entries(history)) assert.equal(ledger[key as keyof SentinelReplayBudgetLedger], value);
};
const chunkKey = (captureId: string, index = 0): KvKey => [...SENTINEL_REPLAY_CHUNK_PREFIX, captureId, index];
const OWNER_PREFIXES = new Set([SENTINEL_REPLAY_ACCOUNTING_PREFIX, SENTINEL_REPLAY_MANIFEST_PREFIX].map((prefix) => prefix.join("/")));
const isOwnerPrefix = (prefix: KvKey): boolean => OWNER_PREFIXES.has(prefix.join("/"));
const isChunkPrefix = (prefix: KvKey): boolean => prefix.join("/") === SENTINEL_REPLAY_CHUNK_PREFIX.join("/");
/**
 * A separate handle on the same store (as another process would hold) that
 * counts every row a matching list actually yields (accounting/manifest rows
 * by default), so a test can bound one bootstrap batch through its real consumer.
 */
const countListReads = (kv: Kv, reads: { count: number }, counts: (prefix: KvKey) => boolean = isOwnerPrefix): Kv => ({
  ...kv,
  list: <T>(selector: KvListSelector, options?: KvListOptions): KvListIterator<T> => {
    const iterator = kv.list<T>(selector, options);
    if (!("prefix" in selector) || !counts(selector.prefix)) return iterator;
    const counted: KvListIterator<T> = {
      get cursor() {
        return iterator.cursor;
      },
      next: async () => {
        const result = await iterator.next();
        if (!result.done) reads.count += 1;
        return result;
      },
      [Symbol.asyncIterator]: () => counted,
    };
    return counted;
  },
});
/** Stored-charge manifests keep a large owner fixture far inside the test budget. */
const ownedManifests = (count: number): SentinelReplayManifest[] =>
  Array.from({ length: count }, (_, index) => ({ ...manifestFor(index + 1), stored_bytes: 1_024 }));
type Hold = Readonly<{ reached: () => void; gate: Promise<undefined> }>;
/** One armable pause point: `arm` returns the test's side of the next hold. */
const holdPoint = () => {
  let armed: Hold | null = null;
  const take = (): Hold | null => {
    const hold = armed;
    armed = null;
    return hold;
  };
  const arm = () => {
    const reached = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    const hold: Hold = {
      reached: () => {
        reached.resolve(undefined);
      },
      gate: gate.promise,
    };
    armed = hold;
    return {
      reached: reached.promise,
      release: () => {
        gate.resolve(undefined);
      },
      disarm: () => {
        if (armed === hold) armed = null;
      },
    };
  };
  return { take, arm };
};
/**
 * A handle whose next matching list, once armed, is held until released. By
 * default it is held before its first read and issued only on release, so it
 * sees every write made meanwhile, and `released` keeps the keys it then
 * yields. With `afterFirstRow` it is held once its first row has been read, so
 * that row keeps the versionstamp it had before the hold.
 */
const holdNextList = (kv: Kv, holds: (prefix: KvKey) => boolean, afterFirstRow = false) => {
  const point = holdPoint();
  const released: KvKey[] = [];
  const handle: Kv = {
    ...kv,
    list: <T>(selector: KvListSelector, options?: KvListOptions): KvListIterator<T> => {
      const hold = "prefix" in selector && holds(selector.prefix) ? point.take() : null;
      if (hold === null) return kv.list<T>(selector, options);
      let inner: KvListIterator<T> | null = afterFirstRow ? kv.list<T>(selector, options) : null;
      let waiting = true;
      const wait = async (): Promise<void> => {
        waiting = false;
        hold.reached();
        await hold.gate;
      };
      const held: KvListIterator<T> = {
        get cursor() {
          return inner?.cursor ?? "";
        },
        next: async () => {
          if (inner === null) {
            await wait();
            inner = kv.list<T>(selector, options);
          }
          const result = await inner.next();
          if (waiting) await wait();
          if (!result.done) released.push(result.value.key);
          return result;
        },
        [Symbol.asyncIterator]: () => held,
      };
      return held;
    },
  };
  return { handle, arm: point.arm, released };
};
/** A handle on which, once armed, the next commit that writes the budget ledger is held until released. */
const holdNextLedgerCommit = (kv: Kv) => {
  const point = holdPoint();
  const handle: Kv = {
    ...kv,
    atomic: (): AtomicOperation => {
      const operation = kv.atomic();
      const set = operation.set.bind(operation);
      const commit = operation.commit.bind(operation);
      let writesLedger = false;
      operation.set = (key, value, options) => {
        writesLedger ||= key.join("/") === SENTINEL_REPLAY_BUDGET_LEDGER_KEY.join("/");
        set(key, value, options);
        return operation;
      };
      operation.commit = async () => {
        const hold = writesLedger ? point.take() : null;
        if (hold !== null) {
          hold.reached();
          await hold.gate;
        }
        return await commit();
      };
      return operation;
    },
  };
  return { handle, arm: point.arm };
};
/**
 * A handle on which, once armed, the next ledger read is answered and then a
 * concurrently refused admission records its skip reason (the ledger write
 * recordSkipReason makes) before the reader can commit.
 */
const interposeSkipReason = (kv: Kv) => {
  let armed = false;
  const handle: Kv = {
    ...kv,
    get: async <T>(key: KvKey, options?: Parameters<Kv["get"]>[1]): Promise<KvEntryMaybe<T>> => {
      const entry = await kv.get<T>(key, options);
      if (!armed || key.join("/") !== SENTINEL_REPLAY_BUDGET_LEDGER_KEY.join("/")) return entry;
      armed = false;
      const state = await readLedger(kv, budget);
      if (state.kind === "corrupt") throw new Error("unexpected corrupt fixture ledger");
      const skipped = { ...state.ledger, last_skip_reason: SENTINEL_REPLAY_ACCOUNTING_REASON, last_warning_at_ms: now };
      const committed = await kv
        .atomic()
        .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: state.versionstamp })
        .set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, skipped)
        .commit();
      assert.ok(committed.ok, "the interposed skip reason must land");
      return entry;
    },
  };
  return {
    handle,
    arm: () => {
      armed = true;
    },
  };
};
/** Every orphan chunk is reclaimed and every owned capture keeps its payload. */
const assertOrphansReclaimed = async (kv: Kv, orphans: readonly string[], owned: readonly SentinelReplayManifest[]): Promise<void> => {
  for (const orphan of orphans) {
    for (const index of [0, 1]) assert.equal((await kv.get(chunkKey(orphan, index))).value, null, `${orphan}/${index} is reclaimed`);
  }
  for (const manifest of owned) assert.notEqual((await kv.get(chunkKey(manifest.capture_id))).value, null, `${manifest.capture_id} keeps its payload`);
};
const ledgerCursor = async (kv: Kv): Promise<string | null> => {
  const state = await readLedger(kv, budget);
  if (state.kind === "corrupt") throw new Error("unexpected corrupt fixture ledger");
  return state.ledger.bootstrap_cursor;
};
/** A deterministic, incompressible capture body that spans several stored chunks. */
const multiChunkBody = (): Uint8Array<ArrayBuffer> => {
  const noise = new Uint8Array(96 * 1_024);
  let state = 0x2545f491;
  for (let index = 0; index < noise.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    noise[index] = state & 0xff;
  }
  return new TextEncoder().encode(JSON.stringify({ model: "gpt-5.6-sol", blob: base64UrlEncode(noise) }));
};
const captureFailure: SentinelFailureObservation = {
  status: 502,
  stream: false,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  synthetic_terminal_type: null,
  provider_route: "chatgpt_codex",
};

test("bootstrap retry: orphan chunks are reclaimed instead of being ignored", async () => {
  const kv = await openKv(":memory:");
  const orphanKey = [...SENTINEL_REPLAY_CHUNK_PREFIX, "orphan-bootstrap", 0] as KvKey;
  try {
    await kv.set(orphanKey, new Uint8Array([1, 2, 3]));
    const ledger = await finishSweep(kv);
    assert.equal(ledger.bootstrap_complete, true);
    assert.equal(ledger.stored_bytes, 0);
    assert.equal((await kv.get(orphanKey)).value, null);
  } finally {
    kv.close();
  }
});

for (const accounted of [false, true]) {
  test(`bootstrap retry: ${accounted ? "existing" : "materialized legacy"} charges rebuild once and preserve history`, async () => {
    const kv = await openKv(":memory:");
    const manifest = manifestFor(1);
    const reserved: SentinelReplayAccountingRow = { ...accountingFor(manifestFor(2)), state: "reserved", bytes: 200 };
    const status = {
      version: 1,
      request_id: "retry-status",
      status: "disabled",
      reason: "fixture",
      captured_at_ms: now,
      manifest_key: null,
      fingerprint: null,
      expires_at_ms: null,
    };
    const tombstone = { fingerprint: "e".repeat(64), reason: "fixture", expires_at_ms: now + SENTINEL_REPLAY_STATUS_TTL_MS };
    const expected = {
      stored_bytes: sentinelReplayManifestCharge(manifest),
      reserved_bytes: reserved.bytes,
      records: 1,
      status_records: 2,
      metadata_bytes: sentinelReplayStatusMetadataBytes(status) + sentinelReplayStatusMetadataBytes(tombstone),
    };
    try {
      const initial = await readLedger(kv, budget);
      if (initial.kind === "corrupt") throw new Error("unexpected corrupt fixture ledger");
      await kv.set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, { ...initial.ledger, ...history });
      await seedManifest(kv, manifest, accounted);
      await kv.set(sentinelReplayAccountingKey(reserved.created_at_ms, reserved.capture_id), reserved);
      await kv.set([...SENTINEL_REPLAY_REQUEST_PREFIX, status.request_id], status);
      await kv.set([...SENTINEL_REPLAY_EVICTION_PREFIX, tombstone.fingerprint], tombstone);
      await kv.set(corruptKey, { invalid: true });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failed = await finishSweep(kv);
        assert.equal(failed.bootstrap_complete, false);
        assert.equal(failed.bootstrap_cursor, null);
        assert.equal(failed.accounting_error, "invalid_in_scope_row");
        assert.deepEqual(liveCounters(failed), expected);
        assertHistory(failed);
      }
      assert.deepEqual((await kv.get(sentinelReplayAccountingKey(manifest.captured_at_ms, manifest.capture_id))).value, accountingFor(manifest));
      await kv.delete(corruptKey);
      const recovered = await finishSweep(kv);
      assert.equal(recovered.bootstrap_complete, true);
      assert.equal(recovered.accounting_error, null);
      assert.equal(recovered.over_budget, false);
      assert.deepEqual(liveCounters(recovered), expected);
      assertHistory(recovered);
    } finally {
      kv.close();
    }
  });
}

test("bootstrap retry: a restarted sweep preserves bounded cursor continuation", async () => {
  const kv = await openKv(":memory:");
  const manifests = Array.from({ length: BOOTSTRAP_BATCH_ENTRIES + 7 }, (_, index) => manifestFor(index + 1));
  const expectedBytes = manifests.reduce((sum, manifest) => sum + sentinelReplayManifestCharge(manifest), 0);
  try {
    for (const manifest of manifests) await seedManifest(kv, manifest, false);
    await kv.set(corruptKey, { invalid: true });
    const failed = await finishSweep(kv);
    assert.equal(failed.bootstrap_complete, false);
    assert.equal(failed.records, manifests.length);
    const partial = await runBatch(kv);
    assert.equal(partial.bootstrap_complete, false);
    assert.notEqual(partial.bootstrap_cursor, null);
    assert.equal(partial.records, BOOTSTRAP_BATCH_ENTRIES);
    const repeated = await finishSweep(kv);
    assert.equal(repeated.bootstrap_complete, false);
    assert.equal(repeated.records, manifests.length);
    assert.equal(repeated.stored_bytes, expectedBytes);
    await kv.delete(corruptKey);
    const recovered = await finishSweep(kv);
    assert.equal(recovered.bootstrap_complete, true);
    assert.equal(recovered.records, manifests.length);
    assert.equal(recovered.stored_bytes, expectedBytes);
  } finally {
    kv.close();
  }
});

test("bootstrap retry: stale ledger CAS cannot commit a rebuilt snapshot", async () => {
  const kv = await openKv(":memory:");
  const manifest = manifestFor(1);
  try {
    await seedManifest(kv, manifest, false);
    await kv.set(corruptKey, { invalid: true });
    await finishSweep(kv);
    await kv.delete(corruptKey);
    const stale = await readLedger(kv, budget);
    if (stale.kind !== "ok") throw new Error("expected a persisted failed sweep");
    const concurrent = { ...stale.ledger, expired_records: stale.ledger.expired_records + 1 };
    const committed = await kv
      .atomic()
      .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: stale.versionstamp })
      .set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, concurrent)
      .commit();
    if (!committed.ok) throw new Error("fixture CAS unexpectedly failed");
    const conflict = await runBootstrapBatch(kv, stale.ledger, stale.versionstamp, budget, now);
    assert.deepEqual(conflict, concurrent);
    const persisted = await kv.get(SENTINEL_REPLAY_BUDGET_LEDGER_KEY);
    assert.deepEqual(persisted.value, concurrent);
    assert.equal(persisted.versionstamp, committed.versionstamp);
    const recovered = await finishSweep(kv);
    assert.equal(recovered.bootstrap_complete, true);
    assert.equal(recovered.expired_records, concurrent.expired_records);
    assert.equal(recovered.stored_bytes, sentinelReplayManifestCharge(manifest));
    assert.equal(recovered.records, 1);
  } finally {
    kv.close();
  }
});

test("bootstrap retry: a recovered legacy charge expires and releases exactly once", async () => {
  const kv = await openKv(":memory:");
  const manifest = manifestFor(1);
  const charge = sentinelReplayManifestCharge(manifest);
  const accountingKey = sentinelReplayAccountingKey(manifest.captured_at_ms, manifest.capture_id);
  try {
    await seedManifest(kv, manifest, false);
    await kv.set(corruptKey, { invalid: true });
    await finishSweep(kv);
    await finishSweep(kv);
    await kv.delete(corruptKey);
    const recovered = await finishSweep(kv);
    assert.equal(recovered.stored_bytes, charge);
    assert.equal(recovered.records, 1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await reclaimExpiredSentinelReplays(kv, { now_ms: manifest.expires_at_ms + 1, budget_bytes: budget });
      const state = await readLedger(kv, budget);
      if (state.kind !== "ok") throw new Error("expected a persisted reclamation ledger");
      const reclaimed = state.ledger;
      assert.equal(reclaimed.stored_bytes, 0);
      assert.equal(reclaimed.reserved_bytes, 0);
      assert.equal(reclaimed.records, 0);
      assert.equal(reclaimed.expired_bytes, charge);
      assert.equal(reclaimed.expired_records, 1);
      assert.equal((await kv.get(accountingKey)).value, null);
      assert.equal((await kv.get(manifestKey(manifest))).value, null);
      assert.equal((await kv.get([...SENTINEL_REPLAY_CHUNK_PREFIX, manifest.capture_id, 0])).value, null);
    }
  } finally {
    kv.close();
  }
});

test("bootstrap retry: chunk owner lookups stay bounded per batch and linear overall", async () => {
  const kv = await openKv(":memory:");
  const reads = { count: 0 };
  const gateway = countListReads(kv, reads);
  // Half the owners are legacy manifests the sweep materializes later; the rest are already accounted.
  const owned = ownedManifests(2 * BOOTSTRAP_OWNER_SCAN_ENTRIES);
  // A capture still staging: its reserved accounting row is its only owner.
  const live: SentinelReplayAccountingRow = { ...accountingFor(manifestFor(owned.length + 1)), capture_id: "live-reserved", state: "reserved", bytes: 2_048 };
  const orphans = ["orphan-a", "orphan-b", "orphan-c"];
  const ownerRows = owned.length + Math.ceil(owned.length / 2) + 1;
  const batchBound = BOOTSTRAP_OWNER_SCAN_ENTRIES + BOOTSTRAP_BATCH_ENTRIES;
  try {
    for (const [index, manifest] of owned.entries()) await seedManifest(kv, manifest, index % 2 === 0);
    await kv.set(sentinelReplayAccountingKey(live.created_at_ms, live.capture_id), live);
    await kv.set(chunkKey(live.capture_id), new Uint8Array(64));
    for (const orphan of orphans) for (const index of [0, 1]) await kv.set(chunkKey(orphan, index), new Uint8Array(32));
    assert.ok(ownerRows > batchBound, "the fixture must hold more owner rows than one bounded batch may read");
    let ledger: SentinelReplayBudgetLedger | null = null;
    let total = 0;
    for (let call = 0; call < 1_000 && ledger === null; call += 1) {
      reads.count = 0;
      ledger = await bootstrapBeforeMutation(gateway, budget, now);
      assert.ok(reads.count <= batchBound, `bootstrap call ${call} read ${reads.count} owner rows; the bound is ${batchBound}`);
      total += reads.count;
    }
    if (ledger === null) throw new Error("bounded bootstrap did not finish");
    // A lone caller reads each owner row once in its own sweep phase and once for the chunk owner index, never once per chunk.
    assert.ok(total <= 2 * ownerRows, `the whole sweep read ${total} owner rows for ${ownerRows}`);
    for (const orphan of orphans) {
      for (const index of [0, 1]) assert.equal((await kv.get(chunkKey(orphan, index))).value, null, `${orphan}/${index} is reclaimed`);
    }
    for (const manifest of owned) assert.notEqual((await kv.get(chunkKey(manifest.capture_id))).value, null, `${manifest.capture_id} keeps its payload`);
    assert.notEqual((await kv.get(chunkKey(live.capture_id))).value, null, "a live reservation keeps its staged chunk");
    assert.deepEqual(liveCounters(ledger), {
      stored_bytes: owned.length * 1_024,
      reserved_bytes: live.bytes,
      records: owned.length,
      status_records: 0,
      metadata_bytes: 0,
    });
    const admitted = await reserveSentinelReplayCapacity(kv, {
      capture_id: "after-bootstrap",
      request_id: "after-bootstrap",
      plaintext_bytes: 128,
      metadata_bytes: 64,
      fingerprint: "a".repeat(64),
      now_ms: now,
      budget_bytes: budget,
    });
    assert.equal(admitted.ok, true, "admissions resume once the bounded sweep completes");
  } finally {
    kv.close();
  }
});

test("bootstrap retry: a chunk owner index is rebuilt after another writer moves the sweep", async () => {
  const kv = await openKv(":memory:");
  const first = countListReads(kv, { count: 0 });
  const second = countListReads(kv, { count: 0 });
  const owned = ownedManifests(2 * BOOTSTRAP_OWNER_SCAN_ENTRIES);
  const late: SentinelReplayAccountingRow = { ...accountingFor(manifestFor(owned.length + 1)), capture_id: "zz-late-owner", state: "reserved", bytes: 2_048 };
  const cursor = (): Promise<string | null> => ledgerCursor(kv);
  try {
    for (const manifest of owned) await seedManifest(kv, manifest, true);
    await kv.set(chunkKey("zz-orphan"), new Uint8Array(32));
    // The first handle finishes its owner index and starts judging chunks.
    for (let call = 0; call < 1_000 && !/^1\|./.test((await cursor()) ?? ""); call += 1) assert.equal(await bootstrapBeforeMutation(first, budget, now), null);
    assert.match((await cursor()) ?? "", /^1\|./);
    // An owner the first handle never saw (after an unobserved ledger reset, for example) witnesses whether its index is reused.
    await kv.set(sentinelReplayAccountingKey(late.created_at_ms, late.capture_id), late);
    await kv.set(chunkKey(late.capture_id), new Uint8Array(64));
    const left = await cursor();
    for (let call = 0; call < 1_000 && (await cursor()) === left; call += 1) assert.equal(await bootstrapBeforeMutation(second, budget, now), null);
    assert.notEqual(await cursor(), left, "the second handle moved the durable sweep");
    let ledger: SentinelReplayBudgetLedger | null = null;
    for (let call = 0; call < 1_000 && ledger === null; call += 1) ledger = await bootstrapBeforeMutation(first, budget, now);
    assert.equal(ledger?.bootstrap_complete, true);
    assert.notEqual((await kv.get(chunkKey(late.capture_id))).value, null, "a stale owner index must not reclaim the late owner's payload");
    assert.equal((await kv.get(chunkKey("zz-orphan"))).value, null, "a true orphan is still reclaimed");
  } finally {
    kv.close();
  }
});

test("bootstrap retry: a batch that outlives sweep completion keeps a capture published meanwhile", async () => {
  const kv = await openKv(":memory:");
  const pausing = holdNextList(kv, isChunkPrefix);
  // One handle for every caller: the shape of one process with concurrent requests.
  const handle = pausing.handle;
  const owned = ownedManifests(2);
  const orphans = ["orphan-a", "orphan-b", "orphan-c", "orphan-d"];
  const keyBytes = new Uint8Array(32).fill(3);
  const requestId = "bootstrap-straddle";
  const liveCaptureId = "zz-live-capture";
  const body = multiChunkBody();
  const input: AcceptedSentinelReplayInput = {
    endpoint: "/v1/responses",
    method: "POST",
    body,
    content_type: "application/json",
    compatibility_headers: {},
    request_id: requestId,
    git_sha: "a".repeat(40),
    deno_revision: "bootstrap-straddle",
  };
  try {
    for (const manifest of owned) await seedManifest(kv, manifest, true);
    for (const orphan of orphans) await kv.set(chunkKey(orphan), new Uint8Array(32));
    // Run until a committed batch has judged chunks, so the next batch reuses its retained owner index.
    for (let call = 0; call < 100 && !/^1\|./.test((await ledgerCursor(kv)) ?? ""); call += 1) {
      assert.equal(await bootstrapBeforeMutation(handle, budget, now), null);
    }
    assert.match((await ledgerCursor(kv)) ?? "", /^1\|./);
    // Batch A has read the incomplete ledger and is held at its next chunk page.
    const hold = pausing.arm();
    const outlived = bootstrapBeforeMutation(handle, budget, now);
    await hold.reached;
    // Meanwhile another request finishes the sweep, and a capture is admitted, staged and published.
    let completed: SentinelReplayBudgetLedger | null = null;
    for (let call = 0; call < 100 && completed === null; call += 1) completed = await bootstrapBeforeMutation(handle, budget, now);
    assert.equal(completed?.bootstrap_complete, true);
    const stored = await persistEncryptedSentinelReplay(input, captureFailure, {
      kv: handle,
      keyBytes,
      now: () => now,
      randomUuid: () => liveCaptureId,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      budgetBytes: budget,
    });
    assert.equal(stored.status, "stored");
    assert.ok(stored.manifest.chunk_count > 1, "the live capture spans several chunks");
    hold.release();
    assert.equal((await outlived)?.bootstrap_complete, true);
    assert.ok(
      pausing.released.some((key) => key[4] === liveCaptureId),
      "the outlived batch judged the published capture's chunks against its pre-admission owner index"
    );
    const exported = await listEncryptedSentinelReplaysByRequestId(kv, requestId, now);
    assert.equal(exported.captures.length, 1, "the published capture stays exportable");
    const plaintext = await decryptExportedSentinelReplay(exported.captures[0], keyBytes);
    assert.deepEqual(plaintext.body, body, "the published capture keeps its whole payload");
    const state = await readLedger(kv, budget);
    if (state.kind === "corrupt") throw new Error("unexpected corrupt fixture ledger");
    assert.equal(state.ledger.bootstrap_complete, true);
    assert.equal(state.ledger.accounting_error, null, "a refused delete never leaves an invalid-row error behind");
    assert.equal(state.ledger.records, owned.length + 1);
    for (const orphan of orphans) assert.equal((await kv.get(chunkKey(orphan))).value, null, `${orphan} is reclaimed`);
  } finally {
    kv.close();
  }
});

for (const schedule of ["skip-reason", "overlapping-batches"] as const) {
  test(`bootstrap retry: lost ledger commits keep the chunk owner index, so a contended sweep finishes (${schedule})`, async () => {
    const kv = await openKv(":memory:");
    const reads = { count: 0 };
    const interposing = interposeSkipReason(countListReads(kv, reads, () => true));
    const pausing = holdNextList(interposing.handle, isOwnerPrefix);
    const handle = pausing.handle;
    const owned = ownedManifests(3 * BOOTSTRAP_OWNER_SCAN_ENTRIES);
    const orphans = ["orphan-a", "orphan-b", "orphan-c", "orphan-d"];
    const ownerRows = 2 * owned.length;
    const sweptRows = ownerRows + owned.length + 2 * orphans.length;
    // One batch lists at most one owner-index slice, one chunk probe and its sweep entries.
    const batchReads = BOOTSTRAP_OWNER_SCAN_ENTRIES + 1 + BOOTSTRAP_BATCH_ENTRIES;
    // Contention may cost every other batch its commit, never the owners already indexed.
    const callBound = 2 * (Math.ceil(sweptRows / BOOTSTRAP_BATCH_ENTRIES) + Math.ceil(ownerRows / BOOTSTRAP_OWNER_SCAN_ENTRIES) + 8);
    const callFor = (call: number): Promise<SentinelReplayBudgetLedger | null> => {
      if (call % 2 === 0) interposing.arm();
      return bootstrapBeforeMutation(handle, budget, now);
    };
    /** Batch X is held at its first owner read while batch Y reads the same ledger; X then commits first and Y loses. */
    const overlappingRound = async (): Promise<SentinelReplayBudgetLedger | null> => {
      const holdX = pausing.arm();
      const x = bootstrapBeforeMutation(handle, budget, now);
      await Promise.race([holdX.reached, x]);
      holdX.disarm();
      const holdY = pausing.arm();
      const y = bootstrapBeforeMutation(handle, budget, now);
      await Promise.race([holdY.reached, y]);
      holdY.disarm();
      holdX.release();
      const first = await x;
      holdY.release();
      const second = await y;
      return first ?? second;
    };
    try {
      for (const manifest of owned) await seedManifest(kv, manifest, true);
      for (const orphan of orphans) for (const index of [0, 1]) await kv.set(chunkKey(orphan, index), new Uint8Array(32));
      assert.ok(ownerRows > 2 * BOOTSTRAP_OWNER_SCAN_ENTRIES, "the owner index must need more slices than one lost commit can cost");
      let ledger: SentinelReplayBudgetLedger | null = null;
      let calls = 0;
      while (ledger === null && calls < callBound) {
        reads.count = 0;
        if (schedule === "skip-reason") {
          ledger = await callFor(calls);
          calls += 1;
          assert.ok(reads.count <= batchReads, `bootstrap call ${calls} listed ${reads.count} rows; the bound is ${batchReads}`);
        } else {
          ledger = await overlappingRound();
          calls += 2;
          assert.ok(reads.count <= 2 * batchReads, `overlapping round ending at call ${calls} listed ${reads.count} rows; the bound is ${2 * batchReads}`);
        }
      }
      assert.equal(ledger?.bootstrap_complete, true, `the contended sweep finished within ${callBound} bootstrap calls (cursor ${await ledgerCursor(kv)})`);
      for (const orphan of orphans) {
        for (const index of [0, 1]) assert.equal((await kv.get(chunkKey(orphan, index))).value, null, `${orphan}/${index} is reclaimed`);
      }
      for (const manifest of owned) assert.notEqual((await kv.get(chunkKey(manifest.capture_id))).value, null, `${manifest.capture_id} keeps its payload`);
      assert.deepEqual(liveCounters(ledger), {
        stored_bytes: owned.length * 1_024,
        reserved_bytes: 0,
        records: owned.length,
        status_records: 0,
        metadata_bytes: 0,
      });
    } finally {
      kv.close();
    }
  });
}

for (const consumer of ["bootstrapBeforeMutation", "reserveSentinelReplayCapacity"] as const) {
  test(`bootstrap retry: a slow batch judging chunks shares the complete owner index, so concurrent batches still advance (${consumer})`, async () => {
    const kv = await openKv(":memory:");
    const pausing = holdNextList(kv, isChunkPrefix);
    // One handle for every caller: the shape of one process with concurrent requests.
    const handle = pausing.handle;
    const owned = ownedManifests(2 * BOOTSTRAP_OWNER_SCAN_ENTRIES);
    const orphans = ["orphan-a", "orphan-b", "orphan-c", "orphan-d"];
    // Every round must commit at least one chunk page or later sweep batch.
    const roundBound = Math.ceil((owned.length + 2 * orphans.length) / BOOTSTRAP_BATCH_ENTRIES) + Math.ceil(owned.length / BOOTSTRAP_BATCH_ENTRIES) + 4;
    let admissions = 0;
    /** One request through the real consumer; true once accounting is authoritative. */
    const request = async (): Promise<boolean> => {
      if (consumer === "bootstrapBeforeMutation") return (await bootstrapBeforeMutation(handle, budget, now)) !== null;
      admissions += 1;
      const admission = await reserveSentinelReplayCapacity(handle, {
        capture_id: `admission-${admissions}`,
        request_id: `admission-${admissions}`,
        plaintext_bytes: 128,
        metadata_bytes: 64,
        fingerprint: "a".repeat(64),
        now_ms: now,
        budget_bytes: budget,
      });
      return admission.ok;
    };
    try {
      for (const manifest of owned) await seedManifest(kv, manifest, true);
      for (const orphan of orphans) for (const index of [0, 1]) await kv.set(chunkKey(orphan, index), new Uint8Array(32));
      // Run until a committed batch has judged chunks, so the complete owner index is held for the durable cursor.
      for (let call = 0; call < 1_000 && !/^1\|./.test((await ledgerCursor(kv)) ?? ""); call += 1) {
        assert.equal(await bootstrapBeforeMutation(handle, budget, now), null);
      }
      assert.match((await ledgerCursor(kv)) ?? "", /^1\|./);
      let finished = false;
      for (let round = 0; round < roundBound && !finished; round += 1) {
        const before = await ledgerCursor(kv);
        // Request X reads the ledger first, takes the owner index and is held at its chunk page.
        const hold = pausing.arm();
        const x = request();
        await Promise.race([hold.reached, x]);
        hold.disarm();
        // Request Y reads the same ledger and commits first; X then loses its commit.
        const y = await request();
        hold.release();
        finished = (await x) || y;
        assert.notEqual(await ledgerCursor(kv), before, `round ${round} must move the durable sweep from ${before}`);
      }
      assert.ok(finished, `the contended sweep finished within ${roundBound} rounds (cursor ${await ledgerCursor(kv)})`);
      const state = await readLedger(kv, budget);
      if (state.kind === "corrupt") throw new Error("unexpected corrupt fixture ledger");
      assert.equal(state.ledger.bootstrap_complete, true);
      assert.equal(state.ledger.accounting_error, null);
      assert.equal(state.ledger.stored_bytes, owned.length * 1_024);
      assert.equal(state.ledger.records, owned.length);
      await assertOrphansReclaimed(kv, orphans, owned);
    } finally {
      kv.close();
    }
  });
}

test("bootstrap retry: a chunk another batch sharing the owner index reclaimed first is not an invalid row", async () => {
  const kv = await openKv(":memory:");
  const committing = holdNextLedgerCommit(kv);
  const reading = holdNextList(committing.handle, isChunkPrefix, true);
  // One handle for every caller: the shape of one process with concurrent requests.
  const handle = reading.handle;
  const owned = ownedManifests(BOOTSTRAP_BATCH_ENTRIES);
  const orphans = ["orphan-a", "orphan-b"];
  const nextChunkOwner = async (): Promise<unknown> => {
    const cursor = (await ledgerCursor(kv)) ?? "";
    if (!/^1\|./.test(cursor)) return null;
    for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_CHUNK_PREFIX }, { cursor: cursor.slice(2), limit: 1 })) return entry.key[4];
    return null;
  };
  try {
    for (const manifest of owned) await seedManifest(kv, manifest, true);
    for (const orphan of orphans) for (const index of [0, 1]) await kv.set(chunkKey(orphan, index), new Uint8Array(32));
    // Run until a committed batch has judged chunks and the next chunk page starts at an orphan.
    for (let call = 0; call < 100 && (await nextChunkOwner()) !== "orphan-a"; call += 1) assert.equal(await bootstrapBeforeMutation(handle, budget, now), null);
    assert.equal(await nextChunkOwner(), "orphan-a");
    // Batch X has read the orphan's row when it is held.
    const read = reading.arm();
    const x = bootstrapBeforeMutation(handle, budget, now);
    await read.reached;
    // Batch Y judges the same page from the same ledger, reclaims every orphan, and is held before its ledger commit.
    const commit = committing.arm();
    const y = bootstrapBeforeMutation(handle, budget, now);
    await commit.reached;
    for (const orphan of orphans) {
      for (const index of [0, 1]) assert.equal((await kv.get(chunkKey(orphan, index))).value, null, `Y reclaimed ${orphan}/${index}`);
    }
    // X's delete of the reclaimed row now fails while its ledger read is still current, so X commits first.
    read.release();
    assert.equal(await x, null);
    const afterX = await readLedger(kv, budget);
    if (afterX.kind === "corrupt") throw new Error("unexpected corrupt fixture ledger");
    assert.equal(afterX.ledger.accounting_error, null, "a chunk already reclaimed is gone, not an invalid in-scope row");
    commit.release();
    assert.equal(await y, null);
    let ledger: SentinelReplayBudgetLedger | null = null;
    for (let call = 0; call < 100 && ledger === null; call += 1) {
      ledger = await bootstrapBeforeMutation(handle, budget, now);
      if (ledger === null) assert.notEqual(await ledgerCursor(kv), null, "the sweep never restarts from the beginning");
    }
    if (ledger === null) throw new Error("bootstrap did not finish");
    assert.equal(ledger.bootstrap_complete, true);
    assert.equal(ledger.accounting_error, null);
    assert.equal(ledger.records, owned.length);
    await assertOrphansReclaimed(kv, orphans, owned);
  } finally {
    kv.close();
  }
});

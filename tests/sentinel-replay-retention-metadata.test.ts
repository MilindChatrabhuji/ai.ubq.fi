import { test } from "bun:test";
import {
  openKv,
  type AtomicOperation,
  type Kv,
  type KvCommitError,
  type KvCommitResult,
  type KvEntry,
  type KvKey,
  type KvListOptions,
  type KvListSelector,
} from "#kv";
/** Native KV metadata expiry/reconciliation fixtures; synthetic rows only, no providers or credentials. */
import assert from "node:assert/strict";
import { SENTINEL_REPLAY_MAX_STATUS_RECORDS } from "../src/sentinel/replay-limits.ts";
import { SENTINEL_REPLAY_REQUEST_PREFIX, type SentinelReplayCaptureStatusRow } from "../src/sentinel/replay-model.ts";
import {
  reconcileSentinelReplayStatusMetadata,
  SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS,
  SENTINEL_REPLAY_METADATA_RECONCILED_KEY,
} from "../src/sentinel/replay-retention-metadata.ts";
import { admitSentinelReplayStatusMetadata, pruneCaptureOwnedStatusMetadata, runSentinelReplayRetentionMaintenance } from "../src/sentinel/replay-retention.ts";
import {
  readSentinelReplayLedgerSnapshot,
  SENTINEL_REPLAY_BUDGET_LEDGER_KEY,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  SENTINEL_REPLAY_EXPIRED_REASON,
  sentinelReplayMetadataReserve,
  sentinelReplayRequestStatusKey,
  sentinelReplayStatusMetadataBytes,
} from "../src/sentinel/replay-retention-schema.ts";

const NOW = 1_702_000_000_000;
const BUDGET_BYTES = 1 * 1_024 * 1_024;

const statusRow = (requestId: string): SentinelReplayCaptureStatusRow => ({
  version: 1,
  request_id: requestId,
  status: "disabled",
  reason: "metadata_fixture",
  captured_at_ms: NOW,
  manifest_key: null,
  fingerprint: null,
  expires_at_ms: null,
});

const tombstoneRow = (index: number) => ({
  version: 1,
  fingerprint: index.toString(16).padStart(64, "0"),
  request_id: `metadata-tombstone-${index}`,
  evicted_at_ms: NOW,
  reason: SENTINEL_REPLAY_EXPIRED_REASON,
});

const ledgerOf = async (kv: Kv, budgetBytes = BUDGET_BYTES) => {
  const snapshot = await readSentinelReplayLedgerSnapshot(kv, budgetBytes);
  assert.ok(snapshot);
  return snapshot;
};

const admitStatus = (kv: Kv, requestId: string, ttlMs = 60_000) =>
  admitSentinelReplayStatusMetadata(kv, {
    key: sentinelReplayRequestStatusKey(requestId),
    row: statusRow(requestId),
    now_ms: NOW,
    ttl_ms: ttlMs,
    budget_bytes: BUDGET_BYTES,
  });

/** KV expiry is earliest-after-TTL; observe native absence with a finite deadline rather than advancing a fake clock. */
const waitForExpiry = async (kv: Kv, keys: KvKey[]): Promise<void> => {
  // Deno 2.9.7 pins denokv_sqlite 0.14.0: its empty-DB collector fallback is 60s
  // plus 0..1s jitter, and later writes do not reschedule that deadline.
  const started = Date.now();
  const deadline = started + 90_000;
  while (Date.now() < deadline) {
    const entries = await kv.getMany(keys);
    if (entries.every((entry) => entry.value === null)) {
      console.info(JSON.stringify({ fixture: "native_metadata_ttl_absent", elapsed_ms: Date.now() - started, rows: keys.length }));
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("native metadata TTL did not disappear within the fixture deadline");
};

const expiringMetadata = async (kv: Kv): Promise<KvKey[]> => {
  const keys: KvKey[] = [];
  for (let index = 0; index < 6; index += 1) {
    const requestId = `ttl-status-${index}`;
    assert.equal(await admitStatus(kv, requestId, 500), true);
    const key = sentinelReplayRequestStatusKey(requestId);
    assert.notEqual((await kv.get(key)).value, null, "positive baseline: native KV really retained the TTL row");
    keys.push(key);
  }
  const row = tombstoneRow(1);
  const key = [...SENTINEL_REPLAY_EVICTION_PREFIX, row.fingerprint];
  assert.equal(await admitSentinelReplayStatusMetadata(kv, { key, row, now_ms: NOW, ttl_ms: 500, budget_bytes: BUDGET_BYTES }), true);
  assert.notEqual((await kv.get(key)).value, null);
  keys.push(key);
  const before = await ledgerOf(kv);
  assert.equal(before.ledger.status_records, 7);
  assert.equal(before.ledger.metadata_bytes + sentinelReplayStatusMetadataBytes(statusRow("ttl-after")) > sentinelReplayMetadataReserve(BUDGET_BYTES), true);
  return keys;
};

const liveMetadata = async (kv: Kv): Promise<Readonly<{ records: number; bytes: number }>> => {
  let records = 0;
  let bytes = 0;
  for (const prefix of [SENTINEL_REPLAY_REQUEST_PREFIX, SENTINEL_REPLAY_EVICTION_PREFIX]) {
    for await (const entry of kv.list({ prefix })) {
      records += 1;
      bytes += sentinelReplayStatusMetadataBytes(entry.value);
    }
  }
  return { records, bytes };
};

const seedOverCapMetadata = async (kv: Kv, budgetBytes: number, requestRecords = SENTINEL_REPLAY_MAX_STATUS_RECORDS): Promise<number> => {
  await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW, budget_bytes: budgetBytes });
  const initial = await ledgerOf(kv, budgetBytes);
  let bytes = 0;
  for (let start = 0; start < requestRecords; start += 128) {
    const operation = kv.atomic();
    for (let index = start; index < Math.min(start + 128, requestRecords); index += 1) {
      const row = statusRow(`legacy-status-${index.toString().padStart(5, "0")}`);
      operation.set(sentinelReplayRequestStatusKey(row.request_id), row);
      bytes += sentinelReplayStatusMetadataBytes(row);
    }
    assert.equal((await operation.commit()).ok, true);
  }
  const tombstones = kv.atomic();
  for (let index = 1; index <= 32; index += 1) {
    const row = { ...tombstoneRow(index), evicted_at_ms: NOW - 1 };
    tombstones.set([...SENTINEL_REPLAY_EVICTION_PREFIX, row.fingerprint], row);
    bytes += sentinelReplayStatusMetadataBytes(row);
  }
  assert.equal((await tombstones.commit()).ok, true);
  await kv.set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, { ...initial.ledger, status_records: requestRecords + 32, metadata_bytes: bytes });
  return bytes;
};

const sameKey = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const isMetadataSelector = (selector: KvListSelector): boolean =>
  "prefix" in selector && [SENTINEL_REPLAY_REQUEST_PREFIX, SENTINEL_REPLAY_EVICTION_PREFIX].some((prefix) => sameKey(selector.prefix, prefix));

/** Counts every status/tombstone row a caller reads through `list`; other prefixes pass through untouched. */
const countMetadataScans = (kv: Kv, counts: { scanned: number }): Kv =>
  new Proxy(kv, {
    get(target, property) {
      if (property === "list") {
        return (selector: KvListSelector, options?: KvListOptions) => {
          const iterator = target.list(selector, options);
          if (!isMetadataSelector(selector)) return iterator;
          return (async function* () {
            for await (const entry of iterator) {
              counts.scanned += 1;
              yield entry;
            }
          })();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

type Poll = Readonly<{ scanned: number; ledger_written: boolean; status: Awaited<ReturnType<typeof runSentinelReplayRetentionMaintenance>> }>;

/** One admin-poll maintenance pass, with its metadata rows scanned and whether it rewrote the ledger. */
const pollMaintenance = async (kv: Kv, nowMs: number, budgetBytes: number): Promise<Poll> => {
  const counts = { scanned: 0 };
  const before = await ledgerOf(kv, budgetBytes);
  const status = await runSentinelReplayRetentionMaintenance(countMetadataScans(kv, counts), { now_ms: nowMs, budget_bytes: budgetBytes });
  const after = await ledgerOf(kv, budgetBytes);
  return { scanned: counts.scanned, ledger_written: after.versionstamp !== before.versionstamp, status };
};

const reconciledAt = async (kv: Kv): Promise<unknown> =>
  (await kv.get<{ reconciled_at_ms?: unknown }>(SENTINEL_REPLAY_METADATA_RECONCILED_KEY)).value?.reconciled_at_ms;

test("native over-cap request rows cannot hide corrupt tombstone pruning candidates", async () => {
  const kv = await openKv(":memory:");
  const budgetBytes = 1_024 * 1_024 * 1_024;
  try {
    await seedOverCapMetadata(kv, budgetBytes, SENTINEL_REPLAY_MAX_STATUS_RECORDS + 1);
    const valid = tombstoneRow(33);
    const cases = [
      { key: [...SENTINEL_REPLAY_EVICTION_PREFIX, valid.fingerprint], row: { evicted_at_ms: NOW + 1 } },
      { key: [...SENTINEL_REPLAY_EVICTION_PREFIX, valid.fingerprint], row: { ...valid, fingerprint: tombstoneRow(34).fingerprint } },
      { key: [...SENTINEL_REPLAY_EVICTION_PREFIX, valid.fingerprint, "extra"], row: valid },
    ];
    for (const fixture of cases) {
      await kv.set(fixture.key, fixture.row);
      const current = await ledgerOf(kv, budgetBytes);
      await kv.set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, {
        ...current.ledger,
        status_records: current.ledger.status_records + 1,
        metadata_bytes: current.ledger.metadata_bytes + sentinelReplayStatusMetadataBytes(fixture.row),
      });
      const before = await ledgerOf(kv, budgetBytes);
      const rowsBefore = await liveMetadata(kv);
      assert.equal(rowsBefore.records, SENTINEL_REPLAY_MAX_STATUS_RECORDS + 34);
      const corruptBefore = await kv.get(fixture.key);
      assert.equal(await reconcileSentinelReplayStatusMetadata(kv, budgetBytes), "over_limit");
      assert.deepEqual(await ledgerOf(kv, budgetBytes), before, "the over-cap witness never writes partial totals");
      assert.equal(await pruneCaptureOwnedStatusMetadata(kv, NOW, 0, 0, 16, budgetBytes), 0);
      assert.deepEqual(await ledgerOf(kv, budgetBytes), before, "a corrupt candidate preserves the exact ledger and version");
      assert.deepEqual(await liveMetadata(kv), rowsBefore, "all native status and tombstone rows survive");
      assert.deepEqual(await kv.get(fixture.key), corruptBefore);
      await kv.atomic().delete(fixture.key).set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, current.ledger).commit();
    }
  } finally {
    kv.close();
  }
});

test("native over-cap metadata makes bounded pruning progress without relaxing admission limits", async () => {
  const kv = await openKv(":memory:");
  const budgetBytes = 1_024 * 1_024 * 1_024;
  try {
    const seededBytes = await seedOverCapMetadata(kv, budgetBytes);
    assert.equal((await liveMetadata(kv)).records, SENTINEL_REPLAY_MAX_STATUS_RECORDS + 32);
    const beforeScan = await ledgerOf(kv, budgetBytes);
    assert.equal(await reconcileSentinelReplayStatusMetadata(kv, budgetBytes), "over_limit");
    assert.deepEqual(await ledgerOf(kv, budgetBytes), beforeScan, "an over-cap scan checks the ledger without writing partial totals");
    // Admin polls take the same over-cap witness once per interval, never every poll, and never write partial totals.
    const witness = await pollMaintenance(kv, NOW + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS, budgetBytes);
    assert.equal(witness.scanned, SENTINEL_REPLAY_MAX_STATUS_RECORDS + 1);
    assert.equal(witness.ledger_written, false);
    assert.equal(await reconciledAt(kv), NOW + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS);
    assert.equal((await pollMaintenance(kv, NOW + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS + 30_000, budgetBytes)).scanned, 0);
    assert.deepEqual(await ledgerOf(kv, budgetBytes), beforeScan);
    const beforeBytes = seededBytes + (await verifyOverCapCas(kv, budgetBytes));
    let removedBytes = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      assert.equal(await pruneCaptureOwnedStatusMetadata(kv, NOW + pass, 0, 0, 16, budgetBytes), 16);
      for (let index = pass * 16 + 1; index <= (pass + 1) * 16; index += 1) {
        const row = { ...tombstoneRow(index), evicted_at_ms: NOW - 1 };
        assert.equal((await kv.get([...SENTINEL_REPLAY_EVICTION_PREFIX, row.fingerprint])).value, null);
        removedBytes += sentinelReplayStatusMetadataBytes(row);
      }
      const after = await ledgerOf(kv, budgetBytes);
      assert.equal(after.ledger.status_records, SENTINEL_REPLAY_MAX_STATUS_RECORDS + 32 - (pass + 1) * 16);
      assert.equal(after.ledger.metadata_bytes, beforeBytes - removedBytes, "only committed row deletions change the charge, never a partial recount");
      assert.equal(after.ledger.status_pruned_records, (pass + 1) * 16);
    }
    const row = statusRow("legacy-after-pruning");
    // The 8 KiB per-row charge still exceeds the fixed 64 MiB reserve. An
    // admission makes one more bounded deletion and keeps refusing that bound.
    assert.equal(
      await admitSentinelReplayStatusMetadata(kv, {
        key: sentinelReplayRequestStatusKey(row.request_id),
        row,
        now_ms: NOW + 2,
        ttl_ms: 60_000,
        budget_bytes: budgetBytes,
      }),
      false
    );
    const after = await ledgerOf(kv, budgetBytes);
    const expected = await liveMetadata(kv);
    assert.equal(after.ledger.status_records, SENTINEL_REPLAY_MAX_STATUS_RECORDS - 1);
    assert.equal(after.ledger.status_records, expected.records);
    assert.equal(after.ledger.metadata_bytes, expected.bytes);
    assert.equal(after.ledger.status_pruned_records, 33);
    assert.equal((await kv.get(sentinelReplayRequestStatusKey(row.request_id))).value, null);
  } finally {
    kv.close();
  }
});

const verifyMaintenanceExpiry = async (kv: Kv): Promise<void> => {
  await waitForExpiry(kv, await expiringMetadata(kv));
  assert.equal((await ledgerOf(kv)).ledger.status_records, 7, "native TTL deletion leaves the old ledger charge until reconciliation");
  const maintained = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW + 1, budget_bytes: BUDGET_BYTES });
  assert.equal(maintained.status_records, 0);
  assert.equal(maintained.metadata_bytes, 0);
  assert.equal((await ledgerOf(kv)).ledger.status_pruned_records, 0);
  assert.equal(await admitStatus(kv, "ttl-after"), true);
  assert.equal((await ledgerOf(kv)).ledger.status_records, 1);
};

const verifyAdmissionExpiry = async (kv: Kv): Promise<void> => {
  await waitForExpiry(kv, await expiringMetadata(kv));
  assert.equal(await admitStatus(kv, "ttl-after"), true);
  const after = await ledgerOf(kv);
  assert.equal(after.ledger.status_records, 1);
  assert.equal(after.ledger.metadata_bytes, sentinelReplayStatusMetadataBytes(statusRow("ttl-after")));
  assert.equal(after.ledger.status_pruned_records, 0);
};

const verifyCompleteScan = async (kv: Kv): Promise<void> => {
  const budgetBytes = 64 * 1_024 * 1_024;
  for (let index = 0; index < 129; index += 1) {
    const status = statusRow(`complete-status-${index}`);
    const tombstone = tombstoneRow(index + 1);
    await kv.set(sentinelReplayRequestStatusKey(status.request_id), status);
    await kv.set([...SENTINEL_REPLAY_EVICTION_PREFIX, tombstone.fingerprint], tombstone);
  }
  let maintained = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW, budget_bytes: budgetBytes });
  for (let pass = 0; pass < 200 && !maintained.accounting_complete; pass += 1) {
    maintained = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW, budget_bytes: budgetBytes });
  }
  assert.equal(maintained.accounting_complete, true);
  const transient = statusRow("complete-expiring");
  const transientKey = sentinelReplayRequestStatusKey(transient.request_id);
  assert.equal(await admitSentinelReplayStatusMetadata(kv, { key: transientKey, row: transient, now_ms: NOW, ttl_ms: 500, budget_bytes: budgetBytes }), true);
  await waitForExpiry(kv, [transientKey]);
  const expected = await liveMetadata(kv);
  assert.equal(expected.records, 258);
  // Inside the interval the expired row keeps its conservative charge; the next due poll removes it.
  const inside = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW + 1, budget_bytes: budgetBytes });
  assert.equal(inside.status_records, expected.records + 1);
  const after = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS, budget_bytes: budgetBytes });
  assert.equal(after.status_records, expected.records);
  assert.equal(after.metadata_bytes, expected.bytes);
  assert.equal((await ledgerOf(kv, budgetBytes)).ledger.status_pruned_records, 0);
};

test("native TTL disappearance restores maintenance admission and complete metadata accounting", async () => {
  // The three independent collectors start together, so genuine native TTL
  // acceptance costs one bounded fallback interval rather than three in series.
  const stores = await Promise.all([openKv(":memory:"), openKv(":memory:"), openKv(":memory:")]);
  try {
    const outcomes = await Promise.allSettled([verifyMaintenanceExpiry(stores[0]), verifyAdmissionExpiry(stores[1]), verifyCompleteScan(stores[2])]);
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map((outcome) => outcome.reason as unknown);
    if (failures.length > 0) throw new AggregateError(failures, "native metadata TTL controls failed");
  } finally {
    for (const kv of stores) kv.close();
  }
});

type CommitObservation = { before: () => Promise<void>; after: (result: KvCommitResult | KvCommitError) => void };

const observedAtomic = (operation: AtomicOperation, observation: CommitObservation): AtomicOperation =>
  new Proxy(operation, {
    get(target, property) {
      if (property === "commit") {
        return async () => {
          await observation.before();
          const result = await target.commit();
          observation.after(result);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => observedAtomic(Reflect.apply(value, target, args) as AtomicOperation, observation);
    },
  });

const observeCommits = (kv: Kv, observation: CommitObservation): Kv =>
  new Proxy(kv, {
    get(target, property) {
      if (property === "atomic") return () => observedAtomic(target.atomic(), observation);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const verifyOverCapCas = async (kv: Kv, budgetBytes: number): Promise<number> => {
  const before = await ledgerOf(kv, budgetBytes);
  const row = statusRow("legacy-status-00000");
  const key = sentinelReplayRequestStatusKey(row.request_id);
  const entry = await kv.get(key);
  const updated = { ...row, reason: "concurrent_metadata_fixture" };
  const delta = sentinelReplayStatusMetadataBytes(updated) - sentinelReplayStatusMetadataBytes(row);
  const outcomes: boolean[] = [];
  const wrapped = observeCommits(kv, {
    before: async () => {
      const result = await kv
        .atomic()
        .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: before.versionstamp })
        .check({ key, versionstamp: entry.versionstamp })
        .set(key, updated)
        .set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, { ...before.ledger, metadata_bytes: before.ledger.metadata_bytes + delta })
        .commit();
      assert.equal(result.ok, true);
    },
    after: (result) => {
      outcomes.push(result.ok);
    },
  });
  assert.equal(await pruneCaptureOwnedStatusMetadata(wrapped, NOW, 0, 0, 16, budgetBytes), 0);
  assert.deepEqual(outcomes, [false], "a native ledger race also rejects an over-cap scan before pruning");
  const after = await ledgerOf(kv, budgetBytes);
  assert.equal(after.ledger.status_records, before.ledger.status_records);
  assert.equal(after.ledger.metadata_bytes, before.ledger.metadata_bytes + delta);
  assert.equal(after.ledger.status_pruned_records, 0);
  return delta;
};

test("a concurrent native status admission invalidates the whole metadata recount CAS", async () => {
  const kv = await openKv(":memory:");
  const outcomes: boolean[] = [];
  const wrapped = observeCommits(kv, {
    before: async () => {
      assert.equal(await admitStatus(kv, "added-during-recount"), true);
    },
    after: (result) => {
      outcomes.push(result.ok);
    },
  });
  try {
    assert.equal(await admitStatus(kv, "before-recount"), true);
    assert.equal(await reconcileSentinelReplayStatusMetadata(wrapped, BUDGET_BYTES), "failed");
    assert.deepEqual(outcomes, [false], "the real native ledger version check rejects the stale scanned totals");
    const expected = await liveMetadata(kv);
    const after = await ledgerOf(kv);
    assert.equal(expected.records, 2);
    assert.equal(after.ledger.status_records, expected.records);
    assert.equal(after.ledger.metadata_bytes, expected.bytes);
    assert.equal(await reconcileSentinelReplayStatusMetadata(kv, BUDGET_BYTES), "reconciled");
  } finally {
    kv.close();
  }
});

const withList = (kv: Kv, list: (selector: KvListSelector, options?: KvListOptions) => AsyncIterable<KvEntry<unknown>>): Kv =>
  new Proxy(kv, {
    get(target, property) {
      if (property === "list") return list;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

async function* interruptedList(kv: Kv, selector: KvListSelector, options?: KvListOptions) {
  for await (const entry of kv.list(selector, options)) {
    yield entry;
    throw new Error("metadata_fixture_list_failure");
  }
}

async function* overLimitRows(limit: number, corruptWitness = false) {
  for (let index = 0; index < limit; index += 1) {
    const row = statusRow(`scan-bound-${index}`);
    const value = corruptWitness && index === SENTINEL_REPLAY_MAX_STATUS_RECORDS ? { ...row, request_id: "wrong-witness-owner" } : row;
    yield await Promise.resolve({ key: sentinelReplayRequestStatusKey(row.request_id), value, versionstamp: "fixture" });
  }
}

test("corruption partial-list failure and an over-limit scan never lower metadata counters", async () => {
  const kv = await openKv(":memory:");
  try {
    assert.equal(await admitStatus(kv, "preserved-row"), true);
    const before = await ledgerOf(kv);
    const corruptKey = sentinelReplayRequestStatusKey("wrong-key-owner");
    await kv.set(corruptKey, statusRow("different-owner"));
    assert.equal(await reconcileSentinelReplayStatusMetadata(kv, BUDGET_BYTES), "failed");
    assert.deepEqual(await ledgerOf(kv), before);
    assert.equal(await pruneCaptureOwnedStatusMetadata(kv, NOW, SENTINEL_REPLAY_MAX_STATUS_RECORDS, 0, 16, BUDGET_BYTES), 0);
    await kv.delete(corruptKey);

    const failed = withList(kv, (selector, options) => interruptedList(kv, selector, options));
    assert.equal(await reconcileSentinelReplayStatusMetadata(failed, BUDGET_BYTES), "failed");
    assert.equal(await pruneCaptureOwnedStatusMetadata(failed, NOW, SENTINEL_REPLAY_MAX_STATUS_RECORDS, 0, 16, BUDGET_BYTES), 0);
    assert.deepEqual(await ledgerOf(kv), before);

    const requested: KvListOptions[] = [];
    const overLimit = withList(kv, (_selector, options) => {
      requested.push(options ?? {});
      return overLimitRows(Math.min(options?.limit ?? 0, SENTINEL_REPLAY_MAX_STATUS_RECORDS + 1));
    });
    assert.equal(await reconcileSentinelReplayStatusMetadata(overLimit, BUDGET_BYTES), "over_limit");
    assert.deepEqual(await ledgerOf(kv), before);
    assert.equal(requested[0].consistency, "strong");
    assert.equal(requested[0].limit, SENTINEL_REPLAY_MAX_STATUS_RECORDS + 1);
    const corruptWitness = withList(kv, (_selector, options) => overLimitRows(options?.limit ?? 0, true));
    assert.equal(await reconcileSentinelReplayStatusMetadata(corruptWitness, BUDGET_BYTES), "failed");
    assert.equal(await pruneCaptureOwnedStatusMetadata(corruptWitness, NOW, SENTINEL_REPLAY_MAX_STATUS_RECORDS, 0, 16, BUDGET_BYTES), 0);
    assert.deepEqual(await ledgerOf(kv), before);
    const unreadable = new Proxy(kv, {
      get(target, property) {
        if (property === "get") return () => Promise.reject(new Error("metadata_fixture_read_failure"));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.equal(await reconcileSentinelReplayStatusMetadata(unreadable, BUDGET_BYTES), "failed");
    await assert.rejects(
      pruneCaptureOwnedStatusMetadata(unreadable, NOW, SENTINEL_REPLAY_MAX_STATUS_RECORDS, 0, 16, BUDGET_BYTES),
      /metadata_fixture_read_failure/
    );
    assert.deepEqual(await ledgerOf(kv), before);
    await kv.set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, { ...before.ledger, status_records: -1 });
    assert.equal(await reconcileSentinelReplayStatusMetadata(kv, BUDGET_BYTES), "failed");
    assert.equal(await pruneCaptureOwnedStatusMetadata(kv, NOW, SENTINEL_REPLAY_MAX_STATUS_RECORDS, 0, 16, BUDGET_BYTES), 0);
    assert.equal((await kv.get<{ status_records: number }>(SENTINEL_REPLAY_BUDGET_LEDGER_KEY)).value?.status_records, -1);
  } finally {
    kv.close();
  }
});

test("healthy admin polls inside the interval skip the metadata recount and the ledger write", async () => {
  const kv = await openKv(":memory:");
  const budgetBytes = 1_024 * 1_024 * 1_024;
  // The analytics view requests /admin/errors?limit=1 every 30 seconds.
  const pollIntervalMs = 30_000;
  try {
    // A representative retained set at the production budget: 4,096 status rows and 32 tombstones,
    // about 35 MiB of the 64 MiB metadata reserve, with the ledger already equal to the live rows.
    await seedOverCapMetadata(kv, budgetBytes, 4_096);
    const live = await liveMetadata(kv);
    assert.equal(live.records, 4_128);
    const start = NOW + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS;
    const first = await pollMaintenance(kv, start, budgetBytes);
    const inside: Poll[] = [];
    for (let at = start + pollIntervalMs; at < start + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS; at += pollIntervalMs) {
      inside.push(await pollMaintenance(kv, at, budgetBytes));
    }
    const due = await pollMaintenance(kv, start + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS, budgetBytes);
    console.info(
      JSON.stringify({
        fixture: "metadata_recount_polls",
        retained_rows: live.records,
        polls: inside.length + 2,
        rows_scanned: first.scanned + inside.reduce((sum, poll) => sum + poll.scanned, 0) + due.scanned,
        ledger_writes: [first, ...inside, due].filter((poll) => poll.ledger_written).length,
      })
    );
    assert.equal(inside.length, SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS / pollIntervalMs - 1);
    assert.deepEqual(
      inside.map((poll) => poll.scanned),
      inside.map(() => 0),
      "a healthy poll inside the interval reads no status or tombstone row"
    );
    assert.deepEqual(
      inside.map((poll) => poll.ledger_written),
      inside.map(() => false),
      "a healthy poll inside the interval never rewrites the ledger"
    );
    for (const poll of inside) assert.deepEqual(poll.status, first.status, "the admin API reports the same retention status");
    assert.equal(first.scanned, live.records, "a due poll recounts the whole retained set exactly once");
    assert.equal(due.scanned, live.records);
    assert.equal(first.ledger_written, false, "a recount that matches the ledger leaves its version alone");
    assert.equal(due.ledger_written, false);
    assert.equal(first.status.status_records, live.records);
    assert.equal(first.status.metadata_bytes, live.bytes);
    assert.equal(await reconciledAt(kv), start + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS);
  } finally {
    kv.close();
  }
});

test("a removed status row converges at the next due poll while metadata pressure reclaims it at once", async () => {
  const kv = await openKv(":memory:");
  try {
    assert.equal((await pollMaintenance(kv, NOW, BUDGET_BYTES)).status.accounting_complete, true);
    const keys: KvKey[] = [];
    for (let index = 0; index < 7; index += 1) {
      assert.equal(await admitStatus(kv, `pressure-status-${index}`, 3_600_000), true);
      keys.push(sentinelReplayRequestStatusKey(`pressure-status-${index}`));
    }
    const full = await ledgerOf(kv);
    assert.equal(full.ledger.status_records, 7);
    assert.equal(
      full.ledger.metadata_bytes + sentinelReplayStatusMetadataBytes(statusRow("pressure-after")) > sentinelReplayMetadataReserve(BUDGET_BYTES),
      true
    );
    // Deleting rows without touching the ledger is exactly what native TTL expiry leaves behind.
    for (const key of keys.slice(0, 4)) await kv.delete(key);

    const inside = await pollMaintenance(kv, NOW + 1, BUDGET_BYTES);
    assert.equal(inside.scanned, 0);
    assert.equal(inside.ledger_written, false);
    assert.equal(inside.status.status_records, 7, "inside the interval the vanished rows keep their conservative charge");

    // Pressure does not wait for the interval: admission recounts before it would prune a live row.
    assert.equal(await admitStatus(kv, "pressure-after", 3_600_000), true);
    const admitted = await ledgerOf(kv);
    assert.equal(admitted.ledger.status_records, 4);
    assert.equal(admitted.ledger.status_pruned_records, 0, "the stale charge was reclaimed without pruning a live row");
    assert.deepEqual(await liveMetadata(kv), { records: admitted.ledger.status_records, bytes: admitted.ledger.metadata_bytes });

    await kv.delete(keys[4]);
    const stillInside = await pollMaintenance(kv, NOW + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS - 1, BUDGET_BYTES);
    assert.equal(stillInside.scanned, 0);
    assert.equal(stillInside.status.status_records, 4);
    const due = await pollMaintenance(kv, NOW + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS, BUDGET_BYTES);
    assert.equal(due.scanned, 3);
    assert.equal(due.ledger_written, true);
    assert.equal(due.status.status_records, 3, "the next due poll converges on the live rows");
    assert.deepEqual(await liveMetadata(kv), { records: due.status.status_records, bytes: due.status.metadata_bytes });
  } finally {
    kv.close();
  }
});

const checksLedgerKey = (property: string | symbol, args: unknown[]): boolean =>
  property === "check" && args.some((check) => sameKey((check as { key: KvKey }).key, SENTINEL_REPLAY_BUDGET_LEDGER_KEY));

/** Runs `race` immediately before the first commit that checks the ledger, and records that commit's outcome. */
const raceFirstLedgerCommit = (kv: Kv, race: () => Promise<void>, outcomes: boolean[]): Kv => {
  let armed = true;
  const wrap = (operation: AtomicOperation, checksLedger: boolean): AtomicOperation =>
    new Proxy(operation, {
      get(target, property) {
        if (property === "commit") {
          return async () => {
            if (!checksLedger || !armed) return await target.commit();
            armed = false;
            await race();
            const result = await target.commit();
            outcomes.push(result.ok);
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => wrap(Reflect.apply(value, target, args) as AtomicOperation, checksLedger || checksLedgerKey(property, args));
      },
    });
  return new Proxy(kv, {
    get(target, property) {
      if (property === "atomic") return () => wrap(target.atomic(), false);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

test("a recount that loses to a concurrent writer, or a stale or corrupt marker, leaves the next poll due", async () => {
  const kv = await openKv(":memory:");
  try {
    await pollMaintenance(kv, NOW, BUDGET_BYTES);
    assert.equal(await reconciledAt(kv), NOW);
    assert.equal(await admitStatus(kv, "before-race"), true);
    const outcomes: boolean[] = [];
    const due = NOW + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS;
    const raced = raceFirstLedgerCommit(
      kv,
      async () => {
        assert.equal(await admitStatus(kv, "during-race"), true);
      },
      outcomes
    );
    await runSentinelReplayRetentionMaintenance(raced, { now_ms: due, budget_bytes: BUDGET_BYTES });
    assert.deepEqual(outcomes, [false], "the ledger version check rejects the stale recount");
    assert.equal(await reconciledAt(kv), NOW, "a lost recount never records itself as done");
    const raceLedger = (await ledgerOf(kv)).ledger;
    assert.deepEqual(await liveMetadata(kv), { records: 2, bytes: raceLedger.metadata_bytes });
    assert.equal(raceLedger.status_records, 2, "the racing admission's own CAS kept the ledger exact");

    const retried = await pollMaintenance(kv, due + 1, BUDGET_BYTES);
    assert.equal(retried.scanned, 2, "the next poll is still due and recounts");
    assert.equal(await reconciledAt(kv), due + 1);
    assert.equal((await pollMaintenance(kv, due + 2, BUDGET_BYTES)).scanned, 0);

    // A marker from a clock that ran ahead cannot postpone the recount indefinitely.
    await kv.set(SENTINEL_REPLAY_METADATA_RECONCILED_KEY, { version: 1, reconciled_at_ms: due + 10 * SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS });
    assert.equal((await pollMaintenance(kv, due + 3, BUDGET_BYTES)).scanned, 2);
    assert.equal(await reconciledAt(kv), due + 3);
    for (const corrupt of ["not-a-marker", { version: 1, reconciled_at_ms: -1 }, { version: 2, reconciled_at_ms: due }]) {
      await kv.set(SENTINEL_REPLAY_METADATA_RECONCILED_KEY, corrupt);
      assert.equal((await pollMaintenance(kv, due + 4, BUDGET_BYTES)).scanned, 2, "a corrupt marker is treated as due");
      assert.equal(await reconciledAt(kv), due + 4);
    }
  } finally {
    kv.close();
  }
});

test("a due recount that meets a corrupt metadata row backs off for the interval instead of rescanning on every poll", async () => {
  const kv = await openKv(":memory:");
  const pollIntervalMs = 30_000;
  try {
    await pollMaintenance(kv, NOW, BUDGET_BYTES);
    for (let index = 0; index < 3; index += 1) assert.equal(await admitStatus(kv, `backoff-${index}`, 3_600_000), true);
    // Sorted after the three healthy rows, so a due scan reads all of them before it meets the corrupt one.
    const corruptKey = sentinelReplayRequestStatusKey("zz-corrupt-owner");
    await kv.set(corruptKey, statusRow("different-owner"));
    const due = NOW + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS;
    const failed = await pollMaintenance(kv, due, BUDGET_BYTES);
    assert.equal(failed.scanned, 4, "the due recount reads up to the corrupt row");
    assert.equal(failed.ledger_written, false);
    assert.equal(await reconciledAt(kv), NOW, "a failed scan never records a recount");

    const inside: number[] = [];
    for (let at = due + pollIntervalMs; at < due + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS; at += pollIntervalMs) {
      inside.push((await pollMaintenance(kv, at, BUDGET_BYTES)).scanned);
    }
    assert.equal(inside.length, SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS / pollIntervalMs - 1);
    assert.deepEqual(
      inside,
      inside.map(() => 0),
      "polls inside the failure backoff do not repeat the scan"
    );

    const retried = await pollMaintenance(kv, due + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS, BUDGET_BYTES);
    assert.equal(retried.scanned, 4, "the scan is retried once the backoff ends");
    await kv.delete(corruptKey);
    assert.equal((await pollMaintenance(kv, due + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS + 1, BUDGET_BYTES)).scanned, 0);
    const recovered = await pollMaintenance(kv, due + 2 * SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS, BUDGET_BYTES);
    assert.equal(recovered.scanned, 3, "after the repair the next due poll recounts the live rows");
    assert.equal(await reconciledAt(kv), due + 2 * SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS);
    assert.equal(recovered.status.status_records, 3);
  } finally {
    kv.close();
  }
});

test("of two concurrent due recounts only the first to commit records the marker, so it never moves back", async () => {
  const kv = await openKv(":memory:");
  try {
    await pollMaintenance(kv, NOW, BUDGET_BYTES);
    assert.equal(await admitStatus(kv, "concurrent-recount", 3_600_000), true);
    const due = NOW + SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS;
    const later = due + 5_000;
    const outcomes: boolean[] = [];
    // The earlier poll reads the marker, scans, and then loses the commit race to a later poll.
    const raced = raceFirstLedgerCommit(
      kv,
      async () => {
        await runSentinelReplayRetentionMaintenance(kv, { now_ms: later, budget_bytes: BUDGET_BYTES });
        assert.equal(await reconciledAt(kv), later);
      },
      outcomes
    );
    await runSentinelReplayRetentionMaintenance(raced, { now_ms: due, budget_bytes: BUDGET_BYTES });
    assert.deepEqual(outcomes, [false], "the stale poll's marker check rejects its commit");
    assert.equal(await reconciledAt(kv), later, "the marker keeps the later recount");
    assert.equal((await pollMaintenance(kv, later + 1, BUDGET_BYTES)).scanned, 0, "and the committed recount still defers the next one");
  } finally {
    kv.close();
  }
});

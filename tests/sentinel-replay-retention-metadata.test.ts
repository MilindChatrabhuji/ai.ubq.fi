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
import { reconcileSentinelReplayStatusMetadata } from "../src/sentinel/replay-retention-metadata.ts";
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
  for (let pass = 0; pass < 20 && !maintained.accounting_complete; pass += 1) {
    maintained = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW, budget_bytes: budgetBytes });
  }
  assert.equal(maintained.accounting_complete, true);
  const transient = statusRow("complete-expiring");
  const transientKey = sentinelReplayRequestStatusKey(transient.request_id);
  assert.equal(await admitSentinelReplayStatusMetadata(kv, { key: transientKey, row: transient, now_ms: NOW, ttl_ms: 500, budget_bytes: budgetBytes }), true);
  await waitForExpiry(kv, [transientKey]);
  const expected = await liveMetadata(kv);
  assert.equal(expected.records, 258);
  const after = await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW + 1, budget_bytes: budgetBytes });
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

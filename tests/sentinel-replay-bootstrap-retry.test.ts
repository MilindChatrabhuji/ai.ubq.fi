import { test } from "bun:test";
import { openKv, type Kv, type KvKey } from "#kv";
import assert from "node:assert/strict";
import { runBootstrapBatch } from "../src/sentinel/replay-retention-bootstrap.ts";
import { reclaimExpiredSentinelReplays } from "../src/sentinel/replay-retention.ts";
import {
  BOOTSTRAP_BATCH_ENTRIES,
  readLedger,
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

import { test } from "bun:test";
import { openKv, type Kv } from "#kv";
import assert from "node:assert/strict";
import {
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_CHUNK_BYTES,
  SENTINEL_REPLAY_DEDUPE_PREFIX,
  SENTINEL_REPLAY_STATUS_TTL_MS,
  SENTINEL_REPLAY_TTL_MS,
  type SentinelReplayCaptureStatusRow,
  type SentinelReplayManifest,
} from "../src/sentinel/replay-model.ts";
import { isSentinelReplayManifest } from "../src/sentinel/replay-read.ts";
import { evictSentinelReplays, runSentinelReplayRetentionMaintenance } from "../src/sentinel/replay-retention.ts";
import {
  readLedger,
  readSentinelReplayLedgerSnapshot,
  sentinelReplayAccountingKey,
  sentinelReplayManifestCharge,
  sentinelReplayManifestKey,
  sentinelReplayRequestStatusKey,
  sentinelReplayStatusMetadataBytes,
  SENTINEL_REPLAY_BUDGET_LEDGER_KEY,
  type SentinelReplayAccountingRow,
} from "../src/sentinel/replay-retention-schema.ts";

const NOW = 1_700_000_000_000;
const BUDGET_BYTES = 64 * 1_024 * 1_024;

/** Synthetic ciphertext rows exercise native deletion without encryption or provider calls. */
const victimFor = (chunkCount: number, index: number) => {
  const captureId = `deletion-budget-${index}`;
  const fingerprint = String(index + 1).repeat(64);
  const manifest: SentinelReplayManifest = {
    version: 1,
    capture_id: captureId,
    request_id: captureId,
    fingerprint,
    case_group_digest: "a".repeat(64),
    captured_at_ms: NOW + index,
    expires_at_ms: NOW + index + SENTINEL_REPLAY_TTL_MS,
    algorithm: "AES-256-GCM",
    compression: "gzip",
    iv: "AAAAAAAAAAAAAAAA",
    chunk_count: chunkCount,
    ciphertext_bytes: chunkCount * SENTINEL_REPLAY_CHUNK_BYTES,
  };
  assert.equal(isSentinelReplayManifest(manifest), true, "fixture manifest obeys the real multi-chunk size contract");
  const accounting: SentinelReplayAccountingRow = {
    version: 1,
    capture_id: captureId,
    request_id: captureId,
    fingerprint,
    bytes: sentinelReplayManifestCharge(manifest),
    state: "stored",
    fence: 1,
    created_at_ms: manifest.captured_at_ms,
    expires_at_ms: manifest.expires_at_ms,
    status_expires_at_ms: NOW + index + SENTINEL_REPLAY_STATUS_TTL_MS,
    stage: 1,
  };
  const manifestKey = sentinelReplayManifestKey(manifest);
  const status: SentinelReplayCaptureStatusRow = {
    version: 1,
    request_id: captureId,
    status: "ready",
    reason: null,
    captured_at_ms: manifest.captured_at_ms,
    manifest_key: manifestKey,
    fingerprint,
    expires_at_ms: manifest.expires_at_ms,
  };
  return { manifest, accounting, manifestKey, status, key: sentinelReplayAccountingKey(accounting.created_at_ms, captureId) };
};

type Victim = ReturnType<typeof victimFor>;

const seedVictims = async (kv: Kv, chunkCounts: readonly number[]): Promise<Victim[]> => {
  const victims = chunkCounts.map(victimFor);
  const state = await readLedger(kv, BUDGET_BYTES);
  if (state.kind === "corrupt") throw new Error("empty fixture ledger is corrupt");
  for (const victim of victims) {
    for (let index = 0; index < victim.manifest.chunk_count; index += 1) {
      await kv.set([...SENTINEL_REPLAY_CHUNK_PREFIX, victim.accounting.capture_id, index], new Uint8Array(SENTINEL_REPLAY_CHUNK_BYTES));
    }
    const committed = await kv
      .atomic()
      .set(victim.key, victim.accounting)
      .set(victim.manifestKey, victim.manifest)
      .set([...SENTINEL_REPLAY_DEDUPE_PREFIX, victim.accounting.fingerprint], { manifest_key: victim.manifestKey })
      .set(sentinelReplayRequestStatusKey(victim.accounting.request_id), victim.status)
      .commit();
    assert.equal(committed.ok, true);
  }
  await kv.set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, {
    ...state.ledger,
    stored_bytes: victims.reduce((bytes, victim) => bytes + victim.accounting.bytes, 0),
    records: victims.length,
    status_records: victims.length,
    metadata_bytes: victims.reduce((bytes, victim) => bytes + sentinelReplayStatusMetadataBytes(victim.status), 0),
    bootstrap_complete: true,
  });
  return victims;
};

const chunkCount = async (kv: Kv, captureId: string): Promise<number> => {
  let count = 0;
  for await (const entry of kv.list({ prefix: [...SENTINEL_REPLAY_CHUNK_PREFIX, captureId] })) {
    if (entry.key.length === SENTINEL_REPLAY_CHUNK_PREFIX.length + 2) count += 1;
  }
  return count;
};

const countsFor = async (kv: Kv, victims: readonly Victim[]): Promise<number[]> =>
  await Promise.all(victims.map((victim) => chunkCount(kv, victim.accounting.capture_id)));

const ledgerFor = async (kv: Kv) => {
  const snapshot = await readSentinelReplayLedgerSnapshot(kv, BUDGET_BYTES);
  if (!snapshot) throw new Error("fixture ledger is corrupt");
  return snapshot.ledger;
};

const withVictims = async (counts: readonly number[], inspect: (kv: Kv, victims: readonly Victim[]) => Promise<void>): Promise<void> => {
  const kv = await openKv(":memory:");
  try {
    const victims = await seedVictims(kv, counts);
    assert.deepEqual(await countsFor(kv, victims), counts, "positive native-KV seed baseline");
    await inspect(kv, victims);
  } finally {
    kv.close();
  }
};

for (const scenario of [
  { limit: 0, remaining: [3, 3], records: 0 },
  { limit: 1, remaining: [2, 3], records: 0 },
  { limit: 5, remaining: [0, 1], records: 1 },
]) {
  test(`eviction honors aggregate max_chunk_deletes=${scenario.limit} across multiple native-KV victims`, () =>
    withVictims([3, 3], async (kv, victims) => {
      const before = await ledgerFor(kv);
      const result = await evictSentinelReplays(kv, {
        target_bytes: 0,
        now_ms: NOW + 10,
        budget_bytes: BUDGET_BYTES,
        max_chunk_deletes: scenario.limit,
      });
      // Native row counts must prove the bound independently of the reported deletion count.
      assert.deepEqual(await countsFor(kv, victims), scenario.remaining, "actual surviving chunk rows");
      assert.equal(result.chunks, scenario.limit);
      assert.equal(result.records, scenario.records);
      const released = scenario.records === 0 ? 0 : victims[0].accounting.bytes;
      assert.equal(result.bytes, released);
      const after = await ledgerFor(kv);
      assert.equal(after.stored_bytes, before.stored_bytes - released, "partial cleanup retains the entire remaining victim charge");
      assert.equal(after.records, 2 - scenario.records);
      assert.equal(after.evicted_records, scenario.records);
      for (const [index, victim] of victims.entries()) {
        const accounting = await kv.get<SentinelReplayAccountingRow>(victim.key);
        if (scenario.remaining[index] === 0) {
          assert.equal(accounting.value, null);
          assert.equal((await kv.get(victim.manifestKey)).value, null);
          assert.equal((await kv.get([...SENTINEL_REPLAY_DEDUPE_PREFIX, victim.accounting.fingerprint])).value, null);
        } else {
          const expectedState = scenario.remaining[index] === 3 ? "stored" : "evicting";
          assert.equal(accounting.value?.state, expectedState);
          assert.equal(accounting.value.bytes, victim.accounting.bytes);
          assert.deepEqual((await kv.get(victim.manifestKey)).value, victim.manifest);
        }
      }
      if (scenario.limit === 0) assert.deepEqual(after, before, "zero budget leaves all accounting unchanged");
    }));
}

test("default eviction deletes at most 512 native chunks and later maintenance releases the partial charge once", () =>
  withVictims([257, 257], async (kv, victims) => {
    const before = await ledgerFor(kv);
    const result = await evictSentinelReplays(kv, { target_bytes: 0, now_ms: NOW + 10, budget_bytes: BUDGET_BYTES });
    assert.deepEqual(await countsFor(kv, victims), [0, 2], "default 512 is one aggregate allowance");
    assert.equal(result.chunks, 512);
    assert.equal(result.records, 1);
    assert.equal(result.bytes, victims[0].accounting.bytes);
    const partial = await ledgerFor(kv);
    assert.equal(partial.stored_bytes, victims[1].accounting.bytes);
    assert.equal(partial.evicted_bytes, victims[0].accounting.bytes);
    const accounting = await kv.get<SentinelReplayAccountingRow>(victims[1].key);
    assert.equal(accounting.value?.state, "evicting");
    assert.equal(accounting.value.bytes, victims[1].accounting.bytes);
    assert.equal(accounting.value.claim_kind, "evicted");

    // Maintenance resumes the budget claim after its payload TTL has passed.
    await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW + SENTINEL_REPLAY_TTL_MS + 11, budget_bytes: BUDGET_BYTES });
    assert.deepEqual(await countsFor(kv, victims), [0, 0], "the bounded continuation deletes only the two remaining chunks");
    assert.equal((await kv.get(victims[1].key)).value, null);
    const finished = await ledgerFor(kv);
    assert.equal(finished.stored_bytes, 0);
    assert.equal(finished.records, 0);
    assert.equal(finished.evicted_records, 2);
    assert.equal(finished.evicted_bytes, before.stored_bytes);
    await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW + 12, budget_bytes: BUDGET_BYTES });
    const repeated = await ledgerFor(kv);
    assert.equal(repeated.stored_bytes, finished.stored_bytes);
    assert.equal(repeated.records, finished.records);
    assert.equal(repeated.evicted_records, finished.evicted_records);
    assert.equal(repeated.evicted_bytes, finished.evicted_bytes, "the same charge is never released twice");
  }));

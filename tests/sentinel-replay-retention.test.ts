/**
 * Retention/accounting regressions for capture-owned storage.
 *
 * Every case uses an isolated in-memory Deno KV, synthetic bytes, a random
 * synthetic encryption key and an injectable small budget from the persist
 * dependencies or the retention test seam. No real GiB is written and no
 * provider is contacted.
 */
import assert from "node:assert/strict";
import { setKvForTest } from "../src/kv.ts";
import { isSentinelReplayCaptureStatusRow } from "../src/sentinel/replay-observation.ts";
import { decryptExportedSentinelReplay, listEncryptedSentinelReplaysByRequestId, readSentinelReplayCaptureStatus } from "../src/sentinel/replay-read.ts";
import { persistEncryptedSentinelReplay } from "../src/sentinel/replay-store.ts";
import {
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_DEDUPE_PREFIX,
  SENTINEL_REPLAY_MANIFEST_PREFIX,
  SENTINEL_REPLAY_REQUEST_PREFIX,
  SENTINEL_REPLAY_TTL_MS,
  type AcceptedSentinelReplayInput,
  type SentinelFailureObservation,
  type SentinelReplayManifest,
} from "../src/sentinel/replay-model.ts";
import {
  abandonSentinelReplayAccounting,
  admitSentinelReplayStatusMetadata,
  advanceSentinelReplayStagingFence,
  evictSentinelReplays,
  prepareSentinelReplayPublication,
  pruneCaptureOwnedStatusMetadata,
  readSentinelReplayRetentionStatus,
  reclaimExpiredSentinelReplays,
  reserveSentinelReplayCapacity,
  runSentinelReplayRetentionMaintenance,
} from "../src/sentinel/replay-retention.ts";
import {
  readSentinelReplayLedgerSnapshot,
  setSentinelReplayBudgetForTest,
  sentinelReplayAccountingKey,
  sentinelReplayManifestCharge,
  sentinelReplayRequestStatusKey,
  sentinelReplayStatusMetadataBytes,
  SENTINEL_REPLAY_ACCOUNTING_REASON,
  SENTINEL_REPLAY_BUDGET_LEDGER_KEY,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  SENTINEL_REPLAY_EVICTION_REASON,
  SENTINEL_REPLAY_EXPIRED_REASON,
  SENTINEL_REPLAY_STATUS_NOT_RETAINED,
  SENTINEL_REPLAY_STORAGE_FULL_REASON,
  setSentinelReplayRetentionFaultsForTest,
  type SentinelReplayAccountingRow,
  type SentinelReplayRetentionStatus,
} from "../src/sentinel/replay-retention-schema.ts";
import { SENTINEL_REPLAY_BUDGET_BYTES, SENTINEL_REPLAY_MAX_METADATA_BYTES, sentinelReplayReservationBytes } from "../src/sentinel/replay-limits.ts";
import { base64UrlEncode } from "../src/utils.ts";

const encoder = new TextEncoder();
const kvAvailable = typeof Deno.openKv === "function";

const failureObservation = (): SentinelFailureObservation => ({
  status: 502,
  stream: false,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  synthetic_terminal_type: null,
  provider_route: "chatgpt_codex",
});

const syntheticInput = (body: Uint8Array<ArrayBuffer>, requestId: string): AcceptedSentinelReplayInput => ({
  endpoint: "/v1/responses",
  method: "POST",
  body,
  content_type: "application/json",
  compatibility_headers: {},
  request_id: requestId,
  git_sha: "a".repeat(40),
  deno_revision: "retention-fixture",
});

/**
 * A deterministic per-request body whose stored charge is large and essentially
 * incompressible (random base64), so a small test budget can exercise eviction
 * without writing anywhere near a real GiB.
 */
const bodyCache = new Map<string, Uint8Array<ArrayBuffer>>();

/** WebCrypto refuses a single getRandomValues buffer above 65,536 bytes. */
const fillRandom = (bytes: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(bytes);
  for (let offset = 0; offset < bytes; offset += 65_536) {
    const slice = new Uint8Array(Math.min(65_536, bytes - offset));
    crypto.getRandomValues(slice);
    out.set(slice, offset);
  }
  return out;
};

const base64Of = (raw: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < raw.length; offset += 32_768) {
    binary += String.fromCharCode(...raw.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

const chargedBody = (requestId: string): Uint8Array<ArrayBuffer> => {
  const cached = bodyCache.get(requestId);
  if (cached) return cached;
  const body = encoder.encode(JSON.stringify({ model: "gpt-5.6-sol", request: requestId, blob: base64Of(fillRandom(256 * 1_024)) }));
  bodyCache.set(requestId, body);
  return body;
};

/**
 * Budgets are derived from the real accounting contract, never guessed:
 * HEADROOM admits several captures with zero evictions, and a tight budget adds
 * the ledger's stored bytes to a lower bound of the next reservation so the
 * next admission must evict the oldest capture.
 */
const HEADROOM_BUDGET_BYTES = 4 * sentinelReplayReservationBytes(256 * 1_024 + 1_024, SENTINEL_REPLAY_MAX_METADATA_BYTES);
const MIN_TEST_BUDGET_BYTES = 64 * 1_024;
const reservationBound = (body: Uint8Array<ArrayBuffer>): number => sentinelReplayReservationBytes(body.byteLength + 4, SENTINEL_REPLAY_MAX_METADATA_BYTES);
const storedPlusReserved = (status: SentinelReplayRetentionStatus): number => (status.stored_bytes ?? 0) + (status.reserved_bytes ?? 0);

const newKey = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;

const persist = async (kv: Deno.Kv, keyBytes: Uint8Array<ArrayBuffer>, requestId: string, budgetBytes: number, nowMs: number) =>
  await persistEncryptedSentinelReplay(syntheticInput(chargedBody(requestId), requestId), failureObservation(), {
    kv,
    keyBytes,
    now: () => nowMs,
    randomUuid: () => `capture-${requestId}`,
    budgetBytes,
  });

const firstManifestKey = async (kv: Deno.Kv): Promise<Deno.KvKey | null> => {
  for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_MANIFEST_PREFIX })) return entry.key;
  return null;
};

Deno.test({
  name: "the injectable budget seam governs the production default path for admission and eviction",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    const now = 1_700_000_000_000;
    const store = (requestId: string, at: number) =>
      persistEncryptedSentinelReplay(syntheticInput(chargedBody(requestId), requestId), failureObservation(), {
        kv,
        keyBytes,
        now: () => at,
        randomUuid: () => `capture-${requestId}`,
        // No budget override anywhere: the seam is the production default path.
      });
    setSentinelReplayBudgetForTest(HEADROOM_BUDGET_BYTES);
    try {
      assert.equal((await store("seam-oldest", now)).status, "stored");
      const seeded = await readSentinelReplayRetentionStatus(kv);
      assert.equal(seeded.budget_bytes, HEADROOM_BUDGET_BYTES, "the seam value is the live budget, not a hard-coded GiB");
      assert.equal(seeded.records, 1);
      assert.equal(seeded.evicted_records, 0, "the first capture fits with no eviction");

      // Tighten the live budget below stored + the next reservation's lower
      // bound, so the next admission must evict the oldest capture instead of
      // refusing or overshooting.
      const tightBudget = (seeded.stored_bytes ?? 0) + sentinelReplayReservationBytes(chargedBody("seam-newest").byteLength + 4, 0) - 1;
      assert.equal(tightBudget > MIN_TEST_BUDGET_BYTES, true);
      setSentinelReplayBudgetForTest(tightBudget);

      assert.equal((await store("seam-newest", now + 1)).status, "stored", "bounded cleanup admits the newest capture");
      const after = await readSentinelReplayRetentionStatus(kv);
      assert.equal(after.budget_bytes, tightBudget);
      assert.equal((after.evicted_records ?? 0) >= 1, true, "the oldest capture was evicted");
      assert.equal(storedPlusReserved(after) <= tightBudget, true, "the live budget still holds");
      assert.equal(after.reserved_bytes, 0, "no reservation may leak after publication");
      assert.equal((await readSentinelReplayCaptureStatus(kv, "seam-oldest", now + 1)).status, "evicted");
      assert.equal((await readSentinelReplayCaptureStatus(kv, "seam-newest", now + 1)).status, "incomplete");
    } finally {
      setSentinelReplayBudgetForTest(null);
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "oldest capture is evicted first and its owner lookup reports evicted, not ready",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    try {
      const first = await persist(kv, keyBytes, "retention-oldest", HEADROOM_BUDGET_BYTES, 1_700_000_000_000);
      assert.equal(first.status, "stored");
      const seeded = await runSentinelReplayRetentionMaintenance(kv, { now_ms: 1_700_000_000_500, budget_bytes: HEADROOM_BUDGET_BYTES });
      assert.equal(seeded.state, "ok");
      assert.equal(seeded.evicted_records, 0, "prepopulation must evict nothing");
      assert.equal(seeded.records, 1);
      assert.equal(seeded.reserved_bytes, 0);
      // The next admission must cross this budget: stored so far plus a lower
      // bound of the next reservation, minus one byte.
      const secondBody = chargedBody("retention-newest");
      const tightBudget = (seeded.stored_bytes ?? 0) + sentinelReplayReservationBytes(secondBody.byteLength + 4, 0) - 1;
      assert.equal(tightBudget > MIN_TEST_BUDGET_BYTES, true);

      const second = await persist(kv, keyBytes, "retention-newest", tightBudget, 1_700_000_001_000);
      assert.equal(second.status, "stored", "the newest capture must be admitted after bounded cleanup");

      const oldest = await readSentinelReplayCaptureStatus(kv, "retention-oldest", 1_700_000_001_000);
      assert.equal(oldest.status, "evicted");
      assert.equal(oldest.reason, SENTINEL_REPLAY_EVICTION_REASON);
      const oldestExport = await listEncryptedSentinelReplaysByRequestId(kv, "retention-oldest", 1_700_000_001_000);
      assert.deepEqual(oldestExport.captures, []);
      assert.equal(oldestExport.status.status, "evicted");
      assert.equal(oldestExport.status.reason, SENTINEL_REPLAY_EVICTION_REASON);

      const newest = await listEncryptedSentinelReplaysByRequestId(kv, "retention-newest", 1_700_000_001_000);
      assert.equal(newest.captures.length, 1);
      // This fixture sends no recorded upstream trace on a 502, so the capture is
      // truthfully partial. `limits.test.ts` covers the full-coverage `ready` path.
      assert.equal(newest.status.status, "incomplete");
      assert.equal(newest.status.reason, null);
      const plaintext = await decryptExportedSentinelReplay(newest.captures[0], keyBytes);
      assert.deepEqual([...plaintext.body], [...secondBody]);

      const retention = await runSentinelReplayRetentionMaintenance(kv, { now_ms: 1_700_000_002_000, budget_bytes: tightBudget });
      assert.equal(retention.state, "ok");
      assert.equal(storedPlusReserved(retention) <= tightBudget, true);
      assert.equal(retention.reserved_bytes, 0, "no reservation may leak after publication");
      assert.equal((retention.evicted_records ?? 0) >= 1, true);
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "a duplicate status row uses the winning manifest's actual expiry",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    try {
      const body = chargedBody("duplicate-winner");
      // The conservative reservation bound of one capture admits the winner
      // without eviction; no guessed constant is involved.
      const budgetBytes = reservationBound(body);
      const first = await persistEncryptedSentinelReplay(syntheticInput(body, "duplicate-winner"), failureObservation(), {
        kv,
        keyBytes,
        now: () => 1_700_000_000_000,
        randomUuid: () => "capture-duplicate-winner",
        budgetBytes,
      });
      assert.equal(first.status, "stored");
      assert.equal(first.manifest.expires_at_ms, 1_700_000_000_000 + SENTINEL_REPLAY_TTL_MS);
      const second = await persistEncryptedSentinelReplay(syntheticInput(body, "duplicate-alias"), failureObservation(), {
        kv,
        keyBytes,
        now: () => 1_700_000_500_000,
        randomUuid: () => "capture-duplicate-alias",
        budgetBytes,
      });
      assert.equal(second.status, "duplicate");
      const alias = await readSentinelReplayCaptureStatus(kv, "duplicate-alias", 1_700_000_500_000);
      assert.equal(alias.status, "incomplete", "the alias mirrors the winner's coverage, not a made-up ready");
      assert.equal(alias.expires_at_ms, first.manifest.expires_at_ms, "the alias must inherit the winner's expiry, never now + TTL");
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "the same failure re-captures after its capture was evicted",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    try {
      assert.equal((await persist(kv, keyBytes, "recapture-a", HEADROOM_BUDGET_BYTES, 1_700_000_000_000)).status, "stored");
      const seeded = await runSentinelReplayRetentionMaintenance(kv, { now_ms: 1_700_000_000_500, budget_bytes: HEADROOM_BUDGET_BYTES });
      assert.equal(seeded.evicted_records, 0, "prepopulation must evict nothing");
      const bodyB = chargedBody("recapture-b");
      const tightBudget = (seeded.stored_bytes ?? 0) + sentinelReplayReservationBytes(bodyB.byteLength + 4, 0) - 1;
      assert.equal((await persist(kv, keyBytes, "recapture-b", tightBudget, 1_700_000_001_000)).status, "stored");
      assert.equal((await readSentinelReplayCaptureStatus(kv, "recapture-a", 1_700_000_001_000)).status, "evicted");
      const recaptured = await persist(kv, keyBytes, "recapture-a", tightBudget, 1_700_000_002_000);
      assert.equal(recaptured.status, "stored", "a stale dedupe row must not alias evicted evidence");
      assert.equal((await readSentinelReplayCaptureStatus(kv, "recapture-a", 1_700_000_002_000)).status, "incomplete");
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "concurrent arrivals never overshoot the budget and leave no reservation",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    // Two concurrent arrivals under a budget that can admit both sequentially
    // but not both at once: at least one must succeed without overshooting.
    const bodyA = chargedBody("concurrent-a");
    const bodyB = chargedBody("concurrent-b");
    const budgetBytes = sentinelReplayReservationBytes(bodyA.byteLength + 4, 0) + sentinelReplayReservationBytes(bodyB.byteLength + 4, 0);
    try {
      const results = await Promise.all([
        persist(kv, keyBytes, "concurrent-a", budgetBytes, 1_700_000_000_000),
        persist(kv, keyBytes, "concurrent-b", budgetBytes, 1_700_000_000_100),
      ]);
      for (const result of results) {
        assert.equal(["stored", "duplicate", "incomplete"].includes(result.status), true, result.status);
      }
      assert.equal(
        results.some((result) => result.status === "stored" || result.status === "duplicate"),
        true
      );
      const retention = await runSentinelReplayRetentionMaintenance(kv, { now_ms: 1_700_000_001_000, budget_bytes: budgetBytes });
      assert.equal(retention.state, "ok");
      assert.equal(storedPlusReserved(retention) <= budgetBytes, true);
      assert.equal(retention.reserved_bytes, 0);
      // An unrelated namespace must survive every eviction path untouched.
      await kv.set(["ubq_ai", "api_keys", "id", "retention-unrelated"], { preserved: true });
      await persist(kv, keyBytes, "concurrent-c", budgetBytes, 1_700_000_002_000);
      const unrelated = await kv.get(["ubq_ai", "api_keys", "id", "retention-unrelated"]);
      assert.deepEqual(unrelated.value, { preserved: true });
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "pre-existing legacy manifests are bootstrapped into the budget, never treated as zero",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    try {
      const capturedAtMs = 1_700_000_000_000;
      const legacy: SentinelReplayManifest = {
        version: 1,
        capture_id: "legacy-capture",
        fingerprint: "b".repeat(64),
        case_group_digest: "c".repeat(64),
        captured_at_ms: capturedAtMs,
        expires_at_ms: capturedAtMs + SENTINEL_REPLAY_TTL_MS,
        algorithm: "AES-256-GCM",
        compression: "gzip",
        iv: base64UrlEncode(new Uint8Array(12)),
        chunk_count: 1,
        ciphertext_bytes: 100,
      };
      await kv.set([...SENTINEL_REPLAY_MANIFEST_PREFIX, capturedAtMs, legacy.fingerprint, legacy.capture_id], legacy);
      await kv.set([...SENTINEL_REPLAY_CHUNK_PREFIX, legacy.capture_id, 0], new Uint8Array(legacy.ciphertext_bytes));
      const retained = await runSentinelReplayRetentionMaintenance(kv, { now_ms: capturedAtMs + 1_000, budget_bytes: SENTINEL_REPLAY_BUDGET_BYTES });
      assert.equal(retained.state, "ok");
      assert.equal(retained.accounting_complete, true);
      assert.equal((retained.stored_bytes ?? 0) > 0, true, "legacy retained bytes must be accounted, not assumed zero");
      assert.equal(retained.records, 1);
      assert.equal((await firstManifestKey(kv)) !== null, true);
      const accountingKey = sentinelReplayAccountingKey(capturedAtMs, legacy.capture_id);
      const accounting = await kv.get<SentinelReplayAccountingRow>(accountingKey);
      assert.equal(accounting.value?.state, "stored", "a legacy charge must have a durable owner that reclamation can select");
      assert.equal(accounting.value.bytes, sentinelReplayManifestCharge(legacy));
      assert.equal(accounting.value.request_id, "", "an absent legacy owner must not become an invented request id");
      assert.equal(accounting.value.expires_at_ms, legacy.expires_at_ms);

      const expired = await reclaimExpiredSentinelReplays(kv, { now_ms: legacy.expires_at_ms + 1, budget_bytes: SENTINEL_REPLAY_BUDGET_BYTES });
      assert.equal(expired.records, 1);
      assert.equal((await kv.get(accountingKey)).value, null);
      assert.equal((await kv.get([...SENTINEL_REPLAY_CHUNK_PREFIX, legacy.capture_id, 0])).value, null);
      assert.equal(await firstManifestKey(kv), null);
      assert.equal((await kv.get(sentinelReplayRequestStatusKey(""))).value, null, "ownerless cleanup must not write an empty request status");
      const released = await runSentinelReplayRetentionMaintenance(kv, { now_ms: legacy.expires_at_ms + 2, budget_bytes: SENTINEL_REPLAY_BUDGET_BYTES });
      assert.equal(released.stored_bytes, 0);
      assert.equal(released.records, 0);
      assert.equal(released.expired_records, 1);
      assert.equal(released.evicted_records, 0);
      assert.equal(released.status_records, 1, "only the fingerprint tombstone is retained without a request owner");
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "a storage_full refusal keeps the newest failure discoverable and never stores unaccounted bytes",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    // The retention clamp's minimum injectable budget is exactly 64 KiB, which
    // is below one capture's reserved capacity, so admission must refuse.
    const budgetBytes = MIN_TEST_BUDGET_BYTES;
    try {
      const result = await persistEncryptedSentinelReplay(
        syntheticInput(encoder.encode(JSON.stringify({ model: "gpt-5.6-sol", input: "y".repeat(200 * 1_024) })), "too-large-for-budget"),
        failureObservation(),
        { kv, keyBytes, now: () => 1_700_000_000_000, randomUuid: () => "capture-too-large", budgetBytes }
      );
      assert.equal(result.status, "incomplete");
      assert.equal(result.reason, SENTINEL_REPLAY_STORAGE_FULL_REASON);
      const status = await readSentinelReplayCaptureStatus(kv, "too-large-for-budget");
      assert.equal(status.status, "unknown", "the raw persist path does not invent a status row; the environment wrapper does");
      const chunks: Deno.KvKey[] = [];
      for await (const entry of kv.list({ prefix: ["uos_ai", "sentinel_replay", "v1", "chunk"] })) chunks.push(entry.key);
      assert.equal(chunks.length, 0, "a refused capture must not leave staged chunks");
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

// ---------------------------------------------------------------------------
// Accounting-row regressions: fencing, exactly-once eviction, bounded cleanup,
// TTL reclamation, dedupe provenance, the metadata bound and fail-closed
// bootstrap. Every case uses an in-memory KV, synthetic bytes and an injectable
// small budget or reserve; no GiB corpus, paid inference or live host.
// ---------------------------------------------------------------------------

const TEST_BUDGET_BYTES = 4 * 1_024 * 1_024;

const fingerprintFor = (tag: string): string => {
  let out = "";
  for (const char of tag) out += (char.charCodeAt(0) % 16).toString(16);
  return `${out}${"0".repeat(64)}`.slice(0, 64);
};

const admitForTest = async (kv: Deno.Kv, captureId: string, nowMs: number, budgetBytes = TEST_BUDGET_BYTES, plaintextBytes = 1_024) =>
  await reserveSentinelReplayCapacity(kv, {
    capture_id: captureId,
    request_id: captureId,
    fingerprint: fingerprintFor(captureId),
    plaintext_bytes: plaintextBytes,
    metadata_bytes: 0,
    now_ms: nowMs,
    budget_bytes: budgetBytes,
  });

const writeChunkRows = async (kv: Deno.Kv, captureId: string, count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await kv.set([...SENTINEL_REPLAY_CHUNK_PREFIX, captureId, index], new Uint8Array([index % 256]), { expireIn: SENTINEL_REPLAY_TTL_MS });
  }
};

const countChunkRows = async (kv: Deno.Kv, captureId: string): Promise<number> => {
  const prefix = [...SENTINEL_REPLAY_CHUNK_PREFIX, captureId];
  let count = 0;
  for await (const entry of kv.list({ prefix })) {
    // Count only rows that really sit under this capture's chunk prefix, so the
    // survival checks can never be satisfied by an unrelated stray key.
    if (entry.key.length === prefix.length + 1) count += 1;
  }
  return count;
};

const ledgerOf = async (kv: Deno.Kv, budgetBytes = TEST_BUDGET_BYTES) => {
  const snapshot = await readSentinelReplayLedgerSnapshot(kv, budgetBytes);
  assert.notEqual(snapshot, null, "the ledger must be readable");
  if (!snapshot) throw new Error("unreachable");
  return snapshot.ledger;
};

const accountingRowOf = async (kv: Deno.Kv, key: Deno.KvKey): Promise<SentinelReplayAccountingRow | null> =>
  (await kv.get<SentinelReplayAccountingRow>(key)).value;

Deno.test({
  name: "two eviction callers racing for the same victim evict it exactly once and hold no charge",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    const now = 1_700_100_000_000;
    try {
      const stored = await persist(kv, keyBytes, "race-victim", HEADROOM_BUDGET_BYTES, now);
      assert.equal(stored.status, "stored");
      const charge = stored.manifest.stored_bytes ?? 0;
      assert.equal(charge > 0, true);
      assert.equal((await countChunkRows(kv, "capture-race-victim")) > 0, true);

      const [first, second] = await Promise.all([
        evictSentinelReplays(kv, { target_bytes: 0, now_ms: now + 1_000, budget_bytes: HEADROOM_BUDGET_BYTES }),
        evictSentinelReplays(kv, { target_bytes: 0, now_ms: now + 1_001, budget_bytes: HEADROOM_BUDGET_BYTES }),
      ]);
      assert.equal(first.records + second.records, 1, "exactly one caller may win the eviction claim");
      // Actual remaining payload rows, not the ledger alone.
      assert.equal(await countChunkRows(kv, "capture-race-victim"), 0);
      const ledger = await ledgerOf(kv, HEADROOM_BUDGET_BYTES);
      assert.equal(ledger.stored_bytes, 0, "the charge is released exactly once");
      assert.equal(ledger.reserved_bytes, 0);
      assert.equal(ledger.records, 0);
      assert.equal(ledger.evicted_records, 1);
      assert.equal(ledger.evicted_bytes, charge);
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "a writer paused between batches cannot advance its fence or publish after a revoke",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const now = 1_700_200_000_000;
    try {
      const admission = await admitForTest(kv, "paused-writer", now);
      assert.equal(admission.ok, true);
      const key = admission.accounting_key;
      const fence = admission.accounting.fence;

      const firstAdvance = await advanceSentinelReplayStagingFence(kv, { accounting_key: key, fence, now_ms: now, budget_bytes: TEST_BUDGET_BYTES });
      assert.equal(firstAdvance.ok, true);
      assert.equal(firstAdvance.stage, 1);
      assert.equal(firstAdvance.versionstamp, (await kv.get(key)).versionstamp);
      await writeChunkRows(kv, "paused-writer", 2);

      // The reaper fences the paused writer off. One bounded pass leaves a chunk
      // behind, so the revoked row keeps its charge.
      const revoked = await abandonSentinelReplayAccounting(kv, admission.accounting, key, {
        now_ms: now,
        budget_bytes: TEST_BUDGET_BYTES,
        max_chunk_deletes: 1,
      });
      assert.equal(revoked.revoked, true);
      assert.equal(revoked.released, false, "a partial deletion must hold the charge");
      assert.equal((await ledgerOf(kv)).reserved_bytes, admission.charge);

      // The writer resumes: its fence is stale, so it may not stage or publish.
      const resumed = await advanceSentinelReplayStagingFence(kv, { accounting_key: key, fence, now_ms: now, budget_bytes: TEST_BUDGET_BYTES });
      assert.equal(resumed.ok, false);
      assert.deepEqual(resumed, { ok: false, reason: "revoked" });
      const publication = await prepareSentinelReplayPublication(kv, admission.accounting, key, 1_000, {
        now_ms: now,
        lease_now_ms: now,
        status_key: sentinelReplayRequestStatusKey("paused-writer"),
        budget_bytes: TEST_BUDGET_BYTES,
      });
      assert.equal(publication, null, "a revoked writer can never publish");

      // The resumed cleanup pass converges and releases exactly once.
      const current = await accountingRowOf(kv, key);
      assert.notEqual(current, null);
      if (!current) throw new Error("unreachable");
      const resumedCleanup = await abandonSentinelReplayAccounting(kv, current, key, { now_ms: now, budget_bytes: TEST_BUDGET_BYTES, max_chunk_deletes: 512 });
      assert.equal(resumedCleanup.released, true);
      assert.equal(await countChunkRows(kv, "paused-writer"), 0);
      assert.equal((await ledgerOf(kv)).reserved_bytes, 0);
      assert.equal(await accountingRowOf(kv, key), null);
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "more than 512 chunks are cleaned across bounded passes with the charge held until empty",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const now = 1_700_250_000_000;
    try {
      const admission = await admitForTest(kv, "bounded-cleanup", now);
      assert.equal(admission.ok, true);
      const key = admission.accounting_key;
      await writeChunkRows(kv, "bounded-cleanup", 600);

      const first = await abandonSentinelReplayAccounting(kv, admission.accounting, key, {
        now_ms: now,
        budget_bytes: TEST_BUDGET_BYTES,
        max_chunk_deletes: 512,
      });
      assert.equal(first.revoked, true);
      assert.equal(first.deleted_chunks, 512);
      assert.equal(first.released, false, "the charge is held until the prefix is empty");
      assert.equal(await countChunkRows(kv, "bounded-cleanup"), 88);
      assert.equal((await ledgerOf(kv)).reserved_bytes, admission.charge);

      const current = await accountingRowOf(kv, key);
      assert.notEqual(current, null);
      if (!current) throw new Error("unreachable");
      const second = await abandonSentinelReplayAccounting(kv, current, key, { now_ms: now, budget_bytes: TEST_BUDGET_BYTES, max_chunk_deletes: 512 });
      assert.equal(second.released, true);
      assert.equal(await countChunkRows(kv, "bounded-cleanup"), 0);
      assert.equal((await ledgerOf(kv)).reserved_bytes, 0);
      assert.equal(await accountingRowOf(kv, key), null, "the accounting row stops existing only when its charge is released");
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "an injected delete and commit failure each converge through a restart-style continuation",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const now = 1_700_300_000_000;
    try {
      // Phase 1: a payload delete fails mid-cleanup.
      const deleteVictim = await admitForTest(kv, "faulty-delete", now);
      assert.equal(deleteVictim.ok, true);
      await writeChunkRows(kv, "faulty-delete", 3);
      let deleteFailures = 1;
      setSentinelReplayRetentionFaultsForTest((kind) => {
        if (kind === "delete" && deleteFailures > 0) {
          deleteFailures -= 1;
          return true;
        }
        return false;
      });
      await assert.rejects(() =>
        abandonSentinelReplayAccounting(kv, deleteVictim.accounting, deleteVictim.accounting_key, { now_ms: now, budget_bytes: TEST_BUDGET_BYTES })
      );
      setSentinelReplayRetentionFaultsForTest(null);
      const afterDeleteFailure = await accountingRowOf(kv, deleteVictim.accounting_key);
      assert.equal(afterDeleteFailure?.state, "revoked");
      assert.equal((await ledgerOf(kv)).reserved_bytes, deleteVictim.charge, "the charge is held while chunks survive");
      assert.equal(await countChunkRows(kv, "faulty-delete"), 3);
      const deleteRecovery = await abandonSentinelReplayAccounting(kv, afterDeleteFailure, deleteVictim.accounting_key, {
        now_ms: now,
        budget_bytes: TEST_BUDGET_BYTES,
      });
      assert.equal(deleteRecovery.released, true, "a restart-style continuation converges");
      assert.equal(await countChunkRows(kv, "faulty-delete"), 0);

      // Phase 2: the release commit itself fails after the payload is gone.
      const commitVictim = await admitForTest(kv, "faulty-commit", now);
      assert.equal(commitVictim.ok, true);
      await writeChunkRows(kv, "faulty-commit", 2);
      let commitFailures = 1;
      setSentinelReplayRetentionFaultsForTest((kind) => {
        if (kind === "commit" && commitFailures > 0) {
          commitFailures -= 1;
          return true;
        }
        return false;
      });
      await assert.rejects(() =>
        abandonSentinelReplayAccounting(kv, commitVictim.accounting, commitVictim.accounting_key, { now_ms: now, budget_bytes: TEST_BUDGET_BYTES })
      );
      setSentinelReplayRetentionFaultsForTest(null);
      const afterCommitFailure = await accountingRowOf(kv, commitVictim.accounting_key);
      assert.equal(afterCommitFailure?.state, "revoked");
      assert.equal((await ledgerOf(kv)).reserved_bytes, commitVictim.charge, "no ledger delta is applied without its row change");
      const commitRecovery = await abandonSentinelReplayAccounting(kv, afterCommitFailure, commitVictim.accounting_key, {
        now_ms: now,
        budget_bytes: TEST_BUDGET_BYTES,
      });
      assert.equal(commitRecovery.released, true);
      assert.equal((await ledgerOf(kv)).reserved_bytes, 0);
    } finally {
      setSentinelReplayRetentionFaultsForTest(null);
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "a resumable reaper reaches an expired reservation stranded in the accounting prefix",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const now = 1_700_350_000_000;
    const budgetBytes = 8 * 1_024 * 1_024;
    const middle = 32;
    const keys: Deno.KvKey[] = [];
    let totalCharge = 0;
    try {
      for (let index = 0; index < middle * 2 + 1; index += 1) {
        const admission = await admitForTest(kv, `reap-stranded-${index}`, now + index, budgetBytes);
        assert.equal(admission.ok, true);
        keys.push(admission.accounting_key);
        totalCharge += admission.charge;
      }
      await kv.delete(["uos_ai", "sentinel_replay", "v1", "reap_cursor"]);
      const stranded = await accountingRowOf(kv, keys[middle]);
      assert.notEqual(stranded, null);
      if (!stranded) throw new Error("unreachable");
      const maintenanceNow = stranded.expires_at_ms + 1;
      for (let index = 0; index < keys.length; index += 1) {
        if (index === middle) continue;
        const row = await accountingRowOf(kv, keys[index]);
        assert.notEqual(row, null);
        if (!row) throw new Error("unreachable");
        await kv.set(keys[index], { ...row, state: "stored", expires_at_ms: maintenanceNow + 1 });
      }
      const ledger = await ledgerOf(kv, budgetBytes);
      await kv.set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, {
        ...ledger,
        stored_bytes: totalCharge - stranded.bytes,
        reserved_bytes: stranded.bytes,
        records: keys.length - 1,
      });

      await runSentinelReplayRetentionMaintenance(kv, { now_ms: maintenanceNow, budget_bytes: budgetBytes });
      assert.notEqual(await accountingRowOf(kv, keys[middle]), null, "the first bounded page stops before the stranded row");
      await runSentinelReplayRetentionMaintenance(kv, { now_ms: maintenanceNow, budget_bytes: budgetBytes });
      assert.equal(await accountingRowOf(kv, keys[middle]), null, "the cursor reaches the middle on the next pass");
      const after = await ledgerOf(kv, budgetBytes);
      assert.equal(after.stored_bytes, totalCharge - stranded.bytes);
      assert.equal(after.reserved_bytes, 0);
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "an expired payload is reclaimed exactly once as expired, never as evicted",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    const now = 1_700_400_000_000;
    try {
      const stored = await persist(kv, keyBytes, "expiry-reclaim", HEADROOM_BUDGET_BYTES, now);
      assert.equal(stored.status, "stored");
      const charge = stored.manifest.stored_bytes ?? 0;
      const expiredAt = now + SENTINEL_REPLAY_TTL_MS + 1;

      const reclaimed = await reclaimExpiredSentinelReplays(kv, { now_ms: expiredAt, budget_bytes: HEADROOM_BUDGET_BYTES });
      assert.equal(reclaimed.records, 1);
      assert.equal(reclaimed.bytes, charge);
      const again = await reclaimExpiredSentinelReplays(kv, { now_ms: expiredAt, budget_bytes: HEADROOM_BUDGET_BYTES });
      assert.equal(again.records, 0, "reclamation is exactly once");

      const ledger = await ledgerOf(kv, HEADROOM_BUDGET_BYTES);
      assert.equal(ledger.stored_bytes, 0);
      assert.equal(ledger.records, 0);
      assert.equal(ledger.expired_records, 1, "expiry is not an eviction");
      assert.equal(ledger.expired_bytes, charge);
      assert.equal(ledger.evicted_records, 0);
      assert.equal(ledger.evicted_bytes, 0);

      const status = await readSentinelReplayCaptureStatus(kv, "expiry-reclaim", expiredAt);
      assert.equal(status.status, "expired");
      assert.equal(status.reason, SENTINEL_REPLAY_EXPIRED_REASON);
      assert.equal(await countChunkRows(kv, "capture-expiry-reclaim"), 0);
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "a stale eviction cannot delete a newer dedupe row for the same fingerprint",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    const now = 1_700_500_000_000;
    try {
      const stored = await persist(kv, keyBytes, "dedupe-victim", HEADROOM_BUDGET_BYTES, now);
      assert.equal(stored.status, "stored");
      const manifest = stored.manifest;
      const dedupeKey = [...SENTINEL_REPLAY_DEDUPE_PREFIX, manifest.fingerprint];
      const newerManifestKey = [...SENTINEL_REPLAY_MANIFEST_PREFIX, now + 60_000, manifest.fingerprint, "newer-capture"];
      // A newer capture with the same fingerprint now owns the dedupe row.
      await kv.set(
        dedupeKey,
        { manifest_key: newerManifestKey, captured_at_ms: now + 60_000, expires_at_ms: now + 60_000 + SENTINEL_REPLAY_TTL_MS },
        { expireIn: SENTINEL_REPLAY_TTL_MS }
      );

      const evicted = await evictSentinelReplays(kv, { target_bytes: 0, now_ms: now + 120_000, budget_bytes: HEADROOM_BUDGET_BYTES });
      assert.equal(evicted.records, 1);
      const surviving = await kv.get<{ manifest_key?: unknown }>(dedupeKey);
      assert.notEqual(surviving.value, null, "the newer owner's dedupe row must survive");
      assert.deepEqual(surviving.value?.manifest_key, newerManifestKey);
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

const absentManifestCases = ["matching", "newer", "raced", "malformed", "stored-null", "mismatched", "manifest-read", "dedupe-read"] as const;

type DedupeCommitObservation = {
  key: Deno.KvKey;
  checks: Deno.AtomicCheck[];
  deletesDedupe: boolean;
  afterCommit: (checks: readonly Deno.AtomicCheck[], result: Deno.KvCommitResult | Deno.KvCommitError) => void;
};

const observeDedupeAtomic = (operation: Deno.AtomicOperation, observation: DedupeCommitObservation): Deno.AtomicOperation =>
  new Proxy(operation, {
    get(atomic, method) {
      if (method === "commit") {
        return async () => {
          const result = await atomic.commit();
          if (observation.deletesDedupe) observation.afterCommit(observation.checks, result);
          return result;
        };
      }
      const value = Reflect.get(atomic, method, atomic);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (method === "check") observation.checks.push(...(args as Deno.AtomicCheck[]));
        if (method === "delete" && Array.isArray(args[0]) && args[0].join("\u0000") === observation.key.join("\u0000")) observation.deletesDedupe = true;
        return observeDedupeAtomic(Reflect.apply(value, atomic, args) as Deno.AtomicOperation, observation);
      };
    },
  });

for (const scenario of absentManifestCases) {
  Deno.test({
    name: `claimed payload cleanup preserves provenance after manifest loss: ${scenario}`,
    ignore: !kvAvailable,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const kv = await Deno.openKv(":memory:");
      const now = 1_700_550_000_000;
      const requestId = `absent-manifest-${scenario}`;
      try {
        const stored = await persist(kv, newKey(), requestId, HEADROOM_BUDGET_BYTES, now);
        assert.equal(stored.status, "stored");
        const manifestKey = await firstManifestKey(kv);
        assert.notEqual(manifestKey, null);
        if (manifestKey === null) throw new Error("stored capture has no manifest");
        const manifest = stored.manifest;
        const dedupeKey = [...SENTINEL_REPLAY_DEDUPE_PREFIX, manifest.fingerprint];
        const accountingKey = sentinelReplayAccountingKey(now, manifest.capture_id);
        const originalDedupe = await kv.get(dedupeKey);
        assert.deepEqual(originalDedupe.value, {
          manifest_key: manifestKey,
          captured_at_ms: now,
          expires_at_ms: manifest.expires_at_ms,
        });
        assert.equal((await countChunkRows(kv, manifest.capture_id)) > 1, true);
        const partial = await evictSentinelReplays(kv, {
          target_bytes: 0,
          max_chunk_deletes: 1,
          now_ms: now + 1,
          budget_bytes: HEADROOM_BUDGET_BYTES,
        });
        assert.equal(partial.records, 0);
        assert.equal((await accountingRowOf(kv, accountingKey))?.state, "evicting");
        const charged = await ledgerOf(kv, HEADROOM_BUDGET_BYTES);
        assert.equal(charged.stored_bytes, manifest.stored_bytes);
        // Model native TTL/manual loss of only the manifest after the durable claim.
        await kv.delete(manifestKey);
        assert.equal((await kv.get(manifestKey)).versionstamp, null);
        const replacement = {
          manifest_key: [...SENTINEL_REPLAY_MANIFEST_PREFIX, now + 60_000, manifest.fingerprint, "newer-capture"],
          captured_at_ms: now + 60_000,
          expires_at_ms: manifest.expires_at_ms + 60_000,
        };
        if (scenario === "newer") await kv.set(dedupeKey, replacement);
        if (scenario === "malformed") await kv.set(manifestKey, { not: "a manifest" });
        if (scenario === "stored-null") await kv.set(manifestKey, null);
        if (scenario === "mismatched") await kv.set(manifestKey, { ...manifest, capture_id: "other-capture" });
        const presentManifest = await kv.get(manifestKey);
        const nativeChecks: Deno.AtomicCheck[] = [];
        const nativeOutcomes: boolean[] = [];
        let interleaved = false;
        const wrapped = new Proxy(kv, {
          get(target, property) {
            if (property === "get") {
              return async (key: Deno.KvKey, options?: { consistency?: Deno.KvConsistencyLevel }) => {
                const entry = await target.get(key, options);
                const isManifest = key.join("\u0000") === manifestKey.join("\u0000");
                const isDedupe = key.join("\u0000") === dedupeKey.join("\u0000");
                if ((scenario === "manifest-read" && isManifest) || (scenario === "dedupe-read" && isDedupe)) throw new Error("synthetic cleanup read failure");
                if (scenario === "raced" && isDedupe && !interleaved) {
                  interleaved = true;
                  await kv.set(dedupeKey, replacement);
                  assert.notEqual((await kv.get(dedupeKey)).versionstamp, entry.versionstamp);
                }
                return entry;
              };
            }
            if (property === "atomic") {
              return () =>
                observeDedupeAtomic(target.atomic(), {
                  key: dedupeKey,
                  checks: [],
                  deletesDedupe: false,
                  afterCommit: (checks, result) => {
                    nativeChecks.push(...checks);
                    nativeOutcomes.push(result.ok);
                  },
                });
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const maintenance = { now_ms: now + 2, budget_bytes: HEADROOM_BUDGET_BYTES };
        if (scenario === "manifest-read" || scenario === "dedupe-read") {
          await assert.rejects(() => runSentinelReplayRetentionMaintenance(wrapped, maintenance), /synthetic cleanup read failure/);
          assert.deepEqual(await ledgerOf(kv, HEADROOM_BUDGET_BYTES), charged, "failed reads must retain the entire charge");
          assert.equal((await accountingRowOf(kv, accountingKey))?.state, "evicting");
          assert.deepEqual(await kv.get(dedupeKey), originalDedupe);
          await runSentinelReplayRetentionMaintenance(kv, maintenance);
        } else {
          await runSentinelReplayRetentionMaintenance(wrapped, maintenance);
        }
        const newer = scenario === "newer" || scenario === "raced";
        const present = scenario === "malformed" || scenario === "stored-null" || scenario === "mismatched";
        const afterDedupe = await kv.get(dedupeKey);
        const existingDedupe = present ? originalDedupe.value : null;
        assert.deepEqual(afterDedupe.value, newer ? replacement : existingDedupe);
        assert.deepEqual(await kv.get(manifestKey), presentManifest, "present malformed or mismatched manifests must survive unchanged");
        if (scenario === "matching" || scenario === "raced") {
          assert.deepEqual(nativeChecks, [{ key: dedupeKey, versionstamp: originalDedupe.versionstamp }]);
          assert.deepEqual(nativeOutcomes, [scenario === "matching"], "native CAS rejects a dedupe overwrite after its read");
          assert.equal(interleaved, scenario === "raced");
        } else {
          assert.deepEqual(nativeOutcomes, []);
        }
        assert.equal(await countChunkRows(kv, manifest.capture_id), 0);
        assert.equal(await accountingRowOf(kv, accountingKey), null);
        const released = await ledgerOf(kv, HEADROOM_BUDGET_BYTES);
        assert.equal(released.stored_bytes, 0);
        assert.equal(released.records, 0);
        assert.equal(released.evicted_bytes, manifest.stored_bytes);
        assert.equal(released.evicted_records, 1);
        if (!present) {
          await runSentinelReplayRetentionMaintenance(kv, maintenance);
          assert.deepEqual(await ledgerOf(kv, HEADROOM_BUDGET_BYTES), released, "continuation must release and count the victim only once");
          assert.deepEqual(await kv.get(dedupeKey), afterDedupe);
        }
      } finally {
        kv.close();
      }
    },
  });
}

Deno.test({
  name: "status and tombstone pressure is pruned at the metadata reserve and reports not-retained",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const budgetBytes = 1 * 1_024 * 1_024;
    const reserve = Math.floor(budgetBytes / 16);
    const now = 1_700_600_000_000;
    try {
      for (let index = 0; index < 12; index += 1) {
        const row = {
          version: 1,
          request_id: `pressure-${index}`,
          status: "disabled",
          reason: "retention_pressure",
          captured_at_ms: now + index,
          manifest_key: null,
          fingerprint: null,
          expires_at_ms: null,
        };
        await admitSentinelReplayStatusMetadata(kv, {
          key: [...SENTINEL_REPLAY_REQUEST_PREFIX, row.request_id],
          row,
          now_ms: now + index,
          ttl_ms: SENTINEL_REPLAY_TTL_MS,
          budget_bytes: budgetBytes,
        });
      }
      // An eviction tombstone shares the same bounded metadata namespace.
      await kv.set([...SENTINEL_REPLAY_EVICTION_PREFIX, fingerprintFor("tombstone")], {
        version: 1,
        fingerprint: fingerprintFor("tombstone"),
        request_id: "pressure-tombstone",
        evicted_at_ms: now - 1_000,
        reason: SENTINEL_REPLAY_EVICTION_REASON,
      });

      const ledger = await ledgerOf(kv, budgetBytes);
      assert.equal(ledger.metadata_bytes <= reserve, true, "capture-owned status metadata must stay inside the reserve");
      assert.equal(ledger.status_records < 12, true);
      assert.equal(ledger.status_pruned_records >= 1, true);
      assert.equal((await readSentinelReplayCaptureStatus(kv, "pressure-0")).status, SENTINEL_REPLAY_STATUS_NOT_RETAINED);
      assert.equal((await readSentinelReplayCaptureStatus(kv, "pressure-11")).status, "disabled", "the newest row survives");
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "status pruning selects the oldest timestamp beyond the key-order scan",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    const budgetBytes = 64 * 1_024;
    const now = 1_700_600_000_000;
    const oldestRequestId = "zzzz-oldest";
    const newestRequestId = "request-000";
    const statusRow = (requestId: string, capturedAtMs: number) => ({
      version: 1,
      request_id: requestId,
      status: "disabled",
      reason: "retention_pressure",
      captured_at_ms: capturedAtMs,
      manifest_key: null,
      fingerprint: null,
      expires_at_ms: null,
    });
    setKvForTest(kv);
    try {
      await kv.set(sentinelReplayRequestStatusKey(oldestRequestId), statusRow(oldestRequestId, now));
      for (let index = 0; index < 128; index += 1) {
        const requestId = `request-${index.toString().padStart(3, "0")}`;
        await kv.set(sentinelReplayRequestStatusKey(requestId), statusRow(requestId, now + index + 1));
      }
      let maintenance = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now, budget_bytes: budgetBytes });
      for (let pass = 0; pass < 20 && !maintenance.accounting_complete; pass += 1) {
        maintenance = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now, budget_bytes: budgetBytes });
      }
      assert.equal(maintenance.accounting_complete, true);

      assert.equal(await pruneCaptureOwnedStatusMetadata(kv, now, 0, 0, 1, budgetBytes), 1);
      assert.equal((await kv.get(sentinelReplayRequestStatusKey(oldestRequestId))).value, null);
      assert.notEqual((await kv.get(sentinelReplayRequestStatusKey(newestRequestId))).value, null);
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "an invalid in-scope row fails bootstrap closed instead of completing at zero",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const corruptKey = [...SENTINEL_REPLAY_MANIFEST_PREFIX, 1, "f".repeat(64), "corrupt-capture"];
    const now = 1_700_700_000_000;
    try {
      await kv.set(corruptKey, { not: "a manifest" });
      const first = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now, budget_bytes: TEST_BUDGET_BYTES });
      assert.equal(first.accounting_complete, false, "an unaccountable row must never look complete");
      assert.equal(first.accounting_error, "invalid_in_scope_row");
      const refused = await admitForTest(kv, "blocked-by-corrupt", now + 1);
      assert.equal(refused.ok, false);
      assert.deepEqual(refused, { ok: false, reason: SENTINEL_REPLAY_ACCOUNTING_REASON });

      // A later pass resolves it once the corrupt row is gone.
      await kv.delete(corruptKey);
      const second = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now + 2, budget_bytes: TEST_BUDGET_BYTES });
      assert.equal(second.accounting_complete, true);
      assert.equal(second.accounting_error, null);
      const resolved = await admitForTest(kv, "blocked-by-corrupt", now + 3);
      assert.equal(resolved.ok, true);
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test({
  name: "a corrupt ledger fails closed instead of being replaced with an empty ledger",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    const now = 1_700_800_000_000;
    try {
      const corrupt = {
        version: 1,
        budget_bytes: -1,
        stored_bytes: 0,
        reserved_bytes: 0,
        records: 0,
        status_records: 0,
        metadata_bytes: 0,
        evicted_bytes: 0,
        evicted_records: 0,
        expired_bytes: 0,
        expired_records: 0,
        status_pruned_records: 0,
        last_eviction_at_ms: null,
        last_warning_at_ms: null,
        last_full_at_ms: null,
        last_skip_reason: null,
        bootstrap_complete: true,
        bootstrap_cursor: null,
        accounting_error: null,
        over_budget: false,
      };
      await kv.set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, corrupt);
      assert.equal(await readSentinelReplayLedgerSnapshot(kv, TEST_BUDGET_BYTES), null, "a corrupt ledger is reported, never zeroed");

      const status = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now, budget_bytes: TEST_BUDGET_BYTES });
      assert.equal(status.accounting_complete, false);
      assert.equal(status.accounting_error, "ledger_corrupt");
      assert.equal(status.stored_bytes, null, "an unreadable ledger is never reported as zero");

      const refused = await persist(kv, keyBytes, "corrupt-ledger", TEST_BUDGET_BYTES, now + 1);
      assert.equal(refused.status, "incomplete");
      assert.equal(refused.reason, SENTINEL_REPLAY_ACCOUNTING_REASON);

      const preserved = await kv.get<{ budget_bytes?: unknown }>(SENTINEL_REPLAY_BUDGET_LEDGER_KEY);
      assert.equal(preserved.value?.budget_bytes, -1, "the corrupt ledger must not be silently replaced");
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

/**
 * The metadata bound is an admission gate: publication and status admission are
 * both refused once `metadata_bytes` or `status_records` reaches its bound.
 * Counting WRITES instead of live rows inflated those counters on every
 * eviction, expiry and repeated status write, so the gate drifted away from the
 * row set it describes and would eventually refuse every capture while the store
 * was nearly empty.
 */
const liveStatusMetadata = async (kv: Deno.Kv): Promise<Readonly<{ records: number; bytes: number }>> => {
  let records = 0;
  let bytes = 0;
  for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_REQUEST_PREFIX })) {
    if (!isSentinelReplayCaptureStatusRow(entry.value)) continue;
    records += 1;
    bytes += sentinelReplayStatusMetadataBytes(entry.value);
  }
  for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_EVICTION_PREFIX })) {
    if (entry.value === null) continue;
    records += 1;
    bytes += sentinelReplayStatusMetadataBytes(entry.value);
  }
  return { records, bytes };
};

/** The ledger counters must describe the live status/tombstone rows exactly. */
const assertMetadataMatchesRows = async (kv: Deno.Kv, label: string, budgetBytes = TEST_BUDGET_BYTES): Promise<void> => {
  const ledger = await ledgerOf(kv, budgetBytes);
  const live = await liveStatusMetadata(kv);
  assert.deepEqual(
    { status_records: ledger.status_records, metadata_bytes: ledger.metadata_bytes },
    { status_records: live.records, metadata_bytes: live.bytes },
    label
  );
};

Deno.test({
  name: "status and tombstone counters stay row-exact across eviction, expiry and repeated writes",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const keyBytes = newKey();
    const now = 1_700_900_000_000;
    const budgetBytes = HEADROOM_BUDGET_BYTES;
    try {
      // Publishing one capture accounts exactly its own status row.
      const stored = await persist(kv, keyBytes, "row-exact-victim", budgetBytes, now);
      assert.equal(stored.status, "stored");
      await assertMetadataMatchesRows(kv, "after publish", budgetBytes);

      // Eviction deletes that status row and writes a replacement plus a
      // tombstone: the counters move by the net difference, not by a whole row.
      const evicted = await evictSentinelReplays(kv, { target_bytes: 0, now_ms: now + 1_000, budget_bytes: budgetBytes });
      assert.equal(evicted.records, 1);
      await assertMetadataMatchesRows(kv, "after eviction", budgetBytes);

      // A duplicate capture rewrites the SAME request status row.
      const first = await persist(kv, keyBytes, "row-exact-duplicate", budgetBytes, now + 2_000);
      assert.equal(first.status, "stored");
      const second = await persist(kv, keyBytes, "row-exact-duplicate", budgetBytes, now + 3_000);
      assert.equal(second.status, "duplicate");
      await assertMetadataMatchesRows(kv, "after a duplicate capture", budgetBytes);

      // TTL reclamation deletes and replaces a status row too.
      const reclaimable = await persist(kv, keyBytes, "row-exact-expired", budgetBytes, now + 4_000);
      assert.equal(reclaimable.status, "stored");
      const reclaimed = await reclaimExpiredSentinelReplays(kv, {
        now_ms: now + 4_000 + SENTINEL_REPLAY_TTL_MS + 1,
        max_records: 1,
        budget_bytes: budgetBytes,
      });
      assert.equal(reclaimed.records, 1);
      await assertMetadataMatchesRows(kv, "after expiry", budgetBytes);

      // Phantom growth would have pruned live rows to satisfy a bound that no
      // longer described them, and the next capture would eventually be refused.
      assert.equal((await ledgerOf(kv, budgetBytes)).status_pruned_records, 0, "no live status row may be pruned for a phantom bound");
      const after = await persist(kv, keyBytes, "row-exact-after", budgetBytes, now + 6_000);
      assert.equal(after.status, "stored");
      await assertMetadataMatchesRows(kv, "after a later capture", budgetBytes);
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

/**
 * A fresh ledger is not authoritative until the resumable sweep has counted the
 * rows that already exist. A row admitted by its own writer while the sweep is
 * still pending is therefore counted twice: once by that admission commit and
 * once by the sweep. Both counters share the same two admission gates, so the
 * phantom growth would refuse status writes and finally whole captures.
 */
Deno.test({
  name: "a status row admitted into an unbootstrapped ledger is counted exactly once",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const now = 1_701_000_000_000;
    const budgetBytes = 1 * 1_024 * 1_024;
    const requestId = "bootstrap-race";
    try {
      const admitted = await admitSentinelReplayStatusMetadata(kv, {
        key: [...SENTINEL_REPLAY_REQUEST_PREFIX, requestId],
        row: {
          version: 1,
          request_id: requestId,
          status: "disabled",
          reason: "bootstrap_race",
          captured_at_ms: now,
          manifest_key: null,
          fingerprint: null,
          expires_at_ms: null,
        },
        now_ms: now,
        ttl_ms: SENTINEL_REPLAY_TTL_MS,
        budget_bytes: budgetBytes,
      });
      assert.equal(admitted, true, "a fresh ledger must bootstrap so its first status row can still be admitted");
      await assertMetadataMatchesRows(kv, "after admitting into an unbootstrapped ledger", budgetBytes);

      // The sweep must not count the same row a second time.
      const maintained = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now + 1, budget_bytes: budgetBytes });
      assert.equal(maintained.accounting_complete, true);
      await assertMetadataMatchesRows(kv, "after the accounting sweep", budgetBytes);
    } finally {
      kv.close();
      setKvForTest(null);
    }
  },
});

const legacyManifestFor = (index: number, capturedAtMs: number, requestId?: string): SentinelReplayManifest => ({
  version: 1,
  capture_id: `legacy-bootstrap-${index}`,
  fingerprint: index.toString(16).padStart(64, "0"),
  case_group_digest: "c".repeat(64),
  captured_at_ms: capturedAtMs,
  expires_at_ms: capturedAtMs + SENTINEL_REPLAY_TTL_MS,
  algorithm: "AES-256-GCM",
  compression: "gzip",
  iv: base64UrlEncode(new Uint8Array(12)),
  chunk_count: 1,
  ciphertext_bytes: 100,
  ...(requestId === undefined ? {} : { request_id: requestId }),
});

const legacyManifestKey = (manifest: SentinelReplayManifest): Deno.KvKey => [
  ...SENTINEL_REPLAY_MANIFEST_PREFIX,
  manifest.captured_at_ms,
  manifest.fingerprint,
  manifest.capture_id,
];

type BootstrapCommitObservation = {
  materializes: boolean;
  beforeCommit: () => Promise<void>;
  afterCommit: (result: Deno.KvCommitResult | Deno.KvCommitError) => void;
};

/** Observe and interleave a real native bootstrap commit, retaining every chained operation. */
const observedBootstrapAtomic = (operation: Deno.AtomicOperation, observation: BootstrapCommitObservation): Deno.AtomicOperation =>
  new Proxy(operation, {
    get(target, property) {
      if (property === "commit") {
        return async () => {
          if (observation.materializes) await observation.beforeCommit();
          const result = await target.commit();
          if (observation.materializes) observation.afterCommit(result);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const [key] = args;
        if (property === "set" && Array.isArray(key) && key[3] === "accounting") observation.materializes = true;
        return observedBootstrapAtomic(Reflect.apply(value, target, args) as Deno.AtomicOperation, observation);
      };
    },
  });

const observeBootstrapCommits = (
  kv: Deno.Kv,
  beforeCommit: () => Promise<void>,
  afterCommit: (result: Deno.KvCommitResult | Deno.KvCommitError) => void
): Deno.Kv =>
  new Proxy(kv, {
    get(target, property) {
      if (property === "atomic") return () => observedBootstrapAtomic(target.atomic(), { materializes: false, beforeCommit, afterCommit });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

Deno.test({
  name: "a bootstrapped legacy capture with an owner is evicted and releases its charge once",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    const now = 1_701_100_000_000;
    const legacy = legacyManifestFor(1, now, "legacy-owned");
    const unrelatedKey = ["uos_ai", "legacy-bootstrap-unrelated"];
    try {
      await kv.set(legacyManifestKey(legacy), legacy);
      await kv.set([...SENTINEL_REPLAY_CHUNK_PREFIX, legacy.capture_id, 0], new Uint8Array(legacy.ciphertext_bytes));
      await kv.set(unrelatedKey, { preserved: true });
      const initial = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now + 1, budget_bytes: TEST_BUDGET_BYTES });
      assert.equal(initial.accounting_complete, true);
      const evicted = await evictSentinelReplays(kv, { target_bytes: 0, now_ms: now + 2, budget_bytes: TEST_BUDGET_BYTES });
      assert.equal(evicted.records, 1);
      const after = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now + 3, budget_bytes: TEST_BUDGET_BYTES });
      assert.equal(after.stored_bytes, 0);
      assert.equal(after.records, 0);
      assert.equal(after.evicted_records, 1);
      assert.equal((await kv.get(sentinelReplayAccountingKey(now, legacy.capture_id))).value, null);
      assert.equal((await readSentinelReplayCaptureStatus(kv, "legacy-owned", now + 3)).status, "evicted");
      assert.deepEqual((await kv.get(unrelatedKey)).value, { preserved: true });
    } finally {
      kv.close();
    }
  },
});

Deno.test({
  name: "legacy accounting materialization resumes across bootstrap batches without charging rows twice",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    const now = 1_701_200_000_000;
    const manifests = Array.from({ length: 39 }, (_, index) => legacyManifestFor(index + 1, now + index));
    const budgetBytes = SENTINEL_REPLAY_BUDGET_BYTES;
    try {
      for (const manifest of manifests) await kv.set(legacyManifestKey(manifest), manifest);
      let status = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now + 1_000, budget_bytes: budgetBytes });
      assert.equal(status.accounting_complete, false, "one bounded pass must not claim to have swept all 39 manifests");
      for (let pass = 0; pass < 5 && !status.accounting_complete; pass += 1) {
        status = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now + 1_000, budget_bytes: budgetBytes });
      }
      assert.equal(status.accounting_complete, true);
      assert.equal(status.records, manifests.length);
      assert.equal(
        status.stored_bytes,
        manifests.reduce((sum, manifest) => sum + sentinelReplayManifestCharge(manifest), 0)
      );
      for (const manifest of manifests) {
        assert.equal(
          (await kv.get<SentinelReplayAccountingRow>(sentinelReplayAccountingKey(manifest.captured_at_ms, manifest.capture_id))).value?.state,
          "stored"
        );
      }
      const repeated = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now + 1_001, budget_bytes: budgetBytes });
      assert.equal(repeated.stored_bytes, status.stored_bytes);
      assert.equal(repeated.records, status.records);
    } finally {
      kv.close();
    }
  },
});

Deno.test({
  name: "a changed legacy manifest rejects the whole bootstrap row and ledger transaction",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    const now = 1_701_300_000_000;
    const manifest = legacyManifestFor(1, now);
    const changed = { ...manifest, ciphertext_bytes: 101 };
    let interleaved = false;
    const outcomes: boolean[] = [];
    const wrapped = observeBootstrapCommits(
      kv,
      async () => {
        if (interleaved) return;
        interleaved = true;
        await kv.set(legacyManifestKey(manifest), changed);
      },
      (result) => outcomes.push(result.ok)
    );
    try {
      await kv.set(legacyManifestKey(manifest), manifest);
      const raced = await runSentinelReplayRetentionMaintenance(wrapped, { now_ms: now + 1, budget_bytes: TEST_BUDGET_BYTES });
      assert.equal(interleaved, true, "the fixture must observe a real accounting-row materialization transaction");
      assert.deepEqual(outcomes, [false], "the native manifest version check must reject the stale charge");
      assert.equal(raced.accounting_complete, false);
      assert.equal(raced.records, 0);
      assert.equal(raced.stored_bytes, 0);
      assert.equal((await kv.get(sentinelReplayAccountingKey(now, manifest.capture_id))).value, null);
      const retried = await runSentinelReplayRetentionMaintenance(kv, { now_ms: now + 2, budget_bytes: TEST_BUDGET_BYTES });
      assert.equal(retried.accounting_complete, true);
      assert.equal(retried.records, 1);
      assert.equal(retried.stored_bytes, sentinelReplayManifestCharge(changed));
    } finally {
      kv.close();
    }
  },
});

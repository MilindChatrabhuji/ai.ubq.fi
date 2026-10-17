import { test } from "bun:test";
import { openKv, type AtomicOperation, type Kv, type KvCommitError, type KvCommitResult, type KvKey } from "#kv";
/** Native KV staging races; synthetic capture bytes and encryption keys only. */
import assert from "node:assert/strict";
import { persistEncryptedSentinelReplay } from "../src/sentinel/replay-store.ts";
import { decryptExportedSentinelReplay, listEncryptedSentinelReplaysByRequestId } from "../src/sentinel/replay-read.ts";
import {
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_TTL_MS,
  type AcceptedSentinelReplayInput,
  type SentinelFailureObservation,
} from "../src/sentinel/replay-model.ts";
import { abandonSentinelReplayAccounting, runSentinelReplayRetentionMaintenance } from "../src/sentinel/replay-retention.ts";
import {
  readSentinelReplayLedgerSnapshot,
  sentinelReplayAccountingKey,
  SENTINEL_REPLAY_STAGING_BATCH_CHUNKS,
  SENTINEL_REPLAY_RESERVATION_TTL_MS,
  SENTINEL_REPLAY_STORAGE_FULL_REASON,
  type SentinelReplayAccountingRow,
} from "../src/sentinel/replay-retention-schema.ts";
import { SENTINEL_REPLAY_STORAGE_CHUNK_BYTES } from "../src/sentinel/replay-limits.ts";

const NOW = 1_703_000_000_000;
const BUDGET_BYTES = 16 * 1_024 * 1_024;
let cachedBody: Uint8Array<ArrayBuffer> | null = null;

const inputBody = (): Uint8Array<ArrayBuffer> => {
  if (cachedBody) return cachedBody;
  const random = new Uint8Array(1 * 1_024 * 1_024);
  for (let offset = 0; offset < random.length; offset += 65_536) crypto.getRandomValues(random.subarray(offset, offset + 65_536));
  let binary = "";
  for (let offset = 0; offset < random.length; offset += 32_768) binary += String.fromCharCode(...random.subarray(offset, offset + 32_768));
  cachedBody = new TextEncoder().encode(JSON.stringify({ model: "gpt-5.6-sol", blob: btoa(binary) }));
  return cachedBody;
};

const captureInput = (requestId: string): AcceptedSentinelReplayInput => ({
  endpoint: "/v1/responses",
  method: "POST",
  body: inputBody(),
  content_type: "application/json",
  compatibility_headers: {},
  request_id: requestId,
  git_sha: "a".repeat(40),
  deno_revision: "staging-fixture",
});

const failure: SentinelFailureObservation = {
  status: 502,
  stream: false,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  synthetic_terminal_type: null,
  provider_route: "chatgpt_codex",
};

type Check = Readonly<{ key: KvKey; versionstamp: string | null }>;
type ChunkWrite = Readonly<{ key: KvKey; bytes: number; ttl_ms: number | undefined }>;
type Batch = Readonly<{ number: number; checks: readonly Check[]; chunks: readonly ChunkWrite[] }>;
type Observation = {
  batches: Batch[];
  direct_chunk_sets: number;
  refuse_deletes: boolean;
  before: (batch: Batch) => Promise<void>;
  after: (batch: Batch, result: KvCommitResult | KvCommitError) => Promise<void>;
};
type AtomicState = { checks: Check[]; chunks: ChunkWrite[] };

const isChunkKey = (key: unknown): key is KvKey =>
  Array.isArray(key) && key.length === SENTINEL_REPLAY_CHUNK_PREFIX.length + 2 && SENTINEL_REPLAY_CHUNK_PREFIX.every((part, index) => key[index] === part);

const recordAtomicCall = (state: AtomicState, property: string | symbol, args: unknown[]): void => {
  if (property === "check") {
    for (const check of args as Check[]) state.checks.push({ key: [...check.key], versionstamp: check.versionstamp });
  }
  if (property !== "set") return;
  const [key, value] = args;
  if (!isChunkKey(key)) return;
  assert.ok(value instanceof Uint8Array);
  const options = args[2] as { expireIn?: number } | undefined;
  // The caller clears chunk buffers later; retain byte lengths and keys now,
  // while native KV remains the source for actual stored/decrypted bytes.
  state.chunks.push({ key: [...key], bytes: value.byteLength, ttl_ms: options?.expireIn });
};

const observedAtomic = (operation: AtomicOperation, state: AtomicState, observation: Observation): AtomicOperation =>
  new Proxy(operation, {
    get(target, property) {
      if (property === "commit") {
        return async () => {
          if (state.chunks.length === 0) return await target.commit();
          const batch: Batch = { number: observation.batches.length + 1, checks: [...state.checks], chunks: [...state.chunks] };
          observation.batches.push(batch);
          await observation.before(batch);
          const result = await target.commit();
          await observation.after(batch, result);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        recordAtomicCall(state, property, args);
        return observedAtomic(Reflect.apply(value, target, args) as AtomicOperation, state, observation);
      };
    },
  });

const observedKv = (kv: Kv, observation: Observation): Kv =>
  new Proxy(kv, {
    get(target, property) {
      if (property === "atomic") return () => observedAtomic(target.atomic(), { checks: [], chunks: [] }, observation);
      if (property === "set") {
        return (key: KvKey, value: unknown, options?: { expireIn?: number }) => {
          if (isChunkKey(key)) observation.direct_chunk_sets += 1;
          return target.set(key, value, options);
        };
      }
      if (property === "delete") {
        return (key: KvKey) => {
          if (isChunkKey(key) && observation.refuse_deletes) return Promise.reject(new Error("staging_fixture_delete_failure"));
          return target.delete(key);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const observationFor = (before: Observation["before"], after: Observation["after"]): Observation => ({
  batches: [],
  direct_chunk_sets: 0,
  refuse_deletes: false,
  before,
  after,
});

const persist = (kv: Kv, requestId: string, keyBytes: Uint8Array<ArrayBuffer>) =>
  persistEncryptedSentinelReplay(captureInput(requestId), failure, {
    kv,
    keyBytes,
    now: () => NOW,
    randomUuid: () => `capture-${requestId}`,
    budgetBytes: BUDGET_BYTES,
  });

const ledgerOf = async (kv: Kv) => {
  const snapshot = await readSentinelReplayLedgerSnapshot(kv, BUDGET_BYTES);
  assert.ok(snapshot);
  return snapshot.ledger;
};

const chunkCount = async (kv: Kv, captureId: string): Promise<number> => {
  let count = 0;
  const prefix = [...SENTINEL_REPLAY_CHUNK_PREFIX, captureId];
  for await (const entry of kv.list({ prefix })) {
    assert.equal(entry.key.length, prefix.length + 1);
    count += 1;
  }
  return count;
};

test("publication rejects a reservation expired during capture staging", async () => {
  const kv = await openKv(":memory:");
  const requestId = "staging-expired-publication";
  let wallNow = NOW;
  let leaseReads = 0;
  const currentNow = () => {
    leaseReads += 1;
    if (leaseReads === 2) wallNow = NOW + SENTINEL_REPLAY_RESERVATION_TTL_MS + 1;
    return wallNow;
  };
  try {
    const result = await persistEncryptedSentinelReplay({ ...captureInput(requestId), body: new TextEncoder().encode("{}") }, failure, {
      kv,
      keyBytes: crypto.getRandomValues(new Uint8Array(32)),
      now: () => NOW,
      currentNow,
      randomUuid: () => `capture-${requestId}`,
      budgetBytes: BUDGET_BYTES,
    });
    assert.deepEqual(result, { status: "incomplete", reason: SENTINEL_REPLAY_STORAGE_FULL_REASON });
    assert.equal(leaseReads, 2);
    assert.equal(await chunkCount(kv, `capture-${requestId}`), 0);
    assert.equal((await ledgerOf(kv)).reserved_bytes, 0);
  } finally {
    kv.close();
  }
});

test("first and second chunk transactions reject a released reservation before writer cleanup", async () => {
  for (const pausedBatch of [1, 2]) {
    const kv = await openKv(":memory:");
    const requestId = `staging-paused-${pausedBatch}`;
    const captureId = `capture-${requestId}`;
    const accountingKey = sentinelReplayAccountingKey(NOW, captureId);
    let revoked = false;
    let inspected = false;
    const observation = observationFor(
      async (batch) => {
        if (batch.number !== pausedBatch) return;
        assert.equal(await chunkCount(kv, captureId), pausedBatch === 1 ? 0 : 12);
        const entry = await kv.get<SentinelReplayAccountingRow>(accountingKey);
        assert.ok(entry.value);
        assert.equal(entry.value.state, "reserved");
        const cleanup = await abandonSentinelReplayAccounting(kv, entry.value, accountingKey, { now_ms: NOW, budget_bytes: BUDGET_BYTES });
        assert.equal(cleanup.released, true);
        assert.equal((await ledgerOf(kv)).reserved_bytes, 0);
        assert.equal(await chunkCount(kv, captureId), 0);
        revoked = true;
      },
      async (batch, result) => {
        if (batch.number !== pausedBatch) return;
        assert.equal(result.ok, false, "native accounting-row CAS must reject before cleanup can conceal the race");
        assert.equal((await kv.get(accountingKey)).value, null);
        assert.equal(await chunkCount(kv, captureId), 0, "no chunk may reappear before the writer receives the failed commit");
        inspected = true;
      }
    );
    try {
      const result = await persist(observedKv(kv, observation), requestId, crypto.getRandomValues(new Uint8Array(32)));
      assert.deepEqual(result, { status: "incomplete", reason: SENTINEL_REPLAY_STORAGE_FULL_REASON });
      assert.equal(revoked, true);
      assert.equal(inspected, true);
      assert.equal(observation.direct_chunk_sets, 0);
      assert.equal(observation.batches.length, pausedBatch);
      assert.equal((await ledgerOf(kv)).reserved_bytes, 0);
    } finally {
      kv.close();
    }
  }
});

test("a capture larger than 12 chunks uses bounded checked transactions and decrypts unchanged", async () => {
  const kv = await openKv(":memory:");
  const requestId = "staging-roundtrip";
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const original = inputBody().slice();
  const accountingKey = sentinelReplayAccountingKey(NOW, `capture-${requestId}`);
  const observation = observationFor(
    async (batch) => {
      assert.deepEqual(batch.checks, [{ key: accountingKey, versionstamp: (await kv.get(accountingKey)).versionstamp }]);
      assert.equal(batch.chunks.length <= 12, true);
      assert.equal(batch.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) <= 576 * 1_024, true);
      for (const chunk of batch.chunks) {
        assert.equal(chunk.bytes <= SENTINEL_REPLAY_STORAGE_CHUNK_BYTES, true);
        assert.equal(chunk.ttl_ms, SENTINEL_REPLAY_TTL_MS);
      }
    },
    (_batch, result) => {
      assert.equal(result.ok, true);
      return Promise.resolve();
    }
  );
  try {
    const result = await persist(observedKv(kv, observation), requestId, keyBytes);
    assert.equal(result.status, "stored");
    assert.equal(result.manifest.chunk_count > 12, true);
    assert.equal(observation.batches.length > 1, true);
    assert.equal(observation.direct_chunk_sets, 0);
    assert.equal(SENTINEL_REPLAY_STAGING_BATCH_CHUNKS, 12);
    const exported = await listEncryptedSentinelReplaysByRequestId(kv, requestId, NOW);
    assert.equal(exported.captures.length, 1);
    const decrypted = await decryptExportedSentinelReplay(exported.captures[0], keyBytes);
    assert.deepEqual(decrypted.body, original);
    assert.equal((await ledgerOf(kv)).reserved_bytes, 0);
    assert.equal((await ledgerOf(kv)).records, 1);
  } finally {
    kv.close();
  }
});

test("a later chunk commit exception preserves its error and cleanup retains charge until native chunks are gone", async () => {
  for (const refuseDeletes of [false, true]) {
    const kv = await openKv(":memory:");
    const requestId = `staging-commit-failure-${refuseDeletes}`;
    const captureId = `capture-${requestId}`;
    const accountingKey = sentinelReplayAccountingKey(NOW, captureId);
    const injected = new Error("staging_fixture_commit_failure");
    const observation = observationFor(
      (batch) => (batch.number === 2 ? Promise.reject(injected) : Promise.resolve()),
      () => Promise.resolve()
    );
    observation.refuse_deletes = refuseDeletes;
    try {
      await assert.rejects(persist(observedKv(kv, observation), requestId, crypto.getRandomValues(new Uint8Array(32))), (error: unknown) => error === injected);
      assert.equal(observation.batches.length, 2);
      const chunks = await chunkCount(kv, captureId);
      const row = await kv.get<SentinelReplayAccountingRow>(accountingKey);
      const ledger = await ledgerOf(kv);
      if (refuseDeletes) {
        assert.equal(chunks, 12);
        assert.equal(row.value?.state, "revoked");
        assert.equal(ledger.reserved_bytes, row.value.bytes);
      } else {
        assert.equal(chunks, 0);
        assert.equal(row.value, null);
        assert.equal(ledger.reserved_bytes, 0);
      }
      observation.refuse_deletes = false;
      await runSentinelReplayRetentionMaintenance(kv, { now_ms: NOW + 1, budget_bytes: BUDGET_BYTES });
      assert.equal(await chunkCount(kv, captureId), 0);
      assert.equal((await ledgerOf(kv)).reserved_bytes, 0);
      assert.equal((await kv.get(accountingKey)).value, null);
    } finally {
      kv.close();
    }
  }
});

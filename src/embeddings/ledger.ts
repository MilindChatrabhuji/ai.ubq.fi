import type { Kv, KvEntryMaybe, KvKey } from "#kv";
// Embeddings KV ledger, idempotency records and job/cache keys, extracted from src/openai.ts.

import { openaiError } from "../http.ts";
import { isRecord, sha256Hex } from "../utils.ts";

export type EmbeddingsEncodingFormat = "float" | "base64";
export type VoyageEmbeddingsInputType = "query" | "document";
export type VoyageEmbeddingsDimension = 256 | 512 | 1024 | 2048;
export type VoyageEmbeddingsOutputDtype = "float";

export type ResolvedEmbeddingsProfile = Readonly<{
  upstream: "voyage";
  upstream_model: "voyage-4-large";
  input_type: VoyageEmbeddingsInputType;
  dimensions: VoyageEmbeddingsDimension;
  output_dtype: VoyageEmbeddingsOutputDtype;
  encoding_format: EmbeddingsEncodingFormat;
  truncation: boolean;
  cache_profile_key: string;
}>;

type ParsedEmbeddingsRequest = Readonly<{
  model: string;
  inputs: string[];
  total_chars: number;
  profile: ResolvedEmbeddingsProfile;
}>;

export type EmbeddingsParseResult = Readonly<{ ok: true; value: ParsedEmbeddingsRequest }> | Readonly<{ ok: false; response: Response }>;

export type VoyageRateLimitState = Readonly<{
  window_start_ms: number;
  requests: number;
  tokens: number;
}>;

export const EMBEDDINGS_MAX_INPUTS_PER_REQUEST = 128;
export const EMBEDDINGS_MAX_CHARS_PER_INPUT = 20_000;
export const EMBEDDINGS_MAX_TOTAL_CHARS = 100_000;
export const EMBEDDINGS_TIMEOUT_MS = 20_000;
// KV cache is best-effort and quota-driven: we cache embeddings until KV rejects
// writes (storage/quota), then evict the oldest entries (FIFO index) and retry.
// We do not track "last read" to keep writes minimal.
export const EMBEDDINGS_CACHE_EVICT_BATCH = 512;
export const EMBEDDINGS_CACHE_EVICT_MAX_BATCH = 8192;
export const EMBEDDINGS_CACHE_QUOTA_MAX_RETRIES = 4;
export const EMBEDDINGS_JOB_TTL_MS = 24 * 60 * 60_000;
export const EMBEDDINGS_JOB_LOCK_MS = 30_000;
export const EMBEDDINGS_RETRYABLE_UPSTREAM_STATUSES = new Set([429, 500, 502, 503, 504]);
const EMBEDDINGS_IDEMPOTENCY_LEASE_MS = 60_000;
const EMBEDDINGS_IDEMPOTENCY_RESPONSE_CHUNK_CHARS = 48_000;
// 128 inputs x 2,048 finite JSON numbers fit comfortably below this cap.
export const EMBEDDINGS_IDEMPOTENCY_MAX_RESPONSE_CHUNKS = 256;
export const EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS = 7 * 24 * 60 * 60_000;
// Response chunks are published before their ledger record. Keep them for one
// extra day so every published ledger expires before the chunks it references;
// unpublished/orphaned generations are reclaimed by the same TTL.
export const EMBEDDINGS_IDEMPOTENCY_RESPONSE_TTL_MS = EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS + 24 * 60 * 60_000;
export const EMBEDDINGS_IDEMPOTENCY_MAX_KEY_CHARS = 255;

export const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
export const VOYAGE_EMBEDDINGS_MODEL = "voyage-4-large";
export const VOYAGE_DEFAULT_DIMENSIONS: VoyageEmbeddingsDimension = 1024;
export const VOYAGE_OUTPUT_DTYPE: VoyageEmbeddingsOutputDtype = "float";
export const VOYAGE_SUPPORTED_DIMENSIONS = new Set<number>([256, 512, 1024, 2048]);
export const UOS_SYNC_EMBEDDINGS_ALLOWED_KEYS = new Set(["dimensions", "encoding_format", "input", "input_type", "model", "truncation", "user"]);
// Jobs deliberately retain the original Voyage-only profile. In particular,
// they require an explicit retrieval input type and only persist float vectors.
export const UOS_EMBEDDINGS_JOB_ALLOWED_KEYS = new Set(["dimensions", "encoding_format", "input", "input_type", "model", "truncation"]);
// Voyage free-tier throttles are tiny; we enforce conservative defaults to avoid 429s.
export const VOYAGE_RATE_LIMIT_RPM = 3;
export const VOYAGE_RATE_LIMIT_TPM = 10_000;
export const VOYAGE_RATE_LIMIT_KEY: KvKey = ["embeddings", "v1", "rate", "voyage"];
export const VOYAGE_API_KEY_KV_KEY: KvKey = ["uos_ai", "voyage_api_key"];

type EmbeddingsIdempotencyState = "reserved" | "dispatched" | "succeeded" | "indeterminate";

type EmbeddingsIdempotencyRecord = Readonly<{
  v: 1;
  fingerprint: string;
  state: EmbeddingsIdempotencyState;
  owner_request_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  lease_until_ms: number | null;
  response_status: number | null;
  response_content_type: string | null;
  response_generation: string | null;
  response_chunk_count: number | null;
  response_sha256: string | null;
}>;

export type EmbeddingsIdempotencyLease = Readonly<{
  kv: Kv;
  key: KvKey;
  responseKeyPrefix: KvKey;
  fingerprint: string;
  ownerRequestId: string;
}>;

type EmbeddingsIdempotencyAcquireResult =
  | Readonly<{ kind: "acquired"; lease: EmbeddingsIdempotencyLease }>
  | Readonly<{ kind: "replay"; response: Response }>
  | Readonly<{ kind: "error"; response: Response }>;

type EmbeddingsJobStatus = "queued" | "running" | "succeeded" | "failed";

export type EmbeddingsJobRecord = Readonly<{
  id: string;
  status: EmbeddingsJobStatus;
  created_at_ms: number;
  updated_at_ms: number;
  model: string;
  cache_profile_key: string;
  upstream: "voyage";
  upstream_model: "voyage-4-large";
  input_type: VoyageEmbeddingsInputType;
  dimensions: VoyageEmbeddingsDimension;
  output_dtype: VoyageEmbeddingsOutputDtype;
  encoding_format: EmbeddingsEncodingFormat;
  truncation: boolean;
  input_hashes: string[];
  input_count: number;
  total_chars: number;
  usage_total_tokens: number;
  retry_after_seconds: number | null;
  locked_until_ms: number | null;
  error: { message: string; type: string; code?: string } | null;
}>;

export type EmbeddingsJobInputRecord = Readonly<{
  v: 1;
  iv_b64: string;
  data_b64: string;
  created_at_ms: number;
}>;

export type EmbeddingsJobLookupRecord = Readonly<{
  cache_profile_key: string;
}>;

export const embeddingsJobKey = (tokenHash: string, cacheProfileKey: string, id: string): KvKey => ["embeddings", "jobs", "v2", tokenHash, cacheProfileKey, id];
export const embeddingsJobLookupKey = (tokenHash: string, id: string): KvKey => ["embeddings", "jobs", "v2", "lookup", tokenHash, id];
export const embeddingsJobInputKey = (tokenHash: string, cacheProfileKey: string, jobId: string, hash: string): KvKey => [
  "embeddings",
  "jobs",
  "v2",
  "input",
  tokenHash,
  cacheProfileKey,
  jobId,
  hash,
];

export const embeddingsCacheIndexKey = (cacheProfileKey: string, createdAtMs: number, hash: string): KvKey => [
  "embeddings",
  "v2",
  "cache_index",
  cacheProfileKey,
  createdAtMs,
  hash,
];
export const embeddingsCacheGlobalIndexPrefix: KvKey = ["embeddings", "v2", "cache_index_global"];
export const embeddingsCacheGlobalIndexKey = (createdAtMs: number, cacheProfileKey: string, hash: string): KvKey => [
  ...embeddingsCacheGlobalIndexPrefix,
  createdAtMs,
  cacheProfileKey,
  hash,
];
export const embeddingsCacheIndexByHashKey = (cacheProfileKey: string, hash: string): KvKey => [
  "embeddings",
  "v2",
  "cache_index_by_hash",
  cacheProfileKey,
  hash,
];
export const embeddingsCacheKey = (cacheProfileKey: string, hash: string): KvKey => ["embeddings", "v2", "cache", cacheProfileKey, hash];

const embeddingsIdempotencyKey = (principalHash: string, idempotencyKeyHash: string): KvKey => [
  "embeddings",
  "idempotency",
  "v1",
  principalHash,
  idempotencyKeyHash,
];

const embeddingsIdempotencyResponseKeyPrefix = (principalHash: string, idempotencyKeyHash: string): KvKey => [
  "embeddings",
  "idempotency",
  "v1",
  "response",
  principalHash,
  idempotencyKeyHash,
];

const isEmbeddingsIdempotencyState = (value: unknown): value is EmbeddingsIdempotencyState =>
  value === "reserved" || value === "dispatched" || value === "succeeded" || value === "indeterminate";

const isEmbeddingsIdempotencyTimestampMs = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isEmbeddingsIdempotencyNullableTimestampMs = (value: unknown): value is number | null => value === null || isEmbeddingsIdempotencyTimestampMs(value);

const isEmbeddingsIdempotencyNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

const isEmbeddingsIdempotencyNullableInteger = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value));

const isEmbeddingsIdempotencyChunkCount = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= EMBEDDINGS_IDEMPOTENCY_MAX_RESPONSE_CHUNKS);

const normalizeEmbeddingsIdempotencyRecord = (value: unknown): EmbeddingsIdempotencyRecord | null => {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.fingerprint !== "string" ||
    !isEmbeddingsIdempotencyState(value.state) ||
    !isEmbeddingsIdempotencyNullableString(value.owner_request_id) ||
    !isEmbeddingsIdempotencyTimestampMs(value.created_at_ms) ||
    !isEmbeddingsIdempotencyTimestampMs(value.updated_at_ms) ||
    !isEmbeddingsIdempotencyNullableTimestampMs(value.lease_until_ms) ||
    !isEmbeddingsIdempotencyNullableInteger(value.response_status) ||
    !isEmbeddingsIdempotencyNullableString(value.response_content_type) ||
    !isEmbeddingsIdempotencyNullableString(value.response_generation) ||
    !isEmbeddingsIdempotencyChunkCount(value.response_chunk_count) ||
    !isEmbeddingsIdempotencyNullableString(value.response_sha256)
  ) {
    return null;
  }

  return {
    v: 1,
    fingerprint: value.fingerprint,
    state: value.state,
    owner_request_id: value.owner_request_id,
    created_at_ms: Math.trunc(value.created_at_ms),
    updated_at_ms: Math.trunc(value.updated_at_ms),
    lease_until_ms: value.lease_until_ms === null ? null : Math.trunc(value.lease_until_ms),
    response_status: value.response_status === null ? null : Math.trunc(value.response_status),
    response_content_type: value.response_content_type,
    response_generation: value.response_generation,
    response_chunk_count: value.response_chunk_count === null ? null : Math.trunc(value.response_chunk_count),
    response_sha256: value.response_sha256,
  };
};

const embeddingsIdempotencyError = (
  status: 409 | 503,
  message: string,
  code: "embedding_idempotency_conflict" | "embedding_idempotency_in_progress" | "embedding_idempotency_indeterminate" | "embedding_idempotency_unavailable",
  retryAfterSeconds?: number
): Response =>
  openaiError(status, message, code, {
    type: status === 503 ? "server_error" : "idempotency_error",
    param: null,
    ...(retryAfterSeconds === undefined ? {} : { headers: { "Retry-After": String(retryAfterSeconds) } }),
  });

const embeddingsIdempotencyConflictResponse = (): Response =>
  embeddingsIdempotencyError(409, "Idempotency-Key was already used with a different embeddings request.", "embedding_idempotency_conflict");

const embeddingsIdempotencyInProgressResponse = (): Response =>
  embeddingsIdempotencyError(409, "The embeddings request for this Idempotency-Key is still in progress.", "embedding_idempotency_in_progress", 1);

export const embeddingsIdempotencyIndeterminateResponse = (): Response =>
  embeddingsIdempotencyError(409, "The embeddings request outcome is indeterminate and will not be dispatched again.", "embedding_idempotency_indeterminate");

export const embeddingsIdempotencyUnavailableResponse = (): Response =>
  embeddingsIdempotencyError(503, "Idempotent embeddings requests require durable KV storage.", "embedding_idempotency_unavailable");

export const hasAsciiControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

export const buildEmbeddingsIdempotencyFingerprint = async (profile: ResolvedEmbeddingsProfile, orderedInputHashes: string[]): Promise<string> =>
  await sha256Hex(
    JSON.stringify([
      "uos-embeddings-idempotency-v1",
      profile.upstream,
      profile.upstream_model,
      profile.input_type,
      profile.dimensions,
      profile.output_dtype,
      profile.encoding_format,
      profile.truncation,
      orderedInputHashes,
    ])
  );

const loadEmbeddingsIdempotencyResponse = async (
  lease: Omit<EmbeddingsIdempotencyLease, "ownerRequestId">,
  record: EmbeddingsIdempotencyRecord
): Promise<Response | null> => {
  if (
    record.state !== "succeeded" ||
    record.response_status !== 200 ||
    !record.response_content_type ||
    !record.response_generation ||
    record.response_chunk_count === null ||
    !record.response_sha256
  ) {
    return null;
  }

  const responseGeneration = record.response_generation;
  const chunks = await Promise.all(
    Array.from({ length: record.response_chunk_count }, (_, index) => lease.kv.get<string>([...lease.responseKeyPrefix, responseGeneration, index]))
  );
  if (chunks.some((entry) => typeof entry.value !== "string")) return null;
  const body = chunks.map((entry) => entry.value ?? "").join("");
  if ((await sha256Hex(body)) !== record.response_sha256) return null;
  return new Response(body, {
    status: record.response_status,
    headers: {
      "Content-Type": record.response_content_type,
      "x-uos-idempotency-replayed": "true",
    },
  });
};

export const markEmbeddingsIdempotencyIndeterminate = async (lease: EmbeddingsIdempotencyLease): Promise<void> => {
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await lease.kv.get<EmbeddingsIdempotencyRecord>(lease.key);
      const record = normalizeEmbeddingsIdempotencyRecord(entry.value);
      if (record?.fingerprint !== lease.fingerprint) return;
      if (record.state === "indeterminate" || record.state === "succeeded") return;
      const now = Date.now();
      const next: EmbeddingsIdempotencyRecord = {
        ...record,
        state: "indeterminate",
        owner_request_id: null,
        updated_at_ms: now,
        lease_until_ms: null,
        response_status: null,
        response_content_type: null,
        response_generation: null,
        response_chunk_count: null,
        response_sha256: null,
      };
      const commit = await lease.kv.atomic().check(entry).set(lease.key, next, { expireIn: EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS }).commit();
      if (commit.ok) return;
    }
  } catch (error) {
    console.error("[ai.ubq.fi] embeddings idempotency indeterminate-state write failed:", error);
  }
};

const buildEmbeddingsIdempotencyIndeterminateRecord = (record: EmbeddingsIdempotencyRecord, now: number): EmbeddingsIdempotencyRecord => ({
  ...record,
  state: "indeterminate",
  owner_request_id: null,
  updated_at_ms: now,
  lease_until_ms: null,
  response_status: null,
  response_content_type: null,
  response_generation: null,
  response_chunk_count: null,
  response_sha256: null,
});

const commitEmbeddingsIdempotencyRecordReplacement = async (
  kv: Kv,
  entry: KvEntryMaybe<EmbeddingsIdempotencyRecord>,
  key: KvKey,
  record: EmbeddingsIdempotencyRecord
): Promise<boolean> => {
  const commit = await kv.atomic().check(entry).set(key, record, { expireIn: EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS }).commit();
  return commit.ok;
};

const resolveSucceededEmbeddingsIdempotencyLease = async (params: {
  kv: Kv;
  key: KvKey;
  entry: KvEntryMaybe<EmbeddingsIdempotencyRecord>;
  record: EmbeddingsIdempotencyRecord;
  lease: EmbeddingsIdempotencyLease;
  now: number;
}): Promise<EmbeddingsIdempotencyAcquireResult | null> => {
  const replay = await loadEmbeddingsIdempotencyResponse(params.lease, params.record);
  if (replay) return { kind: "replay", response: replay };
  const committed = await commitEmbeddingsIdempotencyRecordReplacement(
    params.kv,
    params.entry,
    params.key,
    buildEmbeddingsIdempotencyIndeterminateRecord(params.record, params.now)
  );
  if (committed) return { kind: "error", response: embeddingsIdempotencyIndeterminateResponse() };
  return null;
};

const retireDispatchedEmbeddingsIdempotencyLease = async (params: {
  kv: Kv;
  key: KvKey;
  entry: KvEntryMaybe<EmbeddingsIdempotencyRecord>;
  record: EmbeddingsIdempotencyRecord;
  now: number;
}): Promise<EmbeddingsIdempotencyAcquireResult | null> => {
  const committed = await commitEmbeddingsIdempotencyRecordReplacement(
    params.kv,
    params.entry,
    params.key,
    buildEmbeddingsIdempotencyIndeterminateRecord(params.record, params.now)
  );
  if (committed) return { kind: "error", response: embeddingsIdempotencyIndeterminateResponse() };
  return null;
};

const attemptEmbeddingsIdempotencyLeaseAcquire = async (params: {
  kv: Kv;
  key: KvKey;
  fingerprint: string;
  requestId: string;
  lease: EmbeddingsIdempotencyLease;
}): Promise<EmbeddingsIdempotencyAcquireResult | null> => {
  const entry = await params.kv.get<EmbeddingsIdempotencyRecord>(params.key);
  const record = normalizeEmbeddingsIdempotencyRecord(entry.value);
  const now = Date.now();

  if (entry.versionstamp === null) {
    const reserved: EmbeddingsIdempotencyRecord = {
      v: 1,
      fingerprint: params.fingerprint,
      state: "reserved",
      owner_request_id: params.requestId,
      created_at_ms: now,
      updated_at_ms: now,
      lease_until_ms: now + EMBEDDINGS_IDEMPOTENCY_LEASE_MS,
      response_status: null,
      response_content_type: null,
      response_generation: null,
      response_chunk_count: null,
      response_sha256: null,
    };
    const committed = await commitEmbeddingsIdempotencyRecordReplacement(params.kv, entry, params.key, reserved);
    if (committed) return { kind: "acquired", lease: params.lease };
    return null;
  }

  if (!record) return { kind: "error", response: embeddingsIdempotencyIndeterminateResponse() };
  if (record.fingerprint !== params.fingerprint) {
    return { kind: "error", response: embeddingsIdempotencyConflictResponse() };
  }

  if (record.state === "succeeded") {
    return await resolveSucceededEmbeddingsIdempotencyLease({
      kv: params.kv,
      key: params.key,
      entry,
      record,
      lease: params.lease,
      now,
    });
  }

  if (record.state === "indeterminate") {
    return { kind: "error", response: embeddingsIdempotencyIndeterminateResponse() };
  }

  if (record.lease_until_ms !== null && record.lease_until_ms > now) {
    return { kind: "error", response: embeddingsIdempotencyInProgressResponse() };
  }

  if (record.state === "dispatched") {
    return await retireDispatchedEmbeddingsIdempotencyLease({
      kv: params.kv,
      key: params.key,
      entry,
      record,
      now,
    });
  }

  const reserved: EmbeddingsIdempotencyRecord = {
    ...record,
    state: "reserved",
    owner_request_id: params.requestId,
    updated_at_ms: now,
    lease_until_ms: now + EMBEDDINGS_IDEMPOTENCY_LEASE_MS,
    response_status: null,
    response_content_type: null,
    response_generation: null,
    response_chunk_count: null,
    response_sha256: null,
  };
  const committed = await commitEmbeddingsIdempotencyRecordReplacement(params.kv, entry, params.key, reserved);
  if (committed) return { kind: "acquired", lease: params.lease };
  return null;
};

export const acquireEmbeddingsIdempotencyLease = async (params: {
  kv: Kv;
  principal: string;
  idempotencyKey: string;
  fingerprint: string;
  requestId: string;
}): Promise<EmbeddingsIdempotencyAcquireResult> => {
  const [principalHash, idempotencyKeyHash] = await Promise.all([
    sha256Hex(`uos-embeddings-principal-v1:${params.principal}`),
    sha256Hex(`uos-embeddings-key-v1:${params.idempotencyKey}`),
  ]);
  const key = embeddingsIdempotencyKey(principalHash, idempotencyKeyHash);
  const responseKeyPrefix = embeddingsIdempotencyResponseKeyPrefix(principalHash, idempotencyKeyHash);
  const lease: EmbeddingsIdempotencyLease = {
    kv: params.kv,
    key,
    responseKeyPrefix,
    fingerprint: params.fingerprint,
    ownerRequestId: params.requestId,
  };

  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await attemptEmbeddingsIdempotencyLeaseAcquire({
        kv: params.kv,
        key,
        fingerprint: params.fingerprint,
        requestId: params.requestId,
        lease,
      });
      if (result) return result;
    }
  } catch (error) {
    console.error("[ai.ubq.fi] embeddings idempotency reservation failed:", error);
  }

  return { kind: "error", response: embeddingsIdempotencyUnavailableResponse() };
};

export const markEmbeddingsIdempotencyDispatched = async (lease: EmbeddingsIdempotencyLease): Promise<boolean> => {
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await lease.kv.get<EmbeddingsIdempotencyRecord>(lease.key);
      const record = normalizeEmbeddingsIdempotencyRecord(entry.value);
      if (!record) return false;
      if (record.fingerprint !== lease.fingerprint || record.state !== "reserved" || record.owner_request_id !== lease.ownerRequestId) {
        return false;
      }
      const now = Date.now();
      const dispatched: EmbeddingsIdempotencyRecord = {
        ...record,
        state: "dispatched",
        updated_at_ms: now,
        lease_until_ms: now + EMBEDDINGS_IDEMPOTENCY_LEASE_MS,
      };
      const commit = await lease.kv.atomic().check(entry).set(lease.key, dispatched, { expireIn: EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS }).commit();
      if (commit.ok) return true;
    }
  } catch (error) {
    console.error("[ai.ubq.fi] embeddings idempotency dispatch-state write failed:", error);
  }
  return false;
};

export const releaseEmbeddingsIdempotencyReservation = async (lease: EmbeddingsIdempotencyLease, allowDispatched: boolean): Promise<boolean> => {
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await lease.kv.get<EmbeddingsIdempotencyRecord>(lease.key);
      const record = normalizeEmbeddingsIdempotencyRecord(entry.value);
      if (record?.fingerprint !== lease.fingerprint) return false;
      if (record.owner_request_id !== lease.ownerRequestId) return false;
      if (record.state !== "reserved" && !(allowDispatched && record.state === "dispatched")) return false;
      const commit = await lease.kv.atomic().check(entry).delete(lease.key).commit();
      if (commit.ok) return true;
    }
  } catch (error) {
    console.error("[ai.ubq.fi] embeddings idempotency reservation release failed:", error);
  }
  return false;
};

export const storeEmbeddingsIdempotencySuccess = async (lease: EmbeddingsIdempotencyLease, response: Response): Promise<boolean> => {
  try {
    const body = await response.clone().text();
    const chunks: string[] = [];
    for (let offset = 0; offset < body.length; offset += EMBEDDINGS_IDEMPOTENCY_RESPONSE_CHUNK_CHARS) {
      chunks.push(body.slice(offset, offset + EMBEDDINGS_IDEMPOTENCY_RESPONSE_CHUNK_CHARS));
    }
    if (!chunks.length) chunks.push("");
    if (chunks.length > EMBEDDINGS_IDEMPOTENCY_MAX_RESPONSE_CHUNKS) return false;
    const responseGeneration = lease.ownerRequestId;
    for (let index = 0; index < chunks.length; index += 1) {
      await lease.kv.set([...lease.responseKeyPrefix, responseGeneration, index], chunks[index], { expireIn: EMBEDDINGS_IDEMPOTENCY_RESPONSE_TTL_MS });
    }
    const bodyHash = await sha256Hex(body);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await lease.kv.get<EmbeddingsIdempotencyRecord>(lease.key);
      const record = normalizeEmbeddingsIdempotencyRecord(entry.value);
      if (!record) return false;
      if (
        record.fingerprint !== lease.fingerprint ||
        (record.state !== "reserved" && record.state !== "dispatched") ||
        record.owner_request_id !== lease.ownerRequestId
      ) {
        return false;
      }
      const now = Date.now();
      const succeeded: EmbeddingsIdempotencyRecord = {
        ...record,
        state: "succeeded",
        owner_request_id: null,
        updated_at_ms: now,
        lease_until_ms: null,
        response_status: response.status,
        response_content_type: response.headers.get("Content-Type") ?? "application/json",
        response_generation: responseGeneration,
        response_chunk_count: chunks.length,
        response_sha256: bodyHash,
      };
      const commit = await lease.kv.atomic().check(entry).set(lease.key, succeeded, { expireIn: EMBEDDINGS_IDEMPOTENCY_LEDGER_TTL_MS }).commit();
      if (commit.ok) return true;
    }
  } catch (error) {
    console.error("[ai.ubq.fi] embeddings idempotency response write failed:", error);
  }
  return false;
};

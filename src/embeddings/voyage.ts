import type { Kv, KvEntryMaybe, KvKey } from "#kv";
// Voyage embeddings transport, cache, rate limits and request parsing, extracted from src/openai.ts.

import { openaiError } from "../http.ts";
import { base64ToBytes, bytesToBase64, getString, isRecord } from "../utils.ts";
import { findUnknownKey } from "../openai.ts";
import { type UsageContext } from "../openai-telemetry.ts";
import {
  EMBEDDINGS_CACHE_EVICT_BATCH,
  EMBEDDINGS_CACHE_EVICT_MAX_BATCH,
  EMBEDDINGS_CACHE_QUOTA_MAX_RETRIES,
  EMBEDDINGS_MAX_CHARS_PER_INPUT,
  EMBEDDINGS_MAX_INPUTS_PER_REQUEST,
  EMBEDDINGS_MAX_TOTAL_CHARS,
  EMBEDDINGS_TIMEOUT_MS,
  type EmbeddingsEncodingFormat,
  type EmbeddingsJobInputRecord,
  type EmbeddingsParseResult,
  type ResolvedEmbeddingsProfile,
  UOS_EMBEDDINGS_JOB_ALLOWED_KEYS,
  UOS_SYNC_EMBEDDINGS_ALLOWED_KEYS,
  VOYAGE_API_KEY_KV_KEY,
  VOYAGE_DEFAULT_DIMENSIONS,
  VOYAGE_EMBEDDINGS_MODEL,
  VOYAGE_EMBEDDINGS_URL,
  VOYAGE_OUTPUT_DTYPE,
  VOYAGE_RATE_LIMIT_KEY,
  VOYAGE_RATE_LIMIT_RPM,
  VOYAGE_RATE_LIMIT_TPM,
  VOYAGE_SUPPORTED_DIMENSIONS,
  type VoyageEmbeddingsDimension,
  type VoyageEmbeddingsInputType,
  type VoyageEmbeddingsOutputDtype,
  type VoyageRateLimitState,
  embeddingsCacheGlobalIndexKey,
  embeddingsCacheGlobalIndexPrefix,
  embeddingsCacheIndexByHashKey,
  embeddingsCacheIndexKey,
  embeddingsCacheKey,
} from "./ledger.ts";

const normalizeEmbeddingsCacheTimestampMs = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const ts = Math.trunc(value);
  if (ts < 0) return null;
  return ts;
};

type EmbeddingsCacheEvictResult = Readonly<{
  evicted_embeddings: number;
  deleted_stale_index_keys: number;
}>;

const readEmbeddingsCacheErrorName = (error: unknown): string => {
  if (error === null || error === undefined) return "";
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
};

const readEmbeddingsCacheErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
};

const isEmbeddingsCacheQuotaError = (error: unknown): boolean => {
  const combined = `${readEmbeddingsCacheErrorName(error)} ${readEmbeddingsCacheErrorMessage(error)}`.toLowerCase();
  if (!combined) return false;
  return (
    combined.includes("quota") ||
    (combined.includes("insufficient") && combined.includes("storage")) ||
    (combined.includes("insufficient") && combined.includes("space")) ||
    combined.includes("no space") ||
    combined.includes("storage limit") ||
    (combined.includes("storage") && combined.includes("exceeded"))
  );
};

const writeEmbeddingsCacheEntry = async (
  kv: Kv,
  cacheProfileKey: string,
  hash: string,
  embedding: number[],
  createdAtMs: number
): Promise<{ isNew: boolean }> => {
  const byHashKey = embeddingsCacheIndexByHashKey(cacheProfileKey, hash);
  const cacheKey = embeddingsCacheKey(cacheProfileKey, hash);

  // Concurrency-safe: if multiple requests try to cache the same hash, only one
  // will win the "create index" CAS; the others will reuse the winner's index.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const entry = await kv.get<number>(byHashKey);
    const existingCreatedAtMs = normalizeEmbeddingsCacheTimestampMs(entry.value);
    if (existingCreatedAtMs !== null) {
      const indexKey = embeddingsCacheIndexKey(cacheProfileKey, existingCreatedAtMs, hash);
      const updated = await kv
        .atomic()
        .check(entry)
        .set(cacheKey, { embedding, created_at: new Date(existingCreatedAtMs).toISOString() })
        .set(indexKey, 1)
        .set(embeddingsCacheGlobalIndexKey(existingCreatedAtMs, cacheProfileKey, hash), 1)
        .commit();
      if (updated.ok) return { isNew: false };
      continue;
    }

    const createdAtIso = new Date(createdAtMs).toISOString();
    const indexKey = embeddingsCacheIndexKey(cacheProfileKey, createdAtMs, hash);
    const created = await kv
      .atomic()
      .check(entry)
      .set(cacheKey, { embedding, created_at: createdAtIso })
      .set(indexKey, 1)
      .set(embeddingsCacheGlobalIndexKey(createdAtMs, cacheProfileKey, hash), 1)
      .set(byHashKey, createdAtMs)
      .commit();
    if (created.ok) return { isNew: true };
    // CAS failed: `byHashKey` was updated/created in between, or was evicted and
    // recreated concurrently. Retry to reuse the now-canonical pointer.
  }
  return { isNew: false };
};

export const writeEmbeddingsCacheEntryBestEffort = async (
  kv: Kv,
  cacheProfileKey: string,
  hash: string,
  embedding: number[],
  createdAtMs: number,
  deadlineMs: number
): Promise<{ isNew: boolean }> => {
  let evictBatch = EMBEDDINGS_CACHE_EVICT_BATCH;
  // Attempts = 1 (initial write) + max retries.
  for (let attempt = 0; attempt <= EMBEDDINGS_CACHE_QUOTA_MAX_RETRIES; attempt += 1) {
    if (Date.now() >= deadlineMs) return { isNew: false };
    try {
      return await writeEmbeddingsCacheEntry(kv, cacheProfileKey, hash, embedding, createdAtMs);
    } catch (error) {
      if (!isEmbeddingsCacheQuotaError(error)) {
        console.warn("[ai.ubq.fi] embeddings_cache write failed:", error);
        return { isNew: false };
      }

      // KV rejected the write (likely storage quota). Evict the oldest entries
      // across every embedding profile so a newly introduced profile cannot be
      // starved by cache entries owned by another profile.
      try {
        const evicted = await evictOldestEmbeddingsCacheEntries(kv, evictBatch);
        console.warn(
          `[ai.ubq.fi] embeddings_cache quota eviction requesting_profile=${cacheProfileKey} scope=global evicted=${evicted.evicted_embeddings} stale_index_deleted=${evicted.deleted_stale_index_keys} batch=${evictBatch}`
        );
        if (evicted.evicted_embeddings <= 0 && evicted.deleted_stale_index_keys <= 0) return { isNew: false };
      } catch (evictError) {
        console.warn("[ai.ubq.fi] embeddings_cache quota eviction failed:", evictError);
        return { isNew: false };
      }

      evictBatch = Math.min(EMBEDDINGS_CACHE_EVICT_MAX_BATCH, evictBatch * 2);
    }
  }
  return { isNew: false };
};

const listEmbeddingsCacheEvictionCandidates = async (
  kv: Kv,
  count: number
): Promise<{ globalIndexKey: KvKey; cacheProfileKey: string; createdAtMs: number; hash: string }[]> => {
  const keys: {
    globalIndexKey: KvKey;
    cacheProfileKey: string;
    createdAtMs: number;
    hash: string;
  }[] = [];
  for await (const entry of kv.list({ prefix: embeddingsCacheGlobalIndexPrefix }, { limit: count })) {
    const key = entry.key;
    const hash = key.at(-1);
    const cacheProfileKey = key.at(-2);
    const createdAtMs = key.at(-3);
    if (typeof hash !== "string" || !hash) continue;
    if (typeof cacheProfileKey !== "string" || !cacheProfileKey) continue;
    if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) continue;
    keys.push({
      globalIndexKey: key,
      cacheProfileKey,
      createdAtMs: Math.trunc(createdAtMs),
      hash,
    });
  }
  return keys;
};

const evictEmbeddingsCacheCandidate = async (
  kv: Kv,
  candidate: { globalIndexKey: KvKey; cacheProfileKey: string; createdAtMs: number; hash: string },
  pointerEntry: KvEntryMaybe<number>
): Promise<{ evicted: boolean; deletedStaleIndexKey: boolean }> => {
  const { globalIndexKey, cacheProfileKey, createdAtMs, hash } = candidate;
  const pointer = normalizeEmbeddingsCacheTimestampMs(pointerEntry.value);
  const cacheKey = embeddingsCacheKey(cacheProfileKey, hash);
  const profileIndexKey = embeddingsCacheIndexKey(cacheProfileKey, createdAtMs, hash);

  if (pointer !== null && pointer !== createdAtMs) {
    // Stale duplicate index keys for this hash; delete only the indexes.
    const deleted = await kv.atomic().check(pointerEntry).delete(globalIndexKey).delete(profileIndexKey).commit();
    return { evicted: false, deletedStaleIndexKey: deleted.ok };
  }

  if (pointer === null) {
    // Missing pointer (legacy / partial state): only delete the embedding value
    // if it still matches the index timestamp to avoid deleting a newer cache
    // entry that happens to share the same hash.
    const valueEntry = await kv.get<{ created_at?: unknown }>(cacheKey);
    const value = valueEntry.value;
    const createdAtIso = isRecord(value) && typeof value.created_at === "string" ? value.created_at : null;
    const expectedIso = new Date(createdAtMs).toISOString();
    if (createdAtIso !== expectedIso) {
      const deleted = await kv.atomic().check(pointerEntry).delete(globalIndexKey).delete(profileIndexKey).commit();
      return { evicted: false, deletedStaleIndexKey: deleted.ok };
    }

    const commit = await kv.atomic().check(pointerEntry).delete(globalIndexKey).delete(profileIndexKey).delete(cacheKey).commit();
    return { evicted: commit.ok, deletedStaleIndexKey: false };
  }

  // Canonical pointer match: evict embedding + index + pointer as an atomic unit.
  const commit = await kv
    .atomic()
    .check(pointerEntry)
    .delete(globalIndexKey)
    .delete(profileIndexKey)
    .delete(cacheKey)
    .delete(embeddingsCacheIndexByHashKey(cacheProfileKey, hash))
    .commit();
  return { evicted: commit.ok, deletedStaleIndexKey: false };
};

const evictOldestEmbeddingsCacheEntries = async (kv: Kv, count: number): Promise<EmbeddingsCacheEvictResult> => {
  const candidates = await listEmbeddingsCacheEvictionCandidates(kv, count);
  if (!candidates.length) return { evicted_embeddings: 0, deleted_stale_index_keys: 0 };

  const byHashEntries = await Promise.all(
    candidates.map((candidate) => kv.get<number>(embeddingsCacheIndexByHashKey(candidate.cacheProfileKey, candidate.hash)))
  );

  let evictedEmbeddings = 0;
  let deletedStaleIndexKeys = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const outcome = await evictEmbeddingsCacheCandidate(kv, candidates[i], byHashEntries[i]);
    if (outcome.evicted) evictedEmbeddings += 1;
    if (outcome.deletedStaleIndexKey) deletedStaleIndexKeys += 1;
  }
  return { evicted_embeddings: evictedEmbeddings, deleted_stale_index_keys: deletedStaleIndexKeys };
};

export const resolveEmbeddingsJobTokenSeed = (jobId: string, authToken: string | null, usageContext?: UsageContext): string => {
  // Prefer stable identities so queued jobs remain resolvable even if bearer tokens refresh/rotate.
  if (usageContext?.keyId) return `uos_api_key_id:${usageContext.keyId}`;
  if (usageContext?.kernelRepo) {
    return `uos_kernel_repo:${usageContext.kernelRepo.owner}/${usageContext.kernelRepo.repo}`;
  }
  if (authToken) return authToken;
  return jobId;
};

const TOKEN_ESTIMATOR = new TextEncoder();

export const getEnv = (key: string): string | undefined => {
  try {
    return process.env[key];
  } catch {
    return undefined;
  }
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<boolean> => {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
};

export const estimateTokens = (text: string): number => {
  if (!text) return 0;
  const bytes = TOKEN_ESTIMATOR.encode(text).byteLength;
  return Math.ceil(bytes / 4);
};

export const estimateTokenCount = (texts: string[]): number => texts.reduce((sum, text) => sum + estimateTokens(text), 0);

export const chunkByTokenBudget = (
  items: readonly { hash: string; text: string }[],
  maxItems: number,
  maxTokens: number
): { hash: string; text: string }[][] => {
  const out: { hash: string; text: string }[][] = [];
  const itemLimit = Math.max(1, Math.trunc(maxItems));
  const tokenLimit = Math.max(1, Math.trunc(maxTokens));

  let current: { hash: string; text: string }[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const tokens = estimateTokens(item.text);
    const nextTokens = currentTokens + tokens;
    const hitsItemLimit = current.length >= itemLimit;
    const hitsTokenLimit = nextTokens > tokenLimit && current.length > 0;
    if (hitsItemLimit || hitsTokenLimit) {
      out.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += tokens;
  }
  if (current.length) out.push(current);
  return out;
};

const normalizeVoyageRateLimitState = (value: unknown): VoyageRateLimitState | null => {
  if (!isRecord(value)) return null;
  const windowStart = typeof value.window_start_ms === "number" && Number.isFinite(value.window_start_ms) ? Math.trunc(value.window_start_ms) : null;
  const requests = typeof value.requests === "number" && Number.isFinite(value.requests) ? Math.trunc(value.requests) : null;
  const tokens = typeof value.tokens === "number" && Number.isFinite(value.tokens) ? Math.trunc(value.tokens) : null;
  if (windowStart === null || requests === null || tokens === null) return null;
  if (windowStart < 0 || requests < 0 || tokens < 0) return null;
  return { window_start_ms: windowStart, requests, tokens };
};

const wouldExceedVoyageRateLimit = (limit: number, wouldBeUsed: number): boolean => limit > 0 && wouldBeUsed > limit;

export const tryReserveVoyageBudget = async (kv: Kv, tokens: number): Promise<{ ok: true } | { ok: false; wait_ms: number }> => {
  const windowMs = 60_000;
  const now = Date.now();
  const entry = await kv.get<VoyageRateLimitState>(VOYAGE_RATE_LIMIT_KEY);
  const current = normalizeVoyageRateLimitState(entry.value);
  const state = !current || now - current.window_start_ms >= windowMs ? { window_start_ms: now, requests: 0, tokens: 0 } : current;

  const wouldExceedRequests = wouldExceedVoyageRateLimit(VOYAGE_RATE_LIMIT_RPM, state.requests + 1);
  const wouldExceedTokens = wouldExceedVoyageRateLimit(VOYAGE_RATE_LIMIT_TPM, state.tokens + tokens);
  if (wouldExceedRequests || wouldExceedTokens) {
    const waitMs = Math.max(0, windowMs - (now - state.window_start_ms));
    return { ok: false, wait_ms: waitMs };
  }

  const next: VoyageRateLimitState = {
    window_start_ms: state.window_start_ms,
    requests: state.requests + 1,
    tokens: state.tokens + tokens,
  };
  const commit = await kv.atomic().check(entry).set(VOYAGE_RATE_LIMIT_KEY, next).commit();
  if (commit.ok) return { ok: true };
  return { ok: false, wait_ms: 0 };
};

const tryReserveVoyageBudgetWithRetries = async (kv: Kv, tokens: number): Promise<{ ok: true } | { ok: false; wait_ms: number }> => {
  let reserved: { ok: true } | { ok: false; wait_ms: number } = { ok: false, wait_ms: 0 };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    reserved = await tryReserveVoyageBudget(kv, tokens);
    if (reserved.ok) return reserved;
    if (reserved.wait_ms > 0) break;
    await sleep(5 + attempt * 5);
  }
  return reserved;
};

export const applyVoyageRateLimit = async (kv: Kv, tokens: number, deadlineMs: number): Promise<{ ok: true } | { ok: false; wait_ms: number }> => {
  // Best-effort concurrency-safe rate limiting using KV. If we can't reserve
  // within the request deadline, we fail with 429 and let clients retry.
  for (;;) {
    const now = Date.now();
    if (now >= deadlineMs) return { ok: false, wait_ms: 0 };
    const reserved = await tryReserveVoyageBudgetWithRetries(kv, tokens);
    if (reserved.ok) return reserved;
    const waitMs = reserved.wait_ms;
    if (waitMs <= 0) {
      // CAS contention without a concrete rate-limit wait; avoid tight spinning.
      const now2 = Date.now();
      const sleepMs = Math.min(25, Math.max(0, deadlineMs - now2));
      if (sleepMs > 0) await sleep(sleepMs);
      continue;
    }
    if (now + waitMs > deadlineMs) return { ok: false, wait_ms: waitMs };
    await sleep(waitMs);
  }
};

const parseEmbeddingsEncodingFormat = (value: unknown): { ok: true; value: EmbeddingsEncodingFormat } | { ok: false; message: string } => {
  if (value === undefined) return { ok: true, value: "float" };
  if (typeof value !== "string") return { ok: false, message: "encoding_format must be a string" };
  if (value === "float" || value === "base64") return { ok: true, value };
  return { ok: false, message: 'encoding_format must be one of: "float", "base64"' };
};

const parseEmbeddingsDimensions = (value: unknown): { ok: true; value: VoyageEmbeddingsDimension } | { ok: false; message: string } => {
  if (value === undefined) return { ok: true, value: VOYAGE_DEFAULT_DIMENSIONS };
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, message: "dimensions must be an integer" };
  }
  if (!VOYAGE_SUPPORTED_DIMENSIONS.has(value)) {
    return { ok: false, message: "dimensions must be one of: 256, 512, 1024, 2048" };
  }
  return { ok: true, value: value as VoyageEmbeddingsDimension };
};

const buildEmbeddingsCacheProfileKey = (
  inputType: VoyageEmbeddingsInputType,
  dimensions: VoyageEmbeddingsDimension,
  encodingFormat: EmbeddingsEncodingFormat,
  truncation: boolean
): string => JSON.stringify(["voyage-profile-v2", VOYAGE_EMBEDDINGS_MODEL, inputType, dimensions, VOYAGE_OUTPUT_DTYPE, encodingFormat, truncation]);

const buildResolvedEmbeddingsProfile = (
  inputType: VoyageEmbeddingsInputType,
  dimensions: VoyageEmbeddingsDimension,
  encodingFormat: EmbeddingsEncodingFormat,
  truncation: boolean
): ResolvedEmbeddingsProfile => ({
  upstream: "voyage",
  upstream_model: VOYAGE_EMBEDDINGS_MODEL,
  input_type: inputType,
  dimensions,
  output_dtype: VOYAGE_OUTPUT_DTYPE,
  encoding_format: encodingFormat,
  truncation,
  cache_profile_key: buildEmbeddingsCacheProfileKey(inputType, dimensions, encodingFormat, truncation),
});

const embeddingsUserFieldError = (rawBody: Record<string, unknown>, isJob: boolean): Response | null => {
  if (isJob || !Object.prototype.hasOwnProperty.call(rawBody, "user")) return null;
  const user = rawBody.user;
  if (user === undefined || user === null || typeof user === "string") return null;
  return openaiError(400, "user must be a string", "invalid_request_error", { param: "user" });
};

const resolveEmbeddingsInputTypeField = (
  rawInputType: unknown,
  isJob: boolean
): { ok: true; value: VoyageEmbeddingsInputType } | { ok: false; response: Response } => {
  if (rawInputType === undefined) {
    if (isJob) {
      return {
        ok: false,
        response: openaiError(400, 'input_type is required and must be one of: "query", "document"', "invalid_request_error", {
          param: "input_type",
        }),
      };
    }
    return { ok: true, value: "document" };
  }
  if (rawInputType === "query" || rawInputType === "document") {
    return { ok: true, value: rawInputType };
  }
  return {
    ok: false,
    response: openaiError(400, 'input_type must be one of: "query", "document"', "invalid_request_error", { param: "input_type" }),
  };
};

const parseEmbeddingsTruncationField = (rawTruncation: unknown): { ok: true; value: boolean } | { ok: false; response: Response } => {
  if (rawTruncation !== undefined && typeof rawTruncation !== "boolean") {
    return {
      ok: false,
      response: openaiError(400, "truncation must be a boolean", "invalid_request_error", {
        param: "truncation",
      }),
    };
  }
  return { ok: true, value: rawTruncation ?? true };
};

const parseEmbeddingsInputList = (inputRaw: unknown): { ok: true; value: string[] } | { ok: false; response: Response } => {
  if (typeof inputRaw === "string") {
    return { ok: true, value: [inputRaw] };
  }
  if (!Array.isArray(inputRaw)) {
    return {
      ok: false,
      response: openaiError(400, "input must be a string or an array of strings", "invalid_request_error", {
        param: "input",
      }),
    };
  }
  const inputs: string[] = [];
  for (const item of inputRaw) {
    if (typeof item !== "string") {
      return {
        ok: false,
        response: openaiError(400, "input must be a string or an array of strings", "invalid_request_error", {
          param: "input",
        }),
      };
    }
    inputs.push(item);
  }
  return { ok: true, value: inputs };
};

const measureEmbeddingsInputs = (inputs: string[]): { ok: true; totalChars: number } | { ok: false; response: Response } => {
  if (inputs.length === 0) {
    return {
      ok: false,
      response: openaiError(400, "input must be a non-empty string or a non-empty array", "invalid_request_error", { param: "input" }),
    };
  }
  if (inputs.length > EMBEDDINGS_MAX_INPUTS_PER_REQUEST) {
    return {
      ok: false,
      response: openaiError(400, `Too many inputs: ${inputs.length} (max ${EMBEDDINGS_MAX_INPUTS_PER_REQUEST})`, "invalid_request_error", { param: "input" }),
    };
  }

  let totalChars = 0;
  for (const text of inputs) {
    const len = text.length;
    if (len > EMBEDDINGS_MAX_CHARS_PER_INPUT) {
      return {
        ok: false,
        response: openaiError(400, `Input too large: ${len} chars (max ${EMBEDDINGS_MAX_CHARS_PER_INPUT})`, "invalid_request_error", { param: "input" }),
      };
    }
    totalChars += len;
    if (totalChars > EMBEDDINGS_MAX_TOTAL_CHARS) {
      return {
        ok: false,
        response: openaiError(400, `Request too large: ${totalChars} chars total (max ${EMBEDDINGS_MAX_TOTAL_CHARS})`, "invalid_request_error", {
          param: "input",
        }),
      };
    }
    const tokenEstimate = estimateTokens(text);
    if (tokenEstimate > VOYAGE_RATE_LIMIT_TPM) {
      return {
        ok: false,
        response: openaiError(
          400,
          `Input too large for embeddings provider: ~${tokenEstimate} tokens (max ${VOYAGE_RATE_LIMIT_TPM}).`,
          "invalid_request_error",
          { param: "input" }
        ),
      };
    }
  }

  return { ok: true, totalChars };
};

const parseEmbeddingsRequest = (rawBody: Record<string, unknown>, contract: "uos_sync" | "uos_job"): EmbeddingsParseResult => {
  const isJob = contract === "uos_job";
  const allowedKeys = isJob ? UOS_EMBEDDINGS_JOB_ALLOWED_KEYS : UOS_SYNC_EMBEDDINGS_ALLOWED_KEYS;
  const unknownKey = findUnknownKey(rawBody, allowedKeys);
  if (unknownKey) {
    return {
      ok: false,
      response: openaiError(400, `Unrecognized request argument supplied: ${unknownKey}`, "invalid_request_error"),
    };
  }

  const modelRaw = getString(rawBody.model);
  if (!modelRaw?.trim()) {
    return {
      ok: false,
      response: openaiError(400, "model is required and must be a non-empty string", "invalid_request_error", {
        param: "model",
      }),
    };
  }
  const model = modelRaw;
  if (model !== VOYAGE_EMBEDDINGS_MODEL) {
    return {
      ok: false,
      response: openaiError(400, `Unsupported embedding model: ${model}`, "model_not_found", { param: "model" }),
    };
  }

  const dimensions = parseEmbeddingsDimensions(rawBody.dimensions);
  if (!dimensions.ok) {
    return {
      ok: false,
      response: openaiError(400, dimensions.message, "invalid_request_error", { param: "dimensions" }),
    };
  }

  const encodingFormat = parseEmbeddingsEncodingFormat(rawBody.encoding_format);
  if (!encodingFormat.ok) {
    return {
      ok: false,
      response: openaiError(400, encodingFormat.message, "invalid_request_error", { param: "encoding_format" }),
    };
  }
  if (isJob && encodingFormat.value !== "float") {
    return {
      ok: false,
      response: openaiError(400, 'encoding_format must be "float" for embeddings jobs', "invalid_request_error", { param: "encoding_format" }),
    };
  }

  const inputType = resolveEmbeddingsInputTypeField(rawBody.input_type, isJob);
  if (!inputType.ok) return inputType;

  const truncation = parseEmbeddingsTruncationField(rawBody.truncation);
  if (!truncation.ok) return truncation;

  const userError = embeddingsUserFieldError(rawBody, isJob);
  if (userError) return { ok: false, response: userError };

  const parsedInputs = parseEmbeddingsInputList(rawBody.input);
  if (!parsedInputs.ok) return parsedInputs;

  const measured = measureEmbeddingsInputs(parsedInputs.value);
  if (!measured.ok) return measured;

  return {
    ok: true,
    value: {
      model,
      inputs: parsedInputs.value,
      total_chars: measured.totalChars,
      profile: buildResolvedEmbeddingsProfile(inputType.value, dimensions.value, encodingFormat.value, truncation.value),
    },
  };
};

export const parseUosEmbeddingsRequest = (rawBody: Record<string, unknown>): EmbeddingsParseResult => parseEmbeddingsRequest(rawBody, "uos_sync");

export const parseEmbeddingsJobRequest = (rawBody: Record<string, unknown>): EmbeddingsParseResult => parseEmbeddingsRequest(rawBody, "uos_job");

export const isValidEmbeddingVector = (value: unknown, dimensions: VoyageEmbeddingsDimension): value is number[] =>
  Array.isArray(value) && value.length === dimensions && value.every((item) => typeof item === "number" && Number.isFinite(item));

export const floatEmbeddingToBase64 = (embedding: number[]): string => {
  const buffer = new ArrayBuffer(embedding.length * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < embedding.length; i += 1) {
    view.setFloat32(i * 4, embedding[i], true);
  }
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // Avoid large variadic calls and quadratic string concatenation.
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
};

export const normalizeEmbeddingsJobInputRecord = (value: unknown): EmbeddingsJobInputRecord | null => {
  if (!isRecord(value)) return null;
  const v = value.v;
  if (v !== 1) return null;
  const iv = getString(value.iv_b64);
  const data = getString(value.data_b64);
  if (!iv || !data) return null;
  const createdAt = typeof value.created_at_ms === "number" && Number.isFinite(value.created_at_ms) ? Math.trunc(value.created_at_ms) : null;
  if (createdAt === null || createdAt < 0) return null;
  return { v: 1, iv_b64: iv, data_b64: data, created_at_ms: createdAt };
};

const importEmbeddingsJobKey = async (tokenSeed: string): Promise<CryptoKey> => {
  const material = new TextEncoder().encode(`uos_embeddings_job_v2:${tokenSeed}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
};

export const encryptEmbeddingsJobInput = async (tokenSeed: string, text: string): Promise<EmbeddingsJobInputRecord> => {
  const key = await importEmbeddingsJobKey(tokenSeed);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(text);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return {
    v: 1,
    iv_b64: bytesToBase64(iv),
    data_b64: bytesToBase64(new Uint8Array(encrypted)),
    created_at_ms: Date.now(),
  };
};

export const decryptEmbeddingsJobInput = async (tokenSeed: string, record: EmbeddingsJobInputRecord): Promise<string | null> => {
  const iv = base64ToBytes(record.iv_b64);
  const data = base64ToBytes(record.data_b64);
  if (!iv || !data) return null;
  try {
    const key = await importEmbeddingsJobKey(tokenSeed);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(new Uint8Array(decrypted));
  } catch {
    return null;
  }
};

const extractRetryAfterMs = (value: string | null): number | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(60_000, Math.trunc(seconds * 1000));
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    if (delta > 0) return Math.min(60_000, Math.trunc(delta));
  }
  return null;
};

export const readVoyageApiKey = async (kv: Kv | null): Promise<string | null> => {
  const envKey = (getEnv("VOYAGEAI_API_KEY") ?? "").trim();
  if (envKey) return envKey;
  if (!kv) return null;
  const entry = await kv.get<string>(VOYAGE_API_KEY_KV_KEY);
  const kvKey = typeof entry.value === "string" ? entry.value.trim() : "";
  return kvKey || null;
};

const parseVoyageEmbeddingVector = (embedding: unknown): number[] => {
  if (!Array.isArray(embedding)) {
    throw new Error("Voyage embeddings response missing embedding vector.");
  }
  const vec: number[] = [];
  for (const v of embedding) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error("Voyage embeddings response contained non-numeric values.");
    }
    vec.push(v);
  }
  return vec;
};

const parseVoyageEmbeddingsPayload = (payload: unknown): { vectors: number[][]; totalTokens: number | null } => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Voyage embeddings returned invalid JSON.");
  }

  let totalTokens: number | null = null;
  if (isRecord(payload.usage)) {
    const rawTotalTokens = payload.usage.total_tokens;
    if (typeof rawTotalTokens === "number" && Number.isFinite(rawTotalTokens)) {
      totalTokens = Math.max(0, Math.trunc(rawTotalTokens));
    }
  }

  const data = payload.data as Record<string, unknown>[];
  const vectors: number[][] = [];
  for (const item of data) {
    const embedding = isRecord(item) ? item.embedding : null;
    vectors.push(parseVoyageEmbeddingVector(embedding));
  }
  return { vectors, totalTokens };
};

export const fetchVoyageEmbeddings = async (params: {
  apiKey: string;
  model: "voyage-4-large";
  inputs: string[];
  inputType: VoyageEmbeddingsInputType;
  dimensions: VoyageEmbeddingsDimension;
  outputDtype: VoyageEmbeddingsOutputDtype;
  truncation: boolean;
  deadlineMs: number;
  downstreamSignal?: AbortSignal;
  beforeProviderDispatch?: NonNullable<UsageContext["beforeProviderDispatch"]>;
}): Promise<{ vectors: number[][]; totalTokens: number | null }> => {
  const controller = new AbortController();
  const signal = params.downstreamSignal ? AbortSignal.any([controller.signal, params.downstreamSignal]) : controller.signal;
  const now = Date.now();
  const timeoutMs = Math.max(1, Math.min(EMBEDDINGS_TIMEOUT_MS, params.deadlineMs - now));
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const dispatch = params.beforeProviderDispatch ? await params.beforeProviderDispatch("voyage") : undefined;
    if (signal.aborted) {
      await dispatch?.cancelBeforeTransport();
      throw signal.reason ?? new DOMException("The request was aborted.", "AbortError");
    }
    dispatch?.markTransportStarted();
    const resp = await fetch(VOYAGE_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: params.model,
        input: params.inputs.length === 1 ? params.inputs[0] : params.inputs,
        input_type: params.inputType,
        output_dimension: params.dimensions,
        output_dtype: params.outputDtype,
        truncation: params.truncation,
      }),
      signal,
    });

    if (!resp.ok) {
      // Avoid echoing upstream bodies; they can contain provider details and may be surfaced to clients/logs.
      const err = new Error(`Voyage embeddings failed (${resp.status}).`);
      (err as { status?: number; retry_after_ms?: number }).status = resp.status;
      (err as { retry_after_ms?: number }).retry_after_ms = extractRetryAfterMs(resp.headers.get("Retry-After")) ?? undefined;
      throw err;
    }

    const payload = (await resp.json().catch(() => null)) as unknown;
    return parseVoyageEmbeddingsPayload(payload);
  } finally {
    clearTimeout(timeout);
  }
};

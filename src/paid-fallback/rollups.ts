import type { Kv, KvKey } from "#kv";
import { getKv } from "../kv.ts";
import { isRecord } from "../utils.ts";

/**
 * Compact per-hour usage rollups for every terminal inference route.
 *
 * Raw paid-fallback request rows are retained for a bounded window
 * (PAID_FALLBACK_REQUEST_LOG_RETENTION_MS); these hour×model×provider
 * aggregates are retained indefinitely so long-run research and quota-runway
 * estimates survive row expiry. Every settled paid-fallback request
 * contributes exactly one rollup update from the settlement atomic, so its
 * quota and spend sums are authoritative for settled traffic. The
 * subscription-capacity route (and every other route that never settles
 * through the paid ledger) contributes one accounting observation per
 * terminal response that observed token usage, with zero quota and spend, so
 * the projection can show per-model usage across the whole waterfall instead
 * of paid spend alone. `PAID_FALLBACK_SETTLED_PROVIDERS` are skipped by that
 * observation writer so a settled request can never be counted twice, and a
 * response whose usage was never observed is not recorded at all: a missing
 * measurement must never become a fabricated zero-token row.
 *
 * The hourly key is sharded by request id so concurrent settlements of the
 * same model/provider never contend on one KV key inside the settlement
 * atomic; readers sum all shards when aggregating.
 */
export const PAID_FALLBACK_USAGE_ROLLUP_PREFIX = ["uos_ai", "paid_fallback", "v3", "usage_rollup"] as const;
export const PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS = 60 * 60 * 1_000;
export const PAID_FALLBACK_USAGE_ROLLUP_SHARD_COUNT = 16;

const FNV_PRIME = 0x01000193;

/**
 * Deterministic shard for a request id: spreads concurrent settlements of one
 * model/provider across PAID_FALLBACK_USAGE_ROLLUP_SHARD_COUNT keys while
 * keeping every settlement of the same request on one key.
 */
export const paidFallbackUsageRollupShard = (requestId: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < requestId.length; index += 1) {
    hash ^= requestId.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash % PAID_FALLBACK_USAGE_ROLLUP_SHARD_COUNT;
};

/**
 * Providers whose usage the paid-fallback ledger already folds into these
 * rollups inside its settlement atomic. `PaidFallbackProvider` is exactly
 * `"metered" | "surplus"`, and both the live settlement
 * (`prepareSettlementRollupV3`) and the historical backfill
 * (`foldRequestRowIntoRollupV3`, where a legacy row without a provider label
 * defaults to `metered`) write rows under those two labels.
 * `recordTerminalUsageRollup` skips them: a terminal observation would
 * otherwise count the same request twice.
 */
export const PAID_FALLBACK_SETTLED_PROVIDERS: ReadonlySet<string> = new Set(["metered", "surplus"]);

export type PaidFallbackUsageRollup = Readonly<{
  v: 1;
  bucket_start_at_ms: number;
  model: string;
  provider: string;
  request_count: number;
  quota_sum: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  spend_microcredits: number;
  first_request_at_ms: number;
  last_request_at_ms: number;
  updated_at_ms: number;
}>;

export type PaidFallbackUsageRollupInput = Readonly<{
  bucket_start_at_ms: number;
  model: string;
  provider: string;
  request_id: string;
  quota: number;
  input_tokens: number;
  cached_input_tokens: number | null;
  output_tokens: number;
  spend_microcredits: number;
  request_created_at_ms: number;
  updated_at_ms: number;
}>;

/**
 * One terminal inference response observed by the gateway. `model` and
 * `provider` are nullable because a rejection that never dispatched an
 * upstream still reaches the terminal log; the writer skips those. Token
 * counts are nullable because an aborted, rejected or unmeasured response
 * never observed usage, and the writer skips an unobserved response instead
 * of recording fabricated zeros.
 */
export type TerminalUsageRollupInput = Readonly<{
  model: string | null;
  provider: string | null;
  request_id: string;
  request_created_at_ms?: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
}>;

const safeInteger = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;

const nonNegativeFinite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export const isPaidFallbackUsageRollup = (value: unknown): value is PaidFallbackUsageRollup => {
  if (!isRecord(value)) return false;
  return (
    value.v === 1 &&
    safeInteger(value.bucket_start_at_ms) &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    safeInteger(value.request_count) &&
    nonNegativeFinite(value.quota_sum) &&
    safeInteger(value.input_tokens) &&
    safeInteger(value.cached_input_tokens) &&
    safeInteger(value.output_tokens) &&
    nonNegativeFinite(value.spend_microcredits) &&
    safeInteger(value.first_request_at_ms) &&
    safeInteger(value.last_request_at_ms) &&
    safeInteger(value.updated_at_ms)
  );
};

export const paidFallbackUsageRollupKey = (bucketStartAtMs: number, model: string, provider: string, shard: number): KvKey => [
  ...PAID_FALLBACK_USAGE_ROLLUP_PREFIX,
  bucketStartAtMs,
  model,
  provider,
  shard,
];

/**
 * Merges one settled request into an existing/hour bucket. Pure so tests can
 * assert sums without a KV backend.
 */
export const mergePaidFallbackUsageRollup = (existing: PaidFallbackUsageRollup | null, input: PaidFallbackUsageRollupInput): PaidFallbackUsageRollup => {
  const firstRequestAtMs = existing ? Math.min(existing.first_request_at_ms, input.request_created_at_ms) : input.request_created_at_ms;
  const lastRequestAtMs = existing ? Math.max(existing.last_request_at_ms, input.request_created_at_ms) : input.request_created_at_ms;
  return {
    v: 1,
    bucket_start_at_ms: existing?.bucket_start_at_ms ?? input.bucket_start_at_ms,
    model: existing?.model ?? input.model,
    provider: existing?.provider ?? input.provider,
    request_count: (existing?.request_count ?? 0) + 1,
    quota_sum: (existing?.quota_sum ?? 0) + input.quota,
    input_tokens: (existing?.input_tokens ?? 0) + input.input_tokens,
    cached_input_tokens: (existing?.cached_input_tokens ?? 0) + (input.cached_input_tokens ?? 0),
    output_tokens: (existing?.output_tokens ?? 0) + input.output_tokens,
    spend_microcredits: (existing?.spend_microcredits ?? 0) + input.spend_microcredits,
    first_request_at_ms: firstRequestAtMs,
    last_request_at_ms: lastRequestAtMs,
    updated_at_ms: input.updated_at_ms,
  };
};

const MAX_TERMINAL_USAGE_ROLLUP_WRITE_ATTEMPTS = 3;

/**
 * A token count exactly as observed. Anything else -- a missing field, an
 * invalid value or a fraction -- stays unknown rather than becoming zero.
 */
const observedTokenCount = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
};

/**
 * Folds one terminal inference observation into the hourly rollup.
 *
 * This is the accounting path for traffic that never settles through the
 * paid-fallback ledger, which is the Codex subscription capacity first:
 * without it the projection would count paid spend alone. Providers the
 * settlement already writes are skipped (see
 * `PAID_FALLBACK_SETTLED_PROVIDERS`), and the aggregate labels `gateway`
 * (no upstream dispatched) and `mixed` (more than one route served an image
 * fanout) are not routes, so they are skipped too. A response that never
 * observed its input or output tokens is also skipped: the rollup carries
 * actual known usage, and a missing measurement must not become a zero.
 * Observations carry no quota or spend, so the paid balance runway is never
 * inflated.
 *
 * The write is bounded and best effort: it returns false when the identity or
 * observed usage is missing, KV is unavailable, or every read-merge-write
 * attempt loses its compare-and-set race. A terminal response is already
 * final, so callers on that path swallow failures instead of surfacing them.
 */
export const recordTerminalUsageRollup = async (input: TerminalUsageRollupInput, kvOverride?: Kv | null): Promise<boolean> => {
  const model = input.model?.trim() ?? "";
  const provider = input.provider?.trim() ?? "";
  if (!model || !provider || provider === "gateway" || provider === "mixed" || PAID_FALLBACK_SETTLED_PROVIDERS.has(provider)) return false;
  const inputTokens = observedTokenCount(input.input_tokens);
  const outputTokens = observedTokenCount(input.output_tokens);
  // The route is real but the response never reported the two core token
  // counts, so there is no observed usage to record. A fabricated zero row
  // would understate consumption and claim a measurement that never happened.
  if (inputTokens === null || outputTokens === null) return false;
  const kv = kvOverride === undefined ? await getKv() : kvOverride;
  if (!kv) return false;
  const requestId = input.request_id.trim() || crypto.randomUUID();
  const nowMs = Date.now();
  const requestedCreatedAtMs = input.request_created_at_ms;
  const requestCreatedAtMs =
    typeof requestedCreatedAtMs === "number" && Number.isFinite(requestedCreatedAtMs) ? Math.max(0, Math.trunc(requestedCreatedAtMs)) : nowMs;
  const bucketStartAtMs = Math.floor(requestCreatedAtMs / PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS) * PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS;
  const rollupKey = paidFallbackUsageRollupKey(bucketStartAtMs, model, provider, paidFallbackUsageRollupShard(requestId));
  const cachedInputTokens = observedTokenCount(input.cached_input_tokens);
  for (let attempt = 0; attempt < MAX_TERMINAL_USAGE_ROLLUP_WRITE_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<PaidFallbackUsageRollup>(rollupKey, { consistency: "strong" });
    const existing = isPaidFallbackUsageRollup(entry.value) ? entry.value : null;
    const next = mergePaidFallbackUsageRollup(existing, {
      bucket_start_at_ms: bucketStartAtMs,
      request_id: requestId,
      model,
      provider,
      quota: 0,
      input_tokens: inputTokens,
      cached_input_tokens: cachedInputTokens,
      output_tokens: outputTokens,
      spend_microcredits: 0,
      request_created_at_ms: requestCreatedAtMs,
      updated_at_ms: nowMs,
    });
    const commit = await kv.atomic().check(entry).set(rollupKey, next).commit();
    if (commit.ok) return true;
  }
  return false;
};

export const listPaidFallbackUsageRollups = async (
  kv: Kv | null,
  options: Readonly<{ sinceMs: number; nowMs: number }>
): Promise<PaidFallbackUsageRollup[]> => {
  if (!kv) return [];
  const entries: PaidFallbackUsageRollup[] = [];
  // Floor the scan start to the hour boundary so the bucket that contains the
  // window start is never excluded (bucket-level precision is documented).
  const start: KvKey = [
    ...PAID_FALLBACK_USAGE_ROLLUP_PREFIX,
    Math.floor(Math.max(0, Math.trunc(options.sinceMs)) / PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS) * PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS,
  ];
  const end: KvKey = [...PAID_FALLBACK_USAGE_ROLLUP_PREFIX, Math.trunc(options.nowMs) + PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS];
  // Deno KV rejects selectors that combine a prefix with both range bounds.
  // These bounds already include the complete rollup namespace.
  for await (const entry of kv.list<PaidFallbackUsageRollup>({ start, end })) {
    const rollup = isPaidFallbackUsageRollup(entry.value) ? entry.value : null;
    if (rollup) entries.push(rollup);
  }
  return entries;
};

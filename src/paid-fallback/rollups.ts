import type { Kv, KvKey } from "#kv";
import { getKv } from "../kv.ts";
import {
  PAID_FALLBACK_USAGE_ROLLUP_PREFIX,
  PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS,
  PAID_FALLBACK_USAGE_ROLLUP_SHARD_COUNT,
  PAID_FALLBACK_SETTLED_PROVIDERS,
  paidFallbackUsageRollupShard,
  paidFallbackUsageRollupKey,
  isPaidFallbackUsageRollup,
  mergePaidFallbackUsageRollup,
  paidFallbackTerminalUsageV3,
  paidFallbackTerminalRollupV3,
} from "../authority/native-paid.ts";
import type { PaidFallbackUsageRollup, PaidFallbackUsageRollupInput, TerminalUsageRollupInput } from "../authority/native-paid-contracts.ts";
export {
  PAID_FALLBACK_USAGE_ROLLUP_PREFIX,
  PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS,
  PAID_FALLBACK_USAGE_ROLLUP_SHARD_COUNT,
  PAID_FALLBACK_SETTLED_PROVIDERS,
  paidFallbackUsageRollupShard,
  paidFallbackUsageRollupKey,
  isPaidFallbackUsageRollup,
  mergePaidFallbackUsageRollup,
};
export type { PaidFallbackUsageRollup, PaidFallbackUsageRollupInput, TerminalUsageRollupInput };
const MAX_TERMINAL_USAGE_ROLLUP_WRITE_ATTEMPTS = 3;

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
  const usage = paidFallbackTerminalUsageV3(input);
  if (!usage) return false;
  const { model, provider } = usage;
  const kv = kvOverride === undefined ? await getKv() : kvOverride;
  if (!kv) return false;
  const requestId = input.request_id.trim() || crypto.randomUUID();
  const nowMs = Date.now();
  const rollupInput = paidFallbackTerminalRollupV3(input, usage, requestId, nowMs);
  const rollupKey = paidFallbackUsageRollupKey(rollupInput.bucket_start_at_ms, model, provider, paidFallbackUsageRollupShard(requestId));
  for (let attempt = 0; attempt < MAX_TERMINAL_USAGE_ROLLUP_WRITE_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<PaidFallbackUsageRollup>(rollupKey, { consistency: "strong" });
    const existing = isPaidFallbackUsageRollup(entry.value) ? entry.value : null;
    const next = mergePaidFallbackUsageRollup(existing, rollupInput);
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

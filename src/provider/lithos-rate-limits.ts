// LithosAI rate-limit handling, split out of src/provider/lithos-handlers.ts.

import type { UsageContext } from "../openai-telemetry.ts";

/**
 * The failover ladder behind a requested tier, deepest capability first:
 * `-ultra` refuses -> `-fast` answers -> the family's normal tier answers.
 *
 * Every tier owns its own rate-limit bucket, probed live 2026-09-25: consuming
 * 250,006 tokens on `-fast` left `-ultra` reporting `x-ratelimit-remaining-tokens:
 * 4000000`, and each tier refills at 4,000,000 tokens/minute. A hop therefore
 * moves real capacity alongside capability, and the ladder is no longer a single
 * sibling pair. The next tier below a refusal is tried immediately (no wait),
 * because its bucket is independent; only when the WHOLE ladder refuses does the
 * request wait on the vendor's own reset window.
 *
 * `-ultra-chat` is deliberately absent: LithosAI told the owner on 2026-09-24
 * that it is tuned for short context windows and loses accuracy on the
 * large-context sessions this route serves.
 */
const LITHOS_FAILOVER_LADDERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["deepseek-ai/DeepSeek-V4.1-Flash-ultra", ["deepseek-ai/DeepSeek-V4.1-Flash-fast", "deepseek-ai/DeepSeek-V4.1-Flash"]],
  ["deepseek-ai/DeepSeek-V4.1-Flash-fast", ["deepseek-ai/DeepSeek-V4.1-Flash"]],
  ["moonshotai/Kimi-K3-ultra", ["moonshotai/Kimi-K3-fast", "moonshotai/Kimi-K3"]],
  ["moonshotai/Kimi-K3-fast", ["moonshotai/Kimi-K3"]],
]);

/** Canonical spellings for ladder rungs, using the same trim/case contract as model dispatch. */
const LITHOS_CANONICAL_FAILOVER_MODELS = new Map<string, string>(
  [...LITHOS_FAILOVER_LADDERS.entries()]
    .flatMap(([model, ladder]) => [model, ...ladder])
    .map((model) => [model.toLowerCase(), model] as const)
);

const lithosCanonicalFailoverModelFor = (modelRaw: string): string => {
  const trimmedModel = modelRaw.trim();
  return LITHOS_CANONICAL_FAILOVER_MODELS.get(trimmedModel.toLowerCase()) ?? trimmedModel;
};

/** The ordered tiers to try after a request model refuses, or an empty list at the bottom. */
export const lithosFailoverLadderFor = (modelRaw: string): readonly string[] => LITHOS_FAILOVER_LADDERS.get(lithosCanonicalFailoverModelFor(modelRaw)) ?? [];

/** True when `target` is a legal failover destination for `modelRaw`. */
export const lithosIsLadderTarget = (modelRaw: string, target: string): boolean =>
  lithosFailoverLadderFor(modelRaw).includes(lithosCanonicalFailoverModelFor(target));

/**
 * The in-process failover windows: a tier whose refusal named a reset instant
 * is skipped until that instant passes. Each refused rung has its own deadline,
 * shared by every request whose ladder contains it, so recovered capacity is
 * eligible again without inheriting another rung's reset. Scoped to models with
 * a ladder, so a bottom tier never accumulates state.
 *
 * The state is per process on purpose: it mirrors what this gateway instance has
 * been told by the vendor, and a restart re-learns it from the first refusal.
 */
const lithosFailoverWindows = new Map<string, number>();

/** The ladder tier this request model must start on right now, or null once the window has passed. */
export const lithosFailoverTargetAt = (modelRaw: string, nowMs: number): string | null => {
  if (!Number.isFinite(nowMs)) return null;
  const canonicalModel = lithosCanonicalFailoverModelFor(modelRaw);
  for (const rung of [canonicalModel, ...lithosFailoverLadderFor(canonicalModel)]) {
    const deadlineMs = lithosFailoverWindows.get(rung);
    if (deadlineMs !== undefined && nowMs < deadlineMs) continue;
    lithosFailoverWindows.delete(rung);
    return rung === canonicalModel ? null : rung;
  }
  return null;
};

/** Opens (or extends) the refused rung's own window, inferred from its legal next target unless supplied. */
export const lithosOpenFailoverWindow = (modelRaw: string, nowMs: number, waitMs: number, target: string, refusedRungOverride?: string): void => {
  const canonicalModel = lithosCanonicalFailoverModelFor(modelRaw);
  const ladder = lithosFailoverLadderFor(canonicalModel);
  const targetIndex = ladder.indexOf(lithosCanonicalFailoverModelFor(target));
  const deadlineMs = nowMs + waitMs;
  if (targetIndex === -1 || !Number.isFinite(nowMs) || !Number.isFinite(waitMs) || waitMs <= 0 || !Number.isFinite(deadlineMs)) return;
  const refusedRung =
    refusedRungOverride === undefined
      ? targetIndex === 0
        ? canonicalModel
        : ladder[targetIndex - 1]
      : lithosCanonicalFailoverModelFor(refusedRungOverride);
  const refusedIndex = refusedRung === canonicalModel ? -1 : ladder.indexOf(refusedRung);
  if (refusedRung !== canonicalModel && refusedIndex === -1) return;
  if (refusedIndex >= targetIndex) return;
  const currentDeadlineMs = lithosFailoverWindows.get(refusedRung);
  const unexpiredDeadlineMs = currentDeadlineMs !== undefined && currentDeadlineMs > nowMs ? currentDeadlineMs : deadlineMs;
  lithosFailoverWindows.set(refusedRung, Math.max(deadlineMs, unexpiredDeadlineMs));
};

/** Test seam: drop every window so fixtures cannot leak into each other. */
export const clearLithosFailoverWindows = (): void => {
  lithosFailoverWindows.clear();
};

/** Records the final tier that served a request, or clears it when the requested tier served. */
export const recordLithosFailoverModel = (usageContext: UsageContext | undefined, model: string | null): void => {
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.rateLimitFailoverModel = model;
};

/** One sanitized rate-limit telemetry field: a bounded string, a number, or nothing. */
export type LithosRateLimitLogFields = Readonly<Record<string, string | number | null>>;

/**
 * The vendor's own budget headers for one refusal, captured verbatim but bounded.
 *
 * A refusal is only diagnosable if its numbers are recorded at the moment it is
 * seen: the per-minute token bucket, the remaining counters and the reset
 * window it named. Long values are truncated and only allow-listed header names
 * are read, so no request or response body can reach the log through this path.
 */
/**
 * The pause one refusal is owed once both tiers have refused, or null when it is
 * relayed instead.
 *
 * A refused request is not out of quota for long: on 2026-09-25 the vendor's own
 * headers named ~51 s windows on a 4,000,000-token/minute bucket, so a bounded
 * pause plus a retry absorbs the refusal that would otherwise reach the client
 * as "429 Too Many Requests" after its own retries run out. The caps keep the
 * pause far below the client's default request timeout; past them the vendor's
 * refusal is relayed unchanged. The streamed route spends the wider budget in
 * `LITHOS_STREAMED_REFUSAL_WAIT_POLICY`, because its stream is already open and
 * held by keepalives instead of sitting silently behind an edge proxy.
 */
export const LITHOS_REFUSAL_WAIT_CAP_MS = 75_000;
export const LITHOS_REFUSAL_WAIT_TOTAL_CAP_MS = 120_000;
/** Absorbed pauses per request, so a stream of tiny windows cannot loop forever. */
export const LITHOS_REFUSAL_WAIT_MAX_WAITS = 2;

/**
 * The absorb budget one route may spend on refusals that name their own reset
 * window. The two routes genuinely differ: a buffered response is held silently
 * behind whatever proxy sits in front of the gateway, so its budget stays under
 * the edge read bound; a streamed response opens its SSE stream first and is
 * held by `: keepalive` frames, so it can follow the client's own ~10-minute
 * tolerance and cover the three-and-a-half-minute vendor saturations measured on
 * 2026-09-24 and 2026-09-25. Both budgets keep the same 75-second per-wait cap,
 * because the vendor's 4,000,000-token/minute bucket cannot name a longer
 * window than its own ~60-second refill.
 */
export type LithosRefusalWaitPolicy = Readonly<{ maxWaits: number; totalCapMs: number }>;

export const LITHOS_BUFFERED_REFUSAL_WAIT_POLICY: LithosRefusalWaitPolicy = {
  maxWaits: LITHOS_REFUSAL_WAIT_MAX_WAITS,
  totalCapMs: LITHOS_REFUSAL_WAIT_TOTAL_CAP_MS,
};

export const LITHOS_STREAMED_REFUSAL_WAIT_POLICY: LithosRefusalWaitPolicy = { maxWaits: 5, totalCapMs: 300_000 };

/** The pause this refusal asks for, bounded by the per-wait, count and total caps. */
export const lithosRefusalWait = (
  headers: Headers,
  waitedMs: number,
  waits: number,
  policy: LithosRefusalWaitPolicy = LITHOS_BUFFERED_REFUSAL_WAIT_POLICY
): LithosRateLimitWait | null => {
  if (waits >= policy.maxWaits) return null;
  const planned = lithosRateLimitWait(headers, Date.now());
  if (planned === null) return null;
  if (planned.waitMs > LITHOS_REFUSAL_WAIT_CAP_MS) return null;
  if (waitedMs + planned.waitMs > policy.totalCapMs) return null;
  return planned;
};

/** Records the absorbed wait total so a terminal can report it. */
export const recordLithosRateLimitWaitMs = (usageContext: UsageContext | undefined, waitedMs: number): void => {
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.rateLimitWaitMs = waitedMs;
};

/** One absorbed pause, logged with the header it came from. */
export const logLithosRateLimitWait = (fields: LithosRateLimitLogFields): void => {
  try {
    console.info("[ai.ubq.fi] lithos_rate_limit_wait", JSON.stringify(fields));
  } catch {
    // Telemetry must never change routing or delivery.
  }
};

const lithosRetryAbortError = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (reason === undefined) return new DOMException("The request was aborted while waiting for the LithosAI rate limit to reset.", "AbortError");
  const error = new Error("The request was aborted while waiting for the LithosAI rate limit to reset.", { cause: reason });
  error.name = "AbortError";
  return error;
};

/** Abort-aware sleep: an abandoned request never keeps waiting for a provider window. */
export const waitForLithosRetry = (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal.aborted) {
    return Promise.reject(lithosRetryAbortError(signal));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      reject(lithosRetryAbortError(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

export const lithosRateLimitSnapshot = (headers: Headers): LithosRateLimitLogFields => {
  const count = (name: string): number | null => {
    const raw = headers.get(name)?.trim();
    return raw && /^\d+$/.test(raw) ? Number(raw) : null;
  };
  const text = (name: string): string | null => {
    const raw = headers.get(name)?.trim();
    return raw ? raw.slice(0, 40) : null;
  };
  const window = lithosRateLimitWait(headers, Date.now());
  return {
    window_ms: window?.waitMs ?? null,
    window_source: window?.source ?? null,
    retry_after: text("retry-after"),
    retry_after_ms: count("retry-after-ms"),
    remaining_tokens: count("x-ratelimit-remaining-tokens"),
    limit_tokens: count("x-ratelimit-limit-tokens"),
    reset_tokens: text("x-ratelimit-reset-tokens"),
    remaining_requests: count("x-ratelimit-remaining-requests"),
    limit_requests: count("x-ratelimit-limit-requests"),
    reset_requests: text("x-ratelimit-reset-requests"),
    should_retry: text("x-should-retry"),
  };
};

/** One refusal, with the vendor's budgets as it reported them. */
export const logLithosRateLimitRefusal = (fields: LithosRateLimitLogFields): void => {
  try {
    console.info("[ai.ubq.fi] lithos_rate_limit_refusal", JSON.stringify(fields));
  } catch {
    // Telemetry must never change routing or delivery.
  }
};

export const logLithosRateLimitFailover = (fields: LithosRateLimitLogFields): void => {
  try {
    console.info("[ai.ubq.fi] lithos_rate_limit_failover", JSON.stringify(fields));
  } catch {
    // Telemetry must never change routing or delivery.
  }
};

/** One refusal hint parsed from the vendor's own headers. */
export type LithosRateLimitWait = Readonly<{ waitMs: number; source: string }>;

/** True when the vendor explicitly forbids retrying the tier that returned these headers. */
export const lithosRetryProhibited = (headers: Headers): boolean => headers.get("x-should-retry")?.trim().toLowerCase() === "false";

const lithosIntegerHeader = (raw: string | null): number | null => {
  if (raw === null) return null;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** The duration units the vendor's reset headers use, in milliseconds. */
const LITHOS_DURATION_UNITS_MS: ReadonlyMap<string, number> = new Map([
  ["ms", 1],
  ["s", 1_000],
  ["m", 60_000],
  ["h", 3_600_000],
]);

/** Digits and the decimal point a duration magnitude may carry. */
const isDurationDigit = (character: string): boolean => (character >= "0" && character <= "9") || character === ".";

/**
 * `x-ratelimit-reset-*` carry deltas like `3.23s`, `1s`, `250ms` or `1m30s`.
 * Scanned rather than matched: the shapes are tiny and a linear scan keeps the
 * parse free of the backtracking a repeated unit pattern invites.
 */
const lithosDurationMs = (raw: string | null): number | null => {
  if (raw === null) return null;
  const value = raw.trim().replace(/\s+/g, "");
  if (!value) return null;
  let total = 0;
  let cursor = 0;
  while (cursor < value.length) {
    let digitsEnd = cursor;
    while (digitsEnd < value.length && isDurationDigit(value.charAt(digitsEnd))) digitsEnd += 1;
    if (digitsEnd === cursor) return null;
    const magnitude = Number(value.slice(cursor, digitsEnd));
    if (!Number.isFinite(magnitude)) return null;
    const unitKey = value.startsWith("ms", digitsEnd) ? "ms" : value.charAt(digitsEnd);
    const unitMs = LITHOS_DURATION_UNITS_MS.get(unitKey);
    if (unitMs === undefined) return null;
    total += magnitude * unitMs;
    cursor = digitsEnd + unitKey.length;
  }
  return Number.isFinite(total) ? total : null;
};

/** `retry-after` is either an integer number of seconds or an HTTP date. */
const lithosRetryAfterMs = (raw: string | null, nowMs: number): number | null => {
  const seconds = lithosIntegerHeader(raw);
  if (seconds !== null) {
    const waitMs = seconds * 1_000;
    return Number.isFinite(waitMs) ? waitMs : null;
  }
  if (raw === null) return null;
  const parsed = Date.parse(raw.trim());
  const waitMs = parsed - nowMs;
  return Number.isFinite(waitMs) && waitMs > 0 ? waitMs : null;
};

/**
 * The wait one 429 asks for, in the vendor's own precedence: `retry-after-ms`
 * first, then `retry-after`, then the later of the two `x-ratelimit-reset-*`
 * deltas (the budget that refills last is the one that binds). A vendor
 * instruction never to retry wins over every hint, and a refusal that names no
 * window at all returns null so it is relayed instead of guessed at. Exported
 * because it is the whole header contract in one pure function.
 */
export const lithosRateLimitWait = (headers: Headers, nowMs: number): LithosRateLimitWait | null => {
  if (lithosRetryProhibited(headers)) return null;
  const retryAfterMs = lithosIntegerHeader(headers.get("retry-after-ms"));
  if (retryAfterMs !== null) return { waitMs: retryAfterMs, source: "retry-after-ms" };
  const retryAfter = lithosRetryAfterMs(headers.get("retry-after"), nowMs);
  if (retryAfter !== null) return { waitMs: retryAfter, source: "retry-after" };
  let latest: LithosRateLimitWait | null = null;
  for (const header of ["x-ratelimit-reset-tokens", "x-ratelimit-reset-requests"]) {
    const waitMs = lithosDurationMs(headers.get(header));
    if (waitMs === null) continue;
    if (latest === null || waitMs > latest.waitMs) latest = { waitMs, source: header };
  }
  if (latest !== null) return latest;
  return null;
};

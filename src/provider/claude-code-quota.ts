/**
 * Upstream-observed Claude Code subscription windows. The provider's unified
 * rate-limit headers are the only authoritative statement of remaining
 * subscription allowance; local token accounting is never treated as the
 * account's allowance. Durable exhaustion is only ever recorded from an
 * upstream rejection that carries a window and reset; anything weaker stays a
 * request-local cooldown so a transient 429 cannot invent a weekly block.
 */
import { isRecord } from "../utils.ts";

export const CLAUDE_CODE_QUOTA_KV_KEY = ["ubq_ai", "claude_code_quota"] as const;
/** Margin after an upstream reset before the tier is retried. */
export const CLAUDE_CODE_RESET_MARGIN_MS = 5 * 60_000;
/** Floor for a durable block that arrived without a usable reset instant. */
export const CLAUDE_CODE_MIN_BLOCK_MS = 5 * 60_000;
/** Cooldown for a generic rate limit with no durable window evidence. */
export const CLAUDE_CODE_TRANSIENT_COOLDOWN_MS = 60_000;

export const CLAUDE_CODE_WINDOWS = ["5h", "7d"] as const;
export type ClaudeCodeWindowId = (typeof CLAUDE_CODE_WINDOWS)[number];

const HEADER_PREFIX = "anthropic-ratelimit-unified-";

export type ClaudeCodeQuotaWindow = Readonly<{
  status: string | null;
  utilization: number | null;
  reset_at_ms: number | null;
  observed_at_ms: number;
}>;

export type ClaudeCodeQuotaObservation = Readonly<{
  windows: Readonly<Partial<Record<ClaudeCodeWindowId, ClaudeCodeQuotaWindow>>>;
  representative_claim: string | null;
  observed_at_ms: number;
}>;

export type ClaudeCodeQuotaState = Readonly<{
  windows: Readonly<Partial<Record<ClaudeCodeWindowId, ClaudeCodeQuotaWindow>>>;
  representative_claim: string | null;
  blocked_until_ms: number | null;
  block_window: ClaudeCodeWindowId | null;
  cooldown_until_ms: number | null;
  updated_at_ms: number;
}>;

const finiteNonNegative = (value: number): number | null => (Number.isFinite(value) && value >= 0 ? value : null);

const trimmedOrNull = (value: string | null): string | null => (value !== null && value.trim() !== "" ? value : null);

const parseUtilization = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return finiteNonNegative(parsed);
};

const parseResetSeconds = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  return seconds * 1_000;
};

const parseWindow = (headers: Headers, window: ClaudeCodeWindowId, observedAtMs: number): ClaudeCodeQuotaWindow | null => {
  const status = headers.get(`${HEADER_PREFIX}${window}-status`);
  const utilization = parseUtilization(headers.get(`${HEADER_PREFIX}${window}-utilization`));
  const resetAtMs = parseResetSeconds(headers.get(`${HEADER_PREFIX}${window}-reset`));
  if (status === null && utilization === null && resetAtMs === null) return null;
  return {
    status: trimmedOrNull(status),
    utilization,
    reset_at_ms: resetAtMs,
    observed_at_ms: observedAtMs,
  };
};

/**
 * Read the unified rate-limit headers from one upstream response. Returns null
 * when the response carried no usable observation, so an absent header family
 * never overwrites a previous observation with emptiness.
 */
export const observeClaudeCodeQuota = (headers: Headers, nowMs: number = Date.now()): ClaudeCodeQuotaObservation | null => {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return null;
  const observedAtMs = Math.trunc(nowMs);
  const windows: Partial<Record<ClaudeCodeWindowId, ClaudeCodeQuotaWindow>> = {};
  for (const window of CLAUDE_CODE_WINDOWS) {
    const parsed = parseWindow(headers, window, observedAtMs);
    if (parsed) windows[window] = parsed;
  }
  const claim = headers.get(`${HEADER_PREFIX}representative-claim`);
  if (!Object.keys(windows).length && claim === null) return null;
  return {
    windows,
    representative_claim: trimmedOrNull(claim),
    observed_at_ms: observedAtMs,
  };
};

/**
 * Durable exhaustion requires a rejection plus a window whose reported state is
 * not `allowed` (or whose utilization is at 100 percent). A 429 without that
 * evidence is request-local and must not become a stored block.
 */
export const claudeCodeExhaustionFromResponse = (
  status: number,
  observation: ClaudeCodeQuotaObservation | null
): Readonly<{ window: ClaudeCodeWindowId; reset_at_ms: number | null }> | null => {
  if (status !== 429 || observation === null) return null;
  for (const window of CLAUDE_CODE_WINDOWS) {
    const observed = observation.windows[window];
    if (!observed) continue;
    const statusLimited = observed.status !== null && observed.status.trim().toLowerCase() !== "allowed";
    const utilizationLimited = observed.utilization !== null && observed.utilization >= 1;
    if (statusLimited || utilizationLimited) return { window, reset_at_ms: observed.reset_at_ms };
  }
  return null;
};

const finiteNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A present-but-malformed optional number is rejected; an absent one passes. */
const optionalNumberInvalid = (raw: unknown, parsed: number | null, invalid: (value: number) => boolean): boolean =>
  raw !== undefined && raw !== null && (parsed === null || invalid(parsed));

const parseWindowState = (value: unknown): ClaudeCodeQuotaWindow | null => {
  if (!isRecord(value)) return null;
  const observedAtMs = finiteNumber(value.observed_at_ms);
  if (observedAtMs === null || observedAtMs <= 0) return null;
  const utilization = finiteNumber(value.utilization);
  if (optionalNumberInvalid(value.utilization, utilization, (parsed) => parsed < 0)) return null;
  const resetAtMs = finiteNumber(value.reset_at_ms);
  if (optionalNumberInvalid(value.reset_at_ms, resetAtMs, (parsed) => parsed <= 0 || !Number.isSafeInteger(parsed))) return null;
  return { status: typeof value.status === "string" ? value.status : null, utilization, reset_at_ms: resetAtMs, observed_at_ms: Math.trunc(observedAtMs) };
};

const parseStoredWindows = (value: unknown): Partial<Record<ClaudeCodeWindowId, ClaudeCodeQuotaWindow>> => {
  const windows: Partial<Record<ClaudeCodeWindowId, ClaudeCodeQuotaWindow>> = {};
  if (!isRecord(value)) return windows;
  for (const window of CLAUDE_CODE_WINDOWS) {
    const parsed = parseWindowState((value as Record<string, unknown>)[window]);
    if (parsed) windows[window] = parsed;
  }
  return windows;
};

const parseBlockWindow = (value: unknown): ClaudeCodeWindowId | null =>
  CLAUDE_CODE_WINDOWS.includes(value as ClaudeCodeWindowId) ? (value as ClaudeCodeWindowId) : null;

export const parseClaudeCodeQuotaState = (value: unknown): ClaudeCodeQuotaState | null => {
  if (!isRecord(value)) return null;
  const updatedAtMs = finiteNumber(value.updated_at_ms);
  if (updatedAtMs === null || updatedAtMs <= 0) return null;
  return {
    windows: parseStoredWindows(value.windows),
    representative_claim: typeof value.representative_claim === "string" ? value.representative_claim : null,
    blocked_until_ms: finiteNumber(value.blocked_until_ms),
    block_window: parseBlockWindow(value.block_window),
    cooldown_until_ms: finiteNumber(value.cooldown_until_ms),
    updated_at_ms: Math.trunc(updatedAtMs),
  };
};

export const loadClaudeCodeQuotaState = async (kv: Deno.Kv | null): Promise<ClaudeCodeQuotaState | null> => {
  if (!kv) return null;
  const entry = await kv.get(CLAUDE_CODE_QUOTA_KV_KEY, { consistency: "strong" });
  return parseClaudeCodeQuotaState(entry.value);
};

const newerWindow = (previous: ClaudeCodeQuotaWindow | undefined, next: ClaudeCodeQuotaWindow): ClaudeCodeQuotaWindow =>
  previous && previous.observed_at_ms > next.observed_at_ms ? previous : next;

/**
 * Fold one upstream observation into stored state. A window observation newer
 * than the stored one wins; an older one is ignored rather than resurrecting
 * stale allowance numbers. An active block is preserved until its reset time
 * has passed and a newer observation proves the window moved on.
 */
export const mergeClaudeCodeQuotaState = (
  previous: ClaudeCodeQuotaState | null,
  observation: ClaudeCodeQuotaObservation,
  block: Readonly<{ window: ClaudeCodeWindowId; reset_at_ms: number | null }> | null,
  nowMs: number = Date.now()
): ClaudeCodeQuotaState => {
  const windows: Partial<Record<ClaudeCodeWindowId, ClaudeCodeQuotaWindow>> = { ...(previous?.windows ?? {}) };
  for (const window of CLAUDE_CODE_WINDOWS) {
    const observed = observation.windows[window];
    if (observed) windows[window] = newerWindow(windows[window], observed);
  }
  let blockedUntilMs = previous?.blocked_until_ms ?? null;
  let blockWindow = previous?.block_window ?? null;
  if (previous && blockedUntilMs !== null && blockedUntilMs <= nowMs) {
    blockedUntilMs = null;
    blockWindow = null;
  }
  if (block) {
    const resetBased = block.reset_at_ms === null ? nowMs + CLAUDE_CODE_MIN_BLOCK_MS : block.reset_at_ms + CLAUDE_CODE_RESET_MARGIN_MS;
    const candidate = Math.max(resetBased, nowMs + CLAUDE_CODE_MIN_BLOCK_MS);
    if (blockedUntilMs === null || candidate > blockedUntilMs) {
      blockedUntilMs = candidate;
      blockWindow = block.window;
    }
  }
  return {
    windows,
    representative_claim: observation.representative_claim ?? previous?.representative_claim ?? null,
    blocked_until_ms: blockedUntilMs,
    block_window: blockWindow,
    cooldown_until_ms: previous?.cooldown_until_ms ?? null,
    updated_at_ms: nowMs,
  };
};

export const storeClaudeCodeQuotaState = async (kv: Deno.Kv | null, state: ClaudeCodeQuotaState): Promise<boolean> => {
  if (!kv) return false;
  try {
    await kv.set(CLAUDE_CODE_QUOTA_KV_KEY, state);
    return true;
  } catch {
    return false;
  }
};

/** True while the stored durable block still covers the present instant. */
export const claudeCodeQuotaBlocked = (state: ClaudeCodeQuotaState | null, nowMs: number = Date.now()): boolean =>
  state !== null && state.blocked_until_ms !== null && state.blocked_until_ms > nowMs;

/** True during a short request-local cooldown recorded from a generic 429. */
export const claudeCodeQuotaCoolingDown = (state: ClaudeCodeQuotaState | null, nowMs: number = Date.now()): boolean =>
  state !== null && state.cooldown_until_ms !== null && state.cooldown_until_ms > nowMs;

/**
 * Persist one upstream outcome's evidence. Success paths only refresh window
 * observations; a durable block needs the caller's exhausted-window evidence,
 * and a generic rate limit only sets a short cooldown, so a transient failure
 * can never be persisted as durable exhaustion.
 */
export const recordClaudeCodeQuotaOutcome = async (
  kv: Deno.Kv | null,
  input: Readonly<{
    observation: ClaudeCodeQuotaObservation | null;
    /** Durable exhaustion claimed by the caller's classification. */
    exhaustion?: Readonly<{ window: ClaudeCodeWindowId; reset_at_ms: number | null }> | null;
    /** Generic rate limit with no durable window evidence. */
    transient?: Readonly<{ retry_after_ms: number | null }> | null;
    nowMs?: number;
  }>
): Promise<ClaudeCodeQuotaState | null> => {
  const nowMs = input.nowMs ?? Date.now();
  const previous = await loadClaudeCodeQuotaState(kv);
  const observation = input.observation ?? { windows: {}, representative_claim: null, observed_at_ms: nowMs };
  if (input.observation === null && !input.exhaustion && !input.transient) return previous;
  const base = mergeClaudeCodeQuotaState(previous, observation, input.exhaustion ?? null, nowMs);
  const withCooldown: ClaudeCodeQuotaState = input.transient
    ? {
        ...base,
        cooldown_until_ms:
          nowMs + (input.transient.retry_after_ms && input.transient.retry_after_ms > 0 ? input.transient.retry_after_ms : CLAUDE_CODE_TRANSIENT_COOLDOWN_MS),
      }
    : base;
  const stored = await storeClaudeCodeQuotaState(kv, withCooldown);
  return stored ? withCooldown : base;
};

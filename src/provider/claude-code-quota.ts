import type { Kv } from "#kv";
/**
 * Upstream-observed Claude Code subscription windows. The provider's unified
 * rate-limit headers are the only authoritative statement of remaining
 * subscription allowance; local token accounting is never treated as the
 * account's allowance. Durable exhaustion is only ever recorded from an
 * upstream rejection that carries a window and reset; anything weaker stays a
 * request-local cooldown so a transient 429 cannot invent a weekly block.
 */
import { isRecord } from "../utils.ts";
import {
  CLAUDE_CODE_ACCOUNTS_KEY,
  claudeCodeAccountIdentity,
  currentClaudeCodeAccountEntry,
  type ClaudeCodeAccountBinding,
  type ClaudeCodeAccountIdentity,
} from "./claude-code-accounts.ts";

export const CLAUDE_CODE_QUOTA_KV_KEY = ["ubq_ai", "claude_code_quota"] as const;
/** Margin after an upstream reset before the tier is retried. */
export const CLAUDE_CODE_RESET_MARGIN_MS = 5 * 60_000;
/** Floor for a durable block that arrived without a usable reset instant. */
export const CLAUDE_CODE_MIN_BLOCK_MS = 5 * 60_000;
/** Cooldown for a generic rate limit with no durable window evidence. */
export const CLAUDE_CODE_TRANSIENT_COOLDOWN_MS = 60_000;
/**
 * Cooldown after a configuration-level rejection (billing blocked, unknown
 * workspace). These do not clear on their own upstream, but the gateway must
 * not hammer the endpoint for every request while the operator fixes the
 * account; each new attempt is bounded by this window.
 */
export const CLAUDE_CODE_CONFIG_COOLDOWN_MS = 10 * 60_000;

export const CLAUDE_CODE_WINDOWS = ["5h", "7d"] as const;
export type ClaudeCodeWindowId = (typeof CLAUDE_CODE_WINDOWS)[number];

/** Console API keys are metered with the standard per-family rate-limit headers. */
export const CLAUDE_CODE_STANDARD_FAMILIES = ["requests", "input-tokens", "output-tokens"] as const;
export type ClaudeCodeStandardFamily = (typeof CLAUDE_CODE_STANDARD_FAMILIES)[number];

const HEADER_PREFIX = "anthropic-ratelimit-unified-";
const STANDARD_HEADER_PREFIX = "anthropic-ratelimit-";

export type ClaudeCodeQuotaWindow = Readonly<{
  status: string | null;
  utilization: number | null;
  reset_at_ms: number | null;
  observed_at_ms: number;
}>;

export type ClaudeCodeStandardWindow = Readonly<{
  limit: number | null;
  remaining: number | null;
  reset_at_ms: number | null;
  observed_at_ms: number;
}>;

export type ClaudeCodeQuotaError = Readonly<{
  kind: string;
  status: number | null;
  message: string | null;
  at_ms: number;
}>;

export type ClaudeCodeQuotaObservation = Readonly<{
  windows: Readonly<Partial<Record<ClaudeCodeWindowId, ClaudeCodeQuotaWindow>>>;
  standard: Readonly<Partial<Record<ClaudeCodeStandardFamily, ClaudeCodeStandardWindow>>>;
  representative_claim: string | null;
  observed_at_ms: number;
}>;

export type ClaudeCodeAcceptedObservation = ClaudeCodeAccountIdentity &
  Readonly<{
    v: 1;
    observation_id: string;
    source_observed_at_ms: number | null;
    sampled_at_ms: number;
    response_status: number | null;
    state: "available" | "unavailable";
    observation: ClaudeCodeQuotaObservation;
  }>;
type ObservationRecorder = (kv: Kv, event: ClaudeCodeAcceptedObservation) => Promise<void>;
let observationRecorder: ObservationRecorder | null = null;
/** Install at application module initialization, before its first inference, never on an admin read. */
export const registerClaudeCodeObservationRecorder = (recorder: ObservationRecorder): (() => void) => {
  if (observationRecorder && observationRecorder !== recorder) throw new Error("Claude observation recorder is already installed");
  observationRecorder = recorder;
  return () => {
    if (observationRecorder === recorder) observationRecorder = null;
  };
};
export const claudeCodeQuotaKey = (binding?: ClaudeCodeAccountBinding) =>
  binding ? (["uos_ai", "claude_code_quota", "v1", binding.account_id, binding.account_cohort_id] as const) : CLAUDE_CODE_QUOTA_KV_KEY;

export type ClaudeCodeQuotaState = Readonly<{
  pool_proofs?: Readonly<Record<string, ClaudeCodePoolProof>>;
  windows: Readonly<Partial<Record<ClaudeCodeWindowId, ClaudeCodeQuotaWindow>>>;
  standard: Readonly<Partial<Record<ClaudeCodeStandardFamily, ClaudeCodeStandardWindow>>>;
  representative_claim: string | null;
  blocked_until_ms: number | null;
  block_window: ClaudeCodeWindowId | null;
  cooldown_until_ms: number | null;
  last_error: ClaudeCodeQuotaError | null;
  updated_at_ms: number;
}>;
export type ClaudeCodePoolProof = Readonly<{
  kind: "auth_invalid" | "quota_exhausted";
  model_id: string | null;
  observed_at_ms: number;
  expires_at_ms: number;
  evidence_generation: string;
}>;
export const CLAUDE_CODE_AUTH_INVALID_PROOF_TTL_MS = 5 * 60_000;
const parsePoolProofs = (value: unknown): Record<string, ClaudeCodePoolProof> => {
  if (!isRecord(value)) return {};
  const proofs: Record<string, ClaudeCodePoolProof> = {};
  for (const [key, proof] of Object.entries(value)) {
    if (!isRecord(proof) || (proof.kind !== "auth_invalid" && proof.kind !== "quota_exhausted")) continue;
    if (
      typeof proof.observed_at_ms !== "number" ||
      !Number.isSafeInteger(proof.observed_at_ms) ||
      proof.observed_at_ms <= 0 ||
      typeof proof.expires_at_ms !== "number" ||
      !Number.isSafeInteger(proof.expires_at_ms) ||
      proof.expires_at_ms <= proof.observed_at_ms ||
      typeof proof.evidence_generation !== "string"
    )
      continue;
    if (!(proof.model_id === null || typeof proof.model_id === "string")) continue;
    if (proof.kind === "auth_invalid" ? proof.model_id !== null : !proof.model_id) continue;
    proofs[key] = {
      kind: proof.kind,
      model_id: proof.model_id,
      observed_at_ms: proof.observed_at_ms,
      expires_at_ms: proof.expires_at_ms,
      evidence_generation: proof.evidence_generation,
    };
  }
  return proofs;
};
export const claudeCodePoolProofForModel = (
  state: ClaudeCodeQuotaState | null,
  binding: ClaudeCodeAccountBinding,
  model: string,
  nowMs = Date.now()
): ClaudeCodePoolProof | null =>
  Object.values(state?.pool_proofs ?? {}).find(
    (proof) =>
      proof.evidence_generation === binding.evidence_generation &&
      proof.observed_at_ms <= nowMs &&
      proof.expires_at_ms > nowMs &&
      (proof.kind === "auth_invalid" || proof.model_id === model)
  ) ?? null;

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

const parseStandardWindow = (headers: Headers, family: ClaudeCodeStandardFamily, observedAtMs: number): ClaudeCodeStandardWindow | null => {
  const limit = parseUtilization(headers.get(`${STANDARD_HEADER_PREFIX}${family}-limit`));
  const remaining = parseUtilization(headers.get(`${STANDARD_HEADER_PREFIX}${family}-remaining`));
  const resetAtMs = parseResetSeconds(headers.get(`${STANDARD_HEADER_PREFIX}${family}-reset`));
  if (limit === null && remaining === null && resetAtMs === null) return null;
  return { limit, remaining, reset_at_ms: resetAtMs, observed_at_ms: observedAtMs };
};

const observationIsEmpty = (observation: ClaudeCodeQuotaObservation): boolean =>
  !Object.keys(observation.windows).length && !Object.keys(observation.standard).length && observation.representative_claim === null;

/**
 * Read the rate-limit headers from one upstream response. Returns null when
 * the response carried no usable observation, so an absent header family never
 * overwrites a previous observation with emptiness. Subscription traffic
 * carries the unified 5h/7d windows; Console API keys carry the standard
 * per-family limits, so both are kept when present.
 */
export const observeClaudeCodeQuota = (headers: Headers, nowMs: number = Date.now()): ClaudeCodeQuotaObservation | null => {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return null;
  const observedAtMs = Math.trunc(nowMs);
  const windows: Partial<Record<ClaudeCodeWindowId, ClaudeCodeQuotaWindow>> = {};
  for (const window of CLAUDE_CODE_WINDOWS) {
    const parsed = parseWindow(headers, window, observedAtMs);
    if (parsed) windows[window] = parsed;
  }
  const standard: Partial<Record<ClaudeCodeStandardFamily, ClaudeCodeStandardWindow>> = {};
  for (const family of CLAUDE_CODE_STANDARD_FAMILIES) {
    const parsed = parseStandardWindow(headers, family, observedAtMs);
    if (parsed) standard[family] = parsed;
  }
  const claim = headers.get(`${HEADER_PREFIX}representative-claim`);
  const observation: ClaudeCodeQuotaObservation = {
    windows,
    standard,
    representative_claim: trimmedOrNull(claim),
    observed_at_ms: observedAtMs,
  };
  return observationIsEmpty(observation) ? null : observation;
};

/** Sanitize an upstream error message for operator display; bounded, no headers. */
export const sanitizeClaudeCodeErrorMessage = (raw: unknown, maxLength = 240): string | null => {
  if (typeof raw !== "string") return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
};

export const parseClaudeCodeQuotaError = (value: unknown): ClaudeCodeQuotaError | null => {
  if (!isRecord(value)) return null;
  const kind = typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : null;
  const atMs = finiteNumber(value.at_ms);
  if (!kind || atMs === null || atMs <= 0) return null;
  return {
    kind,
    status: finiteNumber(value.status),
    message: sanitizeClaudeCodeErrorMessage(value.message),
    at_ms: Math.trunc(atMs),
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

const parseResetAtMs = (value: unknown): { ok: boolean; value: number | null } => {
  const resetAtMs = finiteNumber(value);
  const invalid = optionalNumberInvalid(value, resetAtMs, (parsed) => parsed <= 0 || !Number.isSafeInteger(parsed));
  return invalid ? { ok: false, value: null } : { ok: true, value: resetAtMs };
};

const parseWindowState = (value: unknown): ClaudeCodeQuotaWindow | null => {
  if (!isRecord(value)) return null;
  const observedAtMs = finiteNumber(value.observed_at_ms);
  if (observedAtMs === null || observedAtMs <= 0) return null;
  const utilization = finiteNumber(value.utilization);
  if (optionalNumberInvalid(value.utilization, utilization, (parsed) => parsed < 0)) return null;
  const reset = parseResetAtMs(value.reset_at_ms);
  if (!reset.ok) return null;
  return { status: typeof value.status === "string" ? value.status : null, utilization, reset_at_ms: reset.value, observed_at_ms: Math.trunc(observedAtMs) };
};

const parseStandardWindowState = (value: unknown): ClaudeCodeStandardWindow | null => {
  if (!isRecord(value)) return null;
  const observedAtMs = finiteNumber(value.observed_at_ms);
  if (observedAtMs === null || observedAtMs <= 0) return null;
  const limit = finiteNumber(value.limit);
  if (optionalNumberInvalid(value.limit, limit, (parsed) => parsed < 0)) return null;
  const remaining = finiteNumber(value.remaining);
  if (optionalNumberInvalid(value.remaining, remaining, (parsed) => parsed < 0)) return null;
  const reset = parseResetAtMs(value.reset_at_ms);
  if (!reset.ok) return null;
  return { limit, remaining, reset_at_ms: reset.value, observed_at_ms: Math.trunc(observedAtMs) };
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

const parseStoredStandardWindows = (value: unknown): Partial<Record<ClaudeCodeStandardFamily, ClaudeCodeStandardWindow>> => {
  const standard: Partial<Record<ClaudeCodeStandardFamily, ClaudeCodeStandardWindow>> = {};
  if (!isRecord(value)) return standard;
  for (const family of CLAUDE_CODE_STANDARD_FAMILIES) {
    const parsed = parseStandardWindowState((value as Record<string, unknown>)[family]);
    if (parsed) standard[family] = parsed;
  }
  return standard;
};

const parseBlockWindow = (value: unknown): ClaudeCodeWindowId | null =>
  CLAUDE_CODE_WINDOWS.includes(value as ClaudeCodeWindowId) ? (value as ClaudeCodeWindowId) : null;

export const parseClaudeCodeQuotaState = (value: unknown): ClaudeCodeQuotaState | null => {
  if (!isRecord(value)) return null;
  const updatedAtMs = finiteNumber(value.updated_at_ms);
  if (updatedAtMs === null || updatedAtMs <= 0) return null;
  return {
    ...(value.pool_proofs === undefined ? {} : { pool_proofs: parsePoolProofs(value.pool_proofs) }),
    windows: parseStoredWindows(value.windows),
    standard: parseStoredStandardWindows(value.standard),
    representative_claim: typeof value.representative_claim === "string" ? value.representative_claim : null,
    blocked_until_ms: finiteNumber(value.blocked_until_ms),
    block_window: parseBlockWindow(value.block_window),
    cooldown_until_ms: finiteNumber(value.cooldown_until_ms),
    last_error: parseClaudeCodeQuotaError(value.last_error),
    updated_at_ms: Math.trunc(updatedAtMs),
  };
};

export const loadClaudeCodeQuotaState = async (kv: Kv | null, binding?: ClaudeCodeAccountBinding): Promise<ClaudeCodeQuotaState | null> => {
  if (!kv) return null;
  if (binding && !(await currentClaudeCodeAccountEntry(kv, binding))) return null;
  const entry = await kv.get(claudeCodeQuotaKey(binding), { consistency: "strong" });
  return parseClaudeCodeQuotaState(entry.value);
};

const newerWindow = <T extends Readonly<{ observed_at_ms: number }>>(previous: T | undefined, next: T): T =>
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
  const standard: Partial<Record<ClaudeCodeStandardFamily, ClaudeCodeStandardWindow>> = { ...(previous?.standard ?? {}) };
  for (const family of CLAUDE_CODE_STANDARD_FAMILIES) {
    const observed = observation.standard[family];
    if (observed) standard[family] = newerWindow(standard[family], observed);
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
    standard,
    representative_claim: observation.representative_claim ?? previous?.representative_claim ?? null,
    blocked_until_ms: blockedUntilMs,
    block_window: blockWindow,
    cooldown_until_ms: previous?.cooldown_until_ms ?? null,
    last_error: previous?.last_error ?? null,
    updated_at_ms: nowMs,
  };
};

/** True while the stored durable block still covers the present instant. */
export const claudeCodeQuotaBlocked = (state: ClaudeCodeQuotaState | null, nowMs: number = Date.now()): boolean =>
  state !== null && state.blocked_until_ms !== null && state.blocked_until_ms > nowMs;

/** True during a short request-local cooldown recorded from a generic 429. */
export const claudeCodeQuotaCoolingDown = (state: ClaudeCodeQuotaState | null, nowMs: number = Date.now()): boolean =>
  state !== null && state.cooldown_until_ms !== null && state.cooldown_until_ms > nowMs;

/**
 * Persist one upstream outcome's evidence. Success paths only refresh window
 * observations and clear a recorded configuration error; a durable block needs
 * the caller's exhausted-window evidence, a generic rate limit only sets a
 * short cooldown, and a configuration rejection (billing, workspace) sets the
 * longer bounded config cooldown plus its displayable detail, so a transient
 * failure can never be persisted as durable exhaustion.
 */
type QuotaOutcome = Readonly<{
  model_id?: string;
  auth_invalid?: boolean;
  response_observed_at_ms?: number;
  observation: ClaudeCodeQuotaObservation | null;
  binding?: ClaudeCodeAccountBinding;
  response_status?: number | null;
  /** Durable exhaustion claimed by the caller's classification. */
  exhaustion?: Readonly<{ window: ClaudeCodeWindowId; reset_at_ms: number | null }> | null;
  /** Generic rate limit with no durable window evidence. */
  transient?: Readonly<{ retry_after_ms: number | null }> | null;
  /** Configuration rejection: billing, workspace, or credential scoping. */
  config_error?: Readonly<{ kind: string; status: number | null; message: string | null; retry_after_ms?: number | null }> | null;
  /** The tier served this request; clears any recorded configuration error. */
  served?: boolean;
  nowMs?: number;
  /** Internal CAS retry budget, never an upstream retry. */
  attempts?: number;
}>;

const quotaStateForOutcome = (previous: ClaudeCodeQuotaState | null, input: QuotaOutcome, nowMs: number): ClaudeCodeQuotaState => {
  const observation = input.observation ?? { windows: {}, standard: {}, representative_claim: null, observed_at_ms: nowMs };
  const base = mergeClaudeCodeQuotaState(previous, observation, input.exhaustion ?? null, nowMs);
  let withCooldown: ClaudeCodeQuotaState = base;
  if (input.transient) {
    withCooldown = {
      ...withCooldown,
      cooldown_until_ms:
        nowMs + (input.transient.retry_after_ms && input.transient.retry_after_ms > 0 ? input.transient.retry_after_ms : CLAUDE_CODE_TRANSIENT_COOLDOWN_MS),
    };
  }
  if (input.config_error) {
    const retryAfterMs =
      input.config_error.retry_after_ms && input.config_error.retry_after_ms > 0 ? input.config_error.retry_after_ms : CLAUDE_CODE_CONFIG_COOLDOWN_MS;
    withCooldown = {
      ...withCooldown,
      cooldown_until_ms: nowMs + retryAfterMs,
      last_error: {
        kind: input.config_error.kind,
        status: input.config_error.status,
        message: sanitizeClaudeCodeErrorMessage(input.config_error.message),
        at_ms: nowMs,
      },
    };
  } else if (input.served) {
    withCooldown = { ...withCooldown, last_error: null };
  }
  return input.binding ? { ...withCooldown, pool_proofs: poolProofsForOutcome(previous, input, nowMs) } : withCooldown;
};

const newPoolProof = (input: QuotaOutcome, observedAt: number): readonly [string, ClaudeCodePoolProof] | null => {
  if (!input.binding || !input.model_id) return null;
  const reset = input.exhaustion?.reset_at_ms;
  let expiry: number | null = null;
  if (input.auth_invalid) expiry = observedAt + CLAUDE_CODE_AUTH_INVALID_PROOF_TTL_MS;
  else if (reset && reset > observedAt) expiry = reset + CLAUDE_CODE_RESET_MARGIN_MS;
  if (expiry === null) return null;
  return [
    input.auth_invalid ? "credential" : `model:${input.model_id}`,
    {
      kind: input.auth_invalid ? "auth_invalid" : "quota_exhausted",
      model_id: input.auth_invalid ? null : input.model_id,
      observed_at_ms: observedAt,
      expires_at_ms: expiry,
      evidence_generation: input.binding.evidence_generation,
    },
  ];
};
const poolProofsForOutcome = (previous: ClaudeCodeQuotaState | null, input: QuotaOutcome, nowMs: number): Record<string, ClaudeCodePoolProof> => {
  const observedAt = input.response_observed_at_ms ?? nowMs;
  const modelId = input.model_id ?? null;
  const proofs = new Map<string, ClaudeCodePoolProof>(Object.entries(previous?.pool_proofs ?? {}).filter(([, proof]) => proof.expires_at_ms > nowMs));
  if (input.served) {
    for (const [key, proof] of proofs) {
      if (proof.observed_at_ms <= observedAt && (proof.kind === "auth_invalid" || proof.model_id === modelId)) proofs.delete(key);
    }
  }
  const next = newPoolProof(input, observedAt);
  if (next && next[1].expires_at_ms > nowMs) {
    const previousProof = proofs.get(next[0]);
    if (!previousProof || previousProof.observed_at_ms <= observedAt) proofs.set(...next);
  }
  return Object.fromEntries(proofs);
};

const publishAcceptedObservation = async (kv: Kv, input: QuotaOutcome, withCooldown: ClaudeCodeQuotaState, nowMs: number): Promise<void> => {
  if (input.binding && input.observation && !observationIsEmpty(input.observation) && observationRecorder) {
    const event: ClaudeCodeAcceptedObservation = {
      ...claudeCodeAccountIdentity(input.binding),
      v: 1,
      observation_id: crypto.randomUUID(),
      source_observed_at_ms:
        Number.isFinite(input.observation.observed_at_ms) && input.observation.observed_at_ms > 0 ? input.observation.observed_at_ms : null,
      sampled_at_ms: nowMs,
      response_status: input.response_status ?? null,
      state: input.auth_invalid || claudeCodeQuotaBlocked(withCooldown, nowMs) || claudeCodeQuotaCoolingDown(withCooldown, nowMs) ? "unavailable" : "available",
      observation: input.observation,
    };
    try {
      await observationRecorder(kv, event);
    } catch {
      console.warn("[ai.ubq.fi] Claude observation history write failed after accepted quota persistence.");
    }
  }
};

export const recordClaudeCodeQuotaOutcome = async (kv: Kv | null, input: QuotaOutcome): Promise<ClaudeCodeQuotaState | null> => {
  const nowMs = input.nowMs ?? Date.now();
  const accountEntry = kv && input.binding ? await currentClaudeCodeAccountEntry(kv, input.binding) : null;
  if (input.binding && !accountEntry) return null;
  const quotaEntry = kv ? await kv.get(claudeCodeQuotaKey(input.binding), { consistency: "strong" }) : null;
  const previous = parseClaudeCodeQuotaState(quotaEntry?.value);
  if (input.observation === null && !input.exhaustion && !input.transient && !input.config_error && !input.served && !input.auth_invalid) return previous;
  const withCooldown = quotaStateForOutcome(previous, input, nowMs);
  if (!kv) return null;
  const atomic = kv.atomic().check(...(accountEntry ? [accountEntry] : []), ...(quotaEntry ? [quotaEntry] : []));
  const stored = await atomic.set(claudeCodeQuotaKey(input.binding), withCooldown).commit();
  if (!stored.ok) return (input.attempts ?? 0) < 8 ? await recordClaudeCodeQuotaOutcome(kv, { ...input, nowMs, attempts: (input.attempts ?? 0) + 1 }) : null;
  await publishAcceptedObservation(kv, input, withCooldown, nowMs);
  return withCooldown;
};

/**
 * Operator switch: drop the durable block, the cooldown, and the recorded
 * configuration error so the next request retries the tier immediately. The
 * observed window utilization is preserved because it is upstream truth, not a
 * gateway guard.
 */
export const clearClaudeCodeQuotaGuards = async (kv: Kv | null, binding?: ClaudeCodeAccountBinding): Promise<ClaudeCodeQuotaState | null> => {
  if (!kv) return null;
  const accountEntry = binding ? await currentClaudeCodeAccountEntry(kv, binding) : null;
  if (binding && !accountEntry) return null;
  const quotaEntry = await kv.get(claudeCodeQuotaKey(binding), { consistency: "strong" });
  const previous = parseClaudeCodeQuotaState(quotaEntry.value);
  // Even an empty guard record invalidates older in-flight evidence.
  if (!previous && !accountEntry) return null;
  const base = previous ?? mergeClaudeCodeQuotaState(null, { windows: {}, standard: {}, representative_claim: null, observed_at_ms: Date.now() }, null);
  const cleared: ClaudeCodeQuotaState = {
    ...base,
    blocked_until_ms: null,
    block_window: null,
    cooldown_until_ms: null,
    last_error: null,
    pool_proofs: {},
    updated_at_ms: Date.now(),
  };
  const operation = kv.atomic().check(quotaEntry);
  if (accountEntry?.value && binding) {
    operation.check(accountEntry).set(CLAUDE_CODE_ACCOUNTS_KEY, {
      ...accountEntry.value,
      accounts: accountEntry.value.accounts.map((account) =>
        account.account_id === binding.account_id ? { ...account, evidence_generation: crypto.randomUUID() } : account
      ),
    });
  }
  return (await operation.set(claudeCodeQuotaKey(binding), cleared).commit()).ok ? cleared : null;
};

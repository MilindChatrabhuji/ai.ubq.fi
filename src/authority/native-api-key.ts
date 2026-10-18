import type {
  ApiKeyPolicy,
  ApiKeyUsageDispatchPlan,
  ApiKeyUsagePolicyScope,
  ApiKeyUsageProvider,
  ApiKeyUsageReleasePlan,
  ApiKeyUsageRequestV3,
  ApiKeyUsageReservationPlan,
  ApiKeyUsageSnapshot,
  ApiKeyUsageWindowV3,
  ApiKeyUsageWritePlan,
} from "./native-contracts.ts";
import { isRecord } from "../utils.ts";

export const API_KEY_USAGE_V3_RESERVATION_LEASE_MS = 5 * 60_000;
export const API_KEY_USAGE_V3_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Every provider that may own an API-key usage dispatch. The request-row
 * normalizer reads this list, so a provider added here is accepted by the
 * ledger instead of turning its dispatched row into an unreadable one.
 */
export const API_KEY_USAGE_PROVIDERS = [
  "cerebras",
  "chatgpt_codex",
  "claude_code",
  "deepseek",
  "lithos",
  "openrouter",
  "removed_provider",
  "metered",
  "surplus",
  "voyage",
] as const;

const isApiKeyUsageProvider = (value: unknown): value is ApiKeyUsageProvider =>
  typeof value === "string" && (API_KEY_USAGE_PROVIDERS as readonly string[]).includes(value);

export const currentApiKeyUsageWindow = (usageResetAtMs: number, windowMs: number, nowMs: number): { start: number; reset: number } => {
  const initialStart = usageResetAtMs - windowMs;
  if (nowMs < usageResetAtMs) return { start: initialStart, reset: usageResetAtMs };
  const elapsedWindows = Math.floor((nowMs - initialStart) / windowMs);
  const start = initialStart + elapsedWindows * windowMs;
  return { start, reset: start + windowMs };
};

export const makeApiKeyUsageWindowV3 = (policy: Pick<ApiKeyPolicy, ApiKeyUsagePolicyScope | "usage_reset_at_ms">, nowMs: number): ApiKeyUsageWindowV3 => ({
  v: 3,
  key_id: policy.key_id,
  policy_version: policy.policy_version,
  window_start_ms: policy.window_start_ms,
  window_reset_at_ms: policy.usage_reset_at_ms,
  committed_requests: 0,
  reserved_requests: 0,
  updated_at_ms: nowMs,
});

export const isSafeNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const normalizeApiKeyUsageWindowV3 = (value: unknown): ApiKeyUsageWindowV3 | null => {
  if (!isRecord(value)) return null;
  if (
    value.v !== 3 ||
    typeof value.key_id !== "string" ||
    !value.key_id ||
    typeof value.policy_version !== "string" ||
    !value.policy_version ||
    !isSafeNonNegativeInteger(value.window_start_ms) ||
    !isSafeNonNegativeInteger(value.window_reset_at_ms) ||
    value.window_reset_at_ms <= value.window_start_ms ||
    !isSafeNonNegativeInteger(value.committed_requests) ||
    !isSafeNonNegativeInteger(value.reserved_requests) ||
    !isSafeNonNegativeInteger(value.updated_at_ms)
  )
    return null;
  return value as ApiKeyUsageWindowV3;
};

export const normalizeApiKeyUsageRequestV3 = (value: unknown): ApiKeyUsageRequestV3 | null => {
  if (!isRecord(value)) return null;
  if (
    value.v !== 3 ||
    typeof value.key_id !== "string" ||
    !value.key_id ||
    typeof value.request_id !== "string" ||
    !value.request_id ||
    typeof value.route !== "string" ||
    !value.route ||
    (value.state !== "reserved" && value.state !== "dispatched" && value.state !== "released") ||
    !isSafeNonNegativeInteger(value.reserved_at_ms) ||
    !isSafeNonNegativeInteger(value.lease_expires_at_ms) ||
    !(value.provider === null || isApiKeyUsageProvider(value.provider)) ||
    !(value.dispatched_at_ms === null || isSafeNonNegativeInteger(value.dispatched_at_ms)) ||
    !(value.released_at_ms === null || isSafeNonNegativeInteger(value.released_at_ms)) ||
    !(value.release_reason === null || typeof value.release_reason === "string")
  )
    return null;
  if (
    (value.state === "reserved" &&
      (value.provider !== null || value.dispatched_at_ms !== null || value.released_at_ms !== null || value.release_reason !== null)) ||
    (value.state === "dispatched" &&
      (value.provider === null || value.dispatched_at_ms === null || value.released_at_ms !== null || value.release_reason !== null)) ||
    (value.state === "released" &&
      (value.provider !== null || value.dispatched_at_ms !== null || value.released_at_ms === null || value.release_reason === null))
  )
    return null;
  return value as ApiKeyUsageRequestV3;
};

export const matchingApiKeyUsageWindowV3 = (value: unknown, policy: ApiKeyPolicy): ApiKeyUsageWindowV3 | null => {
  const window = normalizeApiKeyUsageWindowV3(value);
  if (!window) return null;
  return window.key_id === policy.key_id &&
    window.policy_version === policy.policy_version &&
    window.window_start_ms === policy.window_start_ms &&
    window.window_reset_at_ms === policy.usage_reset_at_ms
    ? window
    : null;
};

export const apiKeyUsageV3PolicyVersion = (windowMs: number): string => `v3:${windowMs}`;

export const apiKeyUsageV3RetentionMs = (windowResetAtMs: number, nowMs: number): number =>
  Math.max(1, windowResetAtMs + API_KEY_USAGE_V3_RETENTION_MS - nowMs);

export const isApiKeyUsageReservationExpired = (request: ApiKeyUsageRequestV3, nowMs: number): boolean =>
  request.state === "reserved" && request.lease_expires_at_ms <= nowMs;

const writePlan = (
  checks: ApiKeyUsageWritePlan["checks"],
  request: ApiKeyUsageRequestV3,
  window: ApiKeyUsageWindowV3,
  nowMs: number
): ApiKeyUsageWritePlan => ({ kind: "write", checks, request, window, expireIn: apiKeyUsageV3RetentionMs(window.window_reset_at_ms, nowMs) });

/** The adapter supplies the live policy whose hash-row revision it will check. */
export const planApiKeyUsageReservation = (
  policy: ApiKeyPolicy,
  requestId: string,
  route: string,
  snapshot: ApiKeyUsageSnapshot,
  nowMs: number
): ApiKeyUsageReservationPlan => {
  const request = normalizeApiKeyUsageRequestV3(snapshot.request);
  if (snapshot.request !== null && !request) return { kind: "unavailable", reason: "request_malformed" };
  if (request) {
    if (request.key_id !== policy.key_id || request.request_id !== requestId || request.route !== route)
      return { kind: "unavailable", reason: "identity_conflict" };
    if (request.state !== "reserved") return { kind: "unavailable", reason: "identity_consumed" };
    return { kind: "reuse" };
  }
  const window = snapshot.window === null ? makeApiKeyUsageWindowV3(policy, nowMs) : matchingApiKeyUsageWindowV3(snapshot.window, policy);
  if (!window) return { kind: "unavailable", reason: "window_malformed" };
  if (policy.usage_limit_requests !== -1 && window.committed_requests + window.reserved_requests >= policy.usage_limit_requests)
    return { kind: "full", window };
  return writePlan(
    ["policy", "window", "request"],
    {
      v: 3,
      key_id: policy.key_id,
      request_id: requestId,
      route,
      state: "reserved",
      reserved_at_ms: nowMs,
      lease_expires_at_ms: nowMs + API_KEY_USAGE_V3_RESERVATION_LEASE_MS,
      provider: null,
      dispatched_at_ms: null,
      released_at_ms: null,
      release_reason: null,
    },
    { ...window, reserved_requests: window.reserved_requests + 1, updated_at_ms: nowMs },
    nowMs
  );
};

export const planApiKeyUsageDispatch = (
  policy: ApiKeyPolicy,
  requestId: string,
  route: string,
  provider: ApiKeyUsageProvider,
  snapshot: ApiKeyUsageSnapshot,
  nowMs: number
): ApiKeyUsageDispatchPlan => {
  const request = normalizeApiKeyUsageRequestV3(snapshot.request);
  if (request?.key_id !== policy.key_id || request.request_id !== requestId || request.route !== route || request.state === "released")
    return { kind: "invalid" };
  if (request.state === "dispatched") return { kind: "already_dispatched" };
  const window = matchingApiKeyUsageWindowV3(snapshot.window, policy);
  if (!window || window.reserved_requests < 1) return { kind: "invalid" };
  return writePlan(
    ["request", "window"],
    { ...request, state: "dispatched", provider, dispatched_at_ms: nowMs },
    { ...window, committed_requests: window.committed_requests + 1, reserved_requests: window.reserved_requests - 1, updated_at_ms: nowMs },
    nowMs
  );
};

export const planApiKeyUsageReservedRelease = (
  policy: ApiKeyPolicy,
  requestId: string,
  reason: string,
  snapshot: ApiKeyUsageSnapshot,
  nowMs: number,
  expectedRoute?: string
): ApiKeyUsageReleasePlan => {
  const request = normalizeApiKeyUsageRequestV3(snapshot.request);
  if (!request) return { kind: snapshot.request === null ? "missing" : "invalid" };
  if (request.key_id !== policy.key_id || request.request_id !== requestId || (expectedRoute !== undefined && request.route !== expectedRoute))
    return { kind: "invalid" };
  if (request.state !== "reserved") return { kind: "settled" };
  const window = matchingApiKeyUsageWindowV3(snapshot.window, policy);
  if (!window || window.reserved_requests < 1) return { kind: "invalid" };
  return writePlan(
    ["request", "window"],
    { ...request, state: "released", released_at_ms: nowMs, release_reason: reason },
    { ...window, reserved_requests: window.reserved_requests - 1, updated_at_ms: nowMs },
    nowMs
  );
};

/** Only the request-owned transport capability may call this before transport starts. */
export const planApiKeyUsageDispatchCancellation = (
  policy: ApiKeyPolicy,
  requestId: string,
  route: string,
  provider: ApiKeyUsageProvider,
  snapshot: ApiKeyUsageSnapshot,
  nowMs: number
): ApiKeyUsageReleasePlan => {
  const request = normalizeApiKeyUsageRequestV3(snapshot.request);
  if (!request) return { kind: snapshot.request === null ? "missing" : "invalid" };
  if (request.key_id !== policy.key_id || request.request_id !== requestId || request.route !== route) return { kind: "invalid" };
  if (request.state !== "dispatched") return { kind: "settled" };
  if (request.provider !== provider) return { kind: "invalid" };
  const window = matchingApiKeyUsageWindowV3(snapshot.window, policy);
  if (!window || window.committed_requests < 1) return { kind: "invalid" };
  return writePlan(
    ["request", "window"],
    { ...request, state: "released", provider: null, dispatched_at_ms: null, released_at_ms: nowMs, release_reason: "transport_cancelled_before_fetch" },
    { ...window, committed_requests: window.committed_requests - 1, updated_at_ms: nowMs },
    nowMs
  );
};

/**
 * Claude Code subscription tier. This is the owner-gated adapter described in
 * docs/handoff/claude-code-subscription-tier-2026-10-11.md: it speaks the
 * native Anthropic Messages wire with the subscriber's own OAuth credential
 * (the documented one-year `claude setup-token` token for v1), keeps the
 * provider's unified rate-limit headers as the only authoritative quota
 * evidence, and never fabricates client identity beyond the documented OAuth
 * beta. Eligibility is decided by the operator selection, an explicit
 * principal allowlist, and configured credentials; any missing condition
 * leaves the route inert for that request.
 */
import { STREAM_FIRST_EVENT_DEADLINE_MS } from "../inference-deadline.ts";
import { type ApiKeyProviderDispatch, ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import type { SentinelUpstreamRecorder } from "../sentinel/upstream-capture.ts";
import type { PromptCacheMode } from "../openai-telemetry.ts";
import { buildSurplusClaudeRequest, isSurplusClaudeModel } from "./surplus-claude-request.ts";
import { normalizeAnthropicResponsesResponse } from "./anthropic-responses.ts";
import {
  claudeCodeExhaustionFromResponse,
  claudeCodeQuotaBlocked,
  claudeCodeQuotaCoolingDown,
  type ClaudeCodeQuotaObservation,
  type ClaudeCodeQuotaState,
  type ClaudeCodeWindowId,
  observeClaudeCodeQuota,
} from "./claude-code-quota.ts";

export const CLAUDE_CODE_BASE_URL = "https://api.anthropic.com";
const CLAUDE_CODE_MESSAGES_URL = `${CLAUDE_CODE_BASE_URL}/v1/messages`;
export const CLAUDE_CODE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const CLAUDE_CODE_ALLOWED_KEY_IDS_ENV = "CLAUDE_CODE_ALLOWED_KEY_IDS";
export const CLAUDE_CODE_ANTHROPIC_VERSION = "2023-06-01";
export const CLAUDE_CODE_OAUTH_BETA = "oauth-2025-04-20";
/**
 * Anthropic Messages requires `max_tokens`. A client that omits one gets this
 * conservative floor rather than a fabricated per-model ceiling; an explicit
 * client value always wins, and catalog-driven resolution is a follow-up.
 */
export const CLAUDE_CODE_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const CLAUDE_CODE_MAX_TRANSIENT_COOLDOWN_MS = 30 * 60_000;

export type ClaudeCodeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Environment lookup seam so tests never touch process state. */
export type ClaudeCodeEnvLookup = (name: string) => string | null | undefined;

const defaultEnvLookup: ClaudeCodeEnvLookup = (name) => {
  try {
    return process.env[name];
  } catch {
    return null;
  }
};

export const readClaudeCodeToken = (env: ClaudeCodeEnvLookup = defaultEnvLookup): string | null =>
  nonEmptyString(env(CLAUDE_CODE_OAUTH_TOKEN_ENV) ?? undefined);

/**
 * The explicit principal allowlist. Empty or absent means nobody, so enabling
 * the tier always takes a second deliberate operator action beyond storing a
 * credential.
 */
export const parseClaudeCodeAllowedKeyIds = (raw: string | null | undefined): ReadonlySet<string> => {
  const ids = new Set<string>();
  if (typeof raw !== "string") return ids;
  for (const candidate of raw.split(/[\s,]+/)) {
    const id = candidate.trim();
    if (id) ids.add(id);
  }
  return ids;
};

export const readClaudeCodeAllowedKeyIds = (env: ClaudeCodeEnvLookup = defaultEnvLookup): ReadonlySet<string> =>
  parseClaudeCodeAllowedKeyIds(env(CLAUDE_CODE_ALLOWED_KEY_IDS_ENV) ?? undefined);

export type ClaudeCodeEligibility =
  | Readonly<{ eligible: true; token: string }>
  | Readonly<{
      eligible: false;
      reason: "model_unsupported" | "provider_disabled" | "principal_not_allowed" | "token_missing" | "quota_blocked" | "cooling_down";
    }>;

export type ClaudeCodeEligibilityInput = Readonly<{
  /** Gateway-visible model id for this request. */
  model: unknown;
  /** Authenticated principal for this request; never a shared or anonymous scope. */
  keyId: string | null;
  providerEnabled: boolean;
  allowedKeyIds: ReadonlySet<string>;
  token: string | null;
  quota: ClaudeCodeQuotaState | null;
  nowMs?: number;
}>;

/**
 * All conditions are conjunctive and none is inferred from another: the model
 * must be a Claude model, the operator selection must keep the provider on,
 * the request principal must be on the explicit allowlist, a credential must
 * exist, and the last authoritative window observation must not still block.
 */
export const resolveClaudeCodeEligibility = (input: ClaudeCodeEligibilityInput): ClaudeCodeEligibility => {
  const nowMs = input.nowMs ?? Date.now();
  if (!isSurplusClaudeModel(input.model)) return { eligible: false, reason: "model_unsupported" };
  if (!input.providerEnabled) return { eligible: false, reason: "provider_disabled" };
  if (!input.keyId || !input.allowedKeyIds.has(input.keyId)) return { eligible: false, reason: "principal_not_allowed" };
  if (!input.token) return { eligible: false, reason: "token_missing" };
  if (claudeCodeQuotaBlocked(input.quota, nowMs)) return { eligible: false, reason: "quota_blocked" };
  if (claudeCodeQuotaCoolingDown(input.quota, nowMs)) return { eligible: false, reason: "cooling_down" };
  return { eligible: true, token: input.token };
};

export type ClaudeCodeErrorCode = "claude_code_credential_missing" | "claude_code_request_invalid" | "claude_code_upstream_unreachable";

export class ClaudeCodeError extends Error {
  readonly code: ClaudeCodeErrorCode;
  readonly status: number;
  readonly upstream_status: number | null;

  constructor(message: string, code: ClaudeCodeErrorCode, status: number, upstreamStatus: number | null = null) {
    super(message);
    this.name = "ClaudeCodeError";
    this.code = code;
    this.status = status;
    this.upstream_status = upstreamStatus;
  }
}

export type ClaudeCodeResponseClassification = Readonly<{
  kind: "ok" | "durable_exhaustion" | "transient_rate_limited" | "auth_invalid" | "forbidden" | "upstream_error" | "request_rejected";
  exhaustion: Readonly<{ window: ClaudeCodeWindowId; reset_at_ms: number | null }> | null;
  retry_after_ms: number | null;
}>;

const parseRetryAfterMs = (value: string | null): number | null => {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.trunc(seconds * 1_000), CLAUDE_CODE_MAX_TRANSIENT_COOLDOWN_MS);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), CLAUDE_CODE_MAX_TRANSIENT_COOLDOWN_MS);
  return null;
};

/**
 * Classify one upstream response without reading its body: durable exhaustion
 * needs the documented unified window evidence on a rejection, a generic rate
 * limit stays request-local, and authentication failures are their own class.
 */
export const classifyClaudeCodeResponse = (status: number, headers: Headers, nowMs: number = Date.now()): ClaudeCodeResponseClassification => {
  if (status >= 200 && status < 300) return { kind: "ok", exhaustion: null, retry_after_ms: null };
  if (status === 429) {
    const observation = observeClaudeCodeQuota(headers, nowMs);
    const exhaustion = claudeCodeExhaustionFromResponse(status, observation);
    if (exhaustion) return { kind: "durable_exhaustion", exhaustion, retry_after_ms: null };
    return { kind: "transient_rate_limited", exhaustion: null, retry_after_ms: parseRetryAfterMs(headers.get("retry-after")) };
  }
  if (status === 401) return { kind: "auth_invalid", exhaustion: null, retry_after_ms: null };
  if (status === 403) return { kind: "forbidden", exhaustion: null, retry_after_ms: null };
  if (status >= 500) return { kind: "upstream_error", exhaustion: null, retry_after_ms: null };
  return { kind: "request_rejected", exhaustion: null, retry_after_ms: null };
};

export type ClaudeCodeAuthenticatedFetchOptions = Readonly<{
  /** OAuth or setup token; resolved internally from the environment when absent. */
  token?: string | null;
  fetcher?: ClaudeCodeFetch;
  signal?: AbortSignal;
  /** Private authenticated identity for signed native reasoning replay; never sent upstream. */
  reasoningReplayScope?: string;
  beforeDispatch?: () => Promise<ApiKeyProviderDispatch | undefined>;
  onDispatch?: () => void;
  sentinelUpstreamRecorder?: SentinelUpstreamRecorder;
}>;

export type ClaudeCodeResponsesResult = Readonly<{
  response: Response;
  request_id: string | null;
  prompt_cache_mode?: PromptCacheMode;
  explicit_breakpoint_count?: number;
  quota: ClaudeCodeQuotaObservation | null;
  classification: ClaudeCodeResponseClassification;
}>;

const requireClaudeCodeToken = (supplied: string | null | undefined): string => {
  const token = supplied === undefined ? readClaudeCodeToken() : nonEmptyString(supplied);
  if (token) return token;
  throw new ClaudeCodeError(
    `Claude Code subscription inference is unavailable because ${CLAUDE_CODE_OAUTH_TOKEN_ENV} is not configured.`,
    "claude_code_credential_missing",
    503
  );
};

/**
 * The documented subscription-traffic header set. Bearer alone replaces the
 * API key, the OAuth beta must survive gateway forwarding, and no client
 * fingerprint beyond that is synthesized.
 */
export const claudeCodeRequestHeaders = (token: string, stream: boolean): Headers => {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", stream ? "text/event-stream" : "application/json");
  headers.set("anthropic-version", CLAUDE_CODE_ANTHROPIC_VERSION);
  headers.set("anthropic-beta", CLAUDE_CODE_OAUTH_BETA);
  return headers;
};

const claudeCodeRequestUrl = (): string => CLAUDE_CODE_MESSAGES_URL;

const claudeCodeTransportFailure = (error: unknown, signal: AbortSignal | undefined, headersDeadline: AbortController): unknown => {
  if (error instanceof ApiKeyQuotaDispatchError) return error;
  if (signal?.aborted) return signal.reason ?? error;
  if (headersDeadline.signal.aborted) return headersDeadline.signal.reason ?? error;
  if (error instanceof Error && error.name === "AbortError") return error;
  return new ClaudeCodeError("Claude Code Messages request could not reach the upstream service.", "claude_code_upstream_unreachable", 502);
};

const abortReasonError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted.", "AbortError");

const awaitWithAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw abortReasonError(signal);
  let dispose = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      reject(abortReasonError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => {
      signal.removeEventListener("abort", onAbort);
    };
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    dispose();
  }
};

const responseRequestId = (response: Response): string | null => {
  const id = response.headers.get("request-id") ?? response.headers.get("x-request-id");
  return nonEmptyString(id);
};

const responseReasoningSummary = (body: Record<string, unknown>): string | undefined => {
  const reasoning = body.reasoning;
  return isRecord(reasoning) ? (nonEmptyString(reasoning.summary) ?? undefined) : undefined;
};

/**
 * Build the native Messages request for a Claude model. Returns null when the
 * caller's body has no lossless native representation; the caller then leaves
 * the request to the ordinary paid route instead of trimming its meaning.
 */
export const buildClaudeCodeRequest = (
  body: Record<string, unknown>,
  options: Readonly<{ reasoningReplayScope?: string; maxOutputTokens?: number }> = {}
): ReturnType<typeof buildSurplusClaudeRequest> => {
  if (!isSurplusClaudeModel(body.model)) return null;
  const maxOutputTokens = body.max_output_tokens === undefined ? (options.maxOutputTokens ?? CLAUDE_CODE_DEFAULT_MAX_OUTPUT_TOKENS) : undefined;
  const built = buildSurplusClaudeRequest(body, maxOutputTokens, {
    provider: "claude_code",
    reasoningReplayScope: options.reasoningReplayScope,
    // The direct Messages route carries the documented adaptive-thinking wire
    // the shared builder already emits.
    supportsNativeReasoningEffort: true,
  });
  if (!built) return null;
  // `prompt_cache_key` is a reseller-router affinity hint with no place in the
  // native Messages contract, so it never reaches the direct route.
  const nativeBody: Record<string, unknown> = { ...built.body };
  delete nativeBody.prompt_cache_key;
  return { ...built, body: nativeBody };
};

export const fetchClaudeCodeResponses = async (body: unknown, options: ClaudeCodeAuthenticatedFetchOptions = {}): Promise<ClaudeCodeResponsesResult> => {
  if (!isRecord(body)) {
    throw new ClaudeCodeError("Claude Code Messages requests must use a canonical JSON object body.", "claude_code_request_invalid", 400);
  }
  const native = buildClaudeCodeRequest(body, {
    reasoningReplayScope: options.reasoningReplayScope,
    maxOutputTokens: undefined,
  });
  if (!native) {
    throw new ClaudeCodeError("The request has no lossless native Anthropic Messages representation.", "claude_code_request_invalid", 400);
  }

  let encodedBody: string;
  try {
    encodedBody = JSON.stringify(native.body);
  } catch {
    throw new ClaudeCodeError("Claude Code Messages requests must use a JSON-serializable body.", "claude_code_request_invalid", 400);
  }
  if (typeof encodedBody !== "string") {
    throw new ClaudeCodeError("Claude Code Messages requests must use a JSON-serializable body.", "claude_code_request_invalid", 400);
  }

  const token = requireClaudeCodeToken(options.token);
  const headers = claudeCodeRequestHeaders(token, native.body.stream === true);
  const headersDeadline = new AbortController();
  const headersTimer = setTimeout(() => {
    headersDeadline.abort(new DOMException("Claude Code response headers timed out.", "TimeoutError"));
  }, STREAM_FIRST_EVENT_DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, headersDeadline.signal]) : headersDeadline.signal;
  let response: Response;
  let upstreamAttempt: ReturnType<SentinelUpstreamRecorder["startAttempt"]> | null = null;
  try {
    const dispatch = options.beforeDispatch ? await options.beforeDispatch() : undefined;
    if (signal.aborted) {
      await dispatch?.cancelBeforeTransport();
      throw signal.reason ?? new DOMException("The request was aborted.", "AbortError");
    }
    dispatch?.markTransportStarted();
    options.onDispatch?.();
    upstreamAttempt = options.sentinelUpstreamRecorder?.startAttempt("claude_code") ?? null;
    response = await awaitWithAbort(
      (options.fetcher ?? fetch)(claudeCodeRequestUrl(), {
        method: "POST",
        headers,
        body: encodedBody,
        redirect: "manual",
        signal,
      }),
      signal
    );
  } catch (error) {
    upstreamAttempt?.recordFetchError();
    throw claudeCodeTransportFailure(error, options.signal, headersDeadline);
  } finally {
    clearTimeout(headersTimer);
  }

  const requestId = responseRequestId(response);
  const classification = classifyClaudeCodeResponse(response.status, response.headers);
  const quota = observeClaudeCodeQuota(response.headers);
  const recorded = upstreamAttempt ? upstreamAttempt.wrap(response) : response;
  const delivered = await normalizeAnthropicResponsesResponse(recorded, {
    model: String(body.model),
    requestId: requestId ?? undefined,
    signal: options.signal,
    reasoningSummary: responseReasoningSummary(body),
    reasoningReplayScope: options.reasoningReplayScope,
    provider: "claude_code",
  });
  return {
    response: delivered,
    request_id: requestId,
    prompt_cache_mode: native.promptCacheMode,
    explicit_breakpoint_count: native.explicitBreakpointCount,
    quota,
    classification,
  };
};

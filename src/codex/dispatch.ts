// Codex dispatch primitives and request preparation, split out of src/codex.ts.

import { config } from "../config.ts";
import { getKv } from "../kv.ts";
import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { RoutingAccount } from "./routing-state.ts";
import { RouteSelection } from "./routing-state.ts";
import { CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, parseCodexActiveAccountSelection } from "./routing-state.ts";
import { routingAccountIdentity } from "./capacity-routing.ts";
import { type CodexBankedResetConfig, type CodexBankedResetTelemetry } from "./banked-reset.ts";
import { type CodexUsageResetProvider } from "./banked-reset-provider.ts";
import { type ApiKeyProviderDispatch, ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "../inference-deadline.ts";
import { recordCodexProviderHealth } from "../provider/health.ts";
import { recordProviderCapacityDowntimeEvent, triggerProviderCapacitySample } from "../provider/capacity-events.ts";
import type { SentinelUpstreamRecorder } from "../sentinel/upstream-capture.ts";
import { getString, isRecord, sha256Hex } from "../utils.ts";
import type { CodexAuthState } from "../types.ts";
import type { CodexAuthAccountEntry, CodexAuthPoolEntry } from "./auth.ts";
import {
  CODEX_ACTIVE_ADMISSION_RESEELECTION_LIMIT,
  CODEX_AUTH_REAUTH_MESSAGE,
  CODEX_AUTH_REAUTH_WARNING,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CODEX_QUOTA_BLOCKED_ERROR_CODE,
  CODEX_SUBSCRIPTIONS_UNAVAILABLE_ERROR_CODE,
  CODEX_UPSTREAM_DEGRADED_ERROR_CODE,
  CodexError,
  accessTokenExpired,
  codexProbeTransitionsInFlight,
  codexRoutingErrors,
  getAuthPoolEntry,
  getCodexResponseActiveTelemetry,
  getCodexResponseSlot,
  withCodexAuthWarning,
} from "./auth.ts";
import { abortReasonAsError } from "./auth-refresh.ts";
import { recordCodexModelUnsupported } from "../models/codex-models-availability.ts";

const codexModelsBaseUrls = (clientVersion: string | null): string[] => {
  // Strip trailing slashes without the backtracking `\/+$` pattern: the scan is
  // linear and produces exactly what `replace(/\/+$/, "")` produced.
  const configured = config.codexBaseUrl;
  let end = configured.length;
  while (end > 0 && configured.charAt(end - 1) === "/") end -= 1;
  const base = configured.slice(0, end);
  const urls = new Set<string>();

  // Prefer the Codex-specific models endpoint when available. It requires `client_version`.
  if (base.endsWith("/codex")) {
    const codexUrl = new URL(`${base}/models`);
    if (clientVersion) codexUrl.searchParams.set("client_version", clientVersion);
    urls.add(codexUrl.toString());
  } else {
    urls.add(`${base}/models`);
  }

  return Array.from(urls);
};

const fetchCodexModelsWithAuth = async (
  auth: CodexAuthState,
  url: string,
  clientVersion: string | null,
  ifNoneMatch?: string | null,
  signal?: AbortSignal
): Promise<Response> => {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.access_token}`);
  headers.set("ChatGPT-Account-ID", auth.account_id);
  headers.set("originator", CODEX_ORIGINATOR);
  headers.set("user-agent", `codex_cli_rs/${clientVersion ?? CODEX_CLIENT_VERSION} (ai.ubq.fi)`);
  headers.set("Accept", "application/json");
  if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);

  try {
    return await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });
  } catch (error) {
    throw new CodexError("Codex upstream request failed: upstream unreachable.", "codex_upstream_unreachable", 502, error);
  }
};

export const orderCodexAuthAccounts = (accounts: readonly CodexAuthState[], startIndex: number): CodexAuthState[] => {
  if (accounts.length === 0) return [];
  const normalizedStart = ((Math.trunc(startIndex) % accounts.length) + accounts.length) % accounts.length;
  return accounts.map((_, offset) => accounts[(normalizedStart + offset) % accounts.length]);
};

const randomizedAuthEntries = (poolEntry: CodexAuthPoolEntry): CodexAuthAccountEntry[] => {
  const entropy = crypto.getRandomValues(new Uint8Array(1))[0];
  return orderCodexAuthAccounts(poolEntry.pool.accounts, entropy).map((auth) => ({ ...poolEntry, auth }));
};

const cancelResponseBody = (response: Response): void => {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => {});
  } catch {
    // Best effort before retrying another account.
  }
};

const recordCodexResponseHealth = async (
  accountId: string,
  response: Response,
  auth?: CodexAuthState,
  successfulResponseEvent: "success" | "reachable" | null = null
): Promise<void> => {
  const providerRequestId = response.headers.get("X-Request-Id") ?? response.headers.get("X-Api-Request-Id") ?? response.headers.get("X-Oneapi-Request-Id");
  if (response.status === 401 || (response.status === 403 && auth !== undefined && accessTokenExpired(auth))) {
    await recordCodexProviderHealth(accountId, "auth_invalid", response.status, Date.now, providerRequestId);
  } else if (response.status === 429) {
    // An exhausted account is the strongest capacity observation there is.
    triggerProviderCapacitySample();
    await recordCodexProviderHealth(accountId, "quota_exhausted", response.status, Date.now, providerRequestId);
  } else if (response.status >= 500) {
    void recordProviderCapacityDowntimeEvent({
      failure_kind: "upstream_error",
      status: response.status,
      observed_at_ms: Date.now(),
    });
    // An upstream failure is a capacity observation: sample the bucket now.
    triggerProviderCapacitySample();
    await recordCodexProviderHealth(accountId, "upstream_error", response.status, Date.now, providerRequestId);
  } else if (response.ok && successfulResponseEvent !== null) {
    // A served request is a capacity observation too: it keeps the bucket's
    // history current on a healthy gateway, still one probe per bucket.
    triggerProviderCapacitySample();
    await recordCodexProviderHealth(accountId, successfulResponseEvent, response.status, Date.now, providerRequestId);
  } else if (!response.ok) {
    await recordCodexProviderHealth(accountId, "reachable", response.status, Date.now, providerRequestId);
  }
};

const recordCodexThrownHealth = async (accountId: string, error: unknown): Promise<void> => {
  if (
    error instanceof CodexError &&
    (error.code === "codex_auth_refresh_failed" ||
      error.code === "refresh_token_reused" ||
      error.code === "codex_auth_refresh_unreachable" ||
      error.code === "codex_auth_owner_unavailable" ||
      error.code === "codex_auth_owner_conflict")
  ) {
    return;
  }
  const isProviderTransportFailure = error instanceof CodexError && (error.code === "gateway_timeout" || error.code === "codex_upstream_unreachable");
  await recordCodexProviderHealth(accountId, "upstream_error", null);
  if (isProviderTransportFailure) {
    void recordProviderCapacityDowntimeEvent({
      failure_kind: "unreachable",
      status: error instanceof CodexError && error.status >= 500 && error.status <= 599 ? error.status : null,
      observed_at_ms: Date.now(),
    });
    triggerProviderCapacitySample();
  }
};

/**
 * A post-reset retry is fenced more strictly than normal account routing. If
 * the auth-pool slot changes in the tiny interval before transport, preserve
 * the ordinary quota response instead of dispatching stale credentials.
 */
class CodexBankedResetRetryFenceError extends Error {
  constructor() {
    super("Codex banked-reset retry was fenced by an auth-pool change.");
    this.name = "CodexBankedResetRetryFenceError";
  }
}

/** A dispatch admitted before a newer active selection must never reach transport. */
class CodexActiveAccountFenceError extends Error {
  constructor() {
    super("Codex active-account admission was superseded before transport.");
    this.name = "CodexActiveAccountFenceError";
  }
}

const fetchCodexResponseWithAuth = async (
  auth: CodexAuthState,
  url: string,
  serializedBody: string,
  baseHeaders: Headers,
  signal?: AbortSignal,
  beforeTransport?: () => Promise<void>,
  onDispatch?: () => void
): Promise<Response> => {
  const headers = new Headers(baseHeaders);
  headers.set("Authorization", `Bearer ${auth.access_token}`);
  headers.set("ChatGPT-Account-ID", auth.account_id);
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadline.abort(new DOMException("Codex response headers timed out.", "TimeoutError"));
  }, BUFFERED_INFERENCE_DEADLINE_MS);
  const transportSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    await beforeTransport?.();
    if (transportSignal.aborted) {
      throw transportSignal.reason ?? new DOMException("The request was aborted.", "AbortError");
    }
    onDispatch?.();
    return await fetch(url, {
      method: "POST",
      headers,
      body: serializedBody,
      redirect: "manual",
      signal: transportSignal,
    });
  } catch (error) {
    if (error instanceof ApiKeyQuotaDispatchError) throw error;
    if (error instanceof CodexBankedResetRetryFenceError || error instanceof CodexActiveAccountFenceError) throw error;
    const timedOut =
      deadline.signal.aborted ||
      (error instanceof Error && error.name === "TimeoutError") ||
      (signal?.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError");
    if (timedOut) {
      throw new CodexError("Codex upstream exceeded the gateway deadline before response headers were received.", "gateway_timeout", 504, error);
    }
    if (signal?.aborted) throw signal.reason ?? error;
    throw new CodexError("Codex upstream request failed: upstream unreachable.", "codex_upstream_unreachable", 502, error);
  } finally {
    clearTimeout(deadlineTimer);
  }
};

const routingErrorType = (status: 401 | 404 | 429 | 503): string => {
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
};

const routingErrorResponse = (status: 401 | 404 | 429 | 503, message: string, code: string, retryAtMs: number | null = null): Response => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if ((status === 429 || status === 503) && retryAtMs !== null) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000))));
  }
  const response = new Response(
    JSON.stringify({
      error: {
        message,
        type: routingErrorType(status),
        code,
        param: null,
      },
    }),
    { status, headers }
  );
  if (code === CODEX_QUOTA_BLOCKED_ERROR_CODE || code === CODEX_SUBSCRIPTIONS_UNAVAILABLE_ERROR_CODE || code === CODEX_UPSTREAM_DEGRADED_ERROR_CODE) {
    codexRoutingErrors.set(response, code);
  }
  return response;
};

const upstreamTimeoutCircuitResponse = (retryAtMs: number | null): Response =>
  routingErrorResponse(
    503,
    "Codex upstream is temporarily unavailable after response-header timeouts; retry later.",
    CODEX_UPSTREAM_DEGRADED_ERROR_CODE,
    retryAtMs
  );

/**
 * No configured account can serve the named model. This is answered as an
 * unavailable model, never as a retryable quota or credential failure: waiting
 * changes nothing and this path wrote no fence.
 */
const codexModelUnavailableResponse = (model: string, detail: string | null): Response => {
  const base = `The model '${model}' does not exist or is not available through this gateway. Use /v1/models for supported models.`;
  return routingErrorResponse(404, detail === null ? base : `${base} Upstream detail: ${detail}`, "model_not_found");
};

type CodexResponseTimingHooks = Readonly<{
  onDispatch?: () => void;
  onHeaders?: () => void;
}>;

type FetchCodexResponsesOptions = Readonly<{
  clientVersion?: string | null;
  cacheScope?: string | null;
  signal?: AbortSignal;
  requestId?: string | null;
  timing?: CodexResponseTimingHooks;
  retrySleep?: (milliseconds: number) => Promise<void>;
  /**
   * Quota hook. Callers either own a dispatch handle
   * (`Promise<ApiKeyProviderDispatch>`) or have nothing to hand back, which is
   * why the "no value" arm is a `void`-returning function type: it also accepts
   * the `Promise<void>` producers that `?? Promise.resolve()` call sites build.
   */
  beforeDispatch?: (() => Promise<ApiKeyProviderDispatch>) | (() => void);
  bankedReset?: CodexBankedResetOptions;
  /** Request-owned passive recorder; best effort, never required. */
  sentinelUpstreamRecorder?: SentinelUpstreamRecorder;
}>;

type CodexProviderDispatchCoordinator = Readonly<{
  claim: () => Promise<void>;
  markTransportStarted: () => void;
  cancelBeforeTransport: () => Promise<void>;
}>;

const createCodexProviderDispatchCoordinator = (beforeDispatch: FetchCodexResponsesOptions["beforeDispatch"]): CodexProviderDispatchCoordinator => {
  type DispatchGeneration = {
    claim: Promise<ApiKeyProviderDispatch | undefined>;
    dispatch: ApiKeyProviderDispatch | undefined;
    transportStarted: boolean;
    cancellation: Promise<void> | null;
  };
  let current: DispatchGeneration | null = null;
  return {
    claim: () => {
      if (!current || current.transportStarted) {
        const generation: DispatchGeneration = {
          claim: Promise.resolve(undefined),
          dispatch: undefined,
          transportStarted: false,
          cancellation: null,
        };
        const handedBack = beforeDispatch?.();
        const claimed = typeof handedBack === "object" ? handedBack : Promise.resolve(undefined);
        generation.claim = claimed.then((dispatch) => {
          generation.dispatch = dispatch;
          return dispatch;
        });
        current = generation;
      }
      return current.claim.then(() => {});
    },
    markTransportStarted: () => {
      if (!current || current.transportStarted) return;
      current.dispatch?.markTransportStarted();
      current.transportStarted = true;
    },
    cancelBeforeTransport: () => {
      if (!current || current.transportStarted || !current.dispatch) return Promise.resolve();
      current.cancellation ??= current.dispatch.cancelBeforeTransport();
      return current.cancellation;
    },
  };
};

type PreparedCodexSubscriptionRequest = Readonly<{
  body: unknown;
  serializedBody: string;
  conversationIdentity: string;
  nativeSessionIdentity: string | null;
  warnings: readonly string[];
}>;

const CODEX_PROMPT_CACHE_OPTIONS_IGNORED_WARNING = "prompt_cache_options_ignored";
const CODEX_PROMPT_CACHE_RETENTION_IGNORED_WARNING = "prompt_cache_retention_ignored";
const CODEX_PROMPT_CACHE_BREAKPOINT_IGNORED_WARNING = "prompt_cache_breakpoint_ignored";
const CODEX_MAX_OUTPUT_TOKENS_IGNORED_WARNING = "max_output_tokens_ignored";

const deterministicCodexSessionIdentity = async (cacheScope: string, promptCacheKey: string): Promise<string> => {
  const digest = await sha256Hex(`uos-codex-prompt-cache-session-v2\u0000${cacheScope}\u0000${promptCacheKey}`);
  const variant = ((Number.parseInt(digest.charAt(16), 16) & 0b0011) | 0b1000).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const stripCodexPromptCacheBreakpoints = (value: unknown): Readonly<{ value: unknown; removed: boolean }> => {
  if (Array.isArray(value)) {
    const entries = value.map((item) => stripCodexPromptCacheBreakpoints(item));
    if (!entries.some((entry) => entry.removed)) return { value, removed: false };
    return { value: entries.map((entry) => entry.value), removed: true };
  }
  if (!isRecord(value)) return { value, removed: false };

  let next: Record<string, unknown> | null = null;
  if (Object.prototype.hasOwnProperty.call(value, "prompt_cache_breakpoint")) {
    next = { ...value };
    delete next.prompt_cache_breakpoint;
  }
  for (const key of ["content", "output"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const stripped = stripCodexPromptCacheBreakpoints(value[key]);
    if (!stripped.removed) continue;
    next ??= { ...value };
    next[key] = stripped.value;
  }
  // `next` is set by exactly the branches that remove a breakpoint.
  return next === null ? { value, removed: false } : { value: next, removed: true };
};

/**
 * Request fields the gateway accepts from Codex CLI clients but never forwards
 * upstream, paired with the warning each one raises.
 */
const IGNORED_CODEX_REQUEST_FIELDS = [
  ["prompt_cache_options", CODEX_PROMPT_CACHE_OPTIONS_IGNORED_WARNING],
  ["prompt_cache_retention", CODEX_PROMPT_CACHE_RETENTION_IGNORED_WARNING],
  ["max_output_tokens", CODEX_MAX_OUTPUT_TOKENS_IGNORED_WARNING],
  ["max_completion_tokens", CODEX_MAX_OUTPUT_TOKENS_IGNORED_WARNING],
] as const;

const stripIgnoredCodexRequestFields = (prepared: Record<string, unknown>, warnings: string[]): void => {
  for (const [field, warning] of IGNORED_CODEX_REQUEST_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(prepared, field)) continue;
    // `Reflect.deleteProperty` is the computed-key form of `delete`, which the
    // lint stack rejects for the object-shape deoptimization it causes.
    Reflect.deleteProperty(prepared, field);
    if (!warnings.includes(warning)) warnings.push(warning);
  }
};

const prepareCodexSubscriptionRequest = async (body: unknown, cacheScope: string | null): Promise<PreparedCodexSubscriptionRequest> => {
  const warnings: string[] = [];
  let preparedBody = body;
  let promptCacheKey: string | null = null;

  if (isRecord(body)) {
    const prepared: Record<string, unknown> = { ...body };
    promptCacheKey = typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim().length > 0 ? body.prompt_cache_key : null;
    stripIgnoredCodexRequestFields(prepared, warnings);
    if (Object.prototype.hasOwnProperty.call(prepared, "input")) {
      const stripped = stripCodexPromptCacheBreakpoints(prepared.input);
      prepared.input = stripped.value;
      if (stripped.removed) warnings.push(CODEX_PROMPT_CACHE_BREAKPOINT_IGNORED_WARNING);
    }
    preparedBody = prepared;
  }

  const nativeSessionIdentity =
    promptCacheKey === null || cacheScope === null || cacheScope.length === 0 ? null : await deterministicCodexSessionIdentity(cacheScope, promptCacheKey);
  return {
    body: preparedBody,
    serializedBody: JSON.stringify(preparedBody),
    conversationIdentity: nativeSessionIdentity ?? crypto.randomUUID(),
    nativeSessionIdentity,
    warnings,
  };
};

type CodexAttemptPhase = "initial" | "post_refresh" | "two_second_retry" | "post_retry_refresh" | "post_banked_reset" | "overage_fallback";

type CodexBankedResetOptions = Readonly<{
  /** Test seam; normal traffic creates an account-bound upstream adapter only for a live reset candidate. */
  config?: CodexBankedResetConfig;
  /** Test seam for proving a live configuration change stops a pending submission. */
  reloadConfig?: () => CodexBankedResetConfig;
  provider?: CodexUsageResetProvider;
  kv?: Deno.Kv | null;
  now?: () => number;
  newOwnerToken?: () => string;
  hash?: (value: string) => Promise<string>;
  telemetry?: CodexBankedResetTelemetry;
}>;

type CodexBankedResetCandidate = Readonly<{
  accountEntry: CodexAuthAccountEntry;
  auth: CodexAuthState;
  routing: RoutingAccount;
  quotaResetAtMs: number;
  routingGeneration: number;
}>;

const reportCodexResponseTiming = (callback: (() => void) | undefined): void => {
  try {
    callback?.();
  } catch {
    // Observability must not affect inference routing or delivery.
  }
};

const codexStatusClass = (status: number): string => {
  if (status >= 200 && status < 300) return "2xx";
  if (status === 401) return "401";
  if (status === 403) return "403";
  if (status === 429) return "429";
  if (status >= 400 && status < 500) return "invalid_request_4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other_http";
};

const codexErrorClass = (error: unknown): string => {
  if (error instanceof CodexError) {
    if (error.code === "gateway_timeout") return "timeout";
    if (error.code === "codex_upstream_unreachable" || error.code === "codex_auth_refresh_unreachable") {
      return "network_failure";
    }
    return codexStatusClass(error.status);
  }
  return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_failure";
};

const isCodexSiblingTransportFailure = (error: unknown): error is CodexError =>
  error instanceof CodexError && (error.code === "gateway_timeout" || error.code === "codex_upstream_unreachable");

/**
 * A transport or provider callback may throw a non-Error value. Rethrowing it
 * verbatim would leak a non-Error rejection reason, so the value is preserved
 * as the cause instead; an absent value keeps the caller's own classification.
 */
const dispatchFailureAsError = (error: unknown, fallback: () => Error): Error => {
  if (error instanceof Error) return error;
  if (error === null || error === undefined) return fallback();
  return new Error("Codex upstream dispatch failed with a non-Error value.", { cause: error });
};

const logCodexRouting = (
  event:
    "codex_attempt" | "codex_banked_reset_preflight" | "codex_quota_classification" | "codex_token_refresh" | "codex_two_second_retry" | "codex_overage_served",
  fields: Readonly<Record<string, string | number | null>>
): void => {
  try {
    console.info("[ai.ubq.fi] codex_routing", JSON.stringify({ event, ...fields }));
  } catch {
    // Routing telemetry must never alter provider selection.
  }
};

const waitForCodexRetry = async (milliseconds: number, signal: AbortSignal | undefined, sleep: (milliseconds: number) => Promise<void>): Promise<void> => {
  const abortReason = (): unknown => {
    const reason = signal?.reason ?? new DOMException("The request was aborted.", "AbortError");
    if (reason instanceof Error && reason.name === "TimeoutError") {
      return new CodexError("Codex upstream exceeded the gateway deadline while waiting to retry.", "gateway_timeout", 504, reason);
    }
    return reason;
  };

  if (signal?.aborted) throw abortReason();
  if (milliseconds <= 0) return;
  if (!signal) {
    await sleep(milliseconds);
    return;
  }
  let onAbort = (): void => {};
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(abortReasonAsError(abortReason()));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

/** Settle outstanding probe transitions so routing reads observe their results. */
const awaitPendingCodexProbeTransitions = async (): Promise<void> => {
  if (codexProbeTransitionsInFlight.size) {
    await Promise.allSettled([...codexProbeTransitionsInFlight]);
  }
};

/** The upstream model this body asks for, when it names one. */
const requestedCodexModel = (body: unknown): string | null => (isRecord(body) ? getString(body.model) : null);

/** Codex CLI's native session identity is mirrored onto three internal headers. */
const applyNativeSessionHeaders = (headers: Headers, nativeSessionIdentity: string | null): void => {
  if (nativeSessionIdentity === null) return;
  headers.set("session-id", nativeSessionIdentity);
  headers.set("thread-id", nativeSessionIdentity);
  headers.set("x-client-request-id", nativeSessionIdentity);
};

/** The standard re-authentication response for a pool whose credentials all failed. */
const allCodexCredentialsInvalidResponse = (): Response =>
  withCodexAuthWarning(
    routingErrorResponse(401, `${CODEX_AUTH_REAUTH_MESSAGE} All configured Codex credentials are invalid.`, "codex_auth_invalid"),
    CODEX_AUTH_REAUTH_WARNING
  );

/** A selection no configured credential can serve is answered before any dispatch setup. */
const initialCodexSelectionResponse = (selection: RouteSelection): Response | null => {
  if (selection.kind === "routing_unavailable") {
    return routingErrorResponse(503, "Codex routing state is temporarily unavailable; retry the request.", "codex_auth_missing");
  }
  if (selection.kind === "credentials_invalid") return allCodexCredentialsInvalidResponse();
  if (selection.kind === "upstream_blocked") return upstreamTimeoutCircuitResponse(selection.retryAtMs);
  if (selection.kind === "model_unavailable") return codexModelUnavailableResponse(selection.model, selection.detail);
  return null;
};

type CodexSerialAdmissionDrivers = Readonly<{
  runPendingShortRetry: () => Promise<Response | null>;
  dispatchActive: () => Promise<Response | null>;
  terminalTransportResponse: () => Promise<Response | null>;
  hasQueuedRetry: () => boolean;
  reselectionRequested: () => boolean;
  advanceReselection: () => Promise<Response | null>;
  exhaustedResponse: () => Promise<Response>;
  /**
   * Learned account+model unavailability for one dispatched response. Real
   * traffic uses the account-attributed default; a test can supply its own
   * observation without a live upstream.
   */
  classifyModelUnavailable?: (response: Response) => Promise<CodexModelUnavailableAttempt | null>;
}>;

/** The exact upstream rejection that proves one subscription cannot serve one model. */
const CODEX_MODEL_UNSUPPORTED_DETAIL_PATTERN = /^The '([^']+)' model is not supported when using Codex with a ChatGPT account\.$/;

export type CodexModelUnavailableAttempt = Readonly<{ accountId: string; model: string; detail: string }>;

/** The model a not-supported detail names, when the detail has exactly that shape. */
export const parseCodexModelUnsupportedDetail = (payload: unknown): Readonly<{ model: string; detail: string }> | null => {
  if (!isRecord(payload)) return null;
  const detail = getString(payload.detail);
  if (detail === null) return null;
  const match = CODEX_MODEL_UNSUPPORTED_DETAIL_PATTERN.exec(detail);
  if (!match?.[1]) return null;
  return { model: match[1], detail };
};

/**
 * A 400 probe must never extend the caller's latency: the clone is read under
 * the shared byte and time bounds, and an incomplete read is not evidence.
 */
const CODEX_MODEL_UNSUPPORTED_PROBE_TIMEOUT_MS = 250;

const boundedResponseText = async (response: Response): Promise<string | null> => {
  try {
    const { bytes, complete } = await readBoundedResponseBody(response, {
      timeoutMs: CODEX_MODEL_UNSUPPORTED_PROBE_TIMEOUT_MS,
      cancellationReason: "Codex model availability probe",
    });
    return complete ? new TextDecoder().decode(bytes) : null;
  } catch {
    return null;
  }
};

/**
 * Read a 400 body through a bounded clone, so a response that does not match the
 * learned shape still reaches the caller byte-for-byte with its own stream.
 */
export const codexModelUnsupportedFromResponse = async (response: Response): Promise<Readonly<{ model: string; detail: string }> | null> => {
  if (response.status !== 400) return null;
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return null;
  }
  const text = await boundedResponseText(clone);
  if (!text) return null;
  try {
    return parseCodexModelUnsupportedDetail(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
};

/**
 * Prove which account answered a response through the durable active row it was
 * admitted under. A learned rejection skips that account for that model, so a
 * wrong attribution would take capacity from a capable account: both the
 * admission generation and the opaque account identity must match.
 */
const codexResponseAccountId = async (response: Response): Promise<string | null> => {
  const activeGeneration = getCodexResponseActiveTelemetry(response).activeGeneration;
  if (activeGeneration === null || getCodexResponseSlot(response) === null) return null;
  try {
    const kv = await getKv();
    if (!kv) return null;
    const entry = await kv.get(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, { consistency: "strong" });
    const active = parseCodexActiveAccountSelection(entry.value);
    if (active?.generation !== activeGeneration) return null;
    const poolEntry = await getAuthPoolEntry(true, true);
    if (poolEntry.entry?.versionstamp !== active.pool_versionstamp) return null;
    for (const auth of poolEntry.pool.accounts) {
      if ((await routingAccountIdentity(auth)).accountIdHash === active.account_id_hash) return auth.account_id;
    }
  } catch {
    // Attribution is best effort; without it the response is passed through.
  }
  return null;
};

/**
 * Classify one upstream 400 as learned account+model unavailability and record
 * it for routing. Every other response, including every other 400, returns null
 * and leaves both routing state and the response untouched.
 */
export const learnCodexModelUnavailable = async (response: Response): Promise<CodexModelUnavailableAttempt | null> => {
  const unsupported = await codexModelUnsupportedFromResponse(response);
  if (unsupported === null) return null;
  const accountId = await codexResponseAccountId(response);
  if (accountId === null) return null;
  await recordCodexModelUnsupported(accountId, unsupported.model, { detail: unsupported.detail });
  return { accountId, model: unsupported.model, detail: unsupported.detail };
};

type CodexModelUnavailableLoopState = { reselections: number; siblingAttempted: boolean };

/**
 * One bounded sibling attempt for a learned model-unavailable rejection. The
 * recorded account+model pair makes the following reselection skip the
 * ineligible account; when this request has already spent its attempt, the
 * graceful 404 is the final answer.
 */
const advanceCodexModelUnavailable = async (
  drivers: CodexSerialAdmissionDrivers,
  attempt: CodexModelUnavailableAttempt,
  state: CodexModelUnavailableLoopState
): Promise<Response | null> => {
  if (state.siblingAttempted || state.reselections >= CODEX_ACTIVE_ADMISSION_RESEELECTION_LIMIT) {
    return codexModelUnavailableResponse(attempt.model, attempt.detail);
  }
  state.siblingAttempted = true;
  state.reselections += 1;
  return await drivers.advanceReselection();
};

type CodexAdmissionPassOutcome = Readonly<{ kind: "return"; response: Response } | { kind: "continue" } | { kind: "exhausted" }>;

/** The terminal-transport, queued-retry and reselection part of one dispatch-less pass. */
const continueCodexAdmissionWithoutDispatch = async (
  drivers: CodexSerialAdmissionDrivers,
  state: CodexModelUnavailableLoopState
): Promise<CodexAdmissionPassOutcome> => {
  const terminalTransport = await drivers.terminalTransportResponse();
  if (terminalTransport) return { kind: "return", response: terminalTransport };
  if (drivers.hasQueuedRetry()) return { kind: "continue" };
  if (!drivers.reselectionRequested() || state.reselections >= CODEX_ACTIVE_ADMISSION_RESEELECTION_LIMIT) return { kind: "exhausted" };
  state.reselections += 1;
  const advanced = await drivers.advanceReselection();
  return advanced ? { kind: "return", response: advanced } : { kind: "continue" };
};

/** One dispatched response: an unchanged pass-through, or the bounded learned rejection. */
const handleCodexDispatchedResponse = async (
  drivers: CodexSerialAdmissionDrivers,
  classifyModelUnavailable: (response: Response) => Promise<CodexModelUnavailableAttempt | null>,
  dispatched: Response,
  state: CodexModelUnavailableLoopState
): Promise<CodexAdmissionPassOutcome> => {
  const unsupported = await classifyModelUnavailable(dispatched);
  if (unsupported === null) return { kind: "return", response: dispatched };
  const advanced = await advanceCodexModelUnavailable(drivers, unsupported, state);
  return advanced === null ? { kind: "continue" } : { kind: "return", response: advanced };
};

/**
 * The bounded one-account admission loop. Each pass runs a pending short retry,
 * dispatches only the currently admitted global active account, and asks for a
 * strong reselect after an authoritative exhaustion or final credential
 * failure instead of walking a stale sibling list. Order matters: a short retry,
 * then the active dispatch, then any terminal transport outcome, then a queued
 * retry, then one reselection advance, and finally the exhausted response.
 */
const runCodexSerialAdmissionLoop = async (drivers: CodexSerialAdmissionDrivers): Promise<Response> => {
  const classifyModelUnavailable = drivers.classifyModelUnavailable ?? learnCodexModelUnavailable;
  const state: CodexModelUnavailableLoopState = { reselections: 0, siblingAttempted: false };
  for (;;) {
    const dispatched = (await drivers.runPendingShortRetry()) ?? (await drivers.dispatchActive());
    const outcome =
      dispatched === null
        ? await continueCodexAdmissionWithoutDispatch(drivers, state)
        : await handleCodexDispatchedResponse(drivers, classifyModelUnavailable, dispatched, state);
    if (outcome.kind === "return") return outcome.response;
    if (outcome.kind === "exhausted") break;
  }
  return await drivers.exhaustedResponse();
};

export type { CodexAttemptPhase, CodexBankedResetCandidate, CodexProviderDispatchCoordinator, FetchCodexResponsesOptions, PreparedCodexSubscriptionRequest };
export {
  CodexActiveAccountFenceError,
  CodexBankedResetRetryFenceError,
  applyNativeSessionHeaders,
  awaitPendingCodexProbeTransitions,
  cancelResponseBody,
  codexErrorClass,
  codexModelUnavailableResponse,
  codexModelsBaseUrls,
  codexStatusClass,
  createCodexProviderDispatchCoordinator,
  dispatchFailureAsError,
  fetchCodexModelsWithAuth,
  fetchCodexResponseWithAuth,
  initialCodexSelectionResponse,
  isCodexSiblingTransportFailure,
  logCodexRouting,
  prepareCodexSubscriptionRequest,
  randomizedAuthEntries,
  recordCodexResponseHealth,
  recordCodexThrownHealth,
  reportCodexResponseTiming,
  requestedCodexModel,
  routingErrorResponse,
  runCodexSerialAdmissionLoop,
  upstreamTimeoutCircuitResponse,
  waitForCodexRetry,
};

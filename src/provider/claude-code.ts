/**
 * Claude subscription tier. This is the owner-gated adapter described in
 * docs/handoff/claude-code-subscription-tier-2026-10-11.md, extended with the
 * Console API-key direction: a `CLAUDE_API_KEY` (or admin-stored equivalent)
 * travels as `x-api-key`, the legacy `CLAUDE_CODE_OAUTH_TOKEN` keeps the
 * documented Bearer plus OAuth beta wire, and an organization-scoped key that
 * demands `anthropic-workspace-id` discovers a workspace once instead of
 * failing every request. The provider's rate-limit headers stay the only
 * authoritative quota evidence and no client fingerprint is ever synthesized.
 */
import { STREAM_FIRST_EVENT_DEADLINE_MS } from "../inference-deadline.ts";
import { type ApiKeyProviderDispatch, ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import type { SentinelUpstreamRecorder } from "../sentinel/upstream-capture.ts";
import type { PromptCacheMode } from "../openai-telemetry.ts";
import { buildSurplusClaudeRequest, isSurplusClaudeModel } from "./surplus-claude-request.ts";
import { normalizeAnthropicResponsesResponse } from "./anthropic-responses.ts";
import {
  type ClaudeCodeCredentialKind,
  type ClaudeCodeResolvedCredential,
  type ClaudeCodeResolvedWorkspace,
  CLAUDE_CODE_OAUTH_TOKEN_ENV,
  CLAUDE_CODE_WORKSPACE_ID_ENV,
  classifyClaudeCodeCredentialKind,
  resolveClaudeCodeCredential,
  resolveClaudeCodeWorkspace,
  storeClaudeCodeWorkspaceState,
  mergeClaudeCodeWorkspaceState,
  loadClaudeCodeWorkspaceState,
} from "./claude-code-credentials.ts";
import { isRecord } from "../utils.ts";
import {
  claudeCodeExhaustionFromResponse,
  claudeCodeQuotaBlocked,
  claudeCodeQuotaCoolingDown,
  type ClaudeCodeQuotaObservation,
  type ClaudeCodeQuotaState,
  type ClaudeCodeWindowId,
  observeClaudeCodeQuota,
  sanitizeClaudeCodeErrorMessage,
} from "./claude-code-quota.ts";

export const CLAUDE_CODE_BASE_URL = "https://api.anthropic.com";
export const CLAUDE_CODE_MESSAGES_URL = `${CLAUDE_CODE_BASE_URL}/v1/messages`;
export const CLAUDE_CODE_MODELS_URL = `${CLAUDE_CODE_BASE_URL}/v1/models`;
export const CLAUDE_CODE_WORKSPACES_URL = `${CLAUDE_CODE_BASE_URL}/v1/organizations/workspaces`;
export { CLAUDE_CODE_OAUTH_TOKEN_ENV, CLAUDE_CODE_WORKSPACE_ID_ENV };
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
/** Bounded error text retained from upstream for classification and display. */
const CLAUDE_CODE_ERROR_BODY_MAX_BYTES = 4_096;

export type ClaudeCodeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

/** Environment lookup seam so tests never touch process state. */
export type ClaudeCodeEnvLookup = (name: string) => string | null | undefined;

const defaultEnvLookup: ClaudeCodeEnvLookup = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return null;
  }
};

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
  | Readonly<{ eligible: true; credential: ClaudeCodeResolvedCredential; workspace: ClaudeCodeResolvedWorkspace | null }>
  | Readonly<{
      eligible: false;
      reason: "model_unsupported" | "provider_disabled" | "principal_not_allowed" | "credential_missing" | "quota_blocked" | "cooling_down";
    }>;

export type ClaudeCodeEligibilityInput = Readonly<{
  /** Gateway-visible model id for this request. */
  model: unknown;
  /** Authenticated principal for this request; never a shared or anonymous scope. */
  keyId: string | null;
  providerEnabled: boolean;
  allowedKeyIds: ReadonlySet<string>;
  credential: ClaudeCodeResolvedCredential | null;
  workspace?: ClaudeCodeResolvedWorkspace | null;
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
  if (!input.credential) return { eligible: false, reason: "credential_missing" };
  if (claudeCodeQuotaBlocked(input.quota, nowMs)) return { eligible: false, reason: "quota_blocked" };
  if (claudeCodeQuotaCoolingDown(input.quota, nowMs)) return { eligible: false, reason: "cooling_down" };
  return { eligible: true, credential: input.credential, workspace: input.workspace ?? null };
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

export type ClaudeCodeResponseKind =
  | "ok"
  | "durable_exhaustion"
  | "transient_rate_limited"
  | "auth_invalid"
  | "forbidden"
  | "billing_blocked"
  | "workspace_required"
  | "workspace_not_found"
  | "upstream_error"
  | "request_rejected";

export type ClaudeCodeResponseClassification = Readonly<{
  kind: ClaudeCodeResponseKind;
  exhaustion: Readonly<{ window: ClaudeCodeWindowId; reset_at_ms: number | null }> | null;
  retry_after_ms: number | null;
  /** Sanitized upstream message for operator display; never a header echo. */
  detail: string | null;
}>;

/**
 * True for the rejections that mean the credential or its workspace selection
 * is wrong for this account, not that the provider is degraded. They are
 * retried only after the bounded configuration cooldown.
 */
export const isClaudeCodeConfigurationKind = (kind: ClaudeCodeResponseKind): boolean =>
  kind === "billing_blocked" || kind === "workspace_not_found" || kind === "workspace_required" || kind === "forbidden";

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
 * `classifyClaudeCodeErrorBody` then narrows 4xx configuration rejections.
 */
export const classifyClaudeCodeResponse = (status: number, headers: Headers, nowMs: number = Date.now()): ClaudeCodeResponseClassification => {
  if (status >= 200 && status < 300) return { kind: "ok", exhaustion: null, retry_after_ms: null, detail: null };
  if (status === 429) {
    const observation = observeClaudeCodeQuota(headers, nowMs);
    const exhaustion = claudeCodeExhaustionFromResponse(status, observation);
    if (exhaustion) return { kind: "durable_exhaustion", exhaustion, retry_after_ms: null, detail: null };
    return { kind: "transient_rate_limited", exhaustion: null, retry_after_ms: parseRetryAfterMs(headers.get("retry-after")), detail: null };
  }
  if (status === 401) return { kind: "auth_invalid", exhaustion: null, retry_after_ms: null, detail: null };
  if (status === 403) return { kind: "forbidden", exhaustion: null, retry_after_ms: null, detail: null };
  if (status >= 500) return { kind: "upstream_error", exhaustion: null, retry_after_ms: null, detail: null };
  return { kind: "request_rejected", exhaustion: null, retry_after_ms: null, detail: null };
};

/** Prefer the nested `error.message`; fall back to the sanitized raw text. */
const extractClaudeCodeErrorMessage = (bodyText: string | null): string | null => {
  if (!bodyText) return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = nonEmptyString(parsed.error.message);
      if (message) return sanitizeClaudeCodeErrorMessage(message);
    }
  } catch {
    // Fall through: the sanitized raw body is still useful for diagnosis.
  }
  return sanitizeClaudeCodeErrorMessage(bodyText);
};

/**
 * Narrow a non-2xx classification using the upstream error message. The
 * workspace and billing rejections are configuration states the operator must
 * see in the admin console, not generic request failures or provider outages.
 */
export const classifyClaudeCodeErrorBody = (classification: ClaudeCodeResponseClassification, bodyText: string | null): ClaudeCodeResponseClassification => {
  if (classification.kind === "ok" || classification.kind === "durable_exhaustion" || classification.kind === "upstream_error") {
    return classification;
  }
  const detail = extractClaudeCodeErrorMessage(bodyText);
  if (!detail) return classification;
  const lower = detail.toLowerCase();
  const withDetail = { ...classification, detail };
  if (classification.kind === "request_rejected" && lower.includes("not scoped to a workspace")) {
    return { ...withDetail, kind: "workspace_required" };
  }
  if (lower.includes("not found") && lower.includes("workspace")) return { ...withDetail, kind: "workspace_not_found" };
  if (lower.includes("workspace") && lower.includes("valid workspace")) return { ...withDetail, kind: "workspace_not_found" };
  if (lower.includes("credit balance") || lower.includes("purchase credits")) return { ...withDetail, kind: "billing_blocked" };
  if (lower.includes("workspace") && lower.includes("organization")) return { ...withDetail, kind: "workspace_not_found" };
  return withDetail;
};

export type ClaudeCodeAuthenticatedFetchOptions = Readonly<{
  /** Resolved credential; resolved from KV and the environment when absent. */
  credential?: ClaudeCodeResolvedCredential | null;
  /** Resolved workspace; resolved from KV and the environment when absent. */
  workspace?: ClaudeCodeResolvedWorkspace | null;
  /** KV handle used for credential, workspace, and quota state. */
  kv?: Deno.Kv | null;
  env?: ClaudeCodeEnvLookup;
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
  credential: ClaudeCodeResolvedCredential;
  /** Workspace used for this attempt, including one discovered during it. */
  workspace: ClaudeCodeResolvedWorkspace | null;
  prompt_cache_mode?: PromptCacheMode;
  explicit_breakpoint_count?: number;
  quota: ClaudeCodeQuotaObservation | null;
  classification: ClaudeCodeResponseClassification;
}>;

export type ClaudeCodeAuthHeaders = Readonly<{ kind: ClaudeCodeCredentialKind; secret: string }>;

/**
 * The documented credential wire per credential kind. Console API keys travel
 * as `x-api-key`; OAuth and setup tokens travel as `Authorization: Bearer`
 * with the OAuth beta that must survive gateway forwarding. An
 * organization-scoped key additionally needs the workspace selection, and no
 * client fingerprint beyond these documented headers is ever synthesized.
 */
export const claudeCodeRequestHeaders = (credential: ClaudeCodeAuthHeaders, options: Readonly<{ stream: boolean; workspaceId?: string | null }>): Headers => {
  const headers = new Headers();
  if (credential.kind === "oauth") {
    headers.set("Authorization", `Bearer ${credential.secret}`);
    headers.set("anthropic-beta", CLAUDE_CODE_OAUTH_BETA);
  } else {
    headers.set("x-api-key", credential.secret);
  }
  headers.set("Content-Type", "application/json");
  headers.set("Accept", options.stream ? "text/event-stream" : "application/json");
  headers.set("anthropic-version", CLAUDE_CODE_ANTHROPIC_VERSION);
  const workspaceId = nonEmptyString(options.workspaceId);
  if (workspaceId) headers.set("anthropic-workspace-id", workspaceId);
  return headers;
};

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

/** Bounded body read for error classification; never throws. */
const readErrorBodyText = async (response: Response): Promise<string | null> => {
  try {
    const text = await response.clone().text();
    return text.length > CLAUDE_CODE_ERROR_BODY_MAX_BYTES ? text.slice(0, CLAUDE_CODE_ERROR_BODY_MAX_BYTES) : text;
  } catch {
    return null;
  }
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

const requireClaudeCodeCredential = async (
  supplied: ClaudeCodeResolvedCredential | null | undefined,
  kv: Deno.Kv | null,
  env: ClaudeCodeEnvLookup | undefined
): Promise<ClaudeCodeResolvedCredential> => {
  if (supplied) return supplied;
  const resolved = await resolveClaudeCodeCredential(kv, env);
  if (resolved) return resolved;
  throw new ClaudeCodeError(
    `Claude subscription inference is unavailable because neither CLAUDE_API_KEY, ${CLAUDE_CODE_OAUTH_TOKEN_ENV}, nor a stored credential is configured.`,
    "claude_code_credential_missing",
    503
  );
};

type ClaudeCodeWorkspaceListEntry = Readonly<{ id: string; name: string | null }>;

const parseWorkspaceList = (value: unknown): ClaudeCodeWorkspaceListEntry[] => {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  const entries: ClaudeCodeWorkspaceListEntry[] = [];
  for (const item of value.data) {
    if (!isRecord(item)) continue;
    const id = nonEmptyString(item.id);
    if (!id || !id.startsWith("wrkspc_")) continue;
    if (item.archived_at !== null && item.archived_at !== undefined) continue;
    entries.push({ id, name: nonEmptyString(item.name) });
  }
  return entries;
};

/**
 * The Console default workspace is the inference target for an
 * organization-scoped key, so a workspace literally named `Default` wins over
 * the listing order; otherwise the first non-archived workspace is used.
 */
const pickWorkspace = (entries: readonly ClaudeCodeWorkspaceListEntry[]): ClaudeCodeWorkspaceListEntry | null => {
  const preferred = entries.find((entry) => entry.name?.trim().toLowerCase() === "default");
  return preferred ?? entries[0] ?? null;
};

export type ClaudeCodeWorkspaceDiscoveryResult =
  Readonly<{ ok: true; workspace: ClaudeCodeResolvedWorkspace }> | Readonly<{ ok: false; status: number | null; error: string | null }>;

/**
 * Discover the workspace an organization-scoped credential must name. The
 * result is cached in KV as advisory state so later requests skip the lookup;
 * an operator pin always wins because resolution prefers KV and environment
 * configuration over the discovered entry.
 */
export const discoverClaudeCodeWorkspace = async (
  options: Readonly<{ credential: ClaudeCodeAuthHeaders; kv?: Deno.Kv | null; fetcher?: ClaudeCodeFetch; signal?: AbortSignal }>
): Promise<ClaudeCodeWorkspaceDiscoveryResult> => {
  const kv = options.kv ?? null;
  const headers = claudeCodeRequestHeaders(options.credential, { stream: false });
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(CLAUDE_CODE_WORKSPACES_URL, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: options.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: null, error: sanitizeClaudeCodeErrorMessage(message) };
  }
  const bodyText = await response.text().catch(() => null);
  if (!response.ok) {
    return { ok: false, status: response.status, error: sanitizeClaudeCodeErrorMessage(bodyText) };
  }
  let parsed: unknown = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }
  const picked = pickWorkspace(parseWorkspaceList(parsed));
  if (!picked) return { ok: false, status: response.status, error: "No usable workspace was listed for this credential." };
  const workspace: ClaudeCodeResolvedWorkspace = { id: picked.id, name: picked.name, source: "discovered" };
  if (kv) {
    const previous = await loadClaudeCodeWorkspaceState(kv).catch(() => null);
    await storeClaudeCodeWorkspaceState(kv, mergeClaudeCodeWorkspaceState(previous, { id: workspace.id, name: workspace.name, source: "discovered" })).catch(
      () => false
    );
  }
  return { ok: true, workspace };
};

const performClaudeCodeMessagesAttempt = async (
  options: Readonly<{
    credential: ClaudeCodeResolvedCredential;
    workspace: ClaudeCodeResolvedWorkspace | null;
    encodedBody: string;
    stream: boolean;
    signal?: AbortSignal;
    fetcher?: ClaudeCodeFetch;
    beforeDispatch?: () => Promise<ApiKeyProviderDispatch | undefined>;
    onDispatch?: () => void;
    sentinelUpstreamRecorder?: SentinelUpstreamRecorder;
  }>
): Promise<
  Readonly<{ response: Response; classification: ClaudeCodeResponseClassification; quota: ClaudeCodeQuotaObservation | null; requestId: string | null }>
> => {
  const headers = claudeCodeRequestHeaders(options.credential, { stream: options.stream, workspaceId: options.workspace?.id ?? null });
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
      (options.fetcher ?? fetch)(CLAUDE_CODE_MESSAGES_URL, {
        method: "POST",
        headers,
        body: options.encodedBody,
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
  const base = classifyClaudeCodeResponse(response.status, response.headers);
  const classification = base.kind === "ok" ? base : classifyClaudeCodeErrorBody(base, await readErrorBodyText(response));
  const quota = observeClaudeCodeQuota(response.headers);
  const recorded = upstreamAttempt ? upstreamAttempt.wrap(response) : response;
  return { response: recorded, classification, quota, requestId };
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

  const kv = options.kv ?? null;
  const credential = await requireClaudeCodeCredential(options.credential, kv, options.env);
  const initialWorkspace = options.workspace === undefined ? await resolveClaudeCodeWorkspace(kv, options.env) : options.workspace;

  const attemptOptions = {
    credential,
    encodedBody,
    stream: native.body.stream === true,
    signal: options.signal,
    fetcher: options.fetcher,
    beforeDispatch: options.beforeDispatch,
    onDispatch: options.onDispatch,
    sentinelUpstreamRecorder: options.sentinelUpstreamRecorder,
  } as const;

  let workspace = initialWorkspace;
  let attempt = await performClaudeCodeMessagesAttempt({ ...attemptOptions, workspace });
  // An organization-scoped key rejects the first request with a workspace
  // requirement; one discovery call (cached in KV) resolves it for the whole
  // deployment without a per-request lookup afterwards.
  if (attempt.classification.kind === "workspace_required" && !workspace) {
    const discovered = await discoverClaudeCodeWorkspace({ credential, kv, fetcher: options.fetcher, signal: options.signal }).catch(() => null);
    if (discovered?.ok) {
      workspace = discovered.workspace;
      // The retry is the same client dispatch: the single-use pre-transport
      // reservation and the first-provider attribution already happened for
      // this request and must not be claimed twice.
      attempt = await performClaudeCodeMessagesAttempt({ ...attemptOptions, workspace, beforeDispatch: undefined, onDispatch: undefined });
    }
  }

  const delivered = await normalizeAnthropicResponsesResponse(attempt.response, {
    model: String(body.model),
    requestId: attempt.requestId ?? undefined,
    signal: options.signal,
    reasoningSummary: responseReasoningSummary(body),
    reasoningReplayScope: options.reasoningReplayScope,
    provider: "claude_code",
  });
  return {
    response: delivered,
    request_id: attempt.requestId,
    credential,
    workspace,
    prompt_cache_mode: native.promptCacheMode,
    explicit_breakpoint_count: native.explicitBreakpointCount,
    quota: attempt.quota,
    classification: attempt.classification,
  };
};

/** Kind of a credential the admin surface is about to store, for validation. */
export const claudeCodeCredentialKind = (secret: string): ClaudeCodeCredentialKind => classifyClaudeCodeCredentialKind(secret);

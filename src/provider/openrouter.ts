// OpenRouter upstream provider.
//
// OpenRouter serves two surfaces for this gateway: its cached public catalogue
// on both OpenAI-compatible wires, and the typed System One decision transport
// (`typesafe/jev-*`) behind `/v1/systemone`. The SystemOne contract is not
// OpenAI-shaped chat, so it keeps its own fetch — `fetchOpenRouterSystemOne` —
// which the terminal route serves with the gateway's own quota, admission, and
// telemetry treatment. Nothing here hardcodes a Jev model id: callers pass the
// SystemOne model they want, and the route constrains it to the typesafe
// namespace so a shared credential cannot reach unrelated models.

import { fetchOpenRouterModels, openRouterModelsSnapshot } from "../models/openrouter-models.ts";
import type { ApiKeyProviderDispatch } from "../api-key-policy.ts";
import type { SentinelUpstreamRecorder } from "../sentinel/upstream-capture.ts";
import { isRecord } from "../utils.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const OPENROUTER_SYSTEMONE_URL = `${OPENROUTER_BASE_URL}/systemone`;
export const OPENROUTER_CHAT_COMPLETIONS_URL = `${OPENROUTER_BASE_URL}/chat/completions`;
export const OPENROUTER_RESPONSES_URL = `${OPENROUTER_BASE_URL}/responses`;
export const OPENROUTER_FETCH_TIMEOUT_MS = 20_000;

export type OpenRouterErrorCode =
  "openrouter_api_key_missing" | "openrouter_upstream_unreachable" | "openrouter_upstream_error" | "openrouter_upstream_invalid_response";

/** A bounded upstream failure; `status` is the client-facing HTTP status. */
export class OpenRouterError extends Error {
  constructor(
    readonly code: OpenRouterErrorCode,
    /** Client-facing status, normalized (e.g. an upstream 401 answers 502). */
    readonly status: number,
    /** The raw upstream status when a response arrived; null otherwise. */
    readonly upstreamStatus: number | null = null,
    /** True when a local dispatch hook prevented transport from starting. */
    readonly beforeTransport = false
  ) {
    super(code);
    this.name = "OpenRouterError";
  }
}

export type OpenRouterFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The OpenRouter model ids this gateway serves, read from the cached public
 * catalogue. A new upstream model therefore becomes servable as soon as the
 * cached list refreshes — the dispatch, catalogue, and capabilities routes all
 * read this one function, so they can never disagree about what is offered.
 */
export const openRouterServableModelIds = (): readonly string[] => (openRouterModelsSnapshot()?.models ?? []).map((model) => model.id);

/** The upstream id for a requested model, or null when OpenRouter does not serve it. */
export const openRouterUpstreamModelFor = (model: string): string | null => {
  const trimmed = model.trim();
  if (!trimmed) return null;
  return openRouterServableModelIds().includes(trimmed) ? trimmed : null;
};

/**
 * The same resolution for a request that arrives before the catalogue cache
 * has warmed - for example the first request after a restart. A cold snapshot
 * refreshes once (coalesced, bounded by the catalogue transport's own
 * timeout) and the id is re-resolved; a snapshot that is already warm is
 * authoritative, and a failed refresh still answers not-served rather than
 * dispatching an unvetted id.
 */
export const resolveOpenRouterUpstreamModel = async (model: string): Promise<string | null> => {
  const resolved = openRouterUpstreamModelFor(model);
  const trimmed = model.trim();
  const separator = trimmed.indexOf("/");
  if (resolved !== null || openRouterModelsSnapshot() !== null || separator <= 0 || separator === trimmed.length - 1) return resolved;
  if (readOpenRouterApiKey() === null) return null;
  await fetchOpenRouterModels().catch(() => null);
  return openRouterUpstreamModelFor(model);
};

export type OpenRouterDispatchHooks = Readonly<{
  beforeDispatch?: () => Promise<ApiKeyProviderDispatch | undefined>;
  onDispatch?: () => void;
  onHeaders?: () => void;
  /** The request-owned Sentinel recorder, exactly as the other providers take it. */
  sentinelUpstreamRecorder?: SentinelUpstreamRecorder;
}>;

const dispatchOpenRouter = async (
  url: string,
  body: Readonly<Record<string, unknown>>,
  init: Readonly<{ signal: AbortSignal; hooks?: OpenRouterDispatchHooks }>
): Promise<Response> => {
  const apiKey = readOpenRouterApiKey();
  if (!apiKey) throw new OpenRouterError("openrouter_api_key_missing", 503);
  const dispatch = init.hooks?.beforeDispatch ? await init.hooks.beforeDispatch() : undefined;
  if (init.signal.aborted) {
    await dispatch?.cancelBeforeTransport();
    throw new DOMException("Aborted", "AbortError");
  }
  dispatch?.markTransportStarted();
  init.hooks?.onDispatch?.();
  const upstreamAttempt = init.hooks?.sentinelUpstreamRecorder?.startAttempt("openrouter") ?? null;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: init.signal,
    });
  } catch (error) {
    upstreamAttempt?.recordFetchError();
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new OpenRouterError("openrouter_upstream_unreachable", 502);
  }
  init.hooks?.onHeaders?.();
  return upstreamAttempt ? upstreamAttempt.wrap(response) : response;
};

export const fetchOpenRouterChatCompletions = async (
  body: Readonly<Record<string, unknown>>,
  init: Readonly<{ signal: AbortSignal; hooks?: OpenRouterDispatchHooks }>
): Promise<Response> => await dispatchOpenRouter(OPENROUTER_CHAT_COMPLETIONS_URL, body, init);

export const fetchOpenRouterResponses = async (
  body: Readonly<Record<string, unknown>>,
  init: Readonly<{ signal: AbortSignal; hooks?: OpenRouterDispatchHooks }>
): Promise<Response> => await dispatchOpenRouter(OPENROUTER_RESPONSES_URL, body, init);

export const readOpenRouterApiKey = (): string | null => {
  try {
    const value = process.env[OPENROUTER_API_KEY_ENV]?.trim();
    if (!value) return null;
    return value;
  } catch {
    return null;
  }
};

/**
 * One System One decision call. The body is forwarded verbatim (`model`,
 * `state`, `questions`); the answer shape belongs to the caller, which also
 * owns bounds on the questions it sends.
 *
 * Dispatch hooks follow the shared OpenRouter dispatcher: the API-key
 * reservation commits before transport and the hook call sits outside the
 * transport catch, so a quota refusal stays itself instead of being reported
 * as an unreachable upstream.
 */
export const fetchOpenRouterSystemOne = async (input: {
  body: Readonly<Record<string, unknown>>;
  apiKey?: string | null;
  fetcher?: OpenRouterFetch;
  timeoutMs?: number;
  hooks?: OpenRouterDispatchHooks;
}): Promise<Record<string, unknown>> => {
  const apiKey = input.apiKey === undefined ? readOpenRouterApiKey() : input.apiKey;
  if (!apiKey) throw new OpenRouterError("openrouter_api_key_missing", 503);
  const signal = AbortSignal.timeout(input.timeoutMs ?? OPENROUTER_FETCH_TIMEOUT_MS);
  const dispatch = input.hooks?.beforeDispatch ? await input.hooks.beforeDispatch() : undefined;
  if (signal.aborted) {
    await dispatch?.cancelBeforeTransport();
    throw new OpenRouterError("openrouter_upstream_unreachable", 502, null, true);
  }
  dispatch?.markTransportStarted();
  input.hooks?.onDispatch?.();
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(OPENROUTER_SYSTEMONE_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal,
    });
  } catch {
    throw new OpenRouterError("openrouter_upstream_unreachable", 502);
  }
  input.hooks?.onHeaders?.();
  if (!response.ok) {
    const status = response.status === 429 || response.status === 400 ? response.status : 502;
    throw new OpenRouterError("openrouter_upstream_error", status, response.status);
  }
  const payload = await response.json().catch(() => null);
  if (!isRecord(payload)) throw new OpenRouterError("openrouter_upstream_invalid_response", 502);
  return payload;
};

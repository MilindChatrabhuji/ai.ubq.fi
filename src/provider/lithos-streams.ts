// LithosAI stream plumbing, extracted from src/provider/lithos-handlers.ts.

import { LITHOS_RESPONSES_PROFILE, type OriginalToolName } from "../deepseek/responses.ts";
import { type DeepSeekResponsesEcho } from "../deepseek/responses-payload.ts";
import { iterateLithosChatCompletionStream, LithosError } from "./lithos.ts";
import { ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { type ResponseStreamTerminalType, type UsageContext } from "../openai-telemetry.ts";
import { withSseKeepalive } from "../responses-stream.ts";
import { lithosResponseHeaders } from "../upstream-wire.ts";
import { type ProviderStreamAdapter, type ProviderStreamFrame, relayChatCompletionStream, relayResponsesStream } from "./stream-relay.ts";
import { recordLithosProviderHealth } from "./health.ts";

export type LithosFailureKind =
  | "upstream_error"
  | "upstream_http_error"
  | "upstream_unreachable"
  | "incomplete_response"
  | "invalid_json"
  | "invalid_completion_schema"
  | "lithos_upstream_invalid_response"
  | "deadline"
  | "cancellation"
  | "api_key_quota_reservation_unavailable"
  | "lithos_api_key_missing"
  | "lithos_request_invalid"
  /** A stop reason the gateway cannot place in its terminal vocabulary. */
  | `lithos_finish_reason:${string}`;

export const recordLithosFailureKind = (context: UsageContext | undefined, failureKind: LithosFailureKind): void => {
  if (context?.responseTelemetry) context.responseTelemetry.failureKind = failureKind;
};

/**
 * The telemetry classification for an upstream stop reason the gateway cannot
 * place. The value is bounded and carried so an operator can see exactly what
 * the provider said instead of reading a normal completion.
 */
const lithosFinishReasonFailureKind = (finishReason: string | null): LithosFailureKind =>
  `lithos_finish_reason:${finishReason !== null && /^[A-Za-z0-9_.:-]{1,64}$/.test(finishReason) ? finishReason : "unrecognized"}`;

export const lithosTerminalTypeForError = (error: unknown, downstreamSignal: AbortSignal): ResponseStreamTerminalType => {
  if (downstreamSignal.aborted) return "cancelled";
  if (error instanceof LithosError && error.code === "gateway_timeout") return "deadline";
  if (error instanceof Error && error.name === "TimeoutError") return "deadline";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "error";
};

export const lithosTransportFailureKind = (error: unknown, terminalType: ResponseStreamTerminalType): LithosFailureKind => {
  if (terminalType === "cancelled") return "cancellation";
  if (terminalType === "deadline") return "deadline";
  if (error instanceof ApiKeyQuotaDispatchError) return "api_key_quota_reservation_unavailable";
  if (error instanceof LithosError) {
    switch (error.code) {
      case "lithos_api_key_missing":
        return "lithos_api_key_missing";
      case "lithos_request_invalid":
        return "lithos_request_invalid";
      case "lithos_upstream_unreachable":
        return "upstream_unreachable";
      case "lithos_upstream_invalid_response":
        return "lithos_upstream_invalid_response";
      default:
        break;
    }
  }
  return "upstream_error";
};

/**
 * Maps the LithosAI transport's validated chunks onto the shared frame union.
 * This vendor's wire carries no SSE comment frames and its iterator ends at
 * `[DONE]`, which the shared loops read as an exhausted iterator; this provider
 * therefore claims no keep-alive relay it does not have.
 */
async function* lithosChatStreamFrames(
  upstream: Response,
  upstreamModel: string,
  options: Readonly<{ signal: AbortSignal; servedModel?: string }>
): AsyncGenerator<ProviderStreamFrame, void, unknown> {
  for await (const chunk of iterateLithosChatCompletionStream(upstream, upstreamModel, options)) {
    yield { kind: "chunk", value: chunk };
  }
}

export const recordLithosResponseHealth = (status: number, providerRequestId: string | null): void => {
  if (status === 401 || status === 403) {
    void recordLithosProviderHealth("auth_invalid", status, Date.now, providerRequestId);
    return;
  }
  if (status === 402) {
    void recordLithosProviderHealth("quota_exhausted", status, Date.now, providerRequestId);
    return;
  }
  if (status === 429) {
    void recordLithosProviderHealth("quota_exhausted", status, Date.now, providerRequestId);
    return;
  }
  if (status >= 500) {
    void recordLithosProviderHealth("upstream_error", status, Date.now, providerRequestId);
    return;
  }
  if (status >= 400) {
    void recordLithosProviderHealth("reachable", status, Date.now, providerRequestId);
    return;
  }
  void recordLithosProviderHealth("success", status, Date.now, providerRequestId);
};

const isClassifiedLithosRefusal = (status: number | null): boolean => status === 401 || status === 402 || status === 403 || status === 429;

/**
 * Holds a client's SSE connection across provider quiet periods with the
 * gateway's standard `: keepalive` comment frames - the same mechanism the
 * ordinary routes use. Provider bytes are still forwarded as they arrive, and
 * the frames are inert for OpenAI clients.
 */
const withLithosSseKeepalive = (response: Response): Response => {
  const body = response.body;
  if (!body) return response;
  return new Response(withSseKeepalive(body), { status: response.status, headers: response.headers });
};

/** The LithosAI seams for the shared stream writers. */
const lithosStreamAdapter: ProviderStreamAdapter = {
  responseHeaders: lithosResponseHeaders,
  frames: lithosChatStreamFrames,
  recordResponseHealth: recordLithosResponseHealth,
  recordProviderError: (status, providerRequestId) => {
    if (isClassifiedLithosRefusal(status)) return;
    void recordLithosProviderHealth("upstream_error", status, Date.now, providerRequestId);
  },
  recordCancellation: (usageContext) => {
    recordLithosFailureKind(usageContext, "cancellation");
  },
  recordIncompleteResponse: (usageContext) => {
    recordLithosFailureKind(usageContext, "incomplete_response");
  },
  recordFinishFailureKind: (usageContext, finishReason) => {
    recordLithosFailureKind(usageContext, lithosFinishReasonFailureKind(finishReason));
  },
  recordTransportFailure: (usageContext, error, terminalType) => {
    recordLithosFailureKind(usageContext, lithosTransportFailureKind(error, terminalType));
  },
  terminalTypeForError: lithosTerminalTypeForError,
  streamErrorCode: "lithos_upstream_stream_error",
  responsesProfile: LITHOS_RESPONSES_PROFILE,
};

/**
 * The same seams with this request's serving tier pinned, so a response the
 * configured sibling produced is validated against the model that actually
 * answered it instead of the one the client asked for. A deferred (streamed
 * absorb) dispatch does not know the serving tier until its attempt lands, so a
 * live getter is accepted as well as a fixed id; the frames read it after the
 * attempt resolves.
 */
const lithosStreamAdapterServing = (servedModel: string | (() => string)): ProviderStreamAdapter => {
  const servedModelAtFrames = typeof servedModel === "function" ? servedModel : () => servedModel;
  return {
    ...lithosStreamAdapter,
    frames: (upstream, upstreamModel, options) => lithosChatStreamFrames(upstream, upstreamModel, { ...options, servedModel: servedModelAtFrames() }),
  };
};

/**
 * Relays the served attempt as it arrives, wrapped with the gateway's standard
 * `: keepalive` comment frames so a quiet provider never looks like a dead
 * connection to a client or an edge proxy. The provider reports usage
 * unconditionally - including on the trailing frame whose `choices` is empty -
 * so nothing here gates accounting on `stream_options.include_usage`. A refusal
 * only reaches this relay after the load-balanced sibling attempt, so it is
 * reported with the provider's own status and code rather than held open.
 */
export const streamLithosChatCompletion = (
  upstream: Response | Promise<Response>,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  downstreamSignal: AbortSignal,
  requestSignal: AbortSignal,
  upstreamModel: string,
  servedModel: string | (() => string),
  cancelPending?: (reason?: unknown) => void
): Response =>
  withLithosSseKeepalive(
    relayChatCompletionStream(
      lithosStreamAdapterServing(servedModel),
      upstream,
      providerRequestId,
      usageContext,
      downstreamSignal,
      requestSignal,
      upstreamModel,
      cancelPending
    )
  );

/**
 * Relays the LithosAI translated Responses event sequence through the shared
 * writer under this provider's own profile; the shared shape skips comment
 * frames and lets the translator decide the terminal. The `: keepalive`
 * comment frames this stream gains are the same inert connection-preserving
 * frames every other gateway stream carries.
 */
export const streamLithosResponses = (
  upstream: Response | Promise<Response>,
  requestedModel: string,
  responseId: string,
  createdAtSeconds: number,
  echo: DeepSeekResponsesEcho,
  toolNames: ReadonlyMap<string, OriginalToolName>,
  customToolNames: ReadonlySet<string>,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  downstreamSignal: AbortSignal,
  requestSignal: AbortSignal,
  upstreamModel: string,
  servedModel: string | (() => string),
  cancelPending?: (reason?: unknown) => void
): Response =>
  withLithosSseKeepalive(
    relayResponsesStream(lithosStreamAdapterServing(servedModel), {
      upstream,
      requestedModel,
      responseId,
      createdAtSeconds,
      echo,
      toolNames,
      customToolNames,
      providerRequestId,
      usageContext,
      downstreamSignal,
      requestSignal,
      upstreamModel,
      cancelPending,
    })
  );

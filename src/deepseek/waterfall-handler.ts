// Request handler for the `ubiquity/deepseek-v4.1-flash` synthetic model:
// dispatch each hop of the cost-first provider order and advance only on
// infrastructure or serving failures. The two paid hops (Surplus, OpenLux)
// re-enter the ordinary Responses pipeline (admission, reservation and ledger
// settlement included) each pinned to its own paid tier, so a paid hop can
// never silently advance to the other paid provider; streaming hops are gated
// on their first semantic output so a stream that dies before any output still
// advances the chain. See docs/deepseek-waterfall-model-plan.md.

import { openaiError } from "../http.ts";
import { recordAttemptedProvider, type DeepSeekWaterfallFallbackReason, type UsageContext } from "../openai-telemetry.ts";
import { handleLithosResponses } from "../provider/lithos-handlers.ts";
import { handleOpenRouterResponses } from "../provider/openrouter-handlers.ts";
import { GATEWAY_PROVIDER_ID } from "../provider/presentation.ts";
import { isProviderEnabled, loadProviderSelectionCached, type ProviderSelection } from "../provider/selection.ts";
import { prepareResponsesStreamForCommit, type PreparedResponsesStream } from "../responses-failover-stream.ts";
import { runOrdinaryResponsesTail } from "../responses-handler.ts";
import { readResponsesStream } from "../responses-stream.ts";
import type { ResponsesRequest } from "../types.ts";
import { handleDeepSeekResponses } from "./handlers.ts";
import {
  DEEPSEEK_WATERFALL_MODEL_ID,
  DEEPSEEK_WATERFALL_PAID_MODEL_ID,
  DEEPSEEK_WATERFALL_PAID_PIN,
  DEEPSEEK_WATERFALL_PROVIDER_MODEL,
  DEEPSEEK_WATERFALL_REASONING_LEVELS,
  type DeepSeekWaterfallProvider,
  deepSeekWaterfallFailureReason,
  deepSeekWaterfallPlan,
  deepSeekWaterfallProviderConfigured,
  deepSeekWaterfallRequestedEffort,
  isDeepSeekWaterfallReasoningLevel,
  isDeepSeekWaterfallRetryStatus,
} from "./waterfall.ts";

export type DeepSeekWaterfallDispatch = (
  input: Readonly<{
    provider: DeepSeekWaterfallProvider;
    req: Request;
    rawRecord: Record<string, unknown>;
    rawBody: ResponsesRequest;
    model: string;
    usageContext: UsageContext | undefined;
  }>
) => Promise<Response>;

/** The ordinary Responses pipeline tail, injected so tests can stub a paid hop. */
export type DeepSeekWaterfallPaidTail = (
  req: Request,
  rawRecord: Record<string, unknown>,
  rawBody: ResponsesRequest,
  usageContext?: UsageContext,
  options?: Readonly<{
    allowedPaidProviders?: readonly ("metered" | "surplus")[] | null;
    deepSeekWaterfallPaidHop?: "surplus" | "openlux" | null;
  }>
) => Promise<Response>;

export type DeepSeekWaterfallOptions = Readonly<{
  /** Injected transports; production wires the three provider handlers plus the paid tail. */
  dispatch?: DeepSeekWaterfallDispatch;
  /** Overrides the paid hops' pipeline tail (tests only). */
  paidTail?: DeepSeekWaterfallPaidTail;
  /** Overrides for tests; production reads the operator selection and credentials. */
  selection?: ProviderSelection | null;
  enabled?: (provider: DeepSeekWaterfallProvider) => boolean;
  configured?: (provider: DeepSeekWaterfallProvider) => boolean;
}>;

const withAttemptedProviders = (response: Response, attempted: readonly string[]): Response => {
  const headers = new Headers(response.headers);
  headers.set("x-uos-attempted-providers", attempted.join(","));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const unsupportedEffortResponse = (effort: string): Response =>
  openaiError(
    400,
    `The model '${DEEPSEEK_WATERFALL_MODEL_ID}' supports reasoning efforts ${DEEPSEEK_WATERFALL_REASONING_LEVELS.join(", ")}; '${effort}' is not supported.`,
    "unsupported_reasoning_effort",
    { param: "reasoning.effort" }
  );

const unavailableResponse = (): Response =>
  openaiError(503, "No DeepSeek waterfall provider is enabled and configured.", "deepseek_waterfall_unavailable", { type: "server_error" });

const transportFailureResponse = (provider: DeepSeekWaterfallProvider): Response =>
  openaiError(502, `DeepSeek waterfall provider '${provider}' failed before responding.`, "deepseek_waterfall_transport_failure", { type: "server_error" });

const streamFailureResponse = (provider: DeepSeekWaterfallProvider): Response =>
  openaiError(502, `DeepSeek waterfall provider '${provider}' ended its stream before producing output.`, "deepseek_waterfall_stream_failure", {
    type: "server_error",
  });

const dispatchPaidHop = async (paidTail: DeepSeekWaterfallPaidTail, input: Parameters<DeepSeekWaterfallDispatch>[0]): Promise<Response> => {
  const paidBody: ResponsesRequest = { ...input.rawBody, model: DEEPSEEK_WATERFALL_PAID_MODEL_ID };
  const headers = new Headers(input.req.headers);
  // The rewritten body has its own length; the constructor recomputes it.
  headers.delete("content-length");
  const paidRequest = new Request(input.req.url, { method: "POST", headers, body: JSON.stringify(paidBody), signal: input.req.signal });
  // Pin the hop to its own paid tier: without the pin the paid pipeline would
  // apply its fixed Surplus -> Metered cost order to either hop, letting the
  // Surplus hop silently advance to metered and starving the OpenLux hop.
  const allowedPaidProviders = DEEPSEEK_WATERFALL_PAID_PIN[input.provider] ?? null;
  const deepSeekWaterfallPaidHop = input.provider === "openlux" ? "openlux" : "surplus";
  // Each paid hop settles independently. Preserve the parent correlation and
  // its bound quota hook while giving billing a provider-specific request key.
  const paidUsageContext = input.usageContext?.requestId
    ? { ...input.usageContext, paidFallbackRequestId: `${input.usageContext.requestId}:deepseek_waterfall:${deepSeekWaterfallPaidHop}` }
    : input.usageContext;
  return await paidTail(paidRequest, paidBody, paidBody, paidUsageContext, { allowedPaidProviders, deepSeekWaterfallPaidHop });
};

const defaultDispatchFor = (paidTail: DeepSeekWaterfallPaidTail): DeepSeekWaterfallDispatch => {
  return (input) => {
    if (input.provider === "surplus" || input.provider === "openlux") return dispatchPaidHop(paidTail, input);
    if (input.provider === "openrouter") return handleOpenRouterResponses(input.req, input.rawRecord, input.model, input.usageContext);
    if (input.provider === "lithos") return handleLithosResponses(input.req, input.rawRecord, input.model, input.usageContext);
    return handleDeepSeekResponses(input.req, input.rawRecord, input.model, input.usageContext);
  };
};

/** Replays the buffered pre-commit bytes, then forwards the rest of the handler stream verbatim. */
const replayPreparedResponses = (response: Response, prepared: PreparedResponsesStream): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of prepared.buffered) controller.enqueue(encoder.encode(event.raw));
      void (async () => {
        try {
          for await (const event of prepared.iterator) controller.enqueue(encoder.encode(event.raw));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      })();
    },
    cancel(reason) {
      void prepared.iterator.return(reason);
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
};

/**
 * Holds a streaming hop until its first semantic output or a valid terminal.
 * A stream that dies first — malformed frame, premature EOF, or an upstream
 * `response.failed`/`error` terminal — is a failed hop the chain may replace;
 * once output exists the hop is committed and no later provider is spent.
 */
const gateStreamingHop = async (response: Response, signal: AbortSignal): Promise<Readonly<{ committed: boolean; response: Response }>> => {
  if (!response.ok || !response.body) return { committed: true, response };
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return { committed: true, response };
  const iterator = readResponsesStream(response.body, signal);
  let prepared: PreparedResponsesStream;
  try {
    prepared = await prepareResponsesStreamForCommit(iterator);
  } catch (error) {
    if (signal.aborted) throw error;
    return { committed: false, response };
  }
  if (prepared.semantic === null && prepared.terminal !== null && (prepared.terminal.type === "response.failed" || prepared.terminal.type === "error")) {
    await iterator.return(undefined).catch(() => {});
    return { committed: false, response };
  }
  return { committed: true, response: replayPreparedResponses(response, prepared) };
};

type HopFailure = number | "transport" | "stream";
type HopResult = Readonly<{ delivered: boolean; response: Response; failure: HopFailure }>;

const attemptHop = async (
  dispatch: DeepSeekWaterfallDispatch,
  provider: DeepSeekWaterfallProvider,
  req: Request,
  rawRecord: Record<string, unknown>,
  rawBody: ResponsesRequest,
  usageContext: UsageContext | undefined
): Promise<HopResult> => {
  const model = DEEPSEEK_WATERFALL_PROVIDER_MODEL[provider];
  try {
    const response = await dispatch({ provider, req, rawRecord: { ...rawRecord, model }, rawBody, model, usageContext });
    if (isDeepSeekWaterfallRetryStatus(response.status)) return { delivered: false, response, failure: response.status };
    const gated = await gateStreamingHop(response, req.signal);
    if (!gated.committed) return { delivered: false, response: streamFailureResponse(provider), failure: "stream" };
    return { delivered: true, response: gated.response, failure: 0 };
  } catch (error) {
    // A client cancellation is not a provider failure and must not spend the
    // next hop's latency budget.
    if (req.signal.aborted) throw error;
    return { delivered: false, response: transportFailureResponse(provider), failure: "transport" };
  }
};

export const handleDeepSeekWaterfallResponses = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  rawBody: ResponsesRequest = {},
  usageContext?: UsageContext,
  options: DeepSeekWaterfallOptions = {}
): Promise<Response> => {
  const effort = deepSeekWaterfallRequestedEffort(rawRecord);
  if (effort !== null && !isDeepSeekWaterfallReasoningLevel(effort)) return unsupportedEffortResponse(effort);

  const selection = options.selection === undefined ? await loadProviderSelectionCached() : options.selection;
  // The hop plan is the model's fixed definition: while the Ubiquity provider
  // is enabled every configured hop serves in order, and an active selection
  // without it switches the whole route off.
  const enabled = options.enabled ?? (() => isProviderEnabled(GATEWAY_PROVIDER_ID, selection));
  const configured = options.configured ?? deepSeekWaterfallProviderConfigured;
  const plan = deepSeekWaterfallPlan({ enabled, configured });
  if (!plan.length) return unavailableResponse();

  const dispatch = options.dispatch ?? defaultDispatchFor(options.paidTail ?? runOrdinaryResponsesTail);
  const attempted: string[] = [];
  let fallbackReason: DeepSeekWaterfallFallbackReason | null = null;
  let finalResponse = unavailableResponse();
  for (const provider of plan) {
    if (req.signal.aborted) break;
    const result = await attemptHop(dispatch, provider, req, rawRecord, rawBody, usageContext);
    attempted.push(provider);
    recordAttemptedProvider(usageContext, provider);
    finalResponse = result.response;
    if (result.delivered) break;
    fallbackReason ??= deepSeekWaterfallFailureReason(provider, result.failure);
  }
  if (fallbackReason !== null && usageContext?.responseTelemetry) usageContext.responseTelemetry.fallbackReason = fallbackReason;
  return withAttemptedProviders(finalResponse, attempted);
};

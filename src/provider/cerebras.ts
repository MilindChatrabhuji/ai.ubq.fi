import { type ApiKeyProviderDispatch, ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "../inference-deadline.ts";
import { getString, isRecord } from "../utils.ts";
import type { SentinelUpstreamRecorder } from "../sentinel/upstream-capture.ts";

export const CEREBRAS_GPT_OSS_120B_MODEL = "gpt-oss-120b";
export const CEREBRAS_QWEN_3_8_27B_MODEL = "qwen-3.8-27b";
export const CEREBRAS_CHAT_COMPLETIONS_URL = "https://api.cerebras.ai/v1/chat/completions";

/**
 * Every Cerebras id this route serves, in advertised order. The provider used
 * to expose exactly one model, so the routing predicates compared against a
 * single constant; keep the ids in one list so a catalog row and its dispatch
 * rule cannot drift apart again.
 *
 * Per-model capability facts (context window, reasoning tiers and defaults)
 * live with the hints in `src/request-policy.ts`, which is their only consumer.
 */
export const CEREBRAS_MODELS = [CEREBRAS_GPT_OSS_120B_MODEL, CEREBRAS_QWEN_3_8_27B_MODEL] as const;

/**
 * Resolves a client-supplied id to the Cerebras wire id it names, or null when
 * this route does not own it. Matching is case-insensitive because model ids
 * are opaque and clients normalize case inconsistently; the returned value is
 * always the provider's exact spelling so the upstream sees a known id.
 */
export const cerebrasUpstreamModelFor = (model: string): string | null => {
  const requested = model.trim().toLowerCase();
  return CEREBRAS_MODELS.find((candidate) => candidate === requested) ?? null;
};

const CEREBRAS_API_KEY_ENV = "CEREBRAS_API_KEY";
const MAX_CEREBRAS_PROVIDER_REQUEST_ID_LENGTH = 256;
const CEREBRAS_UNSUPPORTED_SCHEMA_FIELDS = new Set([
  "format",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minItems",
  "minLength",
  "minProperties",
  "pattern",
  "uniqueItems",
]);
let cerebrasFetchTimeoutMs = BUFFERED_INFERENCE_DEADLINE_MS;

export type CerebrasFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CerebrasErrorCode = "cerebras_api_key_missing" | "cerebras_request_invalid" | "cerebras_upstream_unreachable" | "gateway_timeout";

export class CerebrasError extends Error {
  readonly code: CerebrasErrorCode;
  readonly status: number;

  constructor(message: string, code: CerebrasErrorCode, status: number) {
    super(message);
    this.name = "CerebrasError";
    this.code = code;
    this.status = status;
  }
}

export type CerebrasChatCompletionsOptions = Readonly<{
  apiKey?: string | null;
  fetcher?: CerebrasFetch;
  signal?: AbortSignal;
  /**
   * Resolves the API-key dispatch admission for this attempt. Both the
   * "claimed a dispatch" and the "nothing to claim" shapes are accepted, which
   * is why this is a union of function types rather than a union that puts
   * `void` inside `Promise<...>`.
   */
  beforeDispatch?: (() => Promise<ApiKeyProviderDispatch>) | (() => void);
  onDispatch?: () => void;
  onHeaders?: () => void;
  /** Request-owned passive recorder; best effort, never required. */
  sentinelUpstreamRecorder?: SentinelUpstreamRecorder;
}>;

type NormalizationResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; message: string }>;

const nonEmptyString = (value: unknown): string | null => {
  const text = getString(value)?.trim() ?? "";
  return text === "" ? null : text;
};

/** Tool IDs and names are opaque OpenAI wire values, not display strings. */
const exactNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return null;
  return value;
};

/**
 * Provider request IDs are opaque support-correlation values. Keep only a
 * bounded, header-safe value so an upstream cannot make the gateway reflect
 * arbitrary metadata.
 */
export const normalizeCerebrasProviderRequestId = (value: unknown): string | null => {
  const requestId = exactNonEmptyString(value);
  if (!requestId || requestId.length > MAX_CEREBRAS_PROVIDER_REQUEST_ID_LENGTH) return null;
  return /^[\x21-\x7e]+$/.test(requestId) ? requestId : null;
};

export const getCerebrasProviderRequestId = (response: Response): string | null =>
  normalizeCerebrasProviderRequestId(
    response.headers.get("X-Request-Id") ?? response.headers.get("X-Api-Request-Id") ?? response.headers.get("X-Cerebras-Request-Id")
  );

const nonNegativeInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
};

const getEnv = (key: string): string | undefined => {
  try {
    return process.env[key];
  } catch {
    return undefined;
  }
};

const timeoutError = (): CerebrasError => new CerebrasError("Upstream request exceeded the gateway deadline.", "gateway_timeout", 504);

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted.", "AbortError");

const isTimeoutError = (error: unknown): boolean => error instanceof Error && error.name === "TimeoutError";

export const readCerebrasApiKey = (): string | null => nonEmptyString(getEnv(CEREBRAS_API_KEY_ENV));

export const setCerebrasFetchTimeoutMsForTest = (timeoutMs: number | null): void => {
  cerebrasFetchTimeoutMs = timeoutMs ?? BUFFERED_INFERENCE_DEADLINE_MS;
};

const requireCerebrasApiKey = (supplied: string | null | undefined): string => {
  const apiKey = supplied === undefined ? readCerebrasApiKey() : nonEmptyString(supplied);
  if (apiKey) return apiKey;
  throw new CerebrasError("The requested model is not configured.", "cerebras_api_key_missing", 503);
};

/**
 * Cerebras accepts a documented subset of JSON Schema for strict native
 * tools. Keep the product's complete schema at the gateway boundary, then
 * project only the provider-bound copy: its server-side validation remains
 * the authoritative enforcement for omitted bounds.
 *
 * IMPORTANT: unsupported KEYWORDS are stripped only at schema positions.
 * Property NAMES inside a `properties` map are ordinary field identifiers —
 * a field called `pattern`, `format` or `minLength` must never be dropped
 * (this used to corrupt multi-field tool schemas: the property disappeared
 * while `required` still named it, and clients saw the model "misassign"
 * arguments into whatever field survived). "const"/"oneOf" are likewise
 * only schema-level constructs.
 */
const projectCerebrasSchemaValue = (value: unknown, inPropertiesMap = false): unknown => {
  if (Array.isArray(value)) return value.map((child) => projectCerebrasSchemaValue(child, false));
  if (!isRecord(value) || Array.isArray(value)) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!inPropertiesMap && CEREBRAS_UNSUPPORTED_SCHEMA_FIELDS.has(key)) continue;
    if (key === "const" && !inPropertiesMap) {
      projected.enum = [projectCerebrasSchemaValue(child, false)];
      continue;
    }
    projected[key === "oneOf" && !inPropertiesMap ? "anyOf" : key] = projectCerebrasSchemaValue(child, key === "properties");
  }
  return projected;
};

const distinctSchemas = (values: readonly unknown[]): unknown[] => {
  const distinct = new Map<string, unknown>();
  for (const value of values) distinct.set(JSON.stringify(value), value);
  return [...distinct.values()];
};

/**
 * Code-unit ascending string order. This is exactly what an argument-less
 * `Array.prototype.sort()` does for strings, so it keeps the projected
 * `required` array byte-identical on the upstream wire while still giving
 * `sort` an explicit comparator.
 */
const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

/**
 * Cerebras requires every function parameter schema to have an object root.
 * Our read tool's exact server-side schema is a root union by operation ID;
 * present it to the model as one object with a constrained ID and nested
 * argument union, then retain exact validation after the response returns.
 */
const collapseCerebrasRootObjectUnion = (value: unknown): unknown => {
  if (!isRecord(value) || Array.isArray(value) || value.type === "object" || !Array.isArray(value.anyOf)) {
    return value;
  }
  const variants = value.anyOf;
  if (
    !variants.length ||
    variants.some(
      (variant) =>
        !isRecord(variant) || Array.isArray(variant) || variant.type !== "object" || !isRecord(variant.properties) || Array.isArray(variant.properties)
    )
  )
    return value;

  const fields = new Map<string, unknown[]>();
  let requiredByEveryVariant: Set<string> | null = null;
  for (const variant of variants) {
    const properties = variant.properties as Record<string, unknown>;
    for (const [name, schema] of Object.entries(properties)) {
      const values = fields.get(name) ?? [];
      values.push(schema);
      fields.set(name, values);
    }
    const required = new Set<string>(
      Array.isArray(variant.required) ? variant.required.filter((name: unknown): name is string => typeof name === "string") : []
    );
    requiredByEveryVariant = requiredByEveryVariant === null ? required : requiredByEveryVariant.intersection(required);
  }

  const properties: Record<string, unknown> = {};
  for (const [name, candidates] of fields) {
    const distinct = distinctSchemas(candidates);
    if (distinct.length === 1) {
      properties[name] = distinct[0];
      continue;
    }
    if (name === "operationId" && distinct.every((candidate) => isRecord(candidate) && Array.isArray(candidate.enum))) {
      properties[name] = {
        enum: distinctSchemas(distinct.flatMap((candidate) => (candidate as Record<string, unknown>).enum as unknown[])),
      };
      continue;
    }
    properties[name] = { anyOf: distinct };
  }
  return {
    type: "object",
    properties,
    required: [...(requiredByEveryVariant ?? [])].sort(compareStrings),
    additionalProperties: false,
  };
};

export const projectCerebrasToolSchema = (value: unknown): unknown => collapseCerebrasRootObjectUnion(projectCerebrasSchemaValue(value));

/**
 * Projects one message onto the Cerebras wire.
 *
 * The `developer` role is mapped onto the `system` role Cerebras accepts: the
 * chat template rejects an unknown role instead of ignoring it (verified live
 * 2026-09-26: `system` 200, `developer` 400), and DeepSeek Harness sends
 * `developer` for system instructions, so an unprojected harness turn can
 * never succeed on this route.
 *
 * `reasoning_content` is removed from an assistant turn. Cerebras validates
 * every message field instead of ignoring the ones it does not implement, so
 * the reasoning this gateway's shared Responses translation replays on
 * assistant turns fails the whole request before the model is reached:
 *
 *   HTTP 400 wrong_api_format: messages.3.assistant.reasoning_content and
 *   messages.4.assistant.reasoning_content are unsupported
 *
 * (Codex session 01a0fea8-58df-7d93-af95-49f80cec6a1b, 2026-10-02, model
 * qwen-3.8-27b: the first tool-bearing turn dispatched, and the continuation
 * carrying the replayed reasoning item failed on both attempts, so the thread
 * could never continue.) The field is still required by DeepSeek's own wire in
 * thinking mode, so the removal belongs here, at the provider-bound copy
 * rather than in the shared translation: this transport is the one seam both
 * Cerebras wires (Chat Completions and the Responses adapter) dispatch
 * through, and DeepSeek/LithosAI bodies are untouched. Reasoning the provider
 * returns is unaffected.
 *
 * A message of any other role is returned as it stands; a `developer` or
 * assistant message is copied before it is projected, so the caller's own
 * request record and every other message object survive untouched.
 */
const projectCerebrasMessage = (message: unknown): unknown => {
  if (!isRecord(message) || Array.isArray(message)) return message;
  const developer = message.role === "developer";
  if (!developer && message.role !== "assistant") return message;
  const projected: Record<string, unknown> = developer ? { ...message, role: "system" } : { ...message };
  delete projected.reasoning_content;
  return projected;
};

const projectCerebrasMessages = (messages: unknown): unknown => {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => projectCerebrasMessage(message));
};

const isCerebrasSystemMessage = (message: unknown): message is Record<string, unknown> =>
  isRecord(message) && !Array.isArray(message) && message.role === "system";

/** Reject content Cerebras cannot represent instead of silently dropping it. */
const rejectUnsupportedCerebrasSystemContent = (): never => {
  throw new CerebrasError("Cerebras supports only text content in system and developer messages.", "cerebras_request_invalid", 400);
};

/** One part of a `system` message's content: a string part whole, or a record part's text. */
const cerebrasSystemPartText = (part: unknown): string => {
  if (typeof part === "string") return part;
  if (isRecord(part) && !Array.isArray(part) && typeof part.text === "string") return part.text;
  return rejectUnsupportedCerebrasSystemContent();
};

/** One `system` message's own text: a string whole, or the concatenation of its text parts. */
const cerebrasSystemContentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return rejectUnsupportedCerebrasSystemContent();
  return content.map(cerebrasSystemPartText).join("");
};

/**
 * Cerebras applies the model's chat template strictly, and the Qwen template
 * accepts exactly one `system` message, at index 0: a second `system` message,
 * or one that follows another message, fails the whole turn before inference
 * with "Failed to apply chat template to messages due to error: System message
 * must be at the beginning." (`wrong_api_format`, verified live 2026-09-28
 * against qwen-3.8-27b). The shared Responses translation emits one `system`
 * message per `instructions` plus one for each `developer` input item, and a
 * Codex client sends both, so the Cerebras wires have to collapse them into the
 * single leading message the template accepts.
 *
 * Every `system` message's text is kept, in original order, joined with a blank
 * line; unsupported content is rejected before dispatch rather than dropped.
 * All other messages keep their relative order. A body that already holds at
 * most one text-only `system` message, at index 0, is returned unchanged, so
 * an ordinary request is never rewritten. The collapse runs for both ids on
 * this route: `gpt-oss-120b`'s harmony template tolerates the extra message,
 * but one wire shape must not drift by model.
 */
export const collapseCerebrasSystemMessages = (messages: unknown): unknown => {
  if (!Array.isArray(messages)) return messages;
  const systems = messages.filter(isCerebrasSystemMessage);
  if (systems.length === 0) return messages;
  if (systems.length === 1 && isCerebrasSystemMessage(messages[0])) {
    cerebrasSystemContentText(systems[0].content);
    return messages;
  }
  const texts = systems.map((message) => cerebrasSystemContentText(message.content)).filter((text) => text !== "");
  return [{ ...systems[0], content: texts.join("\n\n") }, ...messages.filter((message) => !isCerebrasSystemMessage(message))];
};

export const projectCerebrasRequest = (body: Record<string, unknown>): Record<string, unknown> => {
  // The Chat wire's `developer` mapping and the system-message collapse both
  // live here, so every dispatch through this transport carries exactly one
  // leading `system` message whichever wire built the body.
  const projected: Record<string, unknown> = { ...body, messages: collapseCerebrasSystemMessages(projectCerebrasMessages(body.messages)) };
  if (!Array.isArray(body.tools)) return projected;
  return {
    ...projected,
    tools: body.tools.map((tool) => {
      if (!isRecord(tool) || Array.isArray(tool) || !isRecord(tool.function) || Array.isArray(tool.function)) {
        return tool;
      }
      return {
        ...tool,
        function: {
          ...tool.function,
          ...(tool.function.parameters === undefined ? {} : { parameters: projectCerebrasToolSchema(tool.function.parameters) }),
        },
      };
    }),
  };
};

/**
 * Classifies one aborted dispatch, before any upstream response exists. The
 * request signal decides first because its reason carries the caller's own
 * abort/timeout identity.
 */
const abortedTransportError = (signal: AbortSignal, requestSignal: AbortSignal | undefined, deadlineSignal: AbortSignal): Error => {
  if (requestSignal && isTimeoutError(abortError(requestSignal))) return timeoutError();
  if (deadlineSignal.aborted) return timeoutError();
  return abortError(signal);
};

/**
 * Classifies a failed attempt: an aborted request signal keeps its own
 * identity, a deadline or timeout failure becomes the gateway timeout, and
 * everything else is an unreachable upstream.
 */
const transportFailureError = (error: unknown, requestSignal: AbortSignal | undefined, deadlineSignal: AbortSignal): Error => {
  if (requestSignal?.aborted) return isTimeoutError(abortError(requestSignal)) ? timeoutError() : abortError(requestSignal);
  if (deadlineSignal.aborted || isTimeoutError(error)) return timeoutError();
  return new CerebrasError("Upstream request could not be completed.", "cerebras_upstream_unreachable", 502);
};

/**
 * Sends only canonical OpenAI Chat Completions JSON to Cerebras.  The caller
 * owns model selection; this transport never chooses or falls back to another
 * provider.
 */
export const fetchCerebrasChatCompletions = async (body: Record<string, unknown>, options: CerebrasChatCompletionsOptions = {}): Promise<Response> => {
  let encodedBody: string;
  try {
    encodedBody = JSON.stringify(projectCerebrasRequest(body));
  } catch (error) {
    if (error instanceof CerebrasError) throw error;
    throw new CerebrasError("Chat Completions requests must use a JSON-serializable body.", "cerebras_request_invalid", 400);
  }
  if (typeof encodedBody !== "string") {
    throw new CerebrasError("Chat Completions requests must use a JSON-serializable body.", "cerebras_request_invalid", 400);
  }

  const apiKey = requireCerebrasApiKey(options.apiKey);
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException("Cerebras response headers timed out.", "TimeoutError"));
  }, cerebrasFetchTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;

  let upstreamAttempt: ReturnType<SentinelUpstreamRecorder["startAttempt"]> | null = null;
  try {
    // Keep this as the final awaited operation before provider transport so
    // API-key admission cannot be committed after a cancelled request.
    const dispatch = options.beforeDispatch ? await options.beforeDispatch() : undefined;
    if (signal.aborted) {
      await dispatch?.cancelBeforeTransport();
      throw abortedTransportError(signal, options.signal, deadline.signal);
    }
    dispatch?.markTransportStarted();
    options.onDispatch?.();
    upstreamAttempt = options.sentinelUpstreamRecorder?.startAttempt("cerebras") ?? null;
    const response = await (options.fetcher ?? fetch)(CEREBRAS_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers,
      body: encodedBody,
      redirect: "manual",
      signal,
    });
    options.onHeaders?.();
    return upstreamAttempt ? upstreamAttempt.wrap(response) : response;
  } catch (error) {
    upstreamAttempt?.recordFetchError();
    if (error instanceof ApiKeyQuotaDispatchError || error instanceof CerebrasError) throw error;
    throw transportFailureError(error, options.signal, deadline.signal);
  } finally {
    clearTimeout(timer);
  }
};

const normalizeToolCall = (value: unknown, index: number): NormalizationResult<Record<string, unknown>> => {
  if (!isRecord(value) || Array.isArray(value)) {
    return { ok: false, message: `Upstream tool call ${index} is not an object.` };
  }
  const id = exactNonEmptyString(value.id);
  if (!id) return { ok: false, message: `Upstream tool call ${index} is missing an id.` };
  if (value.type !== "function") {
    return { ok: false, message: `Upstream tool call ${index} has an unsupported type.` };
  }
  if (!isRecord(value.function) || Array.isArray(value.function)) {
    return { ok: false, message: `Upstream tool call ${index} is missing its function.` };
  }
  const name = exactNonEmptyString(value.function.name);
  if (!name) return { ok: false, message: `Upstream tool call ${index} is missing a function name.` };
  if (typeof value.function.arguments !== "string") {
    return { ok: false, message: `Upstream tool call ${index} has non-string arguments.` };
  }
  // OpenAI's Chat contract represents function arguments as an opaque string.
  // Do not parse or reserialize it: the Assistant validates it in its shared
  // application pipeline after this provider adapter returns.
  return {
    ok: true,
    value: {
      id,
      type: "function",
      function: { name, arguments: value.function.arguments },
    },
  };
};

/** Upstream `null`, `undefined` and strings are the only accepted nullable text values. */
const isAbsentOrString = (value: unknown): boolean => value === undefined || value === null || typeof value === "string";

/**
 * Normalizes the tool calls of one choice. `undefined` means the message
 * carried no `tool_calls` field at all.
 */
const normalizeToolCalls = (rawToolCalls: unknown, choiceIndex: number): NormalizationResult<Record<string, unknown>[] | undefined> => {
  if (rawToolCalls === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(rawToolCalls)) {
    return { ok: false, message: `Upstream choice ${choiceIndex} has invalid tool calls.` };
  }
  const toolCalls: Record<string, unknown>[] = [];
  for (const [callIndex, call] of rawToolCalls.entries()) {
    const normalized = normalizeToolCall(call, callIndex);
    if (!normalized.ok) return normalized;
    toolCalls.push(normalized.value);
  }
  return { ok: true, value: toolCalls };
};

const choiceHasNoPayload = (content: unknown, toolCalls: readonly unknown[] | undefined, refusal: string): boolean =>
  content === undefined && !toolCalls?.length && !refusal;

/** Mirrors the upstream `content` field: absent content becomes explicit JSON `null` only when a tool call or refusal exists. */
const choiceContent = (content: unknown, toolCalls: readonly unknown[] | undefined, refusal: string): unknown => {
  if (content !== undefined && content !== null) return content;
  return toolCalls?.length || refusal ? null : "";
};

/** Validates the assistant message of one choice and projects it for normalization. */
const normalizeChoiceMessage = (
  message: Record<string, unknown>,
  index: number
): NormalizationResult<Readonly<{ content: unknown; refusal: string; toolCalls: Record<string, unknown>[] | undefined }>> => {
  if (message.role !== "assistant") {
    return { ok: false, message: `Upstream choice ${index} does not contain an assistant message.` };
  }
  if (!isAbsentOrString(message.content)) {
    return { ok: false, message: `Upstream choice ${index} has unsupported message content.` };
  }
  if (!isAbsentOrString(message.refusal)) {
    return { ok: false, message: `Upstream choice ${index} has an invalid refusal.` };
  }
  const refusal = typeof message.refusal === "string" ? message.refusal : "";
  const toolCallsResult = normalizeToolCalls(message.tool_calls, index);
  if (!toolCallsResult.ok) return toolCallsResult;
  const toolCalls = toolCallsResult.value;
  if (choiceHasNoPayload(message.content, toolCalls, refusal)) {
    return { ok: false, message: `Upstream choice ${index} has neither content nor a tool call.` };
  }
  return { ok: true, value: { content: message.content, refusal, toolCalls } };
};

const normalizeChoice = (value: unknown, index: number): NormalizationResult<Record<string, unknown>> => {
  if (!isRecord(value) || Array.isArray(value)) {
    return { ok: false, message: `Upstream choice ${index} is not an object.` };
  }
  const choiceIndex = nonNegativeInteger(value.index);
  if (choiceIndex === null) return { ok: false, message: `Upstream choice ${index} has an invalid index.` };
  if (!isRecord(value.message) || Array.isArray(value.message)) {
    return { ok: false, message: `Upstream choice ${index} is missing an assistant message.` };
  }
  const message = value.message;
  const normalizedMessagePart = normalizeChoiceMessage(message, index);
  if (!normalizedMessagePart.ok) return normalizedMessagePart;
  const { content, refusal, toolCalls } = normalizedMessagePart.value;

  const finishReason = value.finish_reason;
  if (!isAbsentOrString(finishReason)) {
    return { ok: false, message: `Upstream choice ${index} has an invalid finish reason.` };
  }
  const normalizedMessage: Record<string, unknown> = {
    role: "assistant",
    content: choiceContent(content, toolCalls, refusal),
  };
  // 1:1 with native Cerebras (compliance D1, measured 2026-08-29): the
  // upstream reasoning field must reach clients unchanged. The gateway
  // previously dropped it, so clients saw content+role only.
  if (typeof message.reasoning === "string") normalizedMessage.reasoning = message.reasoning;
  if (refusal) normalizedMessage.refusal = refusal;
  if (toolCalls?.length) normalizedMessage.tool_calls = toolCalls;
  return {
    ok: true,
    value: {
      index: choiceIndex,
      message: normalizedMessage,
      finish_reason: finishReason ?? (toolCalls?.length ? "tool_calls" : "stop"),
    },
  };
};

/**
 * One documented nested usage counter, validated against the total it is
 * defined as a subset of. An absent or impossible value stays absent, so no
 * reader downstream can mistake a missing measurement for a measured zero.
 */
const usageDetailCounter = (container: unknown, key: string, ceiling: number): number | null => {
  if (!isRecord(container) || Array.isArray(container)) return null;
  const counter = nonNegativeInteger(container[key]);
  if (counter === null || counter > ceiling) return null;
  return counter;
};

/**
 * `prompt_tokens_details.cached_tokens`, or null when the provider reported no
 * cache measurement or an impossible count. Exported so the provider adapter
 * can reuse the exact guard `normalizeUsage` applies instead of restating it.
 */
export const cerebrasCachedPromptTokens = (value: Record<string, unknown>, promptTokens: number): number | null =>
  usageDetailCounter(value.prompt_tokens_details, "cached_tokens", promptTokens);

/**
 * `completion_tokens_details.reasoning_tokens`, or null when the provider
 * reported no reasoning measurement or an impossible count. Exported beside
 * the cache guard so both detail counters have one definition.
 */
export const cerebrasReasoningTokens = (value: Record<string, unknown>, completionTokens: number): number | null =>
  usageDetailCounter(value.completion_tokens_details, "reasoning_tokens", completionTokens);

/**
 * Reduces a Cerebras usage object to the OpenAI Chat Completions usage shape
 * the Assistant consumes. The provider reports cache reads and reasoning tokens
 * as the documented nested details, so those counters are relayed under their
 * official names rather than dropped; an upstream that reports neither leaves
 * the corresponding detail object absent.
 */
const normalizeUsage = (value: unknown): NormalizationResult<Record<string, unknown> | null> => {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isRecord(value) || Array.isArray(value)) return { ok: false, message: "Upstream usage is not an object." };
  const promptTokens = nonNegativeInteger(value.prompt_tokens);
  const completionTokens = nonNegativeInteger(value.completion_tokens);
  const totalTokens = nonNegativeInteger(value.total_tokens);
  if (promptTokens === null || completionTokens === null || totalTokens === null) {
    return { ok: false, message: "Upstream usage is incomplete." };
  }
  const cachedTokens = cerebrasCachedPromptTokens(value, promptTokens);
  const reasoningTokens = cerebrasReasoningTokens(value, completionTokens);
  return {
    ok: true,
    value: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      ...(cachedTokens === null ? {} : { prompt_tokens_details: { cached_tokens: cachedTokens } }),
      ...(reasoningTokens === null ? {} : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
    },
  };
};

/**
 * Reduces a Cerebras success payload to the OpenAI Chat Completions shape the
 * Assistant consumes. Unknown provider fields, including diagnostics, are not
 * relayed or logged.
 */
export const normalizeCerebrasChatCompletion = (value: unknown, requestedModel: string): NormalizationResult<Record<string, unknown>> => {
  if (!isRecord(value) || Array.isArray(value)) {
    return { ok: false, message: "Upstream did not return a Chat Completions object." };
  }
  const id = nonEmptyString(value.id);
  if (!id) return { ok: false, message: "Upstream Chat Completion is missing an id." };
  const created = nonNegativeInteger(value.created);
  if (created === null) return { ok: false, message: "Upstream Chat Completion has an invalid creation time." };
  if (value.object !== undefined && value.object !== "chat.completion") {
    return { ok: false, message: "Upstream did not return a Chat Completion." };
  }
  const upstreamModel = nonEmptyString(value.model);
  if (upstreamModel && upstreamModel !== requestedModel) {
    return { ok: false, message: "Upstream returned a different model than requested." };
  }
  if (!Array.isArray(value.choices) || value.choices.length === 0) {
    return { ok: false, message: "Upstream Chat Completion has no choices." };
  }
  const choices: Record<string, unknown>[] = [];
  for (const [index, choice] of value.choices.entries()) {
    const normalized = normalizeChoice(choice, index);
    if (!normalized.ok) return normalized;
    choices.push(normalized.value);
  }
  const usage = normalizeUsage(value.usage);
  if (!usage.ok) return usage;
  return {
    ok: true,
    value: {
      id,
      object: "chat.completion",
      created,
      model: requestedModel,
      choices,
      ...(usage.value ? { usage: usage.value } : {}),
    },
  };
};

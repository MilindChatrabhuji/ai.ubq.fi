import { type ApiKeyProviderDispatch, ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { STREAM_FIRST_EVENT_DEADLINE_MS } from "../inference-deadline.ts";
import type { SentinelUpstreamRecorder } from "../sentinel/upstream-capture.ts";
import { getString, isRecord } from "../utils.ts";

/**
 * Official DeepSeek API transport.
 *
 * This is a "special upstream provider" in the same sense as Cerebras: a
 * request addressed to one of its model ids is dispatched straight to the
 * provider's documented OpenAI-compatible Chat Completions endpoint and never
 * races or falls back to another provider.
 *
 * Provider facts (https://api-docs.deepseek.com, read 2026-09-16):
 * - base URL `https://api.deepseek.com`, Chat Completions at `/chat/completions`
 * - model ids `deepseek-flash` and `deepseek-v4-pro`; the provider's own
 *   `GET /models` lists exactly those two, so both are served here
 * - `deepseek-v4-flash` is an accepted interchangeable alias: the API answers it
 *   with `"model": "deepseek-flash"`. It is NOT `deepseek-v4.1-flash`, which the
 *   API rejects ("The supported API model names are deepseek-flash,
 *   deepseek-v4-pro"). That id belongs to the paid Surplus/Metered catalogue,
 *   not to this provider.
 * - `reasoning_effort` accepts none/low/high/max, plus the documented
 *   compatibility aliases minimal (→low), medium and xhigh (→high)
 * - thinking mode is ENABLED BY DEFAULT and its output arrives as
 *   `message.reasoning_content` / `delta.reasoning_content`
 * - the documented output cap is `max_tokens`, and `temperature` has no effect
 *   while thinking mode is active
 * - streaming is native SSE (`data: {...}` frames terminated by `data: [DONE]`),
 *   with `: keep-alive` comment frames while the model is thinking
 */
export const DEEPSEEK_FLASH_MODEL = "deepseek-flash";
/**
 * Interchangeable legacy id for the same official model. It is still accepted
 * by the API and is the id the local Codex model catalog already advertises,
 * so both ids must route here.
 */
export const DEEPSEEK_V4_FLASH_MODEL = "deepseek-v4-flash";
/** The provider's second published model, served under its own canonical id. */
export const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";
/** Operator-facing names, kept beside the ids they describe. */
export const DEEPSEEK_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  [DEEPSEEK_FLASH_MODEL]: "DeepSeek Flash",
  [DEEPSEEK_V4_FLASH_MODEL]: "DeepSeek Flash (legacy id)",
  [DEEPSEEK_PRO_MODEL]: "DeepSeek Pro",
};
export const DEEPSEEK_OFFICIAL_MODEL_IDS = [DEEPSEEK_FLASH_MODEL, DEEPSEEK_V4_FLASH_MODEL, DEEPSEEK_PRO_MODEL] as const;

/**
 * Canonical upstream id for every client-facing id the provider publishes or
 * accepts. The legacy flash alias is the only id that is not sent verbatim: the
 * API serves it as `deepseek-flash`.
 */
const DEEPSEEK_UPSTREAM_MODEL_BY_ID: Readonly<Record<string, string>> = {
  [DEEPSEEK_FLASH_MODEL]: DEEPSEEK_FLASH_MODEL,
  [DEEPSEEK_V4_FLASH_MODEL]: DEEPSEEK_FLASH_MODEL,
  [DEEPSEEK_PRO_MODEL]: DEEPSEEK_PRO_MODEL,
};
export const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_CONTEXT_WINDOW_TOKENS = 1_000_000;
/** Documented reasoning tiers, in ascending order. */
export const DEEPSEEK_REASONING_LEVELS = ["none", "low", "high", "max"] as const;
/** Documented default when a request omits `reasoning_effort` (thinking mode on, effort high). */
export const DEEPSEEK_DEFAULT_REASONING_EFFORT = "high";

/**
 * Thinking-mode gate for the request parameters DeepSeek refuses while
 * thinking is active. `reasoning_effort` `none` disables thinking mode, and
 * `thinking: { type: "disabled" }` does too; every other documented tier
 * (`low`, `high`, `max`) enables it. An omitted effort leaves the documented
 * default (`high`) in force, so it counts as thinking. When both fields are
 * present, the explicit reasoning effort is the canonical mode.
 *
 * Probed 2026-09-21 against `https://api.deepseek.com/chat/completions` with
 * tools advertised: `tool_choice` `required` and the named-function form both
 * answer HTTP 400 `Thinking mode does not support this tool_choice` at
 * `low`, `high`, and the omitted default, and are accepted once thinking is
 * disabled. `none` and `auto` are accepted in every mode.
 */
export const deepSeekThinkingModeActive = (reasoningEffort: unknown, thinking: unknown): boolean => {
  const effort = typeof reasoningEffort === "string" ? reasoningEffort.trim().toLowerCase() : "";
  if (effort) return effort !== "none";
  if (isRecord(thinking) && !Array.isArray(thinking)) {
    const type = getString(thinking.type)?.trim().toLowerCase();
    if (type === "disabled") return false;
    if (type === "enabled") return true;
  }
  return true;
};

/**
 * The `tool_choice` values DeepSeek's thinking mode refuses, or null when the
 * value is one the provider accepts in every mode. Only `required` and the
 * named-function form are restricted; `none` and `auto` are always valid.
 *
 * The rule is expressed once here and consumed by every DeepSeek request seam
 * (the Chat route and the Responses translation), so the two cannot drift.
 */
export const deepSeekThinkingModeForbiddenToolChoice = (toolChoice: unknown): string | null => {
  if (toolChoice === "required") return "required";
  if (isRecord(toolChoice) && !Array.isArray(toolChoice)) {
    const name = getString(toolChoice.name) ?? (isRecord(toolChoice.function) ? getString(toolChoice.function.name) : null);
    if (name) return `function:${name}`;
  }
  return null;
};

/**
 * The terminal a DeepSeek `finish_reason` implies, before output validity
 * applies. The provider's documented vocabulary is `[ stop, length,
 * content_filter, tool_calls, insufficient_system_resource, aborted ]`, read
 * from the official Chat Completions reference
 * (https://api-docs.deepseek.com/api/create-chat-completion, 2026-09-21).
 */
export type DeepSeekFinishDisposition =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "incomplete"; reason: "max_output_tokens" | "content_filter" }>
  | Readonly<{ kind: "failed"; code: string }>
  | Readonly<{ kind: "unknown"; value: string }>;

/**
 * The single expression of the thinking-mode `tool_choice` restriction: returns
 * the conflicting `tool_choice` value, or null when the request is servable.
 *
 * Both DeepSeek request seams call this so the Chat route and the Responses
 * translation cannot drift, and the returned value feeds one message builder so
 * a client sees the same contract on either route.
 */
export const deepSeekThinkingToolChoiceConflict = (reasoningEffort: unknown, thinking: unknown, toolChoice: unknown): string | null => {
  const forbidden = deepSeekThinkingModeForbiddenToolChoice(toolChoice);
  if (!forbidden) return null;
  return deepSeekThinkingModeActive(reasoningEffort, thinking) ? forbidden : null;
};

/**
 * The message a client sees when it asked for a `tool_choice` value that only
 * works with thinking mode disabled. It names both conflicting fields in the
 * vocabulary of the request it was sent on, so the caller can act on it without
 * reading provider documentation.
 */
export const deepSeekToolChoiceThinkingConflictMessage = (toolChoice: string, effortField: string): string =>
  `tool_choice '${toolChoice}' is not supported while ${effortField} keeps DeepSeek thinking mode active; set ${effortField} to 'none' or use tool_choice 'auto'`;

/**
 * Maps a DeepSeek `finish_reason` onto the Responses terminal vocabulary.
 *
 * `length` covers output-budget exhaustion *and* context-window exhaustion, so
 * it maps to `max_output_tokens` — the only reason string the official OpenAI
 * response schema defines for that case. An unrecognized value is reported as
 * unknown rather than being silently treated as a normal stop, which is what
 * the provider's own client does (`mapFinishReason` fail-closes with the
 * uppercased value as its code).
 */
export const deepSeekFinishDisposition = (reason: unknown): DeepSeekFinishDisposition => {
  switch (typeof reason === "string" ? reason.trim() : "") {
    // An absent reason means the frame carried none, not that generation was
    // cut off. The provider's own client defaults `pendingFinish ?? "stop"` at
    // its end sentinel, and this mapping only runs after that sentinel.
    case "":
    case "stop":
    case "tool_calls":
      return { kind: "completed" };
    case "length":
      return { kind: "incomplete", reason: "max_output_tokens" };
    case "content_filter":
      return { kind: "incomplete", reason: "content_filter" };
    case "insufficient_system_resource":
      return { kind: "failed", code: "insufficient_system_resource" };
    case "aborted":
      return { kind: "failed", code: "aborted" };
    default:
      return { kind: "unknown", value: typeof reason === "string" ? reason : "" };
  }
};

const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
const MAX_DEEPSEEK_PROVIDER_REQUEST_ID_LENGTH = 256;
/** One SSE frame is a single generated chunk; bound it so a peer cannot pin memory. */
export const MAX_DEEPSEEK_SSE_FRAME_BYTES = 4 * 1024 * 1024;
export const SSE_FRAME_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;
export const SSE_LINE_BOUNDARY = /\r\n|\r|\n/;
const DEEPSEEK_OFFICIAL_MODEL_ID_SET = new Set<string>(DEEPSEEK_OFFICIAL_MODEL_IDS);
/**
 * Advanced Codex CLI presets are translated to the documented DeepSeek tier at
 * the provider boundary, exactly as the Codex Responses bridge does.
 */
const DEEPSEEK_WIRE_EFFORT_MAP: Readonly<Record<string, string>> = { ultra: "max" };

let deepSeekFetchTimeoutMs = STREAM_FIRST_EVENT_DEADLINE_MS;

export type DeepSeekFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DeepSeekErrorCode = "deepseek_api_key_missing" | "deepseek_request_invalid" | "deepseek_upstream_unreachable" | "gateway_timeout";

export class DeepSeekError extends Error {
  readonly code: DeepSeekErrorCode;
  readonly status: number;

  constructor(message: string, code: DeepSeekErrorCode, status: number) {
    super(message);
    this.name = "DeepSeekError";
    this.code = code;
    this.status = status;
  }
}

export type DeepSeekChatCompletionsOptions = Readonly<{
  apiKey?: string | null;
  fetcher?: DeepSeekFetch;
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
  /** Observes the exact projected body serialized for this dispatch, before any admission await. */
  onProjectedBody?: (body: Record<string, unknown>) => void;
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
export const normalizeDeepSeekProviderRequestId = (value: unknown): string | null => {
  const requestId = exactNonEmptyString(value);
  if (!requestId || requestId.length > MAX_DEEPSEEK_PROVIDER_REQUEST_ID_LENGTH) return null;
  return /^[\x21-\x7e]+$/.test(requestId) ? requestId : null;
};

export const getDeepSeekProviderRequestId = (response: Response): string | null =>
  normalizeDeepSeekProviderRequestId(
    response.headers.get("X-Request-Id") ?? response.headers.get("X-Ds-Request-Id") ?? response.headers.get("X-Deepseek-Request-Id")
  );

const nonNegativeInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
};

const getEnv = (key: string): string | undefined => {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
};

const timeoutError = (): DeepSeekError => new DeepSeekError("Upstream request exceeded the gateway deadline.", "gateway_timeout", 504);

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted.", "AbortError");

export const isTimeoutError = (error: unknown): boolean => error instanceof Error && error.name === "TimeoutError";

export const readDeepSeekApiKey = (): string | null => nonEmptyString(getEnv(DEEPSEEK_API_KEY_ENV));

export const setDeepSeekFetchTimeoutMsForTest = (timeoutMs: number | null): void => {
  deepSeekFetchTimeoutMs = timeoutMs ?? STREAM_FIRST_EVENT_DEADLINE_MS;
};

const requireDeepSeekApiKey = (supplied: string | null | undefined): string => {
  const apiKey = supplied === undefined ? readDeepSeekApiKey() : nonEmptyString(supplied);
  if (apiKey) return apiKey;
  throw new DeepSeekError("The requested model is not configured.", "deepseek_api_key_missing", 503);
};

/**
 * Resolves the canonical upstream model for a client-facing model id, or null
 * when the id is not an official DeepSeek model. Comparison is
 * case-insensitive, matching the gateway's model normalization elsewhere.
 */
export const deepSeekUpstreamModelFor = (model: string): string | null => {
  const normalized = model.trim().toLowerCase();
  return Object.hasOwn(DEEPSEEK_UPSTREAM_MODEL_BY_ID, normalized) ? DEEPSEEK_UPSTREAM_MODEL_BY_ID[normalized] : null;
};

/** Maps a requested reasoning tier onto the documented DeepSeek wire tier. */
export const projectDeepSeekReasoningEffort = (effort: string): string => DEEPSEEK_WIRE_EFFORT_MAP[effort.trim().toLowerCase()] ?? effort;

/**
 * The provider's own effective output allowance when the request omits
 * `max_tokens`, for the reasoning tier being requested.
 *
 * This is observability only: the value is never written into the upstream
 * body, so omitting a cap still sends no cap. Measured directly against the
 * provider (gateway terminal-truthfulness handoff, 2026-09-21, Delta 3): at
 * `reasoning_effort: "none"` an exhaustively long demand stopped at exactly
 * 8191-8192 completion tokens on 3 of 3 runs, so 8,192 is that tier's default.
 * `high` and `max` were only established as lower bounds (>= 65,536 and
 * >= 131,072) and no probe reached them, so those tiers (and any tier the
 * gateway cannot name) report no known allowance rather than a guess.
 */
export const deepSeekDefaultOutputAllowance = (reasoningEffort: string): number | null =>
  projectDeepSeekReasoningEffort(reasoningEffort) === "none" ? 8_192 : null;

/**
 * DeepSeek's Chat contract defines no `developer` role, while the gateway's
 * Chat input accepts the OpenAI one. Forwarding it unchanged would send the
 * provider a role its contract does not define, so the role is translated
 * here, exactly as the Responses translator already does
 * (`src/deepseek/chat-projection.ts`). Message order and content, and every
 * other role, are forwarded unchanged; messages are copied rather than
 * mutated so the caller's own request record is never rewritten in place.
 */
const projectDeepSeekMessages = (messages: unknown): unknown => {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => (isRecord(message) && !Array.isArray(message) && message.role === "developer" ? { ...message, role: "system" } : message));
};

/**
 * Projects the official Chat Completions body onto DeepSeek's documented wire
 * contract. Only three provider necessities are applied — everything else is
 * forwarded unchanged:
 *
 * 1. `model` becomes the canonical official id, so the interchangeable legacy
 *    alias reaches the API as the model it actually serves.
 * 2. `max_completion_tokens` becomes DeepSeek's documented `max_tokens`. The
 *    gateway's Chat contract only accepts the OpenAI field name, and DeepSeek
 *    documents no `max_completion_tokens`, so leaving it in place would both
 *    lose the cap and send an unrecognized parameter.
 * 3. `developer` messages become `system` messages, because DeepSeek's Chat
 *    contract defines no developer role.
 */
export const projectDeepSeekRequest = (body: Record<string, unknown>, requestedModel: string): Record<string, unknown> => {
  const upstreamModel = deepSeekUpstreamModelFor(requestedModel);
  if (!upstreamModel) throw new DeepSeekError("The requested model is not configured.", "deepseek_request_invalid", 400);
  const projected: Record<string, unknown> = { ...body, model: upstreamModel };
  if (projected.max_completion_tokens !== undefined && projected.max_completion_tokens !== null) {
    projected.max_tokens = projected.max_completion_tokens;
  }
  delete projected.max_completion_tokens;
  if (typeof projected.reasoning_effort === "string") projected.reasoning_effort = projectDeepSeekReasoningEffort(projected.reasoning_effort);
  if (Array.isArray(projected.messages)) projected.messages = projectDeepSeekMessages(projected.messages);
  return projected;
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
  return new DeepSeekError("Upstream request could not be completed.", "deepseek_upstream_unreachable", 502);
};

/**
 * Sends only canonical OpenAI Chat Completions JSON to the official DeepSeek
 * API. The caller owns model selection and streaming policy; this transport
 * never chooses or falls back to another provider, and it never rewrites the
 * caller's `stream` flag.
 *
 * The deadline covers response headers only. Once headers arrive the caller
 * owns the stream's inactivity deadline, so a long thinking turn is not killed
 * by the buffered-inference budget.
 */
export const fetchDeepSeekChatCompletions = async (
  body: Record<string, unknown>,
  requestedModel: string,
  options: DeepSeekChatCompletionsOptions = {}
): Promise<Response> => {
  let encodedBody: string;
  let projectedBody: Record<string, unknown>;
  try {
    projectedBody = projectDeepSeekRequest(body, requestedModel);
    encodedBody = JSON.stringify(projectedBody);
  } catch (error) {
    if (error instanceof DeepSeekError) throw error;
    throw new DeepSeekError("Chat Completions requests must use a JSON-serializable body.", "deepseek_request_invalid", 400);
  }
  if (typeof encodedBody !== "string") {
    throw new DeepSeekError("Chat Completions requests must use a JSON-serializable body.", "deepseek_request_invalid", 400);
  }

  options.onProjectedBody?.(projectedBody);

  const apiKey = requireDeepSeekApiKey(options.apiKey);
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException("DeepSeek response headers timed out.", "TimeoutError"));
  }, deepSeekFetchTimeoutMs);
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
    upstreamAttempt = options.sentinelUpstreamRecorder?.startAttempt("deepseek") ?? null;
    const response = await (options.fetcher ?? fetch)(DEEPSEEK_CHAT_COMPLETIONS_URL, {
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
    if (error instanceof ApiKeyQuotaDispatchError || error instanceof DeepSeekError) throw error;
    throw transportFailureError(error, options.signal, deadline.signal);
  } finally {
    clearTimeout(timer);
  }
};

/** Upstream `null`, `undefined` and strings are the only accepted nullable text values. */
const isAbsentOrString = (value: unknown): boolean => value === undefined || value === null || typeof value === "string";

const acceptUpstreamModel = (value: unknown): boolean => {
  const upstreamModel = nonEmptyString(value);
  return upstreamModel === null || DEEPSEEK_OFFICIAL_MODEL_ID_SET.has(upstreamModel.toLowerCase());
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
  return { ok: true, value: { id, type: "function", function: { name, arguments: value.function.arguments } } };
};

/** Retains an Optional OpenAI wire field only when the upstream frame actually carries it. */
const optionalField = <T>(value: unknown, normalize: (input: unknown) => T | null, message: string): NormalizationResult<T | undefined> => {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  const normalized = normalize(value);
  return normalized === null ? { ok: false, message } : { ok: true, value: normalized };
};

/** Normalizes the `function` object of one streaming tool-call delta. */
const normalizeToolCallDeltaFunction = (value: unknown, label: string): NormalizationResult<Record<string, unknown>> => {
  if (!isRecord(value) || Array.isArray(value)) return { ok: false, message: `${label} has an invalid function.` };
  const fn: Record<string, unknown> = {};
  const name = optionalField(value.name, exactNonEmptyString, `${label} has an invalid function name.`);
  if (!name.ok) return name;
  if (name.value !== undefined) fn.name = name.value;
  const args = optionalField(value.arguments, (input) => (typeof input === "string" ? input : null), `${label} has non-string arguments.`);
  if (!args.ok) return args;
  if (args.value !== undefined) fn.arguments = args.value;
  return { ok: true, value: fn };
};

/**
 * Normalizes a STREAMING tool-call delta. Unlike a buffered tool call, a delta
 * legitimately omits `id`, `type` and even `function.name` on continuation
 * frames, so only the fields this frame actually carries are retained.
 */
const normalizeToolCallDelta = (value: unknown, index: number): NormalizationResult<Record<string, unknown>> => {
  const label = `Upstream tool call delta ${index}`;
  if (!isRecord(value) || Array.isArray(value)) return { ok: false, message: `${label} is not an object.` };
  const delta: Record<string, unknown> = {};
  const callIndex = optionalField(value.index, nonNegativeInteger, `${label} has an invalid index.`);
  if (!callIndex.ok) return callIndex;
  if (callIndex.value !== undefined) delta.index = callIndex.value;
  const id = optionalField(value.id, exactNonEmptyString, `${label} has an invalid id.`);
  if (!id.ok) return id;
  if (id.value !== undefined) delta.id = id.value;
  const type = optionalField(value.type, (input) => (input === "function" ? (input as string) : null), `${label} has an unsupported type.`);
  if (!type.ok) return type;
  if (type.value !== undefined) delta.type = type.value;
  if (value.function !== undefined && value.function !== null) {
    const fn = normalizeToolCallDeltaFunction(value.function, label);
    if (!fn.ok) return fn;
    if (Object.keys(fn.value).length) delta.function = fn.value;
  }
  if (!Object.keys(delta).length) return { ok: false, message: `${label} carries no fields.` };
  return { ok: true, value: delta };
};

const normalizeToolCalls = (
  rawToolCalls: unknown,
  label: string,
  normalizeOne: (value: unknown, index: number) => NormalizationResult<Record<string, unknown>>
): NormalizationResult<Record<string, unknown>[] | undefined> => {
  if (rawToolCalls === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(rawToolCalls)) return { ok: false, message: `${label} has invalid tool calls.` };
  const toolCalls: Record<string, unknown>[] = [];
  for (const [callIndex, call] of rawToolCalls.entries()) {
    const normalized = normalizeOne(call, callIndex);
    if (!normalized.ok) return normalized;
    toolCalls.push(normalized.value);
  }
  return { ok: true, value: toolCalls };
};

/**
 * Cache-read tokens as the upstream reports them. DeepSeek publishes
 * `prompt_cache_hit_tokens`; an OpenAI-shaped `prompt_tokens_details.
 * cached_tokens` is accepted as well so one reader serves either spelling.
 *
 * The provider documents this counter as part of the request input, so a value
 * larger than `promptTokens` describes no readable measurement: the field is
 * dropped and the caller reports the cache read as unknown instead of
 * publishing a number the gateway cannot stand behind.
 */
export const deepSeekCachedPromptTokens = (value: Record<string, unknown>, promptTokens: number): number | null => {
  const details = isRecord(value.prompt_tokens_details) && !Array.isArray(value.prompt_tokens_details) ? value.prompt_tokens_details : null;
  const cached = nonNegativeInteger(value.prompt_cache_hit_tokens) ?? nonNegativeInteger(details?.cached_tokens);
  if (cached === null || cached > promptTokens) return null;
  return cached;
};

/**
 * Reasoning tokens as the upstream reports them. Thinking mode publishes
 * `completion_tokens_details.reasoning_tokens`, which the provider defines as
 * part of the completion output, so a value larger than `completionTokens`
 * describes no readable measurement and is dropped rather than published.
 */
export const deepSeekReasoningTokens = (value: Record<string, unknown>, completionTokens: number): number | null => {
  const details = isRecord(value.completion_tokens_details) && !Array.isArray(value.completion_tokens_details) ? value.completion_tokens_details : null;
  const reasoning = nonNegativeInteger(details?.reasoning_tokens);
  if (reasoning === null || reasoning > completionTokens) return null;
  return reasoning;
};

/**
 * Reduces a DeepSeek usage object to the OpenAI Chat Completions usage shape
 * the Assistant consumes. DeepSeek's provider-named cache counter is the only
 * cache signal the provider publishes, so it is relayed under the official
 * `prompt_tokens_details.cached_tokens` field rather than its provider-only
 * name; `prompt_cache_miss_tokens` needs no slot because the miss count is
 * already `prompt_tokens - cached_tokens`. Thinking mode's reasoning count is
 * relayed the same way under `completion_tokens_details.reasoning_tokens`. When
 * the upstream reports neither counter the matching detail object stays absent,
 * so no reader downstream can mistake a missing measurement for a measured zero.
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
  const cachedTokens = deepSeekCachedPromptTokens(value, promptTokens);
  const reasoningTokens = deepSeekReasoningTokens(value, completionTokens);
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
 * The official Chat chunk/message schema types `refusal` as an optional string
 * or `null`. A string is payload this gateway must carry (a refusal is
 * answer-bearing output); `null` is absence; any other type is malformed input
 * and is rejected rather than silently dropped.
 */
const normalizeRefusal = (value: unknown, label: string): NormalizationResult<string | null> => {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, message: `${label} has an invalid refusal.` };
};

const choiceHasNoPayload = (content: unknown, reasoning: unknown, refusal: string | null, toolCalls: readonly unknown[] | undefined): boolean =>
  content === undefined && reasoning === undefined && !refusal && !toolCalls?.length;

/** Mirrors the upstream `content` field: absent content becomes explicit JSON `null` only when another payload exists. */
const choiceContent = (content: unknown, toolCalls: readonly unknown[] | undefined): unknown => {
  if (content !== undefined && content !== null) return content;
  return toolCalls?.length ? null : "";
};

const normalizeChoiceMessage = (
  message: Record<string, unknown>,
  index: number
): NormalizationResult<Readonly<{ content: unknown; reasoning: string | null; refusal: string | null; toolCalls: Record<string, unknown>[] | undefined }>> => {
  if (message.role !== "assistant") {
    return { ok: false, message: `Upstream choice ${index} does not contain an assistant message.` };
  }
  if (!isAbsentOrString(message.content)) {
    return { ok: false, message: `Upstream choice ${index} has unsupported message content.` };
  }
  if (!isAbsentOrString(message.reasoning_content)) {
    return { ok: false, message: `Upstream choice ${index} has invalid reasoning content.` };
  }
  // A malformed non-string refusal invalidates the message; an absent or null
  // one stays absent.
  const refusal = normalizeRefusal(message.refusal, `Upstream choice ${index}`);
  if (!refusal.ok) return refusal;
  const toolCallsResult = normalizeToolCalls(message.tool_calls, `Upstream choice ${index}`, normalizeToolCall);
  if (!toolCallsResult.ok) return toolCallsResult;
  const toolCalls = toolCallsResult.value;
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : null;
  // A refusal-only message is an answer, not an empty one: the continuation
  // eligibility guard reads the same normalized value.
  if (choiceHasNoPayload(message.content, message.reasoning_content, refusal.value, toolCalls)) {
    return { ok: false, message: `Upstream choice ${index} has neither content nor a tool call.` };
  }
  return { ok: true, value: { content: message.content, reasoning, refusal: refusal.value, toolCalls } };
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
  const normalizedMessagePart = normalizeChoiceMessage(value.message, index);
  if (!normalizedMessagePart.ok) return normalizedMessagePart;
  const { content, reasoning, refusal, toolCalls } = normalizedMessagePart.value;

  const finishReason = value.finish_reason;
  if (!isAbsentOrString(finishReason)) {
    return { ok: false, message: `Upstream choice ${index} has an invalid finish reason.` };
  }
  const normalizedMessage: Record<string, unknown> = { role: "assistant", content: choiceContent(content, toolCalls) };
  // DeepSeek thinking mode returns the chain of thought beside `content`.
  // Relay it 1:1 rather than dropping or logging it.
  if (reasoning !== null) normalizedMessage.reasoning_content = reasoning;
  // A refusal is answer-bearing output on this route's own Chat contract, so it
  // travels beside `content` exactly as the upstream sent it. Preserving it is
  // also what keeps the continuation decision from reading an explicit refusal
  // as an ordinary progress stop.
  if (refusal !== null) normalizedMessage.refusal = refusal;
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
 * Reduces a DeepSeek buffered success payload to the OpenAI Chat Completions
 * shape the Assistant consumes. Unknown provider fields, including the
 * `system_fingerprint` and usage breakdowns, are not relayed or logged.
 */
export const normalizeDeepSeekChatCompletion = (value: unknown, requestedModel: string): NormalizationResult<Record<string, unknown>> => {
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
  if (!acceptUpstreamModel(value.model)) {
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
      // The client asked for one of the interchangeable official ids; echo that
      // id rather than the canonical upstream name.
      model: requestedModel,
      choices,
      ...(usage.value ? { usage: usage.value } : {}),
    },
  };
};

/** Normalizes the `delta` object of one streaming chunk choice. */
const normalizeChunkDelta = (value: unknown, label: string): NormalizationResult<Record<string, unknown>> => {
  if (!isRecord(value) || Array.isArray(value)) return { ok: false, message: `${label} has an invalid delta.` };
  const normalizedDelta: Record<string, unknown> = {};
  const role = optionalField(value.role, (input) => (typeof input === "string" ? input : null), `${label} has an invalid delta role.`);
  if (!role.ok) return role;
  if (role.value !== undefined) normalizedDelta.role = role.value;
  for (const field of ["content", "reasoning_content", "refusal"] as const) {
    const text = optionalField(value[field], (input) => (typeof input === "string" ? input : null), `${label} has invalid ${field}.`);
    if (!text.ok) return text;
    if (text.value !== undefined) normalizedDelta[field] = text.value;
  }
  const refusal = normalizeRefusal(value.refusal, label);
  if (!refusal.ok) return refusal;
  if (refusal.value !== null) normalizedDelta.refusal = refusal.value;
  const toolCalls = normalizeToolCalls(value.tool_calls, label, normalizeToolCallDelta);
  if (!toolCalls.ok) return toolCalls;
  if (toolCalls.value?.length) normalizedDelta.tool_calls = toolCalls.value;
  return { ok: true, value: normalizedDelta };
};

const normalizeChoiceDelta = (value: unknown, index: number): NormalizationResult<Record<string, unknown>> => {
  const label = `Upstream chunk choice ${index}`;
  if (!isRecord(value) || Array.isArray(value)) return { ok: false, message: `${label} is not an object.` };
  const choiceIndex = nonNegativeInteger(value.index);
  if (choiceIndex === null) return { ok: false, message: `${label} has an invalid index.` };
  const finishReason = value.finish_reason;
  if (!isAbsentOrString(finishReason)) return { ok: false, message: `${label} has an invalid finish reason.` };
  const normalizedChoice: Record<string, unknown> = { index: choiceIndex };
  const delta = optionalField(value.delta, (input) => input, `${label} has an invalid delta.`);
  if (!delta.ok) return delta;
  if (delta.value !== undefined) {
    const normalizedDelta = normalizeChunkDelta(delta.value, label);
    if (!normalizedDelta.ok) return normalizedDelta;
    normalizedChoice.delta = normalizedDelta.value;
  }
  if (finishReason !== undefined) normalizedChoice.finish_reason = finishReason;
  return { ok: true, value: normalizedChoice };
};

/**
 * Reduces one DeepSeek streaming chunk to the OpenAI `chat.completion.chunk`
 * shape. Chunks are relayed as they arrive, so this validates the frame rather
 * than buffering it.
 */
export const normalizeDeepSeekChatCompletionChunk = (value: unknown, requestedModel: string): NormalizationResult<Record<string, unknown>> => {
  if (!isRecord(value) || Array.isArray(value)) {
    return { ok: false, message: "Upstream did not return a Chat Completions chunk." };
  }
  const id = nonEmptyString(value.id);
  if (!id) return { ok: false, message: "Upstream Chat Completion chunk is missing an id." };
  const created = nonNegativeInteger(value.created);
  if (created === null) return { ok: false, message: "Upstream Chat Completion chunk has an invalid creation time." };
  if (value.object !== undefined && value.object !== "chat.completion.chunk") {
    return { ok: false, message: "Upstream did not return a Chat Completion chunk." };
  }
  if (!acceptUpstreamModel(value.model)) {
    return { ok: false, message: "Upstream returned a different model than requested." };
  }
  if (!Array.isArray(value.choices)) {
    return { ok: false, message: "Upstream Chat Completion chunk has no choices array." };
  }
  const choices: Record<string, unknown>[] = [];
  for (const [index, choice] of value.choices.entries()) {
    const normalized = normalizeChoiceDelta(choice, index);
    if (!normalized.ok) return normalized;
    choices.push(normalized.value);
  }
  const usage = normalizeUsage(value.usage);
  if (!usage.ok) return usage;
  return {
    ok: true,
    value: {
      id,
      object: "chat.completion.chunk",
      created,
      model: requestedModel,
      choices,
      ...(usage.value ? { usage: usage.value } : {}),
    },
  };
};

// Stage 0 terminal-event parsing and validation, split out of scripts/stage0-cache-telemetry-gate.ts.

import {
  ACTIVE_TRANSITION_REASONS,
  ACTIVE_TRANSITION_REASON_VALUES,
  type ActiveTransitionReason,
  GIT_SHA_PATTERN,
  INFERENCE_PROVIDERS,
  INFO_TERMINAL_LINE_PREFIX,
  type InferenceProvider,
  type InferenceTerminalOutcome,
  MAX_MODEL_LABEL_CHARS,
  MAX_RELEASE_IDENTIFIER_CHARS,
  MAX_REQUEST_ID_CHARS,
  PROMPT_CACHE_MODES,
  type PromptCacheMode,
  type ReleaseIdentity,
  SAFE_IDENTIFIER_PATTERN,
  SHA256_HEX_PATTERN,
  STREAM_TERMINAL_TYPES,
  Stage0CacheTelemetryGateError,
  type StreamTerminalType,
  TERMINAL_LINE_PREFIX,
  TERMINAL_MARKER,
  TERMINAL_ROUTES,
  type TerminalEvent,
  type TerminalRoute,
  USAGE_TELEMETRY_STATUSES,
  type UsageTelemetryStatus,
} from "./stage0-cache-telemetry-types.ts";

const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const fail = (lineNumber: number, detail: string): never => {
  throw new Stage0CacheTelemetryGateError(`line ${lineNumber}: ${detail}`);
};

const requireNonEmptyString = (record: Record<string, unknown>, key: string, lineNumber: number): string => {
  const value = record[key];
  if (!hasOwn(record, key) || typeof value !== "string" || value.trim().length === 0) {
    return fail(lineNumber, `terminal event has an invalid ${key} field`);
  }
  return value;
};

const hasAsciiControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const requireBoundedIdentifier = (record: Record<string, unknown>, key: string, maxLength: number, lineNumber: number): string => {
  const value = requireNonEmptyString(record, key, lineNumber);
  if (value.length > maxLength || hasAsciiControlCharacter(value) || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    return fail(lineNumber, `terminal event has an invalid ${key} field`);
  }
  return value;
};

const requireRequestId = (record: Record<string, unknown>, lineNumber: number): string =>
  requireBoundedIdentifier(record, "request_id", MAX_REQUEST_ID_CHARS, lineNumber);

const requireReleaseString = (record: Record<string, unknown>, key: string, lineNumber: number): string => {
  const value = requireBoundedIdentifier(record, key, MAX_RELEASE_IDENTIFIER_CHARS, lineNumber);
  if (value.trim().toLowerCase() === "unknown") {
    return fail(lineNumber, "terminal event has a missing release identity");
  }
  return value;
};

const requireGitSha = (record: Record<string, unknown>, lineNumber: number): string => {
  const gitSha = requireReleaseString(record, "git_sha", lineNumber);
  if (!GIT_SHA_PATTERN.test(gitSha)) {
    return fail(lineNumber, "terminal event has an invalid git_sha field");
  }
  return gitSha;
};

const requireNullableString = (record: Record<string, unknown>, key: string, lineNumber: number): string | null => {
  if (!hasOwn(record, key)) return fail(lineNumber, `terminal event has an invalid ${key} field`);
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail(lineNumber, `terminal event has an invalid ${key} field`);
  }
  return value;
};

const requireNullableReleaseString = (record: Record<string, unknown>, key: string, lineNumber: number): string | null => {
  if (!hasOwn(record, key)) return fail(lineNumber, `terminal event has an invalid ${key} field`);
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string") return fail(lineNumber, `terminal event has an invalid ${key} field`);
  const bounded = requireBoundedIdentifier(record, key, MAX_RELEASE_IDENTIFIER_CHARS, lineNumber);
  if (bounded.toLowerCase() === "unknown") {
    return fail(lineNumber, "terminal event has a missing release identity");
  }
  return bounded;
};

const requireInferenceProvider = (record: Record<string, unknown>, lineNumber: number): InferenceProvider => {
  const provider = requireNonEmptyString(record, "provider", lineNumber);
  if (!INFERENCE_PROVIDERS.has(provider as InferenceProvider)) {
    return fail(lineNumber, "inference terminal event has an unsupported provider field");
  }
  return provider as InferenceProvider;
};

const optionalInferenceProvider = (record: Record<string, unknown>): string | null => {
  const provider = record.provider;
  if (typeof provider !== "string" || provider.trim().length === 0) return null;
  return INFERENCE_PROVIDERS.has(provider as InferenceProvider) ? provider : null;
};

const requireBoundedModelLabel = (record: Record<string, unknown>, lineNumber: number): string => {
  const model = requireNonEmptyString(record, "model", lineNumber);
  if (model.length > MAX_MODEL_LABEL_CHARS || hasAsciiControlCharacter(model)) {
    return fail(lineNumber, "inference terminal event has an invalid model field");
  }
  return model;
};

const optionalBoundedModelLabel = (record: Record<string, unknown>): string | null => {
  const model = record.model;
  if (typeof model !== "string" || model.trim().length === 0) return null;
  if (model.length > MAX_MODEL_LABEL_CHARS || hasAsciiControlCharacter(model)) return null;
  return model;
};

const requireTerminalRoute = (record: Record<string, unknown>, lineNumber: number): TerminalRoute => {
  const route = requireNonEmptyString(record, "route", lineNumber);
  if (!TERMINAL_ROUTES.has(route as TerminalRoute)) {
    return fail(lineNumber, "terminal event has an unsupported route field");
  }
  return route as TerminalRoute;
};

const requireStreamTerminalType = (record: Record<string, unknown>, lineNumber: number): StreamTerminalType | null => {
  const terminalType = requireNullableString(record, "stream_terminal_type", lineNumber);
  if (terminalType !== null && !STREAM_TERMINAL_TYPES.has(terminalType as StreamTerminalType)) {
    return fail(lineNumber, "terminal event has an unsupported stream_terminal_type field");
  }
  return terminalType as StreamTerminalType | null;
};

const requireStatus = (record: Record<string, unknown>, lineNumber: number): number => {
  const value = record.status;
  if (!hasOwn(record, "status") || typeof value !== "number" || !Number.isSafeInteger(value) || value < 100 || value > 599) {
    return fail(lineNumber, "terminal event has an invalid status field");
  }
  return value;
};

const optionalNonNegativeSafeInteger = (record: Record<string, unknown>, key: string, lineNumber: number): number | null => {
  if (!hasOwn(record, key) || record[key] === null) return null;
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(lineNumber, `terminal event has an invalid ${key} field`);
  }
  return value;
};

const requireCacheToken = (record: Record<string, unknown>, key: string, lineNumber: number): number | null => {
  if (!hasOwn(record, key)) return fail(lineNumber, `terminal event has an invalid ${key} field`);
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(lineNumber, `terminal event has an invalid ${key} field`);
  }
  return value;
};

const requireUsageTelemetryStatus = (record: Record<string, unknown>, lineNumber: number): UsageTelemetryStatus => {
  const value = record.usage_telemetry_status;
  if (!hasOwn(record, "usage_telemetry_status") || typeof value !== "string" || !USAGE_TELEMETRY_STATUSES.has(value as UsageTelemetryStatus)) {
    return fail(lineNumber, "terminal event has an invalid usage_telemetry_status field");
  }
  return value as UsageTelemetryStatus;
};

const requireUsageObserved = (record: Record<string, unknown>, lineNumber: number): boolean => {
  const value = record.usage_observed;
  if (!hasOwn(record, "usage_observed") || typeof value !== "boolean") {
    return fail(lineNumber, "terminal event has an invalid usage_observed field");
  }
  return value;
};

const requireBoolean = (record: Record<string, unknown>, key: string, lineNumber: number): boolean => {
  const value = record[key];
  if (!hasOwn(record, key) || typeof value !== "boolean") {
    return fail(lineNumber, `terminal event has an invalid ${key} field`);
  }
  return value;
};

const requirePromptCacheMode = (record: Record<string, unknown>, lineNumber: number): PromptCacheMode => {
  const mode = requireNonEmptyString(record, "prompt_cache_mode", lineNumber);
  if (!PROMPT_CACHE_MODES.has(mode as PromptCacheMode)) {
    return fail(lineNumber, "terminal event has an invalid prompt_cache_mode field");
  }
  return mode as PromptCacheMode;
};

const requireAccountSlot = (record: Record<string, unknown>, lineNumber: number): number | null => {
  if (!hasOwn(record, "account_slot")) return fail(lineNumber, "terminal event has an invalid account_slot field");
  const slot = record.account_slot;
  if (slot === null) return null;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) {
    return fail(lineNumber, "terminal event has an invalid account_slot field");
  }
  return slot;
};

const optionalAccountCohortId = (record: Record<string, unknown>, lineNumber: number): string | null => {
  if (!hasOwn(record, "account_cohort_id") || record.account_cohort_id === null) return null;
  if (typeof record.account_cohort_id !== "string" || !SHA256_HEX_PATTERN.test(record.account_cohort_id)) {
    return fail(lineNumber, "terminal event has an invalid account_cohort_id field");
  }
  return record.account_cohort_id;
};

const requireActiveGeneration = (record: Record<string, unknown>, lineNumber: number): number | null => {
  if (!hasOwn(record, "active_generation")) return fail(lineNumber, "terminal event has an invalid active_generation field");
  const value = record.active_generation;
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  return fail(lineNumber, "terminal event has an invalid active_generation field");
};

const requireActiveTransitionReason = (record: Record<string, unknown>, lineNumber: number): ActiveTransitionReason => {
  if (!hasOwn(record, "active_transition_reason")) return fail(lineNumber, "terminal event has an invalid active_transition_reason field");
  const value = record.active_transition_reason;
  if (value === null) return null;
  if (typeof value === "string" && ACTIVE_TRANSITION_REASONS.has(value as (typeof ACTIVE_TRANSITION_REASON_VALUES)[number])) {
    return value as ActiveTransitionReason;
  }
  return fail(lineNumber, "terminal event has an invalid active_transition_reason field");
};

const requireNullableBoolean = (record: Record<string, unknown>, key: string, lineNumber: number): boolean | null => {
  if (!hasOwn(record, key)) return fail(lineNumber, `terminal event has an invalid ${key} field`);
  const value = record[key];
  if (value === null || typeof value === "boolean") return value;
  return fail(lineNumber, `terminal event has an invalid ${key} field`);
};

const inferenceOutcomeFor = (route: TerminalRoute, streamTerminalType: StreamTerminalType | null): InferenceTerminalOutcome | null => {
  if (route !== "responses" && route !== "chat.completions") return null;
  if (streamTerminalType === "response.completed") return "completed";
  if (streamTerminalType === "response.incomplete") return "incomplete";
  if (streamTerminalType === "cancelled") return "cancelled";
  if (streamTerminalType === "response.failed" || streamTerminalType === "error" || streamTerminalType === "eof" || streamTerminalType === "deadline")
    return "failed";
  return null;
};

/**
 * Provider field for one terminal event: a completed inference must carry a
 * supported provider, a non-inference terminal event carries none, and every
 * other terminal type accepts the optional form.
 */
const inferenceProviderFor = (outcome: InferenceTerminalOutcome | null, record: Record<string, unknown>, lineNumber: number): string | null => {
  if (outcome === "completed") return requireInferenceProvider(record, lineNumber);
  if (outcome === null) return null;
  return optionalInferenceProvider(record);
};

/** Model field for one terminal event; same three-way rule as the provider. */
const inferenceModelFor = (outcome: InferenceTerminalOutcome | null, record: Record<string, unknown>, lineNumber: number): string | null => {
  if (outcome === "completed") return requireBoundedModelLabel(record, lineNumber);
  if (outcome === null) return null;
  return optionalBoundedModelLabel(record);
};

const terminalPayloadFromText = (text: string, lineNumber: number): string | null => {
  const trimmed = text.trim();
  if (!trimmed.includes(TERMINAL_MARKER)) return null;
  // The bare console message and its exact `INFO ` export form are the only
  // raw line shapes this analyzer consumes. Anchoring the marker prevents
  // prompt or other user text embedded in an unrelated log line from
  // impersonating a terminal event. Structured exports must put one of these
  // exact console bodies in their `body` field below.
  const acceptedPrefixes: readonly string[] = [TERMINAL_LINE_PREFIX, INFO_TERMINAL_LINE_PREFIX];
  const prefix = acceptedPrefixes.find((candidate) => trimmed.startsWith(candidate)) ?? null;
  if (prefix === null) {
    return fail(lineNumber, "request_terminal log text must begin with the canonical terminal marker");
  }
  const json = trimmed.slice(prefix.length).trim();
  if (json.length === 0) return fail(lineNumber, "request_terminal event has no JSON payload");
  return json;
};

const terminalPayloadFromLine = (line: string, lineNumber: number): string | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return terminalPayloadFromText(line, lineNumber);

  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    if (line.includes(TERMINAL_MARKER)) {
      return fail(lineNumber, "request_terminal JSON envelope has malformed JSON");
    }
    return null;
  }
  if (!isRecord(envelope) || !hasOwn(envelope, "body")) {
    if (line.includes(TERMINAL_MARKER)) {
      return fail(lineNumber, "request_terminal event must use raw log text or a string body envelope");
    }
    return null;
  }
  if (typeof envelope.body !== "string") {
    if (line.includes(TERMINAL_MARKER)) {
      return fail(lineNumber, "request_terminal JSON envelope has an invalid body field");
    }
    return null;
  }
  return terminalPayloadFromText(envelope.body, lineNumber);
};

const parseTerminalEvent = (line: string, lineNumber: number): TerminalEvent | null => {
  const json = terminalPayloadFromLine(line, lineNumber);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail(lineNumber, "request_terminal event has malformed JSON");
  }
  if (!isRecord(parsed)) return fail(lineNumber, "request_terminal event must be a JSON object");

  const requestId = requireRequestId(parsed, lineNumber);
  const route = requireTerminalRoute(parsed, lineNumber);
  const streamTerminalType = requireStreamTerminalType(parsed, lineNumber);
  const status = requireStatus(parsed, lineNumber);
  const latencyMs = optionalNonNegativeSafeInteger(parsed, "latency_ms", lineNumber);
  const usageTelemetryStatus = requireUsageTelemetryStatus(parsed, lineNumber);
  const usageObserved = requireUsageObserved(parsed, lineNumber);
  const inputTokens = requireCacheToken(parsed, "input_tokens", lineNumber);
  const cachedInputTokens = requireCacheToken(parsed, "cached_input_tokens", lineNumber);
  const cacheWriteInputTokens = requireCacheToken(parsed, "cache_write_input_tokens", lineNumber);
  const promptCacheKeyPresent = requireBoolean(parsed, "prompt_cache_key_present", lineNumber);
  const promptCacheMode = requirePromptCacheMode(parsed, lineNumber);
  const accountSlot = requireAccountSlot(parsed, lineNumber);
  const accountCohortId = optionalAccountCohortId(parsed, lineNumber);
  const activeGeneration = requireActiveGeneration(parsed, lineNumber);
  const activeTransitionReason = requireActiveTransitionReason(parsed, lineNumber);
  const stream = requireNullableBoolean(parsed, "stream", lineNumber);
  const release: ReleaseIdentity = {
    git_sha: requireGitSha(parsed, lineNumber),
    deno_revision: requireReleaseString(parsed, "deno_revision", lineNumber),
    router_revision: requireNullableReleaseString(parsed, "router_revision", lineNumber),
  };

  const inferenceOutcome = inferenceOutcomeFor(route, streamTerminalType);
  if (inferenceOutcome === "completed" && (status < 200 || status >= 300)) {
    return fail(lineNumber, "completed inference event has a non-2xx status field");
  }
  const provider: string | null = inferenceProviderFor(inferenceOutcome, parsed, lineNumber);
  const model: string | null = inferenceModelFor(inferenceOutcome, parsed, lineNumber);
  if (usageObserved !== (usageTelemetryStatus !== "missing")) {
    return fail(lineNumber, "terminal event has inconsistent usage_observed and usage_telemetry_status fields");
  }
  if (inferenceOutcome !== null && usageTelemetryStatus === "reported" && (inputTokens === null || cachedInputTokens === null)) {
    return fail(lineNumber, "reported inference terminal event is missing cache-read usage fields");
  }

  return {
    request_id: requestId,
    route,
    status,
    latency_ms: latencyMs,
    stream_terminal_type: streamTerminalType,
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_write_input_tokens: cacheWriteInputTokens,
    usage_observed: usageObserved,
    usage_telemetry_status: usageTelemetryStatus,
    prompt_cache_key_present: promptCacheKeyPresent,
    prompt_cache_mode: promptCacheMode,
    account_slot: accountSlot,
    account_cohort_id: accountCohortId,
    active_generation: activeGeneration,
    active_transition_reason: activeTransitionReason,
    stream,
    release,
    inference_outcome: inferenceOutcome,
    provider,
    model,
  };
};

export { fail, parseTerminalEvent };

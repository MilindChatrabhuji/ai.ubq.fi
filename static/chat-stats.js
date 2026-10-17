const getNonNegativeInteger = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const getNonNegativeNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export const readChatCompletionMessageText = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const message = choices[0]?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;

  const content = typeof message.content === "string" ? message.content : "";
  if (content.trim().length > 0) return content;
  const refusal = typeof message.refusal === "string" ? message.refusal : "";
  return refusal.trim().length > 0 ? refusal : null;
};

export const readChatCompletionUsage = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const inputTokens = getNonNegativeInteger(value.prompt_tokens);
  const outputTokens = getNonNegativeInteger(value.completion_tokens);
  if (inputTokens === null || outputTokens === null) return null;

  const details = value.prompt_tokens_details;
  const promptTokenDetails = details && typeof details === "object" && !Array.isArray(details) ? details : null;
  const cachedInputTokens =
    promptTokenDetails && "cached_tokens" in promptTokenDetails
      ? getNonNegativeInteger(promptTokenDetails.cached_tokens)
      : null;
  const cacheWriteInputTokens =
    promptTokenDetails && "cache_write_tokens" in promptTokenDetails
      ? getNonNegativeInteger(promptTokenDetails.cache_write_tokens)
      : null;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cachedInputTokens !== null && cachedInputTokens <= inputTokens ? cachedInputTokens : null,
    cacheWriteInputTokens,
  };
};

export const readChatCompletionDecodeTokens = (value, reasoningEffort) => {
  const usage = readChatCompletionUsage(value);
  if (!usage) return null;

  const details = value.completion_tokens_details;
  if (details && typeof details === "object" && !Array.isArray(details) && "reasoning_tokens" in details) {
    const reasoningTokens = getNonNegativeInteger(details.reasoning_tokens);
    if (reasoningTokens === null || reasoningTokens > usage.outputTokens) return null;
    return usage.outputTokens - reasoningTokens;
  }

  const effort = typeof reasoningEffort === "string" ? reasoningEffort.trim().toLowerCase() : "";
  return effort === "none" ? usage.outputTokens : null;
};

const EMPTY_CHAT_STATS = Object.freeze({
  turns: 0,
  steps: 0,
  llmMsTotal: 0,
  llmSamples: 0,
  toolMsTotal: 0,
  toolSamples: 0,
  ttftMsTotal: 0,
  ttftSamples: 0,
  throughputOutputTokens: 0,
  throughputDecodeMs: 0,
  throughputSamples: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  usageSamples: 0,
  cacheSamples: 0,
});

export const resetChatStatsAccumulator = (stats = {}) => Object.assign(stats, EMPTY_CHAT_STATS);

export const createChatStatsAccumulator = () => resetChatStatsAccumulator({});

export const recordCompletedChatResponse = (stats, sample = {}) => {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return false;

  const llmMs = getNonNegativeNumber(sample.llmMs);
  if (llmMs === null) return false;

  stats.turns += 1;
  stats.steps += 1;
  stats.llmMsTotal += llmMs;
  stats.llmSamples += 1;

  const toolMs = getNonNegativeNumber(sample.toolMs);
  if (toolMs !== null) {
    stats.toolMsTotal += toolMs;
    stats.toolSamples += 1;
  }

  const ttftMs = getNonNegativeNumber(sample.ttftMs);
  if (ttftMs !== null) {
    stats.ttftMsTotal += ttftMs;
    stats.ttftSamples += 1;
  }

  const usage = readChatCompletionUsage(sample.usage);
  if (!usage) return true;

  stats.inputTokens += usage.inputTokens;
  stats.outputTokens += usage.outputTokens;
  stats.usageSamples += 1;
  const decodeMs = getNonNegativeNumber(sample.decodeMs);
  const decodeTokens = getNonNegativeInteger(sample.decodeTokens);
  if (decodeMs !== null && decodeMs > 0 && decodeTokens !== null && decodeTokens <= usage.outputTokens) {
    stats.throughputOutputTokens += decodeTokens;
    stats.throughputDecodeMs += decodeMs;
    stats.throughputSamples += 1;
  }
  if (usage.cachedInputTokens !== null) {
    stats.cachedInputTokens += usage.cachedInputTokens;
    stats.cacheSamples += 1;
  }
  return true;
};

export const formatChatTokens = (tokens) => {
  const value = getNonNegativeInteger(tokens);
  if (value === null) return null;
  const scaled = (number) => (number >= 100 ? String(Math.round(number)) : String(Math.round(number * 10) / 10));
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
};

export const formatChatDuration = (milliseconds) => {
  const value = getNonNegativeNumber(milliseconds);
  if (value === null) return null;
  const seconds = value / 1_000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const wholeSeconds = Math.round(seconds);
  return `${Math.floor(wholeSeconds / 60)}m${wholeSeconds % 60}s`;
};

const formatTokensPerSecond = (tokensPerSecond) => {
  const value = getNonNegativeNumber(tokensPerSecond);
  if (value === null) return null;
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
};

const roundedIntegerPercent = (cacheReadTokens, denominator) => {
  const denominatorQuotient = Math.floor(denominator / 200);
  const denominatorRemainder = denominator % 200;
  let lower = 0;
  let upper = 100;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / 200)) {
      lower = candidate;
    } else {
      upper = candidate - 1;
    }
  }
  return lower;
};

export const formatCacheHitPercent = (cacheReadTokens, inputTokens) => {
  const cached = getNonNegativeInteger(cacheReadTokens);
  const input = getNonNegativeInteger(inputTokens);
  if (cached === null || input === null || input === 0 || cached > input) return null;
  if (cached === input) return "100";

  const integerPercent = roundedIntegerPercent(cached, input);
  if (integerPercent < 100) return String(integerPercent);

  const missedInputTokens = input - cached;
  let decimalPlaces = 1;
  let scaledDoubleGap = missedInputTokens * 200;
  const denominatorTens = Math.floor(input / 10);
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10;
    decimalPlaces += 1;
  }

  const denominatorOnes = input % 10;
  let roundedLoss = 5;
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10);
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss;
      break;
    }
  }
  return `99.${"9".repeat(decimalPlaces - 1)}${10 - roundedLoss}`;
};

const formatAverageDuration = (total, samples) => {
  const totalValue = getNonNegativeNumber(total);
  const sampleCount = getNonNegativeInteger(samples);
  if (totalValue === null || sampleCount === null || sampleCount === 0) return null;
  return formatChatDuration(totalValue / sampleCount);
};

export const formatChatStatsLine = (stats = {}) => {
  const groups = [];
  const turns = getNonNegativeInteger(stats.turns);
  const steps = getNonNegativeInteger(stats.steps);
  if (turns === null || steps === null || turns === 0) return "";
  if (steps > 0) groups.push(`${turns} turns · ${steps} steps`);

  const durations = [];
  const llmDuration = formatAverageDuration(stats.llmMsTotal, stats.llmSamples);
  if (llmDuration !== null) durations.push(`LLM avg ${llmDuration}`);
  const toolDuration = formatAverageDuration(stats.toolMsTotal, stats.toolSamples);
  if (toolDuration !== null) durations.push(`Tool call avg ${toolDuration}`);
  if (durations.length > 0) groups.push(durations.join(" · "));

  const speeds = [];
  const ttftDuration = formatAverageDuration(stats.ttftMsTotal, stats.ttftSamples);
  if (ttftDuration !== null) speeds.push(`TTFT avg ${ttftDuration}`);
  const throughputMs = getNonNegativeNumber(stats.throughputDecodeMs);
  const throughputTokens = getNonNegativeInteger(stats.throughputOutputTokens);
  const throughputSamples = getNonNegativeInteger(stats.throughputSamples);
  const usageSamples = getNonNegativeInteger(stats.usageSamples);
  const hasCompleteUsage = usageSamples !== null && usageSamples === turns;
  if (
    hasCompleteUsage &&
    throughputSamples === turns &&
    throughputTokens !== null &&
    throughputMs !== null &&
    throughputMs > 0
  ) {
    const throughput = formatTokensPerSecond(throughputTokens / (throughputMs / 1_000));
    if (throughput !== null) speeds.push(`${throughput} tok/s`);
  }
  if (speeds.length > 0) groups.push(speeds.join(" · "));

  const cacheSamples = getNonNegativeInteger(stats.cacheSamples);
  const inputTokens = getNonNegativeInteger(stats.inputTokens);
  const outputTokens = getNonNegativeInteger(stats.outputTokens);
  const cachedInputTokens = getNonNegativeInteger(stats.cachedInputTokens);
  if (hasCompleteUsage && inputTokens !== null && outputTokens !== null) {
    const cacheHit = cacheSamples === usageSamples ? formatCacheHitPercent(cachedInputTokens, inputTokens) : null;
    if (cacheHit !== null) groups.push(`Cache hit ${cacheHit}%`);
    const input = formatChatTokens(inputTokens);
    const output = formatChatTokens(outputTokens);
    if (input !== null && output !== null) groups.push(`Input ${input} tok · Output ${output} tok`);
  }

  return groups.join(" | ");
};

export const renderChatStats = (element, stats) => {
  const line = formatChatStatsLine(stats);
  element.textContent = line;
  element.title = line;
  element.hidden = !line;
  return line;
};

export const splitChatSseEvents = (buffer, flush = false) => {
  let remaining = typeof buffer === "string" ? buffer : "";
  const events = [];

  for (;;) {
    const boundary = remaining.match(/(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/);
    if (!boundary || boundary.index === undefined) break;
    events.push(remaining.slice(0, boundary.index));
    remaining = remaining.slice(boundary.index + boundary[0].length);
  }

  if (flush && remaining.trim()) {
    events.push(remaining);
    remaining = "";
  }

  return { events, remaining };
};

export const parseChatCompletionStreamEvent = (dataText) => {
  const trimmed = typeof dataText === "string" ? dataText.trim() : "";
  if (!trimmed) return { kind: "empty" };
  if (trimmed === "[DONE]") return { kind: "done" };

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return { kind: "invalid" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "invalid" };

  const error = payload.error;
  if (error !== undefined && error !== null) {
    if (typeof error !== "object" || Array.isArray(error)) return { kind: "invalid" };
    const message =
      typeof error.message === "string" && error.message.trim() ? error.message.trim() : "The response stream failed.";
    return { kind: "error", message };
  }

  if (!Array.isArray(payload.choices)) return { kind: "invalid" };
  if (payload.usage !== undefined && payload.usage !== null) {
    if (
      typeof payload.usage !== "object" ||
      Array.isArray(payload.usage) ||
      readChatCompletionUsage(payload.usage) === null
    ) {
      return { kind: "invalid" };
    }
  }
  if (payload.choices.length === 0) {
    return payload.usage && typeof payload.usage === "object"
      ? { kind: "event", delta: "", usage: payload.usage }
      : { kind: "invalid" };
  }

  const choice = payload.choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return { kind: "invalid" };
  const delta = choice.delta;
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return { kind: "invalid" };
  if (delta.content !== undefined && delta.content !== null && typeof delta.content !== "string") {
    return { kind: "invalid" };
  }
  if (delta.refusal !== undefined && delta.refusal !== null && typeof delta.refusal !== "string") {
    return { kind: "invalid" };
  }

  const content = typeof delta.content === "string" ? delta.content : "";
  const refusal = typeof delta.refusal === "string" ? delta.refusal : "";
  return {
    kind: "event",
    delta: `${content}${refusal}`,
    usage: payload.usage,
  };
};

export const parseChatSseEvent = (rawEvent) => {
  const dataText = (typeof rawEvent === "string" ? rawEvent : "")
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  return parseChatCompletionStreamEvent(dataText);
};

export const createChatMessageElement = (documentRef, role, text) => {
  const message = documentRef.createElement("div");
  message.dataset.message = role;
  const content = documentRef.createElement("div");
  content.dataset.messageContent = "";
  content.textContent = text;
  message.appendChild(content);
  return message;
};

export const setChatMessageContent = (message, text) => {
  const content = message.querySelector("[data-message-content]");
  if (!content) throw new Error("Chat message content is missing.");
  content.textContent = text;
};

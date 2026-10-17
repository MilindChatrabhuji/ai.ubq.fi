export const REASONING_NONE_VALUE = "none";

const REASONING_NONE_UNSUPPORTED_MODELS = new Set(["gpt-oss-120b"]);

export const modelSupportsReasoningNone = (modelId) => {
  const id = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  return !REASONING_NONE_UNSUPPORTED_MODELS.has(id);
};

// ---------------------------------------------------------------------------
// Disabled curated table (kept for the coverage comparison, not in use).
//
// The gateway now serves each model's advertised `supported_reasoning_levels`
// and `default_reasoning_effort` from `/uos/models/capabilities` and
// `/uos/models/catalog`, so every picker reads what a source actually
// published. `src/model_metadata.ts` resolves those values; an id no source
// describes reports no tiers instead of inheriting a rule below.
// ---------------------------------------------------------------------------
//
// Curated model-native reasoning controls for model classes released in the
// six months ending 2026-08-24. The rules intentionally match classes and
// aliases rather than individual provider IDs.
//
// Research sources:
// - OpenAI GPT-5.6: https://developers.openai.com/api/docs/models
// - Anthropic effort: https://platform.claude.com/docs/en/build-with-claude/effort
// - DeepSeek V4 + Qwen 3.8 provider behavior:
//   https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/
// - Z.AI GLM: https://docs.z.ai/guides/capabilities/thinking-mode
// - Gemini thinking: https://ai.google.dev/gemini-api/docs/thinking
// - xAI reasoning: https://docs.x.ai/developers/model-capabilities/text/reasoning
// const RECENT_MODEL_REASONING_RULES = [
//   {
//     modelClass: "gpt-5.6",
//     pattern: /(?:^|\/)gpt-5\.6(?:$|-)/i,
//     levels: ["none", "low", "medium", "high", "xhigh", "max"],
//     defaultLevel: "medium",
//   },
//   {
//     modelClass: "claude-5",
//     pattern: /(?:^|\/)claude-(?:opus|sonnet|fable|mythos)-5(?:$|-)/i,
//     levels: ["low", "medium", "high", "xhigh", "max"],
//     defaultLevel: "high",
//   },
//   {
//     modelClass: "claude-opus-4.8",
//     pattern: /(?:^|\/)claude-opus-4[.-]8(?:$|-)/i,
//     levels: ["low", "medium", "high", "xhigh", "max"],
//     defaultLevel: "high",
//   },
//   {
//     modelClass: "claude-opus-4.7",
//     pattern: /(?:^|\/)claude-opus-4[.-]7(?:$|-)/i,
//     levels: ["low", "medium", "high", "xhigh", "max"],
//     defaultLevel: "high",
//   },
//   {
//     modelClass: "deepseek-v4",
//     pattern: /(?:^|\/)deepseek-v4(?:$|-)/i,
//     levels: ["none", "low", "high", "max"],
//     defaultLevel: "high",
//   },
//   {
//     modelClass: "glm-5.3",
//     pattern: /(?:^|\/)glm-5\.3(?:$|-)/i,
//     levels: ["low", "high", "max"],
//     defaultLevel: "max",
//   },
//   {
//     modelClass: "glm-5.2",
//     pattern: /(?:^|\/)glm-5\.2(?:$|[-:])/i,
//     levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
//     defaultLevel: null,
//   },
//   {
//     modelClass: "glm-5.1-non-thinking",
//     pattern: /(?:^|\/)glm-5\.1-non-thinking(?:$|[-:])/i,
//     levels: ["none"],
//     defaultLevel: "none",
//   },
//   {
//     modelClass: "glm-5.1",
//     pattern: /(?:^|\/)glm-5\.1(?:$|-)/i,
//     levels: ["none", "thinking"],
//     defaultLevel: "thinking",
//   },
//   {
//     modelClass: "kimi-k3",
//     pattern: /(?:^|\/)kimi-k3(?:$|-)/i,
//     levels: ["low", "high", "max"],
//     defaultLevel: null,
//   },
//   {
//     modelClass: "gemini-3.7-flash",
//     pattern: /(?:^|\/)gemini-3\.7-flash(?:$|-)/i,
//     levels: ["low", "medium", "high"],
//     defaultLevel: "medium",
//   },
//   {
//     modelClass: "gemini-3.6-flash",
//     pattern: /(?:^|\/)gemini-3\.6-flash(?:$|-)/i,
//     levels: ["minimal", "low", "medium", "high"],
//     defaultLevel: null,
//   },
//   {
//     modelClass: "gemini-3.5-flash",
//     pattern: /(?:^|\/)gemini-3[.-]5-flash(?:$|-)/i,
//     levels: ["minimal", "low", "medium", "high"],
//     defaultLevel: null,
//   },
//   {
//     modelClass: "gemini-3.1-pro",
//     pattern: /(?:^|\/)gemini-3\.1-pro(?:$|-)/i,
//     levels: ["low", "medium", "high"],
//     defaultLevel: null,
//   },
//   {
//     modelClass: "grok-4.20-multi-agent",
//     pattern: /(?:^|\/)grok-4\.20-multi-agent(?:$|-)/i,
//     levels: ["low", "medium", "high", "xhigh"],
//     defaultLevel: null,
//   },
//   {
//     modelClass: "grok-4.20-non-reasoning",
//     pattern: /(?:^|\/)grok-4\.20[^/]*non-reasoning(?:$|-)/i,
//     levels: ["none"],
//     defaultLevel: "none",
//   },
//   {
//     modelClass: "grok-4.20-reasoning",
//     pattern: /(?:^|\/)grok-4\.20(?:$|-)/i,
//     levels: ["reasoning"],
//     defaultLevel: "reasoning",
//   },
//   {
//     modelClass: "grok-4.6",
//     pattern: /(?:^|\/)grok-4\.6(?:$|-)/i,
//     levels: ["low", "medium", "high", "xhigh"],
//     defaultLevel: "high",
//   },
//   {
//     modelClass: "grok-4.5",
//     pattern: /(?:^|\/)grok-4\.5(?:$|-)/i,
//     levels: ["low", "medium", "high"],
//     defaultLevel: "high",
//   },
//   {
//     modelClass: "grok-4.3",
//     pattern: /(?:^|\/)grok-4\.3(?:$|-)/i,
//     levels: ["none", "low", "medium", "high"],
//     defaultLevel: null,
//   },
//   {
//     modelClass: "qwen3.8-max",
//     pattern: /(?:^|\/)qwen-?3[.-]8-max(?:$|-)/i,
//     levels: ["none", "low", "medium", "high", "xhigh", "max"],
//     defaultLevel: null,
//   },
//   {
//     modelClass: "qwen3.8",
//     pattern: /(?:^|\/)qwen-?3[.-]8(?:$|-)/i,
//     levels: ["none", "thinking"],
//     defaultLevel: null,
//   },
//   {
//     modelClass: "minimax-m3",
//     pattern: /(?:^|\/)(?:minimax[-/])?m3(?:$|-)|(?:^|\/)minimax-m3(?:$|-)/i,
//     levels: ["none", "adaptive", "enabled"],
//     defaultLevel: "adaptive",
//   },
// ];

/**
 * Retained so an already-cached `admin.js` that still imports it keeps loading
 * through the release that removed the curated table above. It no longer
 * consults anything: the catalog endpoint serves the advertised tiers, and the
 * caller reads those. Safe to delete once no cached client can reference it.
 */
export const getRecentModelReasoning = () => null;

const getTrimmedString = (value) => (typeof value === "string" ? value.trim() : "");
const getReasoningEffortValue = (value) => (value === null ? REASONING_NONE_VALUE : getTrimmedString(value));

const getReasoningLevelValue = (level) => {
  if (level === null || typeof level === "string") return getReasoningEffortValue(level);
  if (level && typeof level === "object" && "effort" in level) {
    return getReasoningEffortValue(level.effort);
  }
  return "";
};

const isNoneReasoningValue = (value) => getTrimmedString(value) === REASONING_NONE_VALUE;
const getRawReasoningLevels = (model) =>
  Array.isArray(model?.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
const hasNoneReasoningLevel = (levels) =>
  Array.isArray(levels) && levels.some((level) => isNoneReasoningValue(getReasoningLevelValue(level)));

const uniqueReasoningLevels = (levels) => {
  const unique = [];
  const seen = new Set();
  levels.forEach((level) => {
    const value = getReasoningLevelValue(level);
    if (!value || isNoneReasoningValue(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    unique.push(value);
  });
  return unique;
};

export const getModelDefaultReasoning = (model) => {
  const defaultReasoningEffort = getReasoningEffortValue(model?.default_reasoning_effort);
  if (defaultReasoningEffort) return defaultReasoningEffort;
  return getReasoningEffortValue(model?.default_reasoning_level);
};

export const getModelReasoningLevels = (model) => {
  const rawLevels = getRawReasoningLevels(model);
  const levels = uniqueReasoningLevels(rawLevels);
  if (levels.length) return levels;

  const fallback = getModelDefaultReasoning(model);
  return fallback && !isNoneReasoningValue(fallback) ? [fallback] : [];
};

export const isReasoningNoneSelection = (value, noneValue = REASONING_NONE_VALUE) => {
  const trimmed = getTrimmedString(value);
  if (!trimmed) return false;
  return trimmed === noneValue || isNoneReasoningValue(trimmed);
};

const appendOption = (select, value, label, options = {}) => {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  if (options.disabled) option.disabled = true;
  select.appendChild(option);
  return option;
};

export const setReasoningPlaceholder = (select, label) => {
  select.textContent = "";
  appendOption(select, "", label, { disabled: true });
  select.disabled = true;
  return "";
};

export const setReasoningOptions = (select, levels, preferred, options = {}) => {
  const sourceLevels = Array.isArray(levels) ? levels : [];
  const noneValue = getTrimmedString(options.noneValue) || REASONING_NONE_VALUE;
  const includeDefault = options.includeDefault !== false;
  const includeNone =
    options.includeNone === undefined ? hasNoneReasoningLevel(sourceLevels) : options.includeNone === true;
  const defaultLabel = getTrimmedString(options.defaultLabel) || "Default";
  const noneLabel = getTrimmedString(options.noneLabel) || "None";
  const uniqueLevels = uniqueReasoningLevels(sourceLevels);

  select.textContent = "";
  const optionValues = [];

  if (includeDefault) {
    appendOption(select, "", defaultLabel);
    optionValues.push("");
  }

  if (includeNone) {
    appendOption(select, noneValue, noneLabel);
    optionValues.push(noneValue);
  }

  uniqueLevels.forEach((level) => {
    appendOption(select, level, level);
    optionValues.push(level);
  });

  select.disabled = false;

  const trimmedPreferred = getTrimmedString(preferred);
  const next =
    includeNone && isReasoningNoneSelection(trimmedPreferred, noneValue)
      ? noneValue
      : optionValues.includes(trimmedPreferred)
        ? trimmedPreferred
        : includeDefault
          ? ""
          : (optionValues[0] ?? "");
  select.value = next;
  return next;
};

export const updateReasoningSelectForModel = (select, model, preferred, options = {}) => {
  const noneValue = getTrimmedString(options.noneValue) || REASONING_NONE_VALUE;
  const rawLevels = getRawReasoningLevels(model);
  const levels = getModelReasoningLevels(model);
  const trimmedPreferred = getTrimmedString(preferred);
  const includeNone = options.includeNone !== false;
  const selectOptions = { ...options, includeNone };

  if (!includeNone && isReasoningNoneSelection(trimmedPreferred, noneValue)) {
    return setReasoningOptions(select, rawLevels.length ? rawLevels : levels, "", selectOptions);
  }

  if (includeNone && isReasoningNoneSelection(trimmedPreferred, noneValue)) {
    return setReasoningOptions(select, rawLevels, noneValue, selectOptions);
  }

  if (!trimmedPreferred) {
    return setReasoningOptions(select, rawLevels.length ? rawLevels : levels, "", selectOptions);
  }

  const defaultReasoning = getModelDefaultReasoning(model);
  const selected = levels.includes(trimmedPreferred)
    ? trimmedPreferred
    : levels.includes(defaultReasoning)
      ? defaultReasoning
      : options.includeDefault === false
        ? (levels[0] ?? (includeNone ? noneValue : ""))
        : "";
  return setReasoningOptions(select, rawLevels.length ? rawLevels : levels, selected, selectOptions);
};

export const getReasoningEffortForChatRequest = (selected) => {
  const value = getReasoningEffortValue(selected);
  if (!value) return undefined;
  return value;
};

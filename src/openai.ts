import { fetchCodexResponses, getCodexModelsSnapshotDefaultModel } from "./codex/index.ts";

import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from "./defaults.ts";
import { openaiError } from "./http.ts";
import { createInferenceSignal } from "./inference-deadline.ts";
import { loadRuntimeConfig } from "./runtime-config.ts";
import {} from "./models/metadata.ts";
import { CHAT_COMPLETIONS_REQUEST_KEYS, RESPONSES_REQUEST_KEYS } from "./openai-schema.ts";
import {} from "./paid-fallback/removed-provider.ts";
import {} from "./provider/removed-provider-circuit.ts";
import {} from "./provider/removed-provider-telemetry.ts";
import {} from "./paid-fallback/index.ts";
import type {} from "./sentinel/upstream-capture.ts";

import { type UsageContext } from "./openai-telemetry.ts";
import {} from "./input-normalization.ts";
import { isTemporaryFreeSurplusModel } from "./request-policy.ts";
export const temporaryFreeSurplusCapabilityError = (model: string, body: Record<string, unknown>): Response | null =>
  isTemporaryFreeSurplusModel(model) && Array.isArray(body.tools) && body.tools.length > 0
    ? openaiError(400, `The model '${model}' does not support tools through this gateway.`, "unsupported_model_capability", { param: "tools" })
    : null;

export const getDefaultModel = async (): Promise<string | null> => {
  const runtime = await loadRuntimeConfig();
  return runtime?.default_model ?? getCodexModelsSnapshotDefaultModel(runtime?.codex_models ?? null);
};

export const downstreamSignalFor = (request: Request, context?: UsageContext): AbortSignal => context?.downstreamSignal ?? request.signal;

export const inferenceSignal = (request: Request, context?: UsageContext): AbortSignal => createInferenceSignal(downstreamSignalFor(request, context));

/**
 * Internal test seam for exercising the public OpenAI handlers through the
 * same guarded banked-reset flow. It has no request-schema or runtime-config
 * surface, and remains unset in production.
 */
type CodexBankedResetOptionsForTest = NonNullable<Parameters<typeof fetchCodexResponses>[1]>["bankedReset"];
export let codexBankedResetOptionsForTest: CodexBankedResetOptionsForTest | null = null;

export const setCodexBankedResetOptionsForTest = (options: CodexBankedResetOptionsForTest | null): void => {
  codexBankedResetOptionsForTest = options;
};

export const defaultModelUnavailableError = (): Response =>
  openaiError(503, "Default model is unavailable: no configured default model or Codex model snapshot.", "server_error");

export const getDefaultReasoningEffort = async (): Promise<ReasoningEffort> => {
  return (await loadRuntimeConfig())?.default_reasoning_effort ?? DEFAULT_REASONING_EFFORT;
};
import {} from "./responses-attempts.ts";
export const CHAT_COMPLETIONS_ALLOWED_KEYS = new Set(CHAT_COMPLETIONS_REQUEST_KEYS);
export const RESPONSES_ALLOWED_KEYS = new Set(RESPONSES_REQUEST_KEYS);
export const CODEX_RESPONSES_EXTENSION_KEYS = new Set(["client_metadata"]);
/**
 * Fields a first-party DeepSeek client sends on the provider's own Chat
 * contract that the official OpenAI Chat schema does not define. Kept separate
 * from the OpenAI allowlist so the compatibility surface stays explicit and
 * cannot silently widen the OpenAI-compatible routes; see AGENTS.md's Codex CLI
 * compatibility rule for the same pattern.
 */
export const DEEPSEEK_CHAT_EXTENSION_KEYS = new Set(["thinking"]);

export const findUnknownKey = (record: Record<string, unknown>, allowed: ReadonlySet<string>, extensions?: ReadonlySet<string>): string | null => {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key) && !extensions?.has(key)) return key;
  }
  return null;
};

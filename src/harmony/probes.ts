/**
 * Harmony/Cerebras protocol probe manifest (plan m01).
 *
 * One bounded, staged, deterministic reproduction per protocol question:
 * reasoning return/replay, tool call/result shape, mixed strictness,
 * structured output with tools, reasoning efforts, parallel calls,
 * consecutive tool turns, and native Harmony versus generic calls.
 *
 * Every probe renders a sanitized record: request metadata (roles, tool
 * names, strictness values, flags) and response metadata (status, presence
 * and length of content/reasoning, tool-call shape, a short final-content
 * preview).  Prompts, private reasoning, tool argument values, API keys and
 * raw bodies never appear in results.  Full normalized responses stay in
 * memory only (via {@link ProbeTurnRun}) and are never serialized.
 *
 * Live runs reuse the existing `CEREBRAS_API_KEY`; deterministic tests drive
 * the same manifest through fake transports.
 */

import { buildCerebrasHarmonyRequest, type HarmonyRequestOptions, type HarmonyTransport, normalizeHarmonyChatCompletion, runHarmonyTurn } from "./adapter.ts";
import { projectCerebrasRequest } from "../provider/cerebras.ts";
import {
  type BootstrapClassifierRequestOptions,
  type BootstrapClassifierVerdict,
  buildBootstrapClassifierRequest,
  verdictFromBootstrapResponse,
} from "./classifier.ts";
import {
  analysisLineCount,
  type Conversation,
  createConversation,
  dropAnalysisBeforeCompletedFinal,
  hasCompletedFinal,
  pendingToolCallCount,
} from "./conversation.ts";
import type { HarmonyCallStyle, NormalizedAssistantResponse, ToolDefinition } from "./types.ts";

// ---------------------------------------------------------------------------
// Sanitized record shapes
// ---------------------------------------------------------------------------

export type ProbeGroup = "reasoning" | "replay" | "tools" | "strictness" | "structured" | "parallel" | "classifier";

export type ProbeOutcome = "ok" | "upstream_rejected" | "upstream_error" | "adapter_error" | "failed";

export type ProbeRequestSummary = Readonly<{
  style: HarmonyCallStyle | "classifier";
  model: string;
  roles: readonly string[];
  tools: readonly { name: string; strict: boolean | null }[] | null;
  toolStrictnessValues: readonly boolean[];
  reasoningEffortTopLevel: string | null;
  reasoningInSystem: boolean;
  responseFormat: "json_object" | "json_schema" | "developer" | "none";
  parallelToolCalls: boolean | null;
  maxCompletionTokens: number | null;
  analysisInWire: boolean;
  assistantToolTurns: number;
  toolResultTurns: number;
}>;

export type ProbeResponseSummary = Readonly<{
  status: number;
  model: string;
  contentPresent: boolean;
  contentChars: number;
  contentPreview: string | null;
  reasoningPresent: boolean;
  reasoningChars: number;
  toolCalls: readonly { id: string; name: string; argumentsChars: number; argumentsJsonValid: boolean }[];
  refusal: boolean;
  finishReason: string | null;
}>;

export type ProbeStateSnapshot = Readonly<{
  analysisLines: number;
  analysisAfterDrop: number;
  pendingToolCalls: number;
  completedFinal: boolean;
}>;

export type ProbeTurnRecord = Readonly<{
  outcome: ProbeOutcome;
  status: number | null;
  durationMs: number;
  request: ProbeRequestSummary | null;
  response: ProbeResponseSummary | null;
  upstreamError: Readonly<{ code: string | null; message: string | null }> | null;
  adapterError: Readonly<{ code: string; message: string }> | null;
  state: ProbeStateSnapshot | null;
  notes: readonly string[];
  verdict: BootstrapClassifierVerdict | null;
}>;

/**
 * One executed model turn.  `record` is serializable; `normalized` and
 * `verdict` are scenario-local state and must never be written to output.
 */
export type ProbeTurnRun = Readonly<{
  record: ProbeTurnRecord;
  normalized: NormalizedAssistantResponse | null;
  verdict: BootstrapClassifierVerdict | null;
}>;

export type ProbeScenarioResult = Readonly<{
  id: string;
  group: ProbeGroup;
  style: HarmonyCallStyle | "classifier";
  description: string;
  expectedOutcome: ProbeOutcome | null;
  outcome: ProbeOutcome;
  startedAt: string;
  durationMs: number;
  turns: readonly ProbeTurnRecord[];
  verdict: BootstrapClassifierVerdict | null;
  failure: string | null;
  notes: readonly string[];
}>;

// ---------------------------------------------------------------------------
// Shared probe fixtures
// ---------------------------------------------------------------------------

export const WEATHER_TOOL: ToolDefinition = {
  name: "get_weather",
  description: "Gets the current weather in the provided location.",
  parameters: {
    type: "object",
    properties: { location: { type: "string", description: "The city and state, e.g. San Francisco, CA" } },
    required: ["location"],
    additionalProperties: false,
  },
};

export const NOTE_TOOL: ToolDefinition = {
  name: "save_note",
  description: "Saves a short note to the conversation log.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "Note text" } },
    required: ["text"],
    additionalProperties: false,
  },
};

export const ANSWER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { answer: { type: "integer", description: "The computed answer" } },
  required: ["answer"],
  additionalProperties: false,
};

export const user = (content: string): Conversation => createConversation([{ role: "user", content }]);

export const argsJsonValid = (argumentsText: string): boolean => {
  try {
    JSON.parse(argumentsText);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Probe context: sanitized turn runner
// ---------------------------------------------------------------------------

export type ProbeContext = Readonly<{
  transport: HarmonyTransport;
  now: () => Date;
  runTurn: (conversation: Conversation, options: Omit<HarmonyRequestOptions, "turns">) => Promise<ProbeTurnRun>;
  runRaw: (body: Record<string, unknown>, conversation?: Conversation) => Promise<ProbeTurnRun>;
  runClassifier: (options: BootstrapClassifierRequestOptions) => Promise<ProbeTurnRun>;
}>;

const stateSnapshot = (conversation: Conversation | undefined): ProbeStateSnapshot | null => {
  if (!conversation) return null;
  const dropped = dropAnalysisBeforeCompletedFinal(conversation);
  return {
    analysisLines: analysisLineCount(conversation),
    analysisAfterDrop: analysisLineCount(dropped),
    pendingToolCalls: pendingToolCallCount(conversation),
    completedFinal: hasCompletedFinal(conversation),
  };
};

/** Summarizes a raw `tools` array, ignoring entries that are not tool objects. */
const summarizeRawTools = (toolsValue: unknown): { name: string; strict: boolean | null }[] => {
  if (!Array.isArray(toolsValue)) return [];
  const tools: { name: string; strict: boolean | null }[] = [];
  for (const tool of toolsValue) {
    if (!tool || typeof tool !== "object") continue;
    const fn = (tool as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object") continue;
    const functionRecord = fn as Record<string, unknown>;
    const name = typeof functionRecord.name === "string" ? functionRecord.name : "?";
    const strict = typeof functionRecord.strict === "boolean" ? functionRecord.strict : null;
    tools.push({ name, strict });
  }
  return tools;
};

/** Renders one wire message role, never falling back to Object's default stringification. */
const rawMessageRole = (message: unknown): string => {
  if (!message || typeof message !== "object") return "?";
  const role = (message as Record<string, unknown>).role;
  if (typeof role === "string") return role;
  if (typeof role === "number" || typeof role === "boolean" || typeof role === "bigint") return String(role);
  if (role === null || role === undefined) return "?";
  return JSON.stringify(role);
};

/** Reads message roles after the same projection used by the Cerebras transport. */
const projectedMessageRoles = (body: Record<string, unknown>): readonly string[] => {
  const projected = projectCerebrasRequest(body);
  return Array.isArray(projected.messages) ? projected.messages.map(rawMessageRole) : [];
};

/** Reads the wire `response_format.type` as the probe summary vocabulary. */
const responseFormatOf = (body: Record<string, unknown>): ProbeRequestSummary["responseFormat"] => {
  const format = body.response_format;
  const formatType = format && typeof format === "object" ? (format as Record<string, unknown>).type : undefined;
  if (formatType === "json_object") return "json_object";
  if (formatType === "json_schema") return "json_schema";
  return "none";
};

const summarizeRawBody = (body: Record<string, unknown>): ProbeRequestSummary => {
  const projected = projectCerebrasRequest(body);
  const tools = summarizeRawTools(projected.tools);
  const messages = Array.isArray(projected.messages) ? projected.messages : [];
  const roles = messages.map(rawMessageRole);
  return {
    style: "generic",
    model: typeof body.model === "string" ? body.model : "?",
    roles,
    tools: tools.length > 0 ? tools : null,
    toolStrictnessValues: tools.map((tool) => tool.strict ?? false),
    reasoningEffortTopLevel: typeof body.reasoning_effort === "string" ? body.reasoning_effort : null,
    reasoningInSystem: false,
    responseFormat: responseFormatOf(body),
    parallelToolCalls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : null,
    maxCompletionTokens: typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : null,
    analysisInWire: roles.includes("assistant"),
    assistantToolTurns: messages.filter((message) => message && typeof message === "object" && Array.isArray((message as Record<string, unknown>).tool_calls))
      .length,
    toolResultTurns: roles.filter((role) => role === "tool").length,
  };
};

const responseSummary = (status: number, normalized: NormalizedAssistantResponse): ProbeResponseSummary => ({
  status,
  model: normalized.model,
  contentPresent: normalized.content !== null,
  contentChars: normalized.content?.length ?? 0,
  contentPreview: normalized.content ? normalized.content.slice(0, 120) : null,
  reasoningPresent: normalized.analysis.length > 0,
  reasoningChars: normalized.shape.reasoningChars,
  toolCalls: normalized.toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    argumentsChars: call.arguments.length,
    argumentsJsonValid: argsJsonValid(call.arguments),
  })),
  refusal: normalized.refusal !== null,
  finishReason: normalized.finishReason,
});

const outcomeForStatus = (status: number): ProbeOutcome => (status >= 400 && status < 500 ? "upstream_rejected" : "upstream_error");

const upstreamErrorOf = (value: unknown): { code: string | null; message: string | null } | null => {
  const inner = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    code: typeof inner.code === "string" ? inner.code : null,
    message: typeof inner.message === "string" ? inner.message : null,
  };
};

export const createProbeContext = (transport: HarmonyTransport, now: () => Date = () => new Date()): ProbeContext => {
  const record = (
    outcome: ProbeOutcome,
    status: number | null,
    durationMs: number,
    request: ProbeRequestSummary | null,
    response: ProbeResponseSummary | null,
    upstreamError: { code: string | null; message: string | null } | null,
    adapterError: { code: string; message: string } | null,
    conversation: Conversation | undefined,
    notes: readonly string[] = [],
    verdict: BootstrapClassifierVerdict | null = null
  ): ProbeTurnRecord => ({
    outcome,
    status,
    durationMs,
    request,
    response,
    upstreamError,
    adapterError,
    state: stateSnapshot(conversation),
    notes,
    verdict,
  });

  return {
    transport,
    now,
    runTurn: async (conversation, options) => {
      const started = now().getTime();
      try {
        const built = buildCerebrasHarmonyRequest({ ...options, turns: conversation.turns });
        const request: ProbeRequestSummary = {
          style: built.style,
          model: built.metadata.model,
          roles: built.metadata.messageRoles,
          tools: built.metadata.toolEntries.length > 0 ? built.metadata.toolEntries : null,
          toolStrictnessValues: built.metadata.toolStrictnessValues,
          reasoningEffortTopLevel: built.metadata.reasoningEffortTopLevel,
          reasoningInSystem: built.metadata.reasoningEffortInSystem,
          responseFormat: built.metadata.responseFormat,
          parallelToolCalls: built.metadata.parallelToolCalls,
          maxCompletionTokens: built.metadata.maxCompletionTokens,
          analysisInWire: built.metadata.analysisInWire,
          assistantToolTurns: built.metadata.assistantToolTurns,
          toolResultTurns: built.metadata.toolResultTurns,
        };
        const result = await runHarmonyTurn({ ...options, turns: conversation.turns }, transport);
        const durationMs = now().getTime() - started;
        if (result.ok) {
          return {
            record: record("ok", result.status, durationMs, request, responseSummary(result.status, result.normalized), null, null, conversation),
            normalized: result.normalized,
            verdict: null,
          };
        }
        if (result.upstreamError) {
          return {
            record: record(outcomeForStatus(result.status), result.status, durationMs, request, null, result.upstreamError, null, conversation),
            normalized: null,
            verdict: null,
          };
        }
        return {
          record: record(
            "failed",
            result.status,
            durationMs,
            request,
            null,
            null,
            {
              code: "normalization_error",
              message: result.normalizationError ?? "unknown",
            },
            conversation
          ),
          normalized: null,
          verdict: null,
        };
      } catch (error) {
        const durationMs = now().getTime() - started;
        if (error instanceof Error && "code" in error) {
          return {
            record: record(
              "adapter_error",
              null,
              durationMs,
              null,
              null,
              null,
              {
                code: String((error as { code: unknown }).code),
                message: error.message,
              },
              conversation
            ),
            normalized: null,
            verdict: null,
          };
        }
        return {
          record: record("failed", null, durationMs, null, null, null, { code: "probe_error", message: String(error) }, conversation),
          normalized: null,
          verdict: null,
        };
      }
    },
    runRaw: async (body, conversation) => {
      const started = now().getTime();
      const request = summarizeRawBody(body);
      try {
        const response = await transport(body);
        const status = response.status;
        if (!response.ok) {
          const value = await response.json().catch(() => null);
          return {
            record: record(outcomeForStatus(status), status, now().getTime() - started, request, null, upstreamErrorOf(value), null, conversation),
            normalized: null,
            verdict: null,
          };
        }
        const value = await response.json().catch(() => null);
        if (value === null) {
          return {
            record: record(
              "failed",
              status,
              now().getTime() - started,
              request,
              null,
              null,
              {
                code: "non_json",
                message: "upstream reply is not JSON",
              },
              conversation
            ),
            normalized: null,
            verdict: null,
          };
        }
        const normalized = normalizeHarmonyChatCompletion(value);
        if ("error" in normalized) {
          return {
            record: record(
              "failed",
              status,
              now().getTime() - started,
              request,
              null,
              null,
              {
                code: "normalization_error",
                message: normalized.error,
              },
              conversation
            ),
            normalized: null,
            verdict: null,
          };
        }
        return {
          record: record("ok", status, now().getTime() - started, request, responseSummary(status, normalized), null, null, conversation),
          normalized,
          verdict: null,
        };
      } catch (error) {
        return {
          record: record(
            "failed",
            null,
            now().getTime() - started,
            request,
            null,
            null,
            {
              code: "probe_error",
              message: String(error),
            },
            conversation
          ),
          normalized: null,
          verdict: null,
        };
      }
    },
    runClassifier: async (classifierOptions) => {
      const started = now().getTime();
      const body = buildBootstrapClassifierRequest(classifierOptions);
      const request: ProbeRequestSummary = {
        style: "classifier",
        model: typeof body.model === "string" ? body.model : "?",
        roles: projectedMessageRoles(body),
        tools: null,
        toolStrictnessValues: [],
        reasoningEffortTopLevel: null,
        reasoningInSystem: true,
        responseFormat: "none",
        parallelToolCalls: null,
        maxCompletionTokens: typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : null,
        analysisInWire: false,
        assistantToolTurns: 0,
        toolResultTurns: 0,
      };
      try {
        const response = await transport(body);
        const status = response.status;
        if (!response.ok) {
          const value = await response.json().catch(() => null);
          const unknown = {
            verdict: "unknown",
            raw: null,
            reason: `classifier request rejected with status ${status}`,
          } as const;
          return {
            record: record(
              outcomeForStatus(status),
              status,
              now().getTime() - started,
              request,
              null,
              upstreamErrorOf(value),
              null,
              undefined,
              [`verdict=unknown`],
              unknown
            ),
            normalized: null,
            verdict: unknown,
          };
        }
        const value = await response.json().catch(() => null);
        if (value === null) {
          const unknown = {
            verdict: "unknown",
            raw: null,
            reason: "classifier reply is not JSON",
          } as const;
          return {
            record: record(
              "failed",
              status,
              now().getTime() - started,
              request,
              null,
              null,
              {
                code: "non_json",
                message: "upstream reply is not JSON",
              },
              undefined,
              [`verdict=unknown`],
              unknown
            ),
            normalized: null,
            verdict: unknown,
          };
        }
        const normalized = normalizeHarmonyChatCompletion(value);
        if ("error" in normalized) {
          const unknown = {
            verdict: "unknown",
            raw: null,
            reason: `classifier reply is invalid: ${normalized.error}`,
          } as const;
          return {
            record: record(
              "failed",
              status,
              now().getTime() - started,
              request,
              null,
              null,
              {
                code: "normalization_error",
                message: normalized.error,
              },
              undefined,
              [`verdict=unknown`],
              unknown
            ),
            normalized: null,
            verdict: unknown,
          };
        }
        const verdict = verdictFromBootstrapResponse(normalized);
        return {
          record: record(
            "ok",
            status,
            now().getTime() - started,
            request,
            responseSummary(status, normalized),
            null,
            null,
            undefined,
            [`verdict=${verdict.verdict}`],
            verdict
          ),
          normalized,
          verdict,
        };
      } catch (error) {
        const unknown = {
          verdict: "unknown",
          raw: null,
          reason: `classifier transport failed: ${String(error)}`,
        } as const;
        return {
          record: record(
            "failed",
            null,
            now().getTime() - started,
            request,
            null,
            null,
            {
              code: "probe_error",
              message: String(error),
            },
            undefined,
            [`verdict=unknown`],
            unknown
          ),
          normalized: null,
          verdict: unknown,
        };
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

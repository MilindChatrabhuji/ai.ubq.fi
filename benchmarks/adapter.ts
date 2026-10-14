/**
 * Benchmark adapter contract and the deterministic `reference` adapter.
 *
 * Adapters A/B/C/D (m03) implement {@link BenchmarkAdapter}. Each adapter is
 * handed a {@link AdapterRunContext}: the task manifest, a disposable
 * workspace, an event-recording sink, and a tool-call limit check. Adapters
 * record their own trajectory events; the runner derives metrics, runs
 * verification, evaluates oracles, and writes the result record.
 *
 * The built-in `reference` adapter executes the task's `scripted_trail`
 * against the canonical tool layer owned by m04
 * (`src/harmony/tools/*`): stable schemas, machine-readable result envelopes,
 * path/write boundaries, and dependency-injected deterministic fakes. The
 * fixture workspace is bridged onto the canonical {@link WorkspaceBackend};
 * browser search/open/find and task.update_plan run against offline
 * deterministic fakes (no browser daemon, no network). It never calls an
 * external model, so the default benchmark commands are fully hermetic and
 * reproducible.
 *
 * `TOOL_SCHEMAS` / `CANONICAL_TOOL_NAMES` / `validateToolArgs` are
 * m02-compatible views over the canonical schemas.
 */

import { CEREBRAS_GPT_OSS_120B_MODEL } from "../src/provider/cerebras.ts";
import { type HarmonyTransport } from "../src/harmony/adapter.ts";
import type { HarmonyReasoningEffort } from "../src/harmony/types.ts";
import { type HarnessEvent, renderCanonicalPolicy, runReliabilityHarness } from "../src/harmony/reliability/harness.ts";
import { broadToolSurface, compactToolSurface, type ToolSurfaceId } from "../src/harmony/reliability/surfaces.ts";
import type { ContextBudgetKind } from "../src/harmony/reliability/context.ts";
import type { RetryPolicy } from "../src/harmony/reliability/retry.ts";
import type { VerificationPolicy } from "../src/harmony/reliability/verify.ts";
import { FixtureWorkspace, WriteScopeViolationError } from "./fixture.ts";
import { type ModelRequestEvent, type TaskManifest, type TrailStep, type TrajectoryEvent } from "./schemas.ts";
import { type ToolBackends, type WorkspaceBackend } from "../src/harmony/tools/backend.ts";
import { createFakeToolBackends } from "../src/harmony/tools/fakes.ts";
import { ToolExecutionError, toolFailure } from "../src/harmony/tools/result.ts";
import { runTool } from "../src/harmony/tools/router.ts";
import {
  CANONICAL_TOOL_NAMES as canonicalToolNames,
  type CanonicalToolSchema,
  TOOL_SCHEMAS as canonicalToolSchemas,
  toolParameterTypes,
  validateToolArguments,
} from "../src/harmony/tools/schemas.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TrailMismatchError extends Error {
  constructor(
    readonly stepIndex: number,
    readonly step: TrailStep,
    readonly result: ToolResult
  ) {
    super(`trail step ${stepIndex + 1} (${step.tool}): expected ${describeExpectation(step)}, got ok=${result.ok} ${result.error ?? ""}`.trim());
    this.name = "TrailMismatchError";
  }
}

export class ToolCallLimitExceededError extends Error {
  constructor(readonly maxToolCalls: number) {
    super(`tool call limit exceeded: max_tool_calls=${maxToolCalls}`);
    this.name = "ToolCallLimitExceededError";
  }
}

export class TaskTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`task timed out after ${timeoutMs}ms`);
    this.name = "TaskTimeoutError";
  }
}

/** Canonical config C error: no transport was injected. */
export class CanonicalAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalAdapterError";
  }
}

/** Canonical config C error: the reliability harness did not complete. */
export class CanonicalHarnessError extends Error {
  constructor(
    readonly reason: string | null,
    readonly failureClass: string | null
  ) {
    super(`canonical harness failed: ${reason ?? "unknown"} (reliability class: ${failureClass ?? "none"})`);
    this.name = "CanonicalHarnessError";
  }
}

function describeExpectation(step: TrailStep): string {
  const exp = step.expect;
  if (!exp) return "no assertion";
  const parts: string[] = [];
  const expectedOk = exp.ok ?? exp.error_contains === undefined;
  parts.push(`ok=${expectedOk}`);
  for (const s of exp.output_contains ?? []) parts.push(`output contains ${JSON.stringify(s)}`);
  if (exp.error_contains !== undefined) parts.push(`error contains ${JSON.stringify(exp.error_contains)}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export type AdapterRunContext = {
  runId: string;
  task: TaskManifest;
  workspace: FixtureWorkspace;
  /** Append a validated trajectory event. */
  record(event: TrajectoryEvent): void;
  /** Throw when the run exceeded the declared max_tool_calls. */
  checkToolLimit(): void;
  /** Aborts when the whole-run timeout fired. */
  signal: AbortSignal;
  time(): string;
};

export type BenchmarkAdapter = {
  /** Stable config id used in result records (A, B, C, D, reference, ...). */
  configId: string;
  name: string;
  description: string;
  /**
   * True when the adapter issues model calls. The runner refuses to run
   * such adapters until an approved external-inference gate exists; the
   * hermetic default (reference) never needs one.
   */
  requiresExternalInference: boolean;
  run(ctx: AdapterRunContext): Promise<void>;
};

// ---------------------------------------------------------------------------
// Tool layer (canonical m04 surface with m02-compatible views)
// ---------------------------------------------------------------------------

export type ToolResult = {
  ok: boolean;
  output?: string;
  error?: string;
  error_code?: string;
};

type ToolSchema = {
  required: string[];
  types: Record<string, "string" | "boolean" | "string[]">;
};

/** m02-compatible schema view derived from the canonical tool schemas. */
export const TOOL_SCHEMAS: Record<string, ToolSchema> = Object.fromEntries(
  Object.values(canonicalToolSchemas).map((toolSchema: CanonicalToolSchema) => [
    toolSchema.name,
    {
      required: toolSchema.parameters.required as string[],
      types: { ...toolParameterTypes(toolSchema) },
    },
  ])
);

/**
 * The comparator `Array.prototype.sort` uses when none is supplied: UTF-16 code
 * unit order. Spelled out because the default is easy to mistake for a missing
 * argument, and because `localeCompare` would collate in the host's locale
 * (making this exported constant's order environment-dependent).
 */
function compareUtf16CodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export const CANONICAL_TOOL_NAMES: readonly string[] = [...canonicalToolNames].sort(compareUtf16CodeUnits);

/** Validate tool arguments against the canonical schema (m02-compatible shape). */
export function validateToolArgs(tool: string, args: Record<string, unknown>): { valid: boolean; reason?: string } {
  const result = validateToolArguments(tool, args);
  return result.valid ? { valid: true } : { valid: false, reason: result.reason };
}

const isNotFound = (err: unknown): boolean =>
  typeof err === "object" && err !== null && ((err as { code?: unknown }).code === "ENOENT" || (err as { name?: unknown }).name === "NotFound");

/** Best-effort message for an unknown thrown value; never renders "[object Object]". */
function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : String(err);
}

/** Maps a disposable FixtureWorkspace onto the canonical WorkspaceBackend. */
class FixtureWorkspaceBackend implements WorkspaceBackend {
  readonly label = "fixture-workspace";

  constructor(readonly workspace: FixtureWorkspace) {}

  read(rel: string): string {
    try {
      return this.workspace.read(rel);
    } catch (err) {
      throw this._mapFileError(rel, err);
    }
  }

  listFiles(rel: string): string[] {
    try {
      return this.workspace.listFiles(rel);
    } catch (err) {
      throw this._mapFileError(rel, err);
    }
  }

  isAllowedWrite(rel: string): boolean {
    return this.workspace.isAllowedWrite(rel);
  }

  describeWriteScope(): string {
    return this.workspace.task.allowed_write_scope.join(", ");
  }

  write(rel: string, content: string): void {
    try {
      this.workspace.write(rel, content);
    } catch (err) {
      throw this._mapFileError(rel, err);
    }
  }

  applyPatch(rel: string, patch: { old: string; new: string; add: boolean }): { applied: true; detail: string } {
    try {
      // Empty `old` prepends `new` at the start of the file; the workspace's
      // raw patch helper would treat it as ambiguous (empty matches everywhere).
      if (!patch.add && patch.old === "") {
        this.workspace.write(rel, patch.new + this.workspace.read(rel));
        return { applied: true, detail: `patched ${rel}` };
      }
      const result = this.workspace.applyPatch(rel, patch.old, patch.new, patch.add);
      return { applied: true, detail: result.detail };
    } catch (err) {
      if (err instanceof WriteScopeViolationError) throw new ToolExecutionError("write_scope", err.message);
      const message = isNotFound(err) ? `patch failed: ${rel} does not exist` : errorMessage(err);
      throw new ToolExecutionError("patch_failed", message);
    }
  }

  async execShell(
    command: string,
    opts: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<{ exit_code: number; stdout: string; stderr: string; timed_out: boolean }> {
    try {
      const result = await this.workspace.execShell(command, opts.timeoutMs, opts.signal);
      return { exit_code: result.code, stdout: result.stdout, stderr: result.stderr, timed_out: result.timedOut };
    } catch (err) {
      // Unauthorized shell mutations are restored inside the disposable
      // workspace before this point; surface them through the canonical
      // `write_scope` code instead of a second, shell-only channel.
      if (err instanceof WriteScopeViolationError) throw new ToolExecutionError("write_scope", err.message);
      throw err;
    }
  }

  private _mapFileError(rel: string, err: unknown): ToolExecutionError {
    if (err instanceof WriteScopeViolationError) return new ToolExecutionError("write_scope", err.message);
    if (isNotFound(err)) return new ToolExecutionError("not_found", `file not found: ${rel}`);
    return new ToolExecutionError("internal", errorMessage(err));
  }
}

/** Canonical backends for the reference adapter: fixture workspace + offline fakes. */
function referenceBackends(workspace: FixtureWorkspace): ToolBackends {
  const fakes = createFakeToolBackends();
  return {
    workspace: new FixtureWorkspaceBackend(workspace),
    browser: fakes.browser,
    plan: fakes.plan,
  };
}

type ValidatedToolArgs = { valid: boolean; reason?: string };

/** Resolves one scripted step to its result without touching the trajectory. */
async function executeScriptedStep(backends: ToolBackends, ctx: AdapterRunContext, step: TrailStep, validated: ValidatedToolArgs): Promise<ToolResult> {
  if (!validated.valid) return { ok: false, error: `invalid arguments: ${validated.reason}`, error_code: "invalid_args" };
  if (step.inject) return { ok: false, error: step.inject.error, error_code: step.inject.error_code ?? "injected_failure" };
  if (step.wrong) return { ok: false, error: "wrong tool for this task step", error_code: "wrong_tool" };
  try {
    return await runTool(backends, step.tool, step.args, { signal: ctx.signal });
  } catch (err) {
    return toolFailure("internal", err instanceof Error ? err.message : String(err));
  }
}

function recordScriptedToolCall(ctx: AdapterRunContext, id: string, step: TrailStep, validated: ValidatedToolArgs): void {
  ctx.record({
    type: "tool_call",
    at: ctx.time(),
    id,
    tool: step.tool,
    arguments: step.args,
    valid: validated.valid,
    invalid_reason: validated.valid ? undefined : validated.reason,
    is_wrong_tool: step.wrong === true ? true : undefined,
    is_repeated: step.repeat === true ? true : undefined,
  });
}

/** Throws `TrailMismatchError` when the recorded result contradicts the step's assertion. */
function assertScriptedStepExpectation(stepIndex: number, step: TrailStep, result: ToolResult): void {
  const expect = step.expect;
  if (!expect) return;
  const expectedOk = expect.ok ?? expect.error_contains === undefined;
  const okMatches = result.ok === expectedOk;
  const outputOk = (expect.output_contains ?? []).every((s) => (result.output ?? "").includes(s));
  const errorOk = expect.error_contains === undefined ? true : !result.ok && (result.error ?? "").includes(expect.error_contains);
  if (!(okMatches && outputOk && errorOk)) throw new TrailMismatchError(stepIndex, step, result);
}

// ---------------------------------------------------------------------------
// Reference (scripted) adapter
// ---------------------------------------------------------------------------

export const referenceAdapter: BenchmarkAdapter = {
  configId: "reference",
  name: "reference",
  description: "Deterministic scripted-trail executor; records trajectories and never calls an external model.",
  requiresExternalInference: false,
  async run(ctx: AdapterRunContext): Promise<void> {
    const { task } = ctx;
    const trail = task.scripted_trail;
    if (!trail) {
      throw new TrailMismatchError(-1, { tool: "(none)", args: {} } as TrailStep, {
        ok: false,
        error: `task ${task.id} declares no scripted_trail; the reference adapter can only replay recorded trails`,
        error_code: "invalid_args",
      });
    }
    const backends = referenceBackends(ctx.workspace);
    let seq = 0;
    for (let i = 0; i < trail.length; i++) {
      ctx.checkToolLimit();
      if (ctx.signal.aborted) throw new TaskTimeoutError(task.timeout_ms);
      const step = trail[i];
      const id = `t${++seq}`;
      const validated = validateToolArgs(step.tool, step.args);
      recordScriptedToolCall(ctx, id, step, validated);
      const started = Date.now();
      const result = await executeScriptedStep(backends, ctx, step, validated);
      ctx.record({
        type: "tool_result",
        at: ctx.time(),
        id,
        ok: result.ok,
        output: result.output,
        error: result.error,
        error_code: result.error_code,
        duration_ms: Date.now() - started,
      });
      assertScriptedStepExpectation(i, step, result);
    }
  },
};

/** Registry consumed by the runner. m03 registers adapters A/B/D here. */
export function defaultAdapters(): BenchmarkAdapter[] {
  return [referenceAdapter, canonicalAdapter];
}

// ---------------------------------------------------------------------------
// Canonical configuration C (m05)
// ---------------------------------------------------------------------------

export type CanonicalAdapterOptions = {
  /** Stable config id; defaults to "C". */
  configId?: string;
  name?: string;
  description?: string;
  /**
   * The model transport.  Injected only — no environment variable, CLI flag
   * or secret is read.  Absent for the registered default, which therefore
   * fails fast ("live inference is gated") and is refused by the runner via
   * `requiresExternalInference: true`.
   */
  transport?: HarmonyTransport;
  /** Default true: the runner refuses this adapter without an approved gate. */
  requiresExternalInference?: boolean;
  /** Model-facing tool surface; default "compact" (canonical nine tools). */
  toolSurface?: ToolSurfaceId;
  transcriptBudget?: ContextBudgetKind;
  contextMode?: "full" | "structured";
  reasoningEffort?: HarmonyReasoningEffort;
  retryPolicy?: RetryPolicy;
  verificationPolicy?: VerificationPolicy;
  maxTurns?: number;
  maxCompletionTokens?: number;
};

const parseArgumentsObject = (argumentsText: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(argumentsText);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  return {};
};

/** Maps one harness event onto the benchmark trajectory contract. */
function recordHarnessEvent(ctx: AdapterRunContext, event: HarnessEvent, toolCount: number, requests: Map<number, ModelRequestEvent>): void {
  switch (event.type) {
    case "model_request": {
      const request: ModelRequestEvent = {
        type: "model_request",
        at: ctx.time(),
        id: event.id,
        model: CEREBRAS_GPT_OSS_120B_MODEL,
        message_count: (event.built.body.messages as unknown[]).length,
        input_tokens: event.estimatedTokens,
        output_tokens: 0,
        tool_count: toolCount,
      };
      requests.set(event.id, request);
      ctx.record(request);
      break;
    }
    case "model_response": {
      const request = requests.get(event.requestId);
      if (request !== undefined) request.output_tokens = event.estimatedTokens;
      ctx.record({
        type: "model_response",
        at: ctx.time(),
        request_id: event.requestId,
        content: event.normalized.content ?? undefined,
        tool_calls: event.normalized.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: parseArgumentsObject(call.arguments),
        })),
        finish_reason: event.normalized.finishReason ?? undefined,
      });
      break;
    }
    case "tool_call":
      ctx.checkToolLimit();
      ctx.record({
        type: "tool_call",
        at: ctx.time(),
        id: event.id,
        tool: event.tool,
        arguments: event.arguments,
        valid: event.valid,
        invalid_reason: event.valid ? undefined : event.invalidReason,
        is_repeated: event.repeated === null || event.repeated === undefined ? undefined : true,
      });
      break;
    case "tool_result":
      ctx.record({
        type: "tool_result",
        at: ctx.time(),
        id: event.id,
        ok: event.result.ok,
        output: event.result.output,
        error: event.result.error,
        error_code: event.result.error_code,
        duration_ms: event.durationMs,
      });
      break;
    case "guard":
      ctx.record({
        type: "guard",
        at: ctx.time(),
        kind: event.kind,
        reason: event.message,
        attempt: event.attempt,
        phase: event.phase,
      });
      break;
    case "final":
      // The final content is already recorded by the preceding
      // model_response event; no extra trajectory event is needed.
      break;
    default:
      // Every HarnessEvent type is handled above; this keeps the switch total
      // if the union ever grows a member.
      break;
  }
}

/**
 * Builds the canonical configuration C adapter (m05).  A fake transport makes
 * it fully deterministic for tests; the registered default carries NO
 * transport and `requiresExternalInference: true`, so the hermetic runner
 * refuses it until an approved live gate exists (no env var / flag / secret
 * is ever read).
 */
export function createCanonicalAdapter(options: CanonicalAdapterOptions = {}): BenchmarkAdapter {
  const configId = options.configId ?? "C";
  const requiresExternalInference = options.requiresExternalInference ?? true;
  const surface = options.toolSurface === "broad" ? broadToolSurface() : compactToolSurface();
  return {
    configId,
    name: options.name ?? "canonical C",
    description:
      options.description ??
      `canonical Harmony harness (compact tool surface + m05 reliability guards); transport is injected, so hermetic tests drive it with a fake transport`,
    requiresExternalInference,
    async run(ctx: AdapterRunContext): Promise<void> {
      const transport = options.transport;
      if (transport === undefined) {
        throw new CanonicalAdapterError(
          "canonical config C: no transport was injected, so live inference is gated. " +
            "The runner refuses external-inference adapters; no environment variable, CLI flag or secret is read — " +
            "construct the adapter with an approved or fake transport."
        );
      }
      const tools = surface.definitions;
      const requests = new Map<number, ModelRequestEvent>();
      const outcome = await runReliabilityHarness({
        systemPrompt: renderCanonicalPolicy({
          tools: tools.map((tool) => tool.name),
          budget: options.transcriptBudget ?? "medium",
        }),
        userPrompt:
          `${ctx.task.title} — ${ctx.task.description}\n` +
          `Verify your work before answering; the declared verification command is ${JSON.stringify(ctx.task.verify?.command ?? null)}.`,
        transport: (body, requestOptions) =>
          transport(body, {
            ...requestOptions,
            signal: ctx.signal,
          }),
        backends: referenceBackends(ctx.workspace),
        tools,
        reasoningEffort: options.reasoningEffort ?? "low",
        transcriptBudget: options.transcriptBudget ?? "medium",
        contextMode: options.contextMode ?? "structured",
        retryPolicy: options.retryPolicy,
        verificationPolicy: options.verificationPolicy,
        verificationCommand: ctx.task.verify?.command ?? null,
        maxTurns: options.maxTurns ?? 48,
        maxCompletionTokens: options.maxCompletionTokens ?? 512,
        maxToolCalls: ctx.task.max_tool_calls,
        emit: (event) => {
          recordHarnessEvent(ctx, event, tools.length, requests);
        },
        signal: ctx.signal,
      });
      if (outcome.abortedReason === "signal") throw new TaskTimeoutError(ctx.task.timeout_ms);
      if (outcome.abortedReason === "tool_call_limit") {
        throw new ToolCallLimitExceededError(ctx.task.max_tool_calls);
      }
      if (outcome.phase !== "completed") {
        throw new CanonicalHarnessError(outcome.abortedReason, outcome.classification.failure_class);
      }
    },
  };
}

/** Registered canonical configuration C: external inference by default. */
export const canonicalAdapter: BenchmarkAdapter = createCanonicalAdapter();

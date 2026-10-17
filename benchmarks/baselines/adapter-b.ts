import { runCommand } from "../process.ts";
/**
 * Baseline B: codex-infinity-compatible process/trajectory bridge.
 *
 * B wraps [codex-infinity](https://github.com/lee101/codex-infinity) — a fork
 * of the OpenAI Codex CLI with a Cerebras provider — as a subprocess and
 * translates its run output into benchmark trajectory events. The default
 * configuration is deliberately inert:
 *
 * - the pinned source/provenance record is checked in (repository URL,
 *   commit ref, license, upstream), but **nothing is cloned** by the adapter;
 * - focused tests inject a deterministic driver (the scripted driver below);
 * - the live process path requires an explicit `allowLiveProcess: true` plus
 *   an optional pinned checkout, and even then only the exact pinned ref is
 *   accepted;
 * - the live output format of codex-infinity is not verified yet: the line
 *   parser accepts an *assumed* JSONL event shape and counts skipped lines,
 *   and the exact schema must be confirmed with a live run before any
 *   baseline numbers can be produced (see docs/research/
 *   cerebras-agent-baselines.md).
 */

import { type AdapterRunContext, type BenchmarkAdapter, TaskTimeoutError } from "../adapter.ts";
import type { FixtureWorkspace } from "../fixture.ts";
import type { TaskManifest, TrailStep, TrajectoryEvent } from "../schemas.ts";
import { BaselineAdapterError, BaselineNotProvisionedError } from "./errors.ts";
import { executeBaselineTool, type ToolResult, validateCanonicalToolArgs } from "./tools.ts";

// ---------------------------------------------------------------------------
// Pinned source / provenance
// ---------------------------------------------------------------------------

/**
 * Verified on 2026-08-29 via the GitHub REST API (repo metadata + commit
 * list) and the raw README at that ref. `codex-infinity` is a fork of
 * `openai/codex` (Apache-2.0); the fork is Apache-2.0 as well and ships a
 * NOTICE file. The npm package is `@codex-infinity/codex-infinity`.
 * Facts about the *runtime* protocol still require live verification.
 */
export const CODEX_INFINITY_SOURCE_PIN = {
  provider: "github",
  repositoryUrl: "https://github.com/lee101/codex-infinity",
  defaultBranch: "main",
  pinnedRef: "fbb52680c30a968384b15cfe6dadbec22faba73f",
  pinnedAt: "2026-08-24T11:08:14Z",
  upstreamRepositoryUrl: "https://github.com/openai/codex",
  license: "Apache-2.0",
  npmPackage: "@codex-infinity/codex-infinity",
  homepage: "https://codex-infinity.com/",
  retrievalDate: "2026-08-29",
} as const;

export type CodexInfinityBridgeConfig = {
  readonly sourcePin: Readonly<typeof CODEX_INFINITY_SOURCE_PIN>;
  /**
   * Local checkout of the pinned revision. The adapter never clones; when
   * set, the live driver verifies the checked-out HEAD equals pinnedRef.
   */
  checkoutPath: string | null;
  /** Hard opt-in for the live process path; false by default. */
  allowLiveProcess: boolean;
  /** Cerebras model slug advertised by codex-infinity. */
  modelSlug: string;
  /** Existing environment variable holding the Cerebras key (reused). */
  apiKeyEnv: string;
  /** Binary invoked for the live process path. */
  binary: string;
  /**
   * Extra CLI flags. Auto-continuation flags (--auto-next-steps and friends)
   * are excluded from baseline runs because they would never terminate.
   */
  extraArgs: string[];
};

export const DEFAULT_BRIDGE_CONFIG: CodexInfinityBridgeConfig = {
  sourcePin: CODEX_INFINITY_SOURCE_PIN,
  checkoutPath: null,
  allowLiveProcess: false,
  modelSlug: "cerebras/gpt-oss-120b",
  apiKeyEnv: "CEREBRAS_API_KEY",
  binary: "codex-infinity",
  extraArgs: [],
};

// ---------------------------------------------------------------------------
// Process/trajectory bridge domain
// ---------------------------------------------------------------------------

/** One tool call inside a bridge model turn. */
export type BridgeToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

/**
 * Process-shaped events emitted by a codex-infinity run and translated by
 * the bridge into schema-valid trajectory events. `at` timestamps are added
 * by the bridge, never by the driver. `model_request.id` is supplied by the
 * driver (assumed to be a session-level monotonic number).
 */
export type BridgeProcessEvent =
  | {
      kind: "model_request";
      id: number;
      model: string;
      message_count: number;
      input_tokens: number;
      output_tokens: number;
      tool_count: number;
    }
  | {
      kind: "model_response";
      request_id: number;
      content: string | null;
      tool_calls: readonly BridgeToolCall[];
      finish_reason: string | null;
    }
  | {
      kind: "tool_call";
      id: string;
      tool: string;
      arguments: Record<string, unknown>;
      valid: boolean;
      invalid_reason?: string;
      is_wrong_tool?: boolean;
      is_repeated?: boolean;
    }
  | {
      kind: "tool_result";
      id: string;
      ok: boolean;
      output?: string;
      error?: string;
      error_code?: string;
      duration_ms?: number;
    };

export type ProcessDriverInput = {
  task: TaskManifest;
  workspace: FixtureWorkspace;
  signal: AbortSignal;
};

/** Translates a codex-infinity run into process events (injected in tests). */
export type ProcessDriver = {
  run(input: ProcessDriverInput): AsyncIterable<BridgeProcessEvent> | Iterable<BridgeProcessEvent>;
};

async function* drain(events: AsyncIterable<BridgeProcessEvent> | Iterable<BridgeProcessEvent>): AsyncGenerator<BridgeProcessEvent> {
  yield* events;
}

/** Pure mapping from a process event to the schema-valid trajectory event. */
export function bridgeEventToTrajectory(event: BridgeProcessEvent, at: string): TrajectoryEvent {
  switch (event.kind) {
    case "model_request":
      return {
        type: "model_request",
        at,
        id: event.id,
        model: event.model,
        message_count: event.message_count,
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        tool_count: event.tool_count,
      };
    case "model_response":
      return {
        type: "model_response",
        at,
        request_id: event.request_id,
        content: event.content ?? undefined,
        tool_calls: event.tool_calls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
        finish_reason: event.finish_reason ?? undefined,
      };
    case "tool_call":
      return {
        type: "tool_call",
        at,
        id: event.id,
        tool: event.tool,
        arguments: event.arguments,
        valid: event.valid,
        invalid_reason: event.invalid_reason,
        is_wrong_tool: event.is_wrong_tool,
        is_repeated: event.is_repeated,
      };
    case "tool_result":
      return {
        type: "tool_result",
        at,
        id: event.id,
        ok: event.ok,
        output: event.output,
        error: event.error,
        error_code: event.error_code,
        duration_ms: event.duration_ms,
      };
    default: {
      // Exhaustiveness guard: a new process event kind must be mapped here.
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Scripted (deterministic) driver
// ---------------------------------------------------------------------------

function applyScriptedStep(
  workspace: FixtureWorkspace,
  step: TrailStep,
  signal: AbortSignal,
  validated: { valid: boolean; reason?: string }
): Promise<ToolResult> {
  if (!validated.valid) {
    return Promise.resolve({ ok: false, error: `invalid arguments: ${validated.reason}`, error_code: "invalid_args" });
  }
  if (step.inject) {
    return Promise.resolve({
      ok: false,
      error: step.inject.error,
      error_code: step.inject.error_code ?? "injected_failure",
    });
  }
  if (step.wrong) {
    return Promise.resolve({ ok: false, error: "wrong tool for this task step", error_code: "wrong_tool" });
  }
  return executeScriptedTool(workspace, step, signal);
}

async function executeScriptedTool(workspace: FixtureWorkspace, step: TrailStep, signal: AbortSignal): Promise<ToolResult> {
  try {
    return await executeBaselineTool(workspace, step.tool, step.args, signal);
  } catch (err) {
    return { ok: false, error: (err as Error).message, error_code: "exec_failed" };
  }
}

/**
 * Synthesizes a deterministic codex-infinity-shaped event stream from the
 * task's recorded `scripted_trail`: one model turn issuing all tool calls,
 * the corresponding tool results (injected failures included), then one
 * final model turn. This stands in for a live process until the real output
 * format is verified.
 */
export async function* synthesizeBridgeEvents(input: ProcessDriverInput): AsyncGenerator<BridgeProcessEvent> {
  const { task, workspace, signal } = input;
  const trail = task.scripted_trail ?? [];
  const toolCalls: BridgeToolCall[] = trail.map((step, index) => ({
    id: `bridge-call-${index + 1}`,
    name: step.tool,
    arguments: { ...step.args },
  }));
  yield {
    kind: "model_request",
    id: 1,
    model: "codex-infinity/cerebras",
    message_count: 2,
    input_tokens: 0,
    output_tokens: 0,
    tool_count: toolCalls.length,
  };
  if (toolCalls.length > 0) {
    yield {
      kind: "model_response",
      request_id: 1,
      content: null,
      tool_calls: toolCalls,
      finish_reason: "tool_calls",
    };
  }
  for (let index = 0; index < trail.length; index++) {
    const step = trail[index];
    const validated = validateCanonicalToolArgs(step.tool, step.args);
    yield {
      kind: "tool_call",
      id: toolCalls[index].id,
      tool: step.tool,
      arguments: { ...step.args },
      valid: validated.valid,
      invalid_reason: validated.valid ? undefined : validated.reason,
      is_wrong_tool: step.wrong === true ? true : undefined,
      is_repeated: step.repeat === true ? true : undefined,
    };
    const result = await applyScriptedStep(workspace, step, signal, validated);
    yield {
      kind: "tool_result",
      id: toolCalls[index].id,
      ok: result.ok,
      output: result.output,
      error: result.error,
      error_code: result.error_code,
    };
  }
  yield {
    kind: "model_request",
    id: 2,
    model: "codex-infinity/cerebras",
    message_count: 2,
    input_tokens: 0,
    output_tokens: 0,
    tool_count: toolCalls.length,
  };
  yield {
    kind: "model_response",
    request_id: 2,
    content: "task complete",
    tool_calls: [],
    finish_reason: "stop",
  };
}

/** Deterministic driver built from the input task's scripted trail. */
export function scriptedBridgeDriverFromTrail(): ProcessDriver {
  return {
    run(input: ProcessDriverInput): AsyncIterable<BridgeProcessEvent> {
      return synthesizeBridgeEvents(input);
    },
  };
}

// ---------------------------------------------------------------------------
// Live process path (never used by default)
// ---------------------------------------------------------------------------

/** Renders one unverified JSONL text field, falling back when it is absent or not text. */
const textField = (value: unknown, fallback: string): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return fallback;
};

/** Keeps a JSON object payload, replacing anything else with an empty record. */
const recordField = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;

/** Maps one unverified `model_request` line. */
const parseModelRequestLine = (record: Record<string, unknown>): BridgeProcessEvent => ({
  kind: "model_request",
  id: Number(record.id ?? 0),
  model: textField(record.model, "codex-infinity/cerebras"),
  message_count: Number(record.message_count ?? 0),
  input_tokens: Number(record.input_tokens ?? 0),
  output_tokens: Number(record.output_tokens ?? 0),
  tool_count: Number(record.tool_count ?? 0),
});

/** Maps one unverified `model_response` line, including its tool calls. */
const parseModelResponseLine = (record: Record<string, unknown>): BridgeProcessEvent => {
  const rawCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  return {
    kind: "model_response",
    request_id: Number(record.request_id ?? 0),
    content: typeof record.content === "string" ? record.content : null,
    tool_calls: rawCalls.map((raw, index) => {
      const call = recordField(raw);
      return {
        id: textField(call.id, `bridge-call-${index + 1}`),
        name: textField(call.name, "(unknown)"),
        arguments: recordField(call.arguments),
      };
    }),
    finish_reason: typeof record.finish_reason === "string" ? record.finish_reason : null,
  };
};

/** Maps one unverified `tool_call` line. */
const parseToolCallLine = (record: Record<string, unknown>): BridgeProcessEvent => ({
  kind: "tool_call",
  id: textField(record.id, ""),
  tool: textField(record.tool, "(unknown)"),
  arguments: recordField(record.arguments),
  valid: record.valid === true,
  invalid_reason: typeof record.invalid_reason === "string" ? record.invalid_reason : undefined,
  is_wrong_tool: record.is_wrong_tool === true ? true : undefined,
  is_repeated: record.is_repeated === true ? true : undefined,
});

/** Maps one unverified `tool_result` line. */
const parseToolResultLine = (record: Record<string, unknown>): BridgeProcessEvent => ({
  kind: "tool_result",
  id: textField(record.id, ""),
  ok: record.ok === true,
  output: typeof record.output === "string" ? record.output : undefined,
  error: typeof record.error === "string" ? record.error : undefined,
  error_code: typeof record.error_code === "string" ? record.error_code : undefined,
  duration_ms: typeof record.duration_ms === "number" ? record.duration_ms : undefined,
});

/** Parses one line of assumed codex-infinity JSONL output into a bridge event. */
export function parseCodexProcessLine(line: string): BridgeProcessEvent | null {
  const text = line.trim();
  if (text === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "model_request":
      return parseModelRequestLine(record);
    case "model_response":
      return parseModelResponseLine(record);
    case "tool_call":
      return parseToolCallLine(record);
    case "tool_result":
      return parseToolResultLine(record);
    default:
      // Unverified format: skip and let the live driver count the line.
      return null;
  }
}

async function assertPinnedCheckout(checkoutPath: string): Promise<void> {
  const out = await runCommand(["git", "-C", checkoutPath, "rev-parse", "HEAD"]);
  const ref = out.stdout.trim();
  if (out.code !== 0 || ref !== CODEX_INFINITY_SOURCE_PIN.pinnedRef) {
    throw new BaselineAdapterError(
      `codex-infinity checkout at ${checkoutPath} is at ${ref || "(unknown)"}, expected ` + CODEX_INFINITY_SOURCE_PIN.pinnedRef,
      "invalid-config"
    );
  }
}

/** Drain a child stream without retaining its potentially sensitive content. */
export async function drainChildStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Discard each chunk as soon as it arrives so the child cannot block on
      // a full pipe while the bridge is waiting for stdout.
    }
  } finally {
    reader.releaseLock();
  }
}

/** Creates the live, process-spawning driver. Never constructed by default. */
export function createLiveBridgeProcessDriver(config: CodexInfinityBridgeConfig): ProcessDriver {
  return {
    async *run(input: ProcessDriverInput): AsyncIterable<BridgeProcessEvent> {
      const args = ["-m", config.modelSlug, "--cd", input.workspace.root, ...config.extraArgs, input.task.description];
      const child = Bun.spawn([config.binary, ...args], {
        cwd: input.workspace.root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: input.signal,
      });
      // Start draining before reading stdout. A verbose child can fill its
      // stderr pipe before emitting the next JSONL event and otherwise
      // deadlock both processes.
      const stderrDrain = drainChildStream(child.stderr);
      let skipped = 0;
      try {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const event = parseCodexProcessLine(line);
            if (event === null) skipped += 1;
            else yield event;
          }
        }
      } finally {
        // Drain stderr without exposing its content: it may contain
        // sensitive model output; only summary counts are reported.
        await stderrDrain;
      }
      const code = await child.exited;
      if (code !== 0) {
        throw new BaselineAdapterError(`codex-infinity exited with code ${code} (${skipped} skipped lines)`, "bridge-parse");
      }
      if (skipped > 0) {
        throw new BaselineAdapterError(
          `codex-infinity output contained ${skipped} line(s) in an unverified format; ` + "confirm the real JSONL schema before interpreting them",
          "bridge-parse"
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type BaselineBridgeDriver = ProcessDriver | "live" | null;

export type BaselineBridgeOptions = {
  config?: Partial<CodexInfinityBridgeConfig>;
  /** Deterministic driver for tests; `"live"` = opt-in subprocess path. */
  driver?: BaselineBridgeDriver;
};

export function createBaselineB(options: BaselineBridgeOptions = {}): BenchmarkAdapter {
  const config: CodexInfinityBridgeConfig = { ...DEFAULT_BRIDGE_CONFIG, ...options.config };
  const driver = options.driver ?? null;

  return {
    configId: "B",
    name: "codex-infinity-bridge",
    description:
      "codex-infinity-compatible process/trajectory bridge (pinned source/provenance, no clone and no " +
      "live process by default; live runs require allowLiveProcess and an approved gate).",
    requiresExternalInference: true,
    async run(ctx: AdapterRunContext): Promise<void> {
      let active: ProcessDriver;
      if (driver === null) {
        throw new BaselineNotProvisionedError(
          "codex-infinity bridge is not provisioned: this adapter never clones or spawns a process by " +
            "default. Provide a deterministic driver (tests) or configure allowLiveProcess plus a pinned " +
            `checkout at ${CODEX_INFINITY_SOURCE_PIN.pinnedRef}.`
        );
      } else if (driver === "live") {
        if (!config.allowLiveProcess) {
          throw new BaselineAdapterError("live codex-infinity process is refused: allowLiveProcess must be true before a subprocess may run", "invalid-config");
        }
        if (config.checkoutPath !== null) await assertPinnedCheckout(config.checkoutPath);
        active = createLiveBridgeProcessDriver(config);
      } else {
        active = driver;
      }

      for await (const raw of drain(active.run({ task: ctx.task, workspace: ctx.workspace, signal: ctx.signal }))) {
        if (ctx.signal.aborted) throw new TaskTimeoutError(ctx.task.timeout_ms);
        if (raw.kind === "tool_call") ctx.checkToolLimit();
        ctx.record(bridgeEventToTrajectory(raw, ctx.time()));
      }
    },
  };
}

/** Default instance: inert bridge, refused by the runner. */
export const adapterB: BenchmarkAdapter = createBaselineB();

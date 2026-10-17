/**
 * m05 evidence CLI: full-transcript versus structured-state context
 * comparison, and compact-versus-broad tool-surface comparison.
 *
 * Deterministic and hermetic: it replays every task through the built-in
 * `reference` adapter (no external inference) and derives the evidence from
 * the recorded trajectories.  For every task and every budget tier
 * (short / medium / large) it reports:
 *
 * - the estimated token cost of the FULL transcript replay,
 * - the estimated cost after transcript compaction (`context.ts`),
 * - the estimated cost of the STRUCTURED state context (state summary +
 *   recent tail, exactly what the canonical harness sends in structured
 *   mode),
 * - whether the compaction preserved the structured-state contract
 *   (`stateContract` equality of the full and compacted replays).
 *
 * Usage (from the repository root):
 *
 *   bun --no-env-file \
 *     benchmarks/compare.ts [--tasks=*] [--runs=benchmark-runs]
 *
 * Output is deterministic JSON on stdout (plus a short human summary).
 */

import { type Conversation, createConversation } from "../src/harmony/conversation.ts";
import type { ConversationTurn } from "../src/harmony/types.ts";
import {
  COMPACTION_POLICIES,
  compactTranscript,
  type ContextBudgetKind,
  estimateConversationTokens,
  estimateTokens,
  parseToolResultContent,
  renderStructuredContext,
  serializeToolResultContent,
} from "../src/harmony/reliability/context.ts";
import { broadToolSurface, compactToolSurface, surfaceTokenCost } from "../src/harmony/reliability/surfaces.ts";
import { deriveStateWithMeta, type ReliabilityRun, replayMeta, stateContract } from "../src/harmony/reliability/state.ts";
import { DEFAULT_VERIFICATION_POLICY, type VerificationPolicy } from "../src/harmony/reliability/verify.ts";
import { referenceAdapter } from "./adapter.ts";
import { loadTasks, selectTasks } from "./manifest.ts";
import { finalsFromEvents, observationsFromEvents } from "./reliability.ts";
import { runOne } from "./runner.ts";
import { BENCHMARK_ROOT, BENCHMARK_SCHEMA_VERSION, DEFAULT_RUNS_ROOT, type TaskManifest, type TrajectoryEvent } from "./schemas.ts";

const TAIL_TURNS: Readonly<Record<ContextBudgetKind, number>> = { short: 2, medium: 4, large: 8 };

export type BudgetEvidence = {
  budget: ContextBudgetKind;
  target_tokens: number;
  full_transcript_tokens: number;
  compaction_tokens: number;
  structured_tokens: number;
  compaction_drops: { reads: number; explore: number; analysis_turns: number };
  compaction_met_budget: boolean;
  structured_met_budget: boolean;
  contract_preserved: boolean;
};

export type TaskContextEvidence = {
  task_id: string;
  tool_calls: number;
  full_transcript_tokens: number;
  surfaces: { id: string; tools: number; tokens: number }[];
  budgets: BudgetEvidence[];
};

export type ContextEvidence = {
  schema_version: string;
  mode: "deterministic";
  generated_at: string;
  tasks: TaskContextEvidence[];
  aggregate: Record<
    ContextBudgetKind,
    {
      tasks: number;
      contract_preserved: number;
      compaction_met_budget: number;
      structured_met_budget: number;
      full_tokens: number;
      compaction_tokens: number;
      structured_tokens: number;
      compaction_ratio: number;
      structured_ratio: number;
    }
  >;
  surfaces: { id: string; tools: number; tokens: number }[];
};

/** Builds the model-facing conversation from a recorded trajectory. */
export function conversationFromEvents(events: readonly TrajectoryEvent[]): Conversation {
  const turns: ConversationTurn[] = [];
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const result = events.find((e): e is Extract<TrajectoryEvent, { type: "tool_result" }> => e.type === "tool_result" && e.id === event.id);
    turns.push({
      role: "assistant",
      content: null,
      analysis: [],
      toolCalls: [
        {
          id: event.id,
          name: event.tool,
          arguments: JSON.stringify(event.arguments),
        },
      ],
      finishReason: "tool_calls",
    });
    turns.push({
      role: "tool",
      toolCallId: event.id,
      name: event.tool,
      content: serializeToolResultContent({
        ok: result?.ok ?? false,
        output: result?.output ?? null,
        error: result?.error ?? null,
        error_code: result?.error_code ?? null,
      }),
    });
  }
  return createConversation(turns);
}

/** Extracts observations from a conversation (pair order = observation order). */
export function observationsFromConversation(conversation: Conversation): ReturnType<typeof observationsFromEvents> {
  const observations: ReturnType<typeof observationsFromEvents> = [];
  let seq = 0;
  const turns = conversation.turns;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== "assistant" || turn.toolCalls.length !== 1) continue;
    const call = turn.toolCalls[0];
    const next = turns.at(i + 1);
    if (next?.role !== "tool" || next.toolCallId !== call.id) continue;
    const parsed = parseToolResultContent(next.content);
    seq += 1;
    observations.push({
      seq,
      tool: call.name,
      args: parseJson(call.arguments) ?? {},
      valid: true,
      result: parsed,
    });
  }
  return observations;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  return null;
}

/** Builds the deterministic m05 evidence for one task run. */
export function buildTaskEvidence(task: TaskManifest, events: readonly TrajectoryEvent[]): TaskContextEvidence {
  const policy: VerificationPolicy = {
    ...DEFAULT_VERIFICATION_POLICY,
    verificationCommand: task.verify?.command ?? null,
  };
  const conversation = conversationFromEvents(events);
  const observations = observationsFromEvents(events);
  const finals = finalsFromEvents(events);
  const modelCalls = events.filter((e) => e.type === "model_request").length;
  const fullRun: ReliabilityRun = { observations, finals, modelCalls };
  const fullMeta = replayMeta(observations, policy);
  const fullState = deriveStateWithMeta(fullRun, fullMeta);
  const fullContract = stateContract(fullState);
  const fullTokens = estimateConversationTokens(conversation) + surfaceTokenCost(compactToolSurface());

  const surfaces = [
    {
      id: "compact" as const,
      tools: compactToolSurface().definitions.length,
      tokens: surfaceTokenCost(compactToolSurface()),
    },
    {
      id: "broad" as const,
      tools: broadToolSurface().definitions.length,
      tokens: surfaceTokenCost(broadToolSurface()),
    },
  ];

  const budgets: BudgetEvidence[] = [];
  for (const kind of ["short", "medium", "large"] as const) {
    const policyFor = COMPACTION_POLICIES[kind];
    const compacted = compactTranscript(conversation, { budget: kind });
    const compactedObservations = observationsFromConversation(compacted.conversation);
    const compactedState = deriveStateWithMeta({ observations: compactedObservations, finals, modelCalls }, replayMeta(compactedObservations, policy));
    const structured = renderStructuredContext(fullState, conversation, { maxTailTurns: TAIL_TURNS[kind] });
    const structuredTokens = estimateTokens(structured) + surfaceTokenCost(compactToolSurface());
    const reads = compacted.drops.filter((d) => d.kind === "stale_read").length;
    const explore = compacted.drops.filter((d) => d.kind === "old_explore").length;
    const analysis = compacted.drops.filter((d) => d.kind === "analysis").length;
    budgets.push({
      budget: kind,
      target_tokens: policyFor.targetTokens,
      full_transcript_tokens: fullTokens,
      compaction_tokens: compacted.estimatedTokens + surfaceTokenCost(compactToolSurface()),
      structured_tokens: structuredTokens,
      compaction_drops: { reads, explore, analysis_turns: analysis },
      compaction_met_budget: compacted.metBudget,
      structured_met_budget: structuredTokens <= policyFor.targetTokens,
      contract_preserved: stateContract(compactedState) === fullContract,
    });
  }
  return {
    task_id: task.id,
    tool_calls: observations.length,
    full_transcript_tokens: fullTokens,
    surfaces,
    budgets,
  };
}

/** Builds the full evidence document for a set of tasks (hermetic). */
export async function buildContextEvidence(tasks: readonly TaskManifest[], runsRoot: string = DEFAULT_RUNS_ROOT): Promise<ContextEvidence> {
  const fixturesDir = `${BENCHMARK_ROOT}/fixtures`;
  const tasksDir = `${BENCHMARK_ROOT}/tasks`;
  const evidence: TaskContextEvidence[] = [];
  for (const task of tasks) {
    const { events } = await runOne(task, referenceAdapter, {
      configs: ["reference"],
      taskSelectors: [task.id],
      runsRoot,
      tasksDir,
      fixturesDir,
    });
    evidence.push(buildTaskEvidence(task, events));
  }

  const aggregate = {} as ContextEvidence["aggregate"];
  for (const kind of ["short", "medium", "large"] as const) {
    const perKind = evidence.map((t) => {
      const budget = t.budgets.find((b) => b.budget === kind);
      if (budget === undefined) throw new Error(`task ${t.task_id} has no ${kind} budget evidence`);
      return budget;
    });
    const sum = (fn: (b: (typeof perKind)[number]) => number) => perKind.reduce((n, b) => n + fn(b), 0);
    aggregate[kind] = {
      tasks: perKind.length,
      contract_preserved: sum((b) => (b.contract_preserved ? 1 : 0)),
      compaction_met_budget: sum((b) => (b.compaction_met_budget ? 1 : 0)),
      structured_met_budget: sum((b) => (b.structured_met_budget ? 1 : 0)),
      full_tokens: sum((b) => b.full_transcript_tokens),
      compaction_tokens: sum((b) => b.compaction_tokens),
      structured_tokens: sum((b) => b.structured_tokens),
      compaction_ratio: sum((b) => b.full_transcript_tokens) === 0 ? 0 : sum((b) => b.compaction_tokens) / sum((b) => b.full_transcript_tokens),
      structured_ratio: sum((b) => b.full_transcript_tokens) === 0 ? 0 : sum((b) => b.structured_tokens) / sum((b) => b.full_transcript_tokens),
    };
  }
  return {
    schema_version: BENCHMARK_SCHEMA_VERSION,
    mode: "deterministic",
    generated_at: new Date().toISOString(),
    tasks: evidence,
    aggregate,
    surfaces: [
      {
        id: "compact",
        tools: compactToolSurface().definitions.length,
        tokens: surfaceTokenCost(compactToolSurface()),
      },
      {
        id: "broad",
        tools: broadToolSurface().definitions.length,
        tokens: surfaceTokenCost(broadToolSurface()),
      },
    ],
  };
}

function formatEvidence(evidence: ContextEvidence): string {
  const lines: string[] = [];
  lines.push(`mode: ${evidence.mode}  tasks: ${evidence.tasks.length}`);
  const surface = evidence.surfaces.find((s) => s.id === "compact");
  const broad = evidence.surfaces.find((s) => s.id === "broad");
  if (surface === undefined || broad === undefined) throw new Error("context evidence is missing its compact or broad tool-surface entry");
  lines.push(`surfaces: compact ${surface.tools} tools / ${surface.tokens} tok; broad ${broad.tools} tools / ${broad.tokens} tok`);
  lines.push("");
  lines.push("budget  contract  comp-met  struct-met  full  comp   struct  comp/full  struct/full");
  for (const kind of ["short", "medium", "large"] as const) {
    const a = evidence.aggregate[kind];
    lines.push(
      `${kind.padEnd(7)} ${String(a.contract_preserved).padEnd(8)} ${String(a.compaction_met_budget).padEnd(9)} ` +
        `${String(a.structured_met_budget).padEnd(10)} ${String(a.full_tokens).padEnd(7)} ${String(a.compaction_tokens).padEnd(6)} ` +
        `${String(a.structured_tokens).padEnd(7)} ${(a.compaction_ratio * 100).toFixed(0).padEnd(9)}% ${(a.structured_ratio * 100).toFixed(0)}%`
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseCompareArgs(argv: string[]): { taskSelectors: string[]; runsRoot: string } | { help: true } {
  if (argv[0] === "--") argv = argv.slice(1);
  const opts = { taskSelectors: ["*"] as string[], runsRoot: DEFAULT_RUNS_ROOT };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg.startsWith("--tasks=")) opts.taskSelectors = arg.slice("--tasks=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--runs=")) opts.runsRoot = arg.slice("--runs=".length);
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

if (import.meta.main) {
  const parsed = parseCompareArgs(process.argv.slice(2));
  if ("help" in parsed) {
    console.log("usage: bun --no-env-file " + "benchmarks/compare.ts [--tasks=*] [--runs=benchmark-runs]");
    process.exit(0);
  }
  const tasks = loadTasks(`${BENCHMARK_ROOT}/tasks`);
  const selected = selectTasks(tasks, parsed.taskSelectors);
  const runsRoot = parsed.runsRoot;
  const evidence = await buildContextEvidence(selected, runsRoot);
  console.log(JSON.stringify(evidence, null, 2));
  console.error(formatEvidence(evidence));
}

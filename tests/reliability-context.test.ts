import { test } from "bun:test";
import assert from "node:assert/strict";

import { type Conversation, createConversation } from "../src/harmony/conversation.ts";
import type { ConversationTurn } from "../src/harmony/types.ts";
import {
  COMPACTION_POLICIES,
  compactTranscript,
  estimateConversationTokens,
  estimateTokens,
  extractPairs,
  parseToolResultContent,
  renderStructuredContext,
  serializeToolResultContent,
} from "../src/harmony/reliability/context.ts";
import { broadToolSurface, compactToolSurface, surfaceTokenCost } from "../src/harmony/reliability/surfaces.ts";
import { deriveStateWithMeta, replayMeta, stateContract, type ToolObservation } from "../src/harmony/reliability/state.ts";
import { DEFAULT_VERIFICATION_POLICY } from "../src/harmony/reliability/verify.ts";

let pairCounter = 0;
const pairTurns = (
  tool: string,
  args: Record<string, unknown>,
  result: { ok: boolean; output?: string; error?: string; error_code?: string }
): ConversationTurn[] => {
  const id = `ctx-${++pairCounter}`;
  return [
    {
      role: "assistant",
      content: null,
      analysis: [],
      toolCalls: [{ id, name: tool, arguments: JSON.stringify(args) }],
      finishReason: "tool_calls",
    },
    { role: "tool", toolCallId: id, name: tool, content: serializeToolResultContent(result) },
  ];
};

const scaffold = (): Conversation => {
  const turns: ConversationTurn[] = [{ role: "user", content: "Fix all files." }];
  const big = (path: string) => `${path}=1\n`.repeat(120); // ~720 chars per read
  turns.push(
    ...pairTurns(
      "task.update_plan",
      { plan: ["read", "edit", "verify"] },
      {
        ok: true,
        output: "plan updated (3 items)",
      }
    )
  );
  turns.push(
    ...pairTurns(
      "editor.apply_patch",
      { path: "a.txt", old: "a=0", new: "a=1" },
      {
        ok: true,
        output: "patched a.txt",
      }
    )
  );
  for (let i = 0; i < 6; i++) {
    turns.push(...pairTurns("filesystem.read", { path: "a.txt" }, { ok: true, output: big("a") }));
  }
  turns.push(
    ...pairTurns(
      "editor.apply_patch",
      { path: "b.txt", old: "b=0", new: "b=1" },
      {
        ok: true,
        output: "patched b.txt",
      }
    )
  );
  turns.push(...pairTurns("shell.exec", { command: "sh tests/run.sh" }, { ok: true, output: "ok" }));
  turns.push(...pairTurns("filesystem.find", { path: ".", pattern: "*.txt" }, { ok: true, output: "a.txt\nb.txt" }));
  turns.push(...pairTurns("filesystem.search", { path: ".", query: "a=1" }, { ok: true, output: "a.txt:1:a=1" }));
  turns.push(
    ...pairTurns(
      "editor.apply_patch",
      { path: "c.txt", old: "c=0", new: "c=1" },
      {
        ok: true,
        output: "patched c.txt",
      }
    )
  );
  for (let i = 0; i < 3; i++) {
    turns.push(...pairTurns("filesystem.read", { path: "c.txt" }, { ok: true, output: big("c") }));
  }
  turns.push(
    ...pairTurns(
      "shell.exec",
      { command: "grep -c c=1 c.txt" },
      {
        ok: false,
        error_code: "exec_failed",
        error: "grep: no match",
      }
    )
  );
  return createConversation(turns);
};

const policy = { ...DEFAULT_VERIFICATION_POLICY, verificationCommand: "sh tests/run.sh" };

function stateOf(conversation: Conversation) {
  const turns = conversation.turns;
  const observations: ToolObservation[] = [];
  let seq = 0;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== "assistant" || turn.toolCalls.length !== 1) continue;
    const call = turn.toolCalls[0];
    const next = turns.at(i + 1);
    if (next === undefined) continue;
    if (next.role !== "tool" || next.toolCallId !== call.id) continue;
    const parsed = parseToolResultContent(next.content);
    seq += 1;
    observations.push({
      seq,
      tool: call.name,
      args: JSON.parse(call.arguments) as Record<string, unknown>,
      valid: parsed !== null,
      result: parsed ?? { ok: false, error_code: "internal", error: "unparseable" },
    });
  }
  return deriveStateWithMeta({ observations, finals: [], modelCalls: 0 }, replayMeta(observations, policy));
}

test("context: token estimation is deterministic and monotone", () => {
  assert.equal(estimateTokens(""), 1);
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("a".repeat(4000)), 1000);
  assert.ok(estimateConversationTokens(scaffold()) > 0);
  assert.equal(estimateConversationTokens(scaffold()), estimateConversationTokens(scaffold()));
});

test("context: tool-result serialization round-trips", () => {
  const line = serializeToolResultContent({ ok: false, error_code: "duplicate_call", error: "dup", output: null });
  const parsed = parseToolResultContent(line);
  assert.ok(parsed);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "duplicate_call");
  assert.equal(parsed.error, "dup");
  assert.equal(parseToolResultContent("not json"), null);
});

test("context: short tier drops stale reads and old explore pairs", () => {
  const conversation = scaffold();
  const result = compactTranscript(conversation, { budget: "short" });
  const kinds = result.drops.map((d) => d.kind);
  assert.ok(kinds.includes("stale_read"), `expected stale_read drops in ${kinds.join(",")}`);
  assert.ok(kinds.includes("old_explore"), `expected old_explore drops in ${kinds.join(",")}`);
  assert.ok(result.droppedTurnCount > 0);
  const pairs = extractPairs(result.conversation);
  assert.ok(
    pairs.some((p) => p.tool === "shell.exec" && p.parsed?.ok === false),
    "errors must never be dropped"
  );
  assert.ok(pairs.filter((p) => p.tool === "editor.apply_patch").length === 3, "patch pairs must never be dropped");
  assert.ok(result.estimatedTokens < estimateConversationTokens(conversation));
});

test("context: compaction preserves the structured state contract at every budget", () => {
  const conversation = scaffold();
  const full = stateOf(conversation);
  const fullContract = stateContract(full);
  assert.equal(full.pendingVerification.length, 0, "scaffold ends verified");
  for (const kind of ["short", "medium", "large"] as const) {
    const compacted = compactTranscript(conversation, { budget: kind });
    const compactedContract = stateContract(stateOf(compacted.conversation));
    assert.equal(compactedContract, fullContract, `${kind} compaction must preserve the contract`);
  }
});

test("context: large keeps more reads per path than short", () => {
  const conversation = scaffold();
  const shortReads = compactTranscript(conversation, { budget: "short" }).drops.filter((d) => d.kind === "stale_read").length;
  const largeReads = compactTranscript(conversation, { budget: "large" }).drops.filter((d) => d.kind === "stale_read").length;
  assert.ok(shortReads > largeReads, `short ${shortReads} > large ${largeReads}`);
});

test("context: budgets are ordered and per-tier policies are stable", () => {
  assert.ok(COMPACTION_POLICIES.short.targetTokens < COMPACTION_POLICIES.medium.targetTokens);
  assert.ok(COMPACTION_POLICIES.medium.targetTokens < COMPACTION_POLICIES.large.targetTokens);
  assert.equal(COMPACTION_POLICIES.short.readsPerPath, 1);
  assert.equal(COMPACTION_POLICIES.large.readsPerPath, 2);
});

test("context: structured context is cheaper than a full transcript replay", () => {
  const conversation = scaffold();
  const state = stateOf(conversation);
  const full = estimateConversationTokens(conversation);
  const tailTurnsByKind = { short: 2, medium: 4, large: 8 } as const;
  for (const kind of ["short", "medium", "large"] as const) {
    const structured = renderStructuredContext(state, conversation, { maxTailTurns: tailTurnsByKind[kind] });
    const structuredTokens = estimateTokens(structured);
    assert.ok(structuredTokens < full, `${kind}: structured ${structuredTokens} < full ${full}`);
    assert.match(structured, /\[structured task state\]/);
    assert.match(structured, /phase: /);
  }
});

test("context: the broad experimental surface is larger than the compact one", () => {
  const compact = compactToolSurface();
  const broad = broadToolSurface();
  assert.equal(compact.definitions.length, 9);
  assert.equal(broad.definitions.length, 13);
  const compactTokens = surfaceTokenCost(compact);
  const broadTokens = surfaceTokenCost(broad);
  assert.ok(broadTokens > compactTokens);
  assert.ok(broad.definitions.some((tool) => tool.name === "filesystem.write"));
});

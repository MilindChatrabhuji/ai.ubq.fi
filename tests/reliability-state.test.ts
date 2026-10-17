import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  deriveStateWithMeta,
  emptyTaskState,
  reduceFinalAttempt,
  type ReliabilityRun,
  replayMeta,
  stateContract,
  stateFromRun,
  type ToolObservation,
} from "../src/harmony/reliability/state.ts";
import { DEFAULT_VERIFICATION_POLICY } from "../src/harmony/reliability/verify.ts";

const read = (seq: number, path: string, output: string): ToolObservation => ({
  seq,
  tool: "filesystem.read",
  args: { path },
  valid: true,
  result: { ok: true, output },
});
const patch = (seq: number, path: string, oldText: string, newText: string, ok = true): ToolObservation => ({
  seq,
  tool: "editor.apply_patch",
  args: { path, old: oldText, new: newText },
  valid: true,
  result: ok ? { ok: true, output: `patched ${path}` } : { ok: false, error_code: "patch_failed", error: "no match" },
});
const exec = (seq: number, command: string, ok: boolean): ToolObservation => ({
  seq,
  tool: "shell.exec",
  args: { command },
  valid: true,
  result: ok ? { ok: true, output: "ok" } : { ok: false, error_code: "exec_failed", error: "exit 1" },
});

const policy = { ...DEFAULT_VERIFICATION_POLICY, verificationCommand: "sh tests/run.sh" };

test("state: a verified edit run reaches phase done and a stable contract", () => {
  const run: ReliabilityRun = {
    observations: [
      read(1, "src/a.txt", "x=0"),
      patch(2, "src/a.txt", "x=0", "x=1"),
      read(3, "src/a.txt", "x=1"),
      {
        seq: 4,
        tool: "task.update_plan",
        args: { plan: ["read", "edit", "verify"] },
        valid: true,
        result: { ok: true, output: "plan updated (3 items)" },
      },
    ],
    finals: [{ content: "done", accepted: true, seq: 5 }],
    modelCalls: 6,
  };
  const state = stateFromRun(run);
  assert.equal(state.phase, "done");
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].verified, true);
  assert.equal(state.pendingVerification.length, 0);
  assert.equal(state.plan.items.length, 3);
  assert.equal(state.modelCalls, 6);
  assert.equal(typeof stateContract(state), "string");
  assert.equal(stateContract(state), stateContract({ ...state }));
});

test("state: unverified writes and unresolved failures surface in the contract", () => {
  const run: ReliabilityRun = {
    observations: [patch(1, "answer.txt", "", "answer", true), exec(2, "curl https://example.invalid", false)],
    finals: [{ content: "done", accepted: false, seq: 3 }],
    modelCalls: 2,
  };
  const state = stateFromRun(run);
  assert.equal(state.phase, "completing");
  assert.equal(state.pendingVerification.length, 1);
  assert.equal(state.unresolvedCommands.length, 1);
  assert.equal(state.finalAttempts, 1);
  const contract = stateContract(state);
  assert.match(contract, /"pendingVerification":\["answer\.txt"\]/);
});

test("state: the declared verification command satisfies pending writes in the replay", () => {
  const run: ReliabilityRun = {
    observations: [patch(1, "a.txt", "", "1", true), exec(2, "sh tests/run.sh", true)],
    finals: [],
    modelCalls: 0,
  };
  const meta = replayMeta(run.observations, policy);
  const state = deriveStateWithMeta(run, meta);
  assert.equal(state.writes[0].verified, true);
  assert.equal(state.writes[0].verifiedBy, "shell");
  assert.equal(state.pendingVerification.length, 0);
});

test("state: semantic loops stall the phase and count in the contract", () => {
  const observations: ToolObservation[] = [];
  let seq = 0;
  for (let i = 0; i < 8; i++) {
    observations.push(read(++seq, "x.txt", "same"));
    observations.push(exec(++seq, "pwd", true));
  }
  const state = stateFromRun({ observations, finals: [], modelCalls: 0 });
  // Effect repetition of the read closes a loop; the streak persists while
  // the alternating pattern repeats.
  assert.ok(state.semanticLoops >= 1, "expected a semantic loop, got 0");
  assert.ok(state.semanticLoopStreak >= 1, `expected streak, got ${state.semanticLoopStreak}`);
  assert.equal(state.phase, "stalled");
  assert.ok(state.semanticLoops >= 1, "loop counters live on the structured state");
  // Diagnostic counters are excluded from the durable-state contract by design.
  const contract = stateContract(state);
  assert.equal(contract.includes("semanticLoops"), false);
});

test("state: invalid calls never produce verification or write records", () => {
  const run: ReliabilityRun = {
    observations: [
      {
        seq: 1,
        tool: "filesystem.read",
        args: { path: 42 },
        valid: false,
        result: { ok: false, error_code: "invalid_args", error: "invalid arguments (1 issue(s))" },
      },
      { seq: 2, tool: "filesystem.read", args: { path: "a.txt" }, valid: true, result: { ok: true, output: "data" } },
    ],
    finals: [],
    modelCalls: 1,
  };
  const state = stateFromRun(run);
  assert.equal(state.invalidCalls, 1);
  assert.equal(state.invalidCallStreak, 0); // trailing valid call resets it
  assert.equal(state.reads.length, 1);
});

test("state: reduceFinalAttempt sorts finals and marks done", () => {
  let state = emptyTaskState();
  state = reduceFinalAttempt(state, { content: "one", accepted: false, seq: 5 });
  state = reduceFinalAttempt(state, { content: "two", accepted: true, seq: 6 });
  assert.equal(state.phase, "done");
  assert.equal(state.finalAttempts, 2);
  assert.equal(state.finals[0].content, "one");
  assert.equal(state.finals[1].accepted, true);
});

test("state: replayed duplicates are counted from the observation stream", () => {
  const run: ReliabilityRun = {
    observations: [read(1, "x", "v"), read(2, "x", "v")],
    finals: [],
    modelCalls: 0,
  };
  const state = stateFromRun(run);
  assert.equal(state.duplicateCalls, 1);
});

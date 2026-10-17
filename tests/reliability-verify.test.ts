import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  DEFAULT_VERIFICATION_POLICY,
  type FinalAttempt,
  GUARD_PREFIX,
  guardFinal,
  renderGuardRequirements,
  type VerificationPolicy,
  VerificationTracker,
} from "../src/harmony/reliability/verify.ts";

const patchOk = (path: string) => ({
  ok: true,
  output: `patched ${path}`,
});
const readOk = (content: string) => ({ ok: true, output: content });
const execOk = () => ({ ok: true, output: "done" });
const execFail = () => ({ ok: false, output: "", error_code: "exec_failed", error: "exit 1" });

function guard(policy: VerificationPolicy, tracker: VerificationTracker, opts: Partial<Parameters<typeof guardFinal>[0]> = {}) {
  const previousFinals: readonly FinalAttempt[] = opts.previousFinals ?? [];
  return guardFinal({
    finalContent: opts.finalContent ?? "done",
    lastActionSeq: opts.lastActionSeq ?? 0,
    previousFinals,
    semanticLoopStreak: opts.semanticLoopStreak ?? 0,
    planUpdated: opts.planUpdated ?? true,
    writes: opts.writes ?? 0,
    tracker,
    policy,
  });
}

test("verify: a patch creates a pending verification satisfied by a later read with the marker", () => {
  const tracker = new VerificationTracker();
  tracker.observe("editor.apply_patch", { path: "a.txt", old: "x", new: "y" }, patchOk("a.txt"));
  assert.equal(tracker.pending().length, 1);
  const resolution = tracker.observe("filesystem.read", { path: "a.txt" }, readOk("y now here"));
  assert.deepEqual(resolution, { kind: "read", paths: ["a.txt"] });
  assert.equal(tracker.allVerified(), true);
});

test("verify: a read without the marker does not satisfy a pending write", () => {
  const tracker = new VerificationTracker();
  tracker.observe("editor.apply_patch", { path: "a.txt", old: "x", new: "y" }, patchOk("a.txt"));
  assert.equal(tracker.observe("filesystem.read", { path: "a.txt" }, readOk("nothing relevant")), null);
  assert.equal(tracker.pending().length, 1);
});

test("verify: the declared verification command satisfies all pending writes", () => {
  const tracker = new VerificationTracker({ ...DEFAULT_VERIFICATION_POLICY, verificationCommand: "sh tests/run.sh" });
  tracker.observe("editor.apply_patch", { path: "a.txt", add: true, new: "1" }, patchOk("a.txt"));
  tracker.observe("editor.apply_patch", { path: "b.txt", add: true, new: "2" }, patchOk("b.txt"));
  const resolution = tracker.observe("shell.exec", { command: "sh tests/run.sh" }, execOk());
  assert.deepEqual(resolution, { kind: "shell", paths: ["a.txt", "b.txt"] });
  assert.equal(tracker.allVerified(), true);
});

test("verify: a failed shell command is unresolved until a later successful command", () => {
  const tracker = new VerificationTracker();
  tracker.observe("shell.exec", { command: "grep -z nope file" }, execFail());
  assert.equal(tracker.unresolvedCommands().length, 1);
  tracker.observe("shell.exec", { command: "true" }, execOk());
  assert.equal(tracker.unresolvedCommands().length, 0);
});

test("verify: a failed patch is unresolved until the same path is written successfully", () => {
  const tracker = new VerificationTracker();
  tracker.observe("editor.apply_patch", { path: "a.txt", old: "missing", new: "y" }, { ok: false, error_code: "patch_failed", error: "old text not found" });
  assert.equal(tracker.unresolvedEdits().length, 1);
  tracker.observe("editor.apply_patch", { path: "a.txt", add: true, new: "y" }, patchOk("a.txt"));
  assert.equal(tracker.unresolvedEdits().length, 0);
});

test("verify: guard rejects a final with unverified writes and lists the requirement", () => {
  const tracker = new VerificationTracker();
  tracker.observe("editor.apply_patch", { path: "answer.txt", add: true, new: "42" }, patchOk("answer.txt"));
  const decision = guard(DEFAULT_VERIFICATION_POLICY, tracker);
  assert.equal(decision.allowed, false);
  assert.equal(decision.requirements[0].kind, "unverified_write");
  assert.equal(decision.requirements[0].path, "answer.txt");
  assert.match(renderGuardRequirements(decision.requirements), /unverified write: answer\.txt/);
});

test("verify: guard allows a final when everything is verified", () => {
  const tracker = new VerificationTracker();
  tracker.observe("editor.apply_patch", { path: "a.txt", add: true, new: "42" }, patchOk("a.txt"));
  tracker.observe("filesystem.read", { path: "a.txt" }, readOk("42"));
  const decision = guard(DEFAULT_VERIFICATION_POLICY, tracker);
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.requirements, []);
});

test("verify: unresolved command and edit failures block the final", () => {
  const tracker = new VerificationTracker();
  tracker.observe("shell.exec", { command: "curl example" }, execFail());
  tracker.observe("editor.apply_patch", { path: "b.txt", old: "nope", new: "y" }, { ok: false, error_code: "patch_failed", error: "not found" });
  const decision = guard(DEFAULT_VERIFICATION_POLICY, tracker);
  assert.equal(decision.allowed, false);
  const kinds = decision.requirements.map((r) => r.kind);
  assert.ok(kinds.includes("unresolved_command"));
  assert.ok(kinds.includes("unresolved_edit"));
});

test("verify: an active semantic loop blocks the final", () => {
  const tracker = new VerificationTracker();
  const decision = guard(DEFAULT_VERIFICATION_POLICY, tracker, { semanticLoopStreak: 3 });
  assert.equal(decision.allowed, false);
  assert.ok(decision.requirements.some((r) => r.kind === "active_loop"));
});

test("verify: a repeated final with no intervening action is a false completion", () => {
  const tracker = new VerificationTracker();
  const policy = DEFAULT_VERIFICATION_POLICY;
  const first = guard(policy, tracker); // rejected (nothing to verify here? pending empty => allowed)
  assert.equal(first.allowed, true);
  assert.equal(first.attempt.repetitions, 0);
  // Build the repeated-final case explicitly: first attempt rejected, same seq.
  const rejected: FinalAttempt = { content: "done", rejected: true, lastActionSeq: 0, repetitions: 0 };
  const second = guard(policy, tracker, { previousFinals: [rejected], lastActionSeq: 0 });
  assert.equal(second.allowed, false);
  assert.equal(second.falseCompletion, true);
  assert.ok(second.requirements.some((r) => r.kind === "false_completion"));
  assert.equal(second.attempt.repetitions, 1);
});

test("verify: requeued writes supersede earlier pending state per path", () => {
  const tracker = new VerificationTracker();
  tracker.observe("editor.apply_patch", { path: "a.txt", old: "x", new: "y" }, patchOk("a.txt"));
  tracker.observe("editor.apply_patch", { path: "a.txt", old: "y", new: "z" }, patchOk("a.txt"));
  assert.equal(tracker.pending().length, 1);
  assert.equal(tracker.pending()[0].marker, "z");
});

test("verify: the guard prefix is stable", () => {
  assert.equal(GUARD_PREFIX, "[guard] final answer rejected");
});

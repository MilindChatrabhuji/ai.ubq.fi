import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  callIdentity,
  canonicalArgs,
  canonicalize,
  effectDigest,
  effectSignature,
  LoopDetector,
  renderLoopFeedback,
} from "../src/harmony/reliability/loops.ts";

const ok = (output = "content") => ({ ok: true, output });
// The wire field stays `error_code`; the parameter itself follows the repo's naming convention.
const fail = (errorCode: string, error = "boom") => ({ ok: false, error_code: errorCode, error });

test("loops: canonical arguments are order-independent and nested", () => {
  assert.equal(canonicalArgs({ b: 1, a: 2 }), canonicalArgs({ a: 2, b: 1 }));
  assert.equal(canonicalArgs({ a: { y: 1, x: 2 } }), canonicalArgs({ a: { x: 2, y: 1 } }));
  assert.equal(JSON.stringify(canonicalize(["b", "a"])), JSON.stringify(["b", "a"])); // arrays keep order
});

test("loops: call identity and effect digests are deterministic", () => {
  const a = callIdentity("filesystem.read", { path: "x" });
  const b = callIdentity("filesystem.read", { path: "x" });
  assert.equal(a, b);
  assert.notEqual(a, callIdentity("filesystem.read", { path: "y" }));
  assert.equal(effectDigest(ok("same")), effectDigest(ok("same")));
  assert.notEqual(effectDigest(ok("same")), effectDigest(ok("other")));
  assert.equal(effectSignature("filesystem.read", { path: "x" }, ok("c")), effectSignature("filesystem.read", { path: "x" }, ok("c")));
});

test("loops: adjacent identical call after success is flagged as repeat_after_success", () => {
  const detector = new LoopDetector();
  detector.observe("filesystem.read", { path: "x" }, ok("v"));
  const dup = detector.checkDuplicate("filesystem.read", { path: "x" });
  assert.equal(dup, "repeat_after_success");
  const flags = detector.observe("filesystem.read", { path: "x" }, ok("v"));
  assert.equal(flags.duplicate, "repeat_after_success");
  assert.equal(flags.semanticLoop, false);
});

test("loops: adjacent call after a failure is exact_adjacent (retry, not duplication)", () => {
  const detector = new LoopDetector();
  detector.observe("shell.exec", { command: "false" }, fail("exec_failed"));
  const dup = detector.checkDuplicate("shell.exec", { command: "false" });
  assert.equal(dup, "exact_adjacent");
  const flags = detector.observe("shell.exec", { command: "false" }, fail("exec_failed"));
  assert.equal(flags.duplicate, "exact_adjacent");
});

test("loops: a different call is never flagged", () => {
  const detector = new LoopDetector();
  detector.observe("filesystem.read", { path: "x" }, ok("v"));
  assert.equal(detector.checkDuplicate("filesystem.read", { path: "y" }), null);
  const flags = detector.observe("filesystem.read", { path: "y" }, ok("w"));
  assert.equal(flags.duplicate, null);
  assert.equal(flags.semanticLoop, false);
});

test("loops: effect repetition inside the window closes a semantic loop", () => {
  const detector = new LoopDetector();
  // Same action + same effect three times => effect_repeat at the third read.
  detector.observe("filesystem.read", { path: "x" }, ok("v"));
  detector.observe("shell.exec", { command: "ls" }, ok("list"));
  detector.observe("filesystem.read", { path: "x" }, ok("v"));
  assert.equal(detector.observe("shell.exec", { command: "ls" }, ok("list")).semanticLoop, false);
  const fifth = detector.observe("filesystem.read", { path: "x" }, ok("v"));
  assert.equal(fifth.semanticLoop, true);
  assert.equal(fifth.loopKind, "effect_repeat");
  assert.equal(fifth.streak, 1);
});

test("loops: alternating pattern recurrence closes a loop and tracks streak", () => {
  const detector = new LoopDetector({ patternLength: 2, window: 8 });
  const reads = () => detector.observe("filesystem.read", { path: "x" }, ok("v"));
  const patches = () => detector.observe("editor.apply_patch", { path: "y", old: "nope", new: "z" }, fail("patch_failed"));
  // R P R P => at the 4th call the last-2 pattern repeats the previous 2.
  reads();
  patches();
  reads();
  const fourth = patches();
  assert.equal(fourth.semanticLoop, true);
  assert.equal(fourth.loopKind, "pattern_recurrence");
  const fifth = reads();
  assert.equal(fifth.semanticLoop, true); // effect_repeat keeps the streak
  assert.equal(fifth.streak, 2);
});

test("loops: breaking the pattern resets the streak", () => {
  const detector = new LoopDetector({ patternLength: 2, window: 8 });
  const reads = () => detector.observe("filesystem.read", { path: "x" }, ok("v"));
  const patches = () => detector.observe("editor.apply_patch", { path: "y", old: "nope", new: "z" }, fail("patch_failed"));
  reads();
  patches();
  reads();
  patches();
  const fix = detector.observe("editor.apply_patch", { path: "y", old: "x", new: "z" }, ok("patched y"));
  assert.equal(fix.semanticLoop, false);
  assert.equal(fix.streak, 0);
});

test("loops: repeated guard rejections are detected as a loop themselves", () => {
  const detector = new LoopDetector();
  detector.observe("filesystem.read", { path: "x" }, ok("v"));
  detector.observe("filesystem.read", { path: "x" }, { ok: false, error_code: "duplicate_call", error: "dup" });
  detector.observe("filesystem.read", { path: "x" }, { ok: false, error_code: "duplicate_call", error: "dup" });
  const third = detector.observe(
    "filesystem.read",
    { path: "x" },
    {
      ok: false,
      error_code: "duplicate_call",
      error: "dup",
    }
  );
  assert.equal(third.semanticLoop, true);
});

test("loops: renderLoopFeedback is deterministic and only for loops", () => {
  const detector = new LoopDetector({ patternLength: 2, window: 8 });
  detector.observe("filesystem.read", { path: "x" }, ok("v"));
  detector.observe("shell.exec", { command: "pwd" }, ok("."));
  detector.observe("filesystem.read", { path: "x" }, ok("v"));
  detector.observe("shell.exec", { command: "pwd" }, ok("."));
  const other = detector.observe("filesystem.read", { path: "x" }, ok("v"));
  assert.equal(other.semanticLoop, true);
  assert.notEqual(other.loopKind, null);
  const text = renderLoopFeedback(other);
  assert.match(text, /semantic loop detected/);
});

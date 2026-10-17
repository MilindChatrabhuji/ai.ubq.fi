import { test } from "bun:test";
import assert from "node:assert/strict";

import { invalidCallLabel, renderValidationFeedback, validateToolArgumentsDetailed } from "../src/harmony/reliability/feedback.ts";

test("feedback: a fully valid call has no issues", () => {
  const result = validateToolArgumentsDetailed("filesystem.read", { path: "docs/spec.txt" });
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.arguments, { path: "docs/spec.txt" });
});

test("feedback: reports every issue at once with stable codes and hints", () => {
  const result = validateToolArgumentsDetailed("filesystem.read", { path: 42, file: "x" });
  assert.equal(result.valid, false);
  const codes = result.issues.map((i) => i.code);
  assert.ok(codes.includes("wrong_type"), `expected wrong_type, got ${codes.join(",")}`);
  assert.ok(codes.includes("unexpected_argument"), `expected unexpected_argument, got ${codes.join(",")}`);
  const unexpected = result.issues.find((i) => i.code === "unexpected_argument");
  assert.ok(unexpected, "expected an unexpected_argument issue");
  assert.match(unexpected.hint, /allowed: path/);
  const wrongType = result.issues.find((i) => i.code === "wrong_type");
  assert.ok(wrongType, "expected a wrong_type issue");
  assert.match(wrongType.message, /must be a string/);
});

test("feedback: required, non-empty and undefined rules are enforced", () => {
  const missing = validateToolArgumentsDetailed("shell.exec", {});
  assert.equal(missing.valid, false);
  assert.equal(missing.issues[0].code, "missing_required");
  assert.match(missing.issues[0].hint, /command/);

  const empty = validateToolArgumentsDetailed("shell.exec", { command: "" });
  assert.equal(empty.valid, false);
  assert.equal(empty.issues[0].code, "non_empty");

  const undefinedArg = validateToolArgumentsDetailed("filesystem.read", { path: "a", pattern: undefined });
  assert.equal(undefinedArg.valid, false);
  assert.ok(undefinedArg.issues.some((i) => i.code === "unexpected_argument"));
});

test("feedback: plan arrays validate item by item", () => {
  const bad = validateToolArgumentsDetailed("task.update_plan", { plan: ["ok", ""] });
  assert.equal(bad.valid, false);
  assert.equal(bad.issues[0].code, "bad_array_item");
  assert.match(bad.issues[0].location, /plan\[1\]/);
  const good = validateToolArgumentsDetailed("task.update_plan", { plan: ["a", "b"] });
  assert.equal(good.valid, true);
});

test("feedback: unknown tools produce one deterministic issue", () => {
  const result = validateToolArgumentsDetailed("filesystem.write", { path: "x" });
  assert.equal(result.valid, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, "unknown_tool");
  assert.match(result.issues[0].hint, /filesystem\.read/);
});

test("feedback: non-object arguments are rejected deterministically", () => {
  const result = validateToolArgumentsDetailed("filesystem.read", "not-an-object");
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].code, "not_an_object");
});

test("feedback: rendered feedback is one deterministic line with every issue", () => {
  const result = validateToolArgumentsDetailed("filesystem.read", { path: 42, file: "x" });
  const rendered = renderValidationFeedback("filesystem.read", result);
  assert.match(rendered, /^invalid arguments \(2 issue\(s\)\)/);
  assert.match(rendered, /#1: /);
  assert.match(rendered, /#2: /);
  const again = renderValidationFeedback("filesystem.read", result);
  assert.equal(rendered, again);
});

test("feedback: invalidCallLabel is a stable short code", () => {
  const result = validateToolArgumentsDetailed("shell.exec", { command: "" });
  const label = invalidCallLabel(result);
  assert.match(label, /^non_empty:/);
});

import { test } from "bun:test";
import assert from "node:assert/strict";

import { type ToolDefinition } from "../src/harmony/types.ts";
import { normalizeToolStrictness } from "../src/harmony/adapter.ts";
import {
  assertCanonicalToolSchemas,
  CANONICAL_TOOL_DEFAULT_STRICTNESS,
  CANONICAL_TOOL_NAMES,
  lookupToolSchema,
  TOOL_SCHEMAS,
  toolDefinitions,
  toolParameterTypes,
  validateToolArguments,
} from "../src/harmony/tools/schemas.ts";

test("tool schemas: the canonical surface is exactly the nine compact tools", () => {
  assert.deepEqual(
    [...CANONICAL_TOOL_NAMES].sort((left, right) => left.localeCompare(right)),
    [
      "browser.find",
      "browser.open",
      "browser.search",
      "editor.apply_patch",
      "filesystem.find",
      "filesystem.read",
      "filesystem.search",
      "shell.exec",
      "task.update_plan",
    ]
  );
  assert.equal(lookupToolSchema("shell.exec")?.name, "shell.exec");
  assert.equal(lookupToolSchema("shell.execx"), null);
});

test("tool schemas: every schema is well-formed, bounded and strict-compatible", () => {
  const proof = assertCanonicalToolSchemas(true);
  // Optional parameters (apply_patch old/new/add, filesystem.find pattern) are
  // intentional, so the strict-mode proof must fail exactly on those two.
  assert.equal(proof.ok, false);

  assert.ok(["editor.apply_patch", "filesystem.find"].includes(proof.name));

  const nonStrict = assertCanonicalToolSchemas(false);
  if (!nonStrict.ok) throw new Error(`schemas not well-formed: ${nonStrict.name}: ${nonStrict.reason}`);
  assert.equal(nonStrict.names.length, 9);

  for (const tool of CANONICAL_TOOL_NAMES) {
    const schema = TOOL_SCHEMAS[tool];
    assert.equal(schema.name, tool);
    assert.ok(schema.description.length > 0, `${tool} needs a description`);
    const params = schema.parameters as Record<string, unknown>;
    assert.equal(params.type, "object");
    assert.equal(params.additionalProperties, false);
    const properties = params.properties as Record<string, Record<string, unknown>>;
    for (const [key, prop] of Object.entries(properties)) {
      if (prop.type === "string" || prop.type === "boolean") continue;
      if (prop.type === "array") {
        const items = prop.items as Record<string, unknown>;
        assert.equal(items.type, "string");
        continue;
      }
      throw new Error(`${tool}.${key} uses non-canonical type ${JSON.stringify(prop.type)}`);
    }
    const types = toolParameterTypes(schema);
    for (const key of Object.keys(properties)) {
      assert.ok(["string", "boolean", "string[]"].includes(types[key]), `${tool}.${key} type view`);
    }
  }
});

test("tool schemas: definitions expose m01 ToolDefinitions with uniform strictness", () => {
  const definitions = toolDefinitions();
  assert.equal(definitions.length, 9);
  for (const definition of definitions) {
    assert.equal(definition.strict, CANONICAL_TOOL_DEFAULT_STRICTNESS);
    assert.ok(TOOL_SCHEMAS[definition.name as keyof typeof TOOL_SCHEMAS], `${definition.name} registered`);
    assert.deepEqual(definition.parameters, TOOL_SCHEMAS[definition.name as keyof typeof TOOL_SCHEMAS].parameters);
  }
  const strictValues = new Set(definitions.map((d) => d.strict));
  assert.equal(strictValues.size, 1, "strictness must be uniform across the whole surface");

  const strict = toolDefinitions({ strict: true });
  assert.ok(strict.every((d) => d.strict === true));

  // Direct compat with the m01 adapter's normalization helper.
  const normalized = normalizeToolStrictness(definitions as ToolDefinition[], true);
  assert.ok(normalized.every((d) => d.strict === true));

  // The definitions are assignable to the m01 model-facing ToolDefinition type.
  const asM01: readonly ToolDefinition[] = definitions;
  assert.equal(asM01.length, 9);
});

const validExamples: Readonly<Record<string, Record<string, unknown>>> = {
  "filesystem.read": { path: "src/main.ts" },
  "filesystem.find": { path: "src", pattern: "**/*.ts" },
  "filesystem.search": { path: "src", query: "TODO" },
  "browser.search": { query: "harmony format" },
  "browser.open": { url: "https://example.com/index.html" },
  "browser.find": { query: "tool" },
  "shell.exec": { command: "sh tests/run.sh" },
  "editor.apply_patch": { path: "src/config.txt", old: "PORT = 8000", new: "PORT = 9000" },
  "task.update_plan": { plan: ["read the spec", "implement", "verify"] },
};

test("tool schemas: every canonical tool validates its documented argument shape", () => {
  for (const [tool, args] of Object.entries(validExamples)) {
    const result = validateToolArguments(tool, args);
    assert.equal(result.valid, true, `${tool} should accept ${JSON.stringify(args)}`);
    {
      assert.deepEqual(result.arguments, args);
    }
  }
  // Optional parameters stay optional.
  assert.equal(validateToolArguments("editor.apply_patch", { path: "a.txt", add: true, new: "x" }).valid, true);
  assert.equal(validateToolArguments("filesystem.find", { path: "docs" }).valid, true);
  assert.equal(validateToolArguments("task.update_plan", { plan: [] }).valid, true);
  // Empty old/new are meaningful (start-of-file insert), so they are allowed.
  assert.equal(validateToolArguments("editor.apply_patch", { path: "a.txt", old: "", new: "x" }).valid, true);
});

test("tool schemas: validation rejects unknown tools, unknown args, missing and mistyped args", () => {
  const cases: readonly { tool: string; args: unknown; reason: string }[] = [
    { tool: "ghost.action", args: {}, reason: "unknown tool" },
    { tool: "filesystem.read", args: 42, reason: "arguments must be an object" },
    { tool: "filesystem.read", args: { path: "a.txt", magic: 1 }, reason: "unexpected argument" },
    { tool: "filesystem.read", args: {}, reason: "missing required argument" },
    { tool: "filesystem.read", args: { path: 42 }, reason: "must be a string" },
    { tool: "filesystem.read", args: { path: "" }, reason: "must be a non-empty string" },
    { tool: "filesystem.find", args: { path: "docs", pattern: 7 }, reason: "must be a string" },
    { tool: "shell.exec", args: { command: "" }, reason: "must be a non-empty string" },
    { tool: "editor.apply_patch", args: { path: "a.txt", add: "yes" }, reason: "must be a boolean" },
    { tool: "task.update_plan", args: { plan: ["ok", ""] }, reason: "array of non-empty strings" },
    { tool: "task.update_plan", args: { plan: "nope" }, reason: "array of non-empty strings" },
  ];
  for (const { tool, args, reason } of cases) {
    const result = validateToolArguments(tool, args);
    assert.equal(result.valid, false, `${tool} should reject ${JSON.stringify(args)}`);
    {
      assert.ok(result.reason.includes(reason), `expected ${reason} in ${result.reason}`);
    }
  }
});

import { test } from "bun:test";
import assert from "node:assert/strict";

import { normalizeToolStrictness } from "../src/harmony/adapter.ts";
import { harmonyTypeFromJsonSchema, quoteString, renderDeveloperMessage, renderSystemMessage } from "../src/harmony/render.ts";
import { ANSWER_SCHEMA, NOTE_TOOL, WEATHER_TOOL } from "../src/harmony/probes.ts";

test("system message renders identity, dates, reasoning effort, channels and the tool note", () => {
  const rendered = renderSystemMessage({
    currentDate: "2025-06-28",
    reasoningEffort: "high",
  });
  assert.match(rendered, /^You are ChatGPT, a large language model trained by OpenAI\./);
  assert.match(rendered, /Knowledge cutoff: 2024-06/);
  assert.match(rendered, /Current date: 2025-06-28/);
  assert.match(rendered, /Reasoning: high/);
  assert.match(rendered, /# Valid channels: analysis, commentary, final\. Channel must be included for every message\./);
  assert.match(rendered, /Calls to these tools must go to the commentary channel: 'functions'\./);
});

test("system message omits the function-call note when no tools are exposed", () => {
  const rendered = renderSystemMessage({
    currentDate: "2025-06-28",
    reasoningEffort: "low",
    toolNamespace: null,
  });
  assert.match(rendered, /Reasoning: low/);
  assert.doesNotMatch(rendered, /must go to the commentary channel/);
});

test("developer message renders Harmony TypeScript tool definitions", () => {
  const rendered = renderDeveloperMessage({
    instructions: "You are a weather assistant.",
    tools: [WEATHER_TOOL],
  });
  assert.match(rendered, /# Instructions\n\nYou are a weather assistant\./);
  assert.match(rendered, /# Tools\n\n## functions\n\nnamespace functions \{/);
  assert.match(rendered, /\/\/ Gets the current weather in the provided location\./);
  assert.match(rendered, /type get_weather = \(_: \{/);
  assert.match(rendered, /\/\/ The city and state, e.g\. San Francisco, CA/);
  assert.match(rendered, /location: string,/);
  assert.match(rendered, /\} \/\/ namespace functions/);
});

test("developer message renders optional fields, enums and defaults", () => {
  const rendered = renderDeveloperMessage({
    instructions: "Use tools.",
    tools: [
      {
        name: "get_current_weather",
        description: "Gets the current weather in the provided location.",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string", description: "The city and state, e.g. San Francisco, CA" },
            format: { type: "string", enum: ["celsius", "fahrenheit"], default: "celsius" },
          },
          required: ["location"],
        },
      },
    ],
  });
  assert.match(rendered, /location: string,/);
  assert.match(rendered, /format\?: "celsius" \| "fahrenheit", \/\/ default: "celsius"/);
});

test("developer message renders a response format schema section", () => {
  const rendered = renderDeveloperMessage({
    instructions: "Return JSON.",
    responseFormat: { formatName: "answer_response", description: "The computed answer", schema: ANSWER_SCHEMA },
  });
  assert.match(rendered, /# Response Formats/);
  assert.match(rendered, /## answer_response/);
  assert.match(rendered, /\/\/ The computed answer/);
  assert.match(rendered, new RegExp(JSON.stringify(ANSWER_SCHEMA).slice(0, 24)));
});

test("harmonyTypeFromJsonSchema covers enums, arrays, anyOf and nested objects", () => {
  assert.equal(harmonyTypeFromJsonSchema({ type: "integer" }), "integer");
  assert.equal(harmonyTypeFromJsonSchema({ type: "string", enum: ["a", "b"] }), '"a" | "b"');
  assert.equal(harmonyTypeFromJsonSchema({ type: "array", items: { type: "string" } }), "string[]");
  assert.equal(harmonyTypeFromJsonSchema({ anyOf: [{ type: "string" }, { type: "integer" }] }), "string | integer");
  const nested = harmonyTypeFromJsonSchema({
    type: "object",
    properties: { inner: { type: "object", properties: { value: { type: "boolean" } }, required: ["value"] } },
    required: ["inner"],
  });
  assert.equal(nested, "{\n  inner: {\n    value: boolean,\n  },\n}");
});

test("unknown schema constructs degrade to any, never crash", () => {
  assert.equal(harmonyTypeFromJsonSchema("not a schema"), "any");
  assert.equal(harmonyTypeFromJsonSchema({ type: "object" }), "any");
  assert.equal(harmonyTypeFromJsonSchema({ type: "object", properties: {} }), "{}");
  assert.equal(harmonyTypeFromJsonSchema(null), "any");
});

test("quoteString escapes Harmony TS string literals", () => {
  assert.equal(quoteString('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteString("a\\b"), '"a\\\\b"');
});

test("normalizeToolStrictness forces one strictness value on every tool", () => {
  const mixed = [{ ...WEATHER_TOOL, strict: true } as const, NOTE_TOOL];
  const allFalse = normalizeToolStrictness(mixed, false);
  assert.equal(allFalse.length, 2);
  assert.ok(allFalse.every((tool) => tool.strict === false));
  const allTrue = normalizeToolStrictness(mixed, true);
  assert.ok(allTrue.every((tool) => tool.strict === true));
});

import { test } from "bun:test";
import assert from "node:assert/strict";

import { functionNameFromRecipient, harmonyTurnsFromMessages, normalizeToolArguments, parseHarmonyOutput } from "../src/harmony/parse.ts";

test("parses the documented analysis + final example", () => {
  const parsed = parseHarmonyOutput(
    '<|channel|>analysis<|message|>User asks: "What is 2 + 2?" Simple arithmetic. Provide answer.<|end|>\n' +
      "<|start|>assistant<|channel|>final<|message|>2 + 2 = 4.<|return|>"
  );
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.turns, [
    { kind: "reasoning", text: 'User asks: "What is 2 + 2?" Simple arithmetic. Provide answer.' },
    { kind: "final", text: "2 + 2 = 4." },
  ]);
});

test("parses the documented function-call example (recipient in the channel section)", () => {
  const parsed = parseHarmonyOutput(
    "<|channel|>analysis<|message|>Need to use function get_weather.<|end|>" +
      "<|start|>assistant<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>" +
      '{"location":"San Francisco"}<|call|>'
  );
  assert.deepEqual(parsed.turns, [
    { kind: "reasoning", text: "Need to use function get_weather." },
    {
      kind: "tool_call",
      recipient: "functions.get_weather",
      name: "get_weather",
      arguments: '{"location":"San Francisco"}',
    },
  ]);
});

test("parses the recipient in the role section (alternative header order)", () => {
  const parsed = parseHarmonyOutput('<|start|>assistant to=functions.get_weather <|constrain|>json<|message|>{"location":"SF"}<|call|>');
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.turns.length, 1);
  assert.deepEqual(parsed.turns[0], {
    kind: "tool_call",
    recipient: "functions.get_weather",
    name: "get_weather",
    arguments: '{"location":"SF"}',
  });
});

test("parses built-in tool recipients on the analysis channel", () => {
  const parsed = parseHarmonyOutput('<|start|>assistant<|channel|>analysis to=browser.search<|message|>{"query":"Harmony"}<|call|>');
  assert.deepEqual(parsed.turns, [
    {
      kind: "tool_call",
      recipient: "browser.search",
      name: "browser.search",
      arguments: '{"query":"Harmony"}',
    },
  ]);
});

test("parses commentary preambles followed by a call in one emission", () => {
  const parsed = parseHarmonyOutput(
    "<|channel|>analysis<|message|>long chain of thought<|end|>" +
      "<|start|>assistant<|channel|>commentary<|message|>**Action plan**:<|end|>" +
      "<|start|>assistant<|channel|>commentary to=functions.generate_file <|constrain|>json<|message|>" +
      '{"path":"index.html"}<|call|>'
  );
  assert.deepEqual(
    parsed.turns.map((turn) => turn.kind),
    ["reasoning", "commentary", "tool_call"]
  );
  assert.equal(parsed.turns[2].kind === "tool_call" ? parsed.turns[2].name : null, "generate_file");
});

test("marks truncated tails and keeps partial content", () => {
  const parsed = parseHarmonyOutput("<|channel|>analysis<|message|>Need to use function");
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.turns, [{ kind: "reasoning", text: "Need to use function" }]);
});

test("plain text without Harmony markers yields no turns", () => {
  const parsed = parseHarmonyOutput("2 + 2 = 4.");
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.turns, []);
  assert.equal(parsed.messages.length, 1);
});

test("tool-result messages are retained as raw messages but never become assistant turns", () => {
  const parsed = parseHarmonyOutput('<|start|>functions.get_weather to=assistant<|channel|>commentary<|message|>{"sunny": true}<|end|>');
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].role, "functions.get_weather");
  assert.deepEqual(parsed.turns, []);
});

test("harmonyTurnsFromMessages ignores non-assistant messages", () => {
  const turns = harmonyTurnsFromMessages([
    {
      role: "functions.get_weather",
      channel: "commentary",
      recipient: "assistant",
      constrain: null,
      content: '{"sunny": true}',
      stoppedBy: "<|end|>",
    },
    {
      role: "assistant",
      channel: "final",
      recipient: null,
      constrain: null,
      content: "The weather is sunny.",
      stoppedBy: "<|return|>",
    },
  ]);
  assert.deepEqual(turns, [{ kind: "final", text: "The weather is sunny." }]);
});

test("functionNameFromRecipient strips only the functions. namespace", () => {
  assert.equal(functionNameFromRecipient("functions.get_weather"), "get_weather");
  assert.equal(functionNameFromRecipient("browser.search"), "browser.search");
  assert.equal(functionNameFromRecipient("python"), "python");
});

test("normalizeToolArguments compacts valid JSON and keeps invalid JSON verbatim", () => {
  assert.equal(normalizeToolArguments('{"location": "SF", "format": "celsius"}'), '{"location":"SF","format":"celsius"}');
  assert.equal(normalizeToolArguments("{not json"), "{not json");
  assert.equal(normalizeToolArguments(""), "");
});

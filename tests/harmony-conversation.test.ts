import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  advanceConversation,
  analysisLineCount,
  appendToolResult,
  appendTurn,
  appendUser,
  createConversation,
  dropAnalysisBeforeCompletedFinal,
  hasCompletedFinal,
  pendingToolCallCount,
  wireMessagesFromConversation,
} from "../src/harmony/conversation.ts";
import type { NormalizedAssistantResponse } from "../src/harmony/types.ts";

const assistantResponse = (overrides: Partial<NormalizedAssistantResponse>): NormalizedAssistantResponse => ({
  id: "cmpl-test",
  model: "gpt-oss-120b",
  created: 1,
  turns: [],
  analysis: [],
  content: null,
  toolCalls: [],
  finishReason: null,
  refusal: null,
  shape: {
    contentPresent: false,
    contentChars: 0,
    reasoningField: "none",
    reasoningChars: 0,
    toolCallsField: false,
    toolCallCount: 0,
    finishReason: null,
    refusal: false,
  },
  ...overrides,
});

test("analysis is preserved across an unfinished tool turn", () => {
  const conversation = advanceConversation(
    createConversation([{ role: "user", content: "Weather?" }]),
    assistantResponse({
      analysis: ["Need to use function get_weather."],
      toolCalls: [{ id: "call-1", name: "get_weather", arguments: '{"location":"SF"}' }],
    })
  );
  assert.equal(analysisLineCount(conversation), 1);
  assert.equal(pendingToolCallCount(conversation), 1);
  assert.equal(hasCompletedFinal(conversation), false);
  // The unfinished turn keeps its analysis under the replay policy.
  assert.equal(analysisLineCount(dropAnalysisBeforeCompletedFinal(conversation)), 1);
});

test("analysis is dropped after a completed final answer", () => {
  const withTool = advanceConversation(
    createConversation([{ role: "user", content: "Weather?" }]),
    assistantResponse({
      analysis: ["Need to use function get_weather."],
      toolCalls: [{ id: "call-1", name: "get_weather", arguments: '{"location":"SF"}' }],
    })
  );
  const withResult = appendToolResult(withTool, "call-1", "get_weather", '{"sunny": true}');
  const withAnswer = advanceConversation(withResult, assistantResponse({ analysis: ["Summarize the weather."], content: "It is sunny in San Francisco." }));
  assert.equal(analysisLineCount(withAnswer), 2);
  const replayed = dropAnalysisBeforeCompletedFinal(withAnswer);
  assert.equal(analysisLineCount(replayed), 0);
  assert.equal(hasCompletedFinal(withAnswer), true);
});

test("wire view never carries analysis and replays tool calls in OpenAI shape", () => {
  const conversation = advanceConversation(
    createConversation([{ role: "user", content: "Weather?" }]),
    assistantResponse({
      analysis: ["Need to use function get_weather."],
      content: "Let me check the weather.",
      toolCalls: [{ id: "call-1", name: "get_weather", arguments: '{"location":"SF"}' }],
    })
  );
  const messages = wireMessagesFromConversation(conversation);
  assert.deepEqual(messages, [
    { role: "user", content: "Weather?" },
    {
      role: "assistant",
      content: "Let me check the weather.",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "get_weather", arguments: '{"location":"SF"}' },
        },
      ],
    },
  ]);
  assert.ok(!JSON.stringify(messages).includes("Need to use function get_weather."));
});

test("wire view renders tool results with tool_call_id and no name field", () => {
  const conversation = appendToolResult(createConversation([{ role: "user", content: "Weather?" }]), "call-1", "get_weather", '{"sunny": true}');
  const messages = wireMessagesFromConversation(conversation);
  assert.deepEqual(messages[1], { role: "tool", tool_call_id: "call-1", content: '{"sunny": true}' });
});

test("wire view drops empty assistant turns and keeps empty user turns out", () => {
  const conversation = createConversation([
    { role: "assistant", content: null, analysis: ["private"], toolCalls: [], finishReason: null },
    { role: "user", content: "" },
    { role: "system", content: "sys" },
  ]);
  const messages = wireMessagesFromConversation(conversation);
  assert.deepEqual(messages, [{ role: "system", content: "sys" }]);
});

test("appendTurn/appendUser/appendToolResult compose turss immutably", () => {
  const base = createConversation();
  const one = appendUser(base, "hello");
  const two = appendTurn(one, { role: "system", content: "sys" });
  assert.equal(base.turns.length, 0);
  assert.equal(one.turns.length, 1);
  assert.equal(two.turns.length, 2);
  assert.equal(two.turns[0].role, "user");
  assert.equal(two.turns[1].role, "system");
});

test("pendingToolCallCount counts only calls without a matching result", () => {
  const conversation = appendToolResult(
    advanceConversation(
      appendToolResult(
        advanceConversation(
          createConversation([{ role: "user", content: "go" }]),
          assistantResponse({
            toolCalls: [
              { id: "call-1", name: "get_weather", arguments: "{}" },
              { id: "call-2", name: "save_note", arguments: "{}" },
            ],
          })
        ),
        "call-1",
        "get_weather",
        "{}"
      ),
      assistantResponse({ toolCalls: [{ id: "call-1", name: "get_weather", arguments: "{}" }] })
    ),
    "call-1",
    "get_weather",
    "{}"
  );
  assert.equal(pendingToolCallCount(conversation), 1);
});

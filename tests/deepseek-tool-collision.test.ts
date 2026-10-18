import { test } from "bun:test";
import assert from "node:assert/strict";

import { type DeepSeekResponsesEcho, toDeepSeekResponsesPayload } from "../src/deepseek/responses-payload.ts";
import { toDeepSeekResponsesChatBody } from "../src/deepseek/chat-projection.ts";

const echo: DeepSeekResponsesEcho = { tools: undefined, tool_choice: undefined, parallel_tool_calls: true, instructions: null };

const chatCompletion = (message: Record<string, unknown>) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_780_000_000,
  model: "deepseek-flash",
  choices: [{ index: 0, message, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
});

test("deepseek responses: preserves namespace for a colliding tool choice and call", () => {
  const body = toDeepSeekResponsesChatBody(
    {
      input: "hi",
      reasoning: { effort: "none" },
      tool_choice: { type: "function", name: "now", namespace: "clock" },
      tools: [
        { type: "function", name: "now", parameters: { type: "object" } },
        { type: "namespace", name: "clock", tools: [{ type: "function", name: "now", parameters: { type: "object" } }] },
      ],
    },
    "deepseek-flash",
    false
  );
  assert.equal(body.ok, true);
  assert.deepEqual(body.value.body.tool_choice, { type: "function", function: { name: "clock_now" } });

  const payload = toDeepSeekResponsesPayload(
    chatCompletion({ content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "clock_now", arguments: "{}" } }] }),
    "deepseek-flash",
    "resp_collision",
    echo,
    body.value.toolNames,
    body.value.customToolNames
  );
  assert.deepEqual((payload.output as Record<string, unknown>[])[0], {
    id: "fc_resp_collision_0_0",
    type: "function_call",
    status: "completed",
    call_id: "call_1",
    name: "now",
    namespace: "clock",
    arguments: "{}",
  });
});

test("deepseek responses: resolves a bare top-level choice after a namespace-first collision", () => {
  const body = toDeepSeekResponsesChatBody(
    {
      input: "hi",
      reasoning: { effort: "none" },
      tool_choice: { type: "function", name: "now" },
      tools: [
        { type: "namespace", name: "clock", tools: [{ type: "function", name: "now" }] },
        { type: "function", name: "now" },
      ],
    },
    "deepseek-flash",
    false
  );
  assert.equal(body.ok, true);
  assert.deepEqual(
    (body.value.body.tools as { function: { name: string } }[]).map((tool) => tool.function.name),
    ["now", "now_2"]
  );
  assert.deepEqual(body.value.body.tool_choice, { type: "function", function: { name: "now_2" } });
});

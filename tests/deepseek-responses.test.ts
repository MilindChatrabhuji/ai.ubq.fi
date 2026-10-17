import { test } from "bun:test";
import assert from "node:assert/strict";

import { type DeepSeekResponsesEcho, toDeepSeekResponsesPayload, toResponsesUsage } from "../src/deepseek/responses-payload.ts";
import { createDeepSeekResponsesStreamTranslator, deepSeekResponsesTerminalKind, encodeResponsesEvent } from "../src/deepseek/responses-stream.ts";
import { toDeepSeekChatMessages, toDeepSeekResponsesChatBody } from "../src/deepseek/chat-projection.ts";
import { type ForwardedPayloadElision, FORWARDED_PAYLOAD_POLICY } from "../src/deepseek/forwarded-payload-policy.ts";
import { deepSeekFinishDisposition, deepSeekThinkingToolChoiceConflict } from "../src/deepseek/index.ts";

const echo: DeepSeekResponsesEcho = { tools: undefined, tool_choice: undefined, parallel_tool_calls: true, instructions: null };

const chatCompletion = (message: Record<string, unknown>, usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_780_000_000,
  model: "deepseek-flash",
  choices: [{ index: 0, message, finish_reason: "stop" }],
  usage,
});

const chatChunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-stream",
  object: "chat.completion.chunk",
  created: 1_780_000_001,
  model: "deepseek-flash",
  choices: [{ index: 0, delta, finish_reason: null, ...extra }],
});

const eventTypes = (events: readonly Record<string, unknown>[]): string[] => events.map((event) => String(event.type));

test("deepseek responses: maps Responses input onto Chat messages", () => {
  const result = toDeepSeekChatMessages(
    [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "be terse" }] },
      { type: "reasoning", summary: [] },
      { type: "function_call", name: "get_date", arguments: "{}", call_id: "call_1" },
      { type: "function_call", name: "get_weather", arguments: '{"city":"x"}', call_id: "call_2" },
      { type: "function_call_output", call_id: "call_1", output: "2026-09-16" },
      { type: "function_call_output", call_id: "call_2", output: { temp: 7 } },
    ],
    "system prompt"
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, [
    { role: "system", content: "system prompt" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    // DeepSeek, like OpenAI Chat, has no developer role.
    { role: "system", content: "be terse" },
    // Consecutive calls collapse into one assistant turn.
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_date", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "get_weather", arguments: '{"city":"x"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "2026-09-16" },
    { role: "tool", tool_call_id: "call_2", content: '{"temp":7}' },
  ]);
});

test("deepseek responses: rejects input shapes it cannot translate", () => {
  const badType = toDeepSeekChatMessages([{ type: "computer_call", call_id: "c" }], null);
  assert.equal(badType.ok, false);
  const badContent = toDeepSeekChatMessages([{ type: "message", role: "user", content: [{ type: "input_audio" }] }], null);
  assert.equal(badContent.ok, false);
});

test("deepseek responses: emitted refusal output replays as assistant history", () => {
  // Both transports emit an assistant message whose content carries
  // `{ type: "refusal", refusal }`. A client that sends that output back as the
  // next request's `input` must be able to continue the conversation: before
  // this translation the adapter rejected its own emitted part with
  // `input.content type 'refusal' is not supported` (HTTP 400).
  const refusal = "I cannot help with that.";

  // The buffered transport's output object, replayed verbatim as history.
  const buffered = toDeepSeekResponsesPayload(chatCompletion({ role: "assistant", content: null, refusal }), "deepseek-flash", "resp_refusal_replay", echo);
  const bufferedReplay = toDeepSeekResponsesChatBody({ input: buffered.output }, "deepseek-flash", false);
  assert.equal(bufferedReplay.ok, true);
  assert.deepEqual(bufferedReplay.value.body.messages, [{ role: "assistant", content: refusal }]);

  // The streamed terminal response's output, replayed the same way.
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_refusal_stream", echo, 1_780_000_000);
  translator.push(chatChunk({ role: "assistant", refusal }));
  translator.push(chatChunk({}, { finish_reason: "stop" }));
  const terminal = translator.finish().at(-1) as { response: Record<string, unknown> };
  const streamedReplay = toDeepSeekResponsesChatBody({ input: terminal.response.output }, "deepseek-flash", false);
  assert.equal(streamedReplay.ok, true);
  assert.deepEqual(streamedReplay.value.body.messages, [{ role: "assistant", content: refusal }]);

  // One assistant message carrying both an answer and a refusal keeps both
  // payloads in the single Chat content string the established shape supports;
  // no top-level `refusal` alias is invented on the request.
  const mixed = toDeepSeekResponsesChatBody(
    {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Answer. " },
            { type: "refusal", refusal: "Not that part." },
          ],
        },
      ],
    },
    "deepseek-flash",
    false
  );
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.value.body.messages, [{ role: "assistant", content: "Answer. Not that part." }]);
  assert.equal("refusal" in (mixed.value.body.messages as Record<string, unknown>[])[0], false);
});

test("deepseek responses: a malformed refusal part is rejected instead of translated", () => {
  const missing = toDeepSeekResponsesChatBody({ input: [{ type: "message", role: "assistant", content: [{ type: "refusal" }] }] }, "deepseek-flash", false);
  assert.equal(missing.ok, false);
  assert.equal(missing.param, "input.content.refusal");
  assert.match(missing.message, /refusal must be a string/);

  for (const refusal of [42, null, { text: "no" }, ["no"]]) {
    const malformed = toDeepSeekResponsesChatBody(
      { input: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal }] }] },
      "deepseek-flash",
      false
    );
    assert.equal(malformed.ok, false);
    assert.equal(malformed.param, "input.content.refusal");
  }

  // An unsupported content type is still rejected by name, not approximated.
  const unknown = toDeepSeekResponsesChatBody(
    { input: [{ type: "message", role: "assistant", content: [{ type: "output_audio" }] }] },
    "deepseek-flash",
    false
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.param, "input.content.type");

  // A refusal part is assistant history only. Another role keeps the existing
  // unsupported-type rejection instead of silently becoming user text.
  const wrongRole = toDeepSeekResponsesChatBody(
    { input: [{ type: "message", role: "user", content: [{ type: "refusal", refusal: "not mine" }] }] },
    "deepseek-flash",
    false
  );
  assert.equal(wrongRole.ok, false);
  assert.equal(wrongRole.param, "input.content.type");
  assert.match(wrongRole.message, /type 'refusal' is not supported/);
});

test("deepseek responses: flattens namespaced tools and drops what the API cannot serve", () => {
  // `reasoning.effort: "none"` disables thinking mode. A named tool_choice is
  // rejected while thinking mode is active (see the thinking-mode test below),
  // so this capability check disables thinking first.
  const result = toDeepSeekResponsesChatBody(
    {
      input: "hi",
      max_output_tokens: 256,
      reasoning: { effort: "none" },
      text: { format: { type: "json_object" } },
      tool_choice: { type: "function", name: "now" },
      parallel_tool_calls: false,
      tools: [
        { type: "web_search" },
        { type: "function", name: "now", description: "top level", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "clock",
          tools: [
            { type: "function", name: "now", description: "current time", parameters: { type: "object" }, strict: false },
            { type: "function", name: "sleep", parameters: { type: "object" } },
          ],
        },
      ],
    },
    "deepseek-v4-flash",
    false
  );
  assert.equal(result.ok, true);
  const { body, toolNames } = result.value;
  assert.equal(body.model, "deepseek-flash");
  assert.equal(body.max_tokens, 256);
  assert.equal(body.reasoning_effort, "none");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.parallel_tool_calls, false);
  // A tool-bearing request carries the added continuation guidance, so the
  // caller's history is compared from after that system message.
  const [guidance, ...history] = body.messages as Record<string, unknown>[];
  assert.equal(guidance.role, "system");
  assert.deepEqual(history, [{ role: "user", content: "hi" }]);
  const tools = body.tools as { function: { name: string } }[];
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ["now", "clock_now", "sleep"]
  );
  // A namespaced tool keeps the namespace the client resolves the call with, so
  // a flattened Chat name round-trips to the exact Responses identity.
  assert.deepEqual(toolNames.get("clock_now"), { name: "now", namespace: "clock" });
  assert.deepEqual(toolNames.get("sleep"), { name: "sleep", namespace: "clock" });
  assert.equal(toolNames.has("now"), false);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "now" } });
});

test("deepseek responses: bounds synthesized namespaced tool names and suffixes", () => {
  const name = "f".repeat(64);
  const namespace = "n".repeat(64);
  const result = toDeepSeekResponsesChatBody(
    {
      input: "hi",
      tools: [
        { type: "function", name, parameters: { type: "object" } },
        {
          type: "namespace",
          name: namespace,
          tools: [
            { type: "function", name, parameters: { type: "object" } },
            { type: "function", name, parameters: { type: "object" } },
          ],
        },
      ],
    },
    "deepseek-v4-flash",
    false
  );
  assert.equal(result.ok, true);
  const names = (result.value.body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
  assert.deepEqual(names, [name, `${namespace}_${name.slice(0, 63)}`, `${namespace}_${name.slice(0, 61)}_2`]);
  assert.ok(names.every((toolName) => toolName.length <= 128));
  assert.deepEqual(result.value.toolNames.get(names[1]), { name, namespace });
});

test("deepseek responses: a namespaced tool call returns its namespace to the client", () => {
  const body = toDeepSeekResponsesChatBody(
    {
      input: "hi",
      tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }] }],
    },
    "deepseek-v4-flash",
    false
  );
  assert.equal(body.ok, true);
  const toolCall = { id: "call_1", type: "function", function: { name: "spawn_agent", arguments: "{}" } };
  const payload = toDeepSeekResponsesPayload(
    chatCompletion({ content: "", tool_calls: [toolCall] }),
    "deepseek-v4-flash",
    "resp_ns",
    echo,
    body.value.toolNames,
    body.value.customToolNames
  );
  assert.deepEqual((payload.output as Record<string, unknown>[])[0], {
    id: "fc_resp_ns_0_0",
    type: "function_call",
    status: "completed",
    call_id: "call_1",
    name: "spawn_agent",
    namespace: "collaboration",
    arguments: "{}",
  });

  const translator = createDeepSeekResponsesStreamTranslator(
    "deepseek-v4-flash",
    "resp_ns_stream",
    echo,
    1_780_000_000,
    body.value.toolNames,
    body.value.customToolNames
  );
  translator.open();
  const events = [
    ...translator.push(chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "spawn_agent", arguments: "{}" } }] })),
    ...translator.finish(),
  ];
  const added = events.find((event) => event.type === "response.output_item.added") as { item: Record<string, unknown> };
  assert.equal(added.item.name, "spawn_agent");
  assert.equal(added.item.namespace, "collaboration");
  const completed = events.filter((event) => event.type === "response.completed");
  assert.equal(completed.length, 1);
  assert.deepEqual((completed[0].response as { output: Record<string, unknown>[] }).output, [
    {
      id: "fc_resp_ns_stream_0",
      type: "function_call",
      status: "completed",
      call_id: "call_1",
      name: "spawn_agent",
      namespace: "collaboration",
      arguments: "{}",
    },
  ]);
});

test("deepseek responses: replays reasoning on tool turns because the provider requires it", () => {
  // A tool-bearing request whose historical assistant turn omits
  // `reasoning_content` is rejected by the provider with HTTP 400:
  // "The `reasoning_content` in the thinking mode must be passed back to the API."
  const withoutReasoning = toDeepSeekResponsesChatBody(
    {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run echo hi" }] },
        { type: "function_call", name: "shell", arguments: '{"cmd":"echo hi"}', call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "hi" },
      ],
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
    },
    "deepseek-flash",
    false
  );
  assert.equal(withoutReasoning.ok, true);
  const [guidance, ...history] = withoutReasoning.value.body.messages as Record<string, unknown>[];
  assert.equal(guidance.role, "system");
  assert.deepEqual(history, [
    { role: "user", content: "run echo hi" },
    {
      role: "assistant",
      content: null,
      reasoning_content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"echo hi"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "hi" },
  ]);
});

test("deepseek responses: fills reasoning on every assistant turn after the last user message", () => {
  // Reproduces the production failure: Codex echoes the assistant's text
  // message ahead of its `function_call`, so continuing a tool call sends a
  // plain assistant message in the tail. The provider rejected that request
  // with HTTP 400 until every trailing assistant turn carried the field.
  const body = toDeepSeekResponsesChatBody(
    {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me look." }] },
        { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "a.ts" },
      ],
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
    },
    "deepseek-flash",
    false
  );
  assert.equal(body.ok, true);
  const [guidance, ...messages] = body.value.body.messages as Record<string, unknown>[];
  assert.equal(guidance.role, "system");
  assert.deepEqual(messages, [
    { role: "user", content: "list files" },
    { role: "assistant", content: "Let me look.", reasoning_content: "" },
    {
      role: "assistant",
      content: null,
      reasoning_content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "a.ts" },
  ]);
});

test("deepseek responses: an assistant turn before the last user message keeps its reasoning absent", () => {
  // The measured provider rule exempts history before the last user message, so
  // the fill must not rewrite replayed turns the provider never validated.
  const body = toDeepSeekResponsesChatBody(
    {
      input: [
        { type: "message", role: "user", content: "list files" },
        { type: "message", role: "assistant", content: "Let me look." },
        { type: "message", role: "user", content: "now summarize" },
      ],
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
    },
    "deepseek-flash",
    false
  );
  assert.equal(body.ok, true);
  const messages = body.value.body.messages as Record<string, unknown>[];
  assert.equal(messages[0].role, "system");
  // The guidance system message shifts positions, so the replayed assistant
  // turn is identified by role rather than by a fixed index.
  const assistant = messages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.content, "Let me look.");
  assert.equal("reasoning_content" in assistant, false);
});

test("deepseek responses: carries the client's echoed reasoning onto its assistant turn", () => {
  const withReasoning = toDeepSeekResponsesChatBody(
    {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run echo hi" }] },
        {
          type: "reasoning",
          id: "rs_1",
          summary: [
            { type: "summary_text", text: "I should call " },
            { type: "summary_text", text: "the shell tool." },
          ],
        },
        { type: "function_call", name: "shell", arguments: '{"cmd":"echo hi"}', call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "hi" },
      ],
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
    },
    "deepseek-flash",
    false
  );
  assert.equal(withReasoning.ok, true);
  const messages = withReasoning.value.body.messages as Record<string, unknown>[];
  assert.equal(messages[0].role, "system");
  // The assistant turn is located by role because the added guidance system
  // message shifted the fixed index this test used to rely on.
  const assistant = messages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.content, null);
  assert.equal(assistant.reasoning_content, "I should call the shell tool.");
  assert.deepEqual(assistant.tool_calls, [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"echo hi"}' } }]);
});

test("deepseek responses: continuation guidance never rewrites caller instructions or history", () => {
  const instructions = "Caller rules.";
  const guided = toDeepSeekResponsesChatBody(
    {
      instructions,
      input: "hi",
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
    },
    "deepseek-flash",
    false
  );
  assert.equal(guided.ok, true);
  const [guidance, ...history] = guided.value.body.messages as Record<string, unknown>[];
  // The guidance extends the caller's own system message instead of replacing it.
  assert.equal(guidance.role, "system");
  assert.equal(String(guidance.content).startsWith(`${instructions}\n\n`), true);
  assert.equal(String(guidance.content).length > instructions.length + 2, true);
  assert.deepEqual(history, [{ role: "user", content: "hi" }]);

  // A hard no-tools request and a request whose only tool has no executable
  // mapping keep the caller's instructions and history exactly as sent.
  const untouched = [
    toDeepSeekResponsesChatBody(
      {
        instructions,
        input: "hi",
        tool_choice: "none",
        tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
      },
      "deepseek-flash",
      false
    ),
    toDeepSeekResponsesChatBody({ instructions, input: "hi", tools: [{ type: "web_search" }] }, "deepseek-flash", false),
  ];
  for (const result of untouched) {
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.body.messages, [
      { role: "system", content: instructions },
      { role: "user", content: "hi" },
    ]);
  }
});

test("deepseek responses: a reasoning item also rides a plain assistant message", () => {
  const withMessage = toDeepSeekResponsesChatBody(
    {
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "reasoning", content: [{ type: "reasoning_text", text: "Because." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
        { type: "message", role: "user", content: "again" },
      ],
    },
    "deepseek-flash",
    false
  );
  assert.equal(withMessage.ok, true);
  const messages = withMessage.value.body.messages as Record<string, unknown>[];
  assert.equal(messages[1].reasoning_content, "Because.");
});

test("deepseek responses: clears reasoning at a user-turn boundary", () => {
  const reasoningOnly = toDeepSeekResponsesPayload(
    chatCompletion({ role: "assistant", content: "", reasoning_content: "stale reasoning" }),
    "deepseek-flash",
    "resp_reasoning_only",
    echo
  );
  const reasoningItems = reasoningOnly.output as Record<string, unknown>[];
  assert.equal(reasoningItems.length, 1);
  assert.deepEqual(reasoningItems.map((item) => item.type), ["reasoning"]);
  const body = toDeepSeekResponsesChatBody(
    { input: [...reasoningItems, { type: "message", role: "user", content: "new question" }, { type: "message", role: "assistant", content: "new answer" }] },
    "deepseek-flash",
    false
  );
  assert.equal(body.ok, true);
  assert.deepEqual(body.value.body.messages, [{ role: "user", content: "new question" }, { role: "assistant", content: "new answer" }]);
});

test("deepseek responses: reasoning is never invented without tools", () => {
  const withoutTools = toDeepSeekResponsesChatBody(
    {
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "function_call", name: "shell", arguments: "{}", call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "hi" },
      ],
    },
    "deepseek-flash",
    false
  );
  assert.equal(withoutTools.ok, true);
  const messages = withoutTools.value.body.messages as Record<string, unknown>[];
  assert.equal("reasoning_content" in messages[1], false);
});

test("deepseek responses: freeform tools round-trip through the function-only provider contract", () => {
  // Codex's freeform tools (`apply_patch`, code-mode `exec`) have no Chat
  // Completions shape, so they are advertised as one freeform string parameter
  // and their calls come back as `custom_tool_call` items.
  const body = toDeepSeekResponsesChatBody(
    {
      instructions: "You are a coding agent.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "patch it" }] },
        { type: "custom_tool_call", call_id: "call_1", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
        { type: "custom_tool_call_output", call_id: "call_1", output: "Done!" },
      ],
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch." }],
      reasoning: { effort: "max" },
    },
    "deepseek-v4-flash",
    false
  );
  assert.equal(body.ok, true);
  const tools = body.value.body.tools as { type: string; function: { name: string; parameters: unknown } }[];
  assert.deepEqual(tools, [
    {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply a patch.",
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "Freeform input for the tool." } },
          required: ["input"],
          additionalProperties: false,
        },
      },
    },
  ]);
  // The replayed freeform text travels as the single Chat argument.
  const messages = body.value.body.messages as Record<string, unknown>[];
  assert.equal(messages[0].role, "system");
  assert.deepEqual(messages[2], {
    role: "assistant",
    content: null,
    reasoning_content: "",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' } }],
  });
  assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_1", content: "Done!" });
  assert.deepEqual([...body.value.customToolNames], ["apply_patch"]);

  // The provider answers with JSON arguments; the client gets its text back.
  const payload = toDeepSeekResponsesPayload(
    chatCompletion({
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' } }],
    }),
    "deepseek-v4-flash",
    "resp_1",
    echo,
    body.value.toolNames,
    body.value.customToolNames
  );
  assert.deepEqual((payload.output as Record<string, unknown>[])[0], {
    id: "ctc_resp_1_0_0",
    type: "custom_tool_call",
    status: "completed",
    call_id: "call_1",
    name: "apply_patch",
    input: "*** Begin Patch\n*** End Patch",
  });
});

test("deepseek responses: a streamed freeform call emits custom tool events", () => {
  const body = toDeepSeekResponsesChatBody(
    {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "run code" }] }],
      tools: [{ type: "custom", name: "exec", description: "Run code." }],
    },
    "deepseek-v4-flash",
    true
  );
  assert.equal(body.ok, true);
  const translator = createDeepSeekResponsesStreamTranslator(
    "deepseek-v4-flash",
    "resp_1",
    echo,
    1_780_000_000,
    body.value.toolNames,
    body.value.customToolNames
  );
  translator.open();
  const events = [
    ...translator.push({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "exec", arguments: '{"input":"text(' } }] } }],
    }),
    ...translator.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'hi);"}' } }] } }] }),
    ...translator.finish(),
  ];
  const added = events.find((event) => event.type === "response.output_item.added") as { item: Record<string, unknown> };
  assert.equal(added.item.type, "custom_tool_call");
  assert.equal(added.item.input, "");
  // No function-argument deltas: a freeform call carries its input on the item.
  assert.equal(
    events.some((event) => event.type === "response.function_call_arguments.delta"),
    false
  );
  const deltas = events.filter((event) => event.type === "response.custom_tool_call_input.delta");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta, "text(hi);");
  const completed = events.filter((event) => event.type === "response.completed");
  assert.equal(completed.length, 1);
  assert.deepEqual((completed[0].response as { output: Record<string, unknown>[] }).output, [
    { id: "ctc_resp_1_0", type: "custom_tool_call", status: "completed", call_id: "call_1", name: "exec", input: "text(hi);" },
  ]);
});

test("deepseek responses: projects a sub-agent message envelope onto a user turn", () => {
  const plaintextPayload = toDeepSeekChatMessages(
    [
      { type: "message", role: "user", content: [{ type: "input_text", text: "delegate this" }] },
      {
        type: "agent_message",
        author: "/root/probe_qwen2",
        recipient: "/root",
        content: [
          { type: "input_text", text: "ok" },
          // Multiple readable parts join in order, one newline between them.
          { type: "input_text", text: "follow-up payload" },
          // A thread whose model runs outside the ChatGPT backend carries its
          // payload here in the clear, so it must reach the model.
          { type: "encrypted_content", encrypted_content: "payload-from-worker" },
        ],
      },
    ],
    null
  );
  assert.equal(plaintextPayload.ok, true);
  assert.deepEqual(plaintextPayload.value, [
    { role: "user", content: "delegate this" },
    { role: "user", content: "[agent message] /root/probe_qwen2 -> /root:\nok\nfollow-up payload\npayload-from-worker" },
  ]);

  // A sealed payload is a Fernet token only the ChatGPT backend can open, so it
  // is declared instead of forwarded as ciphertext.
  const sealedPayload = toDeepSeekChatMessages(
    [
      {
        type: "agent_message",
        author: "/root",
        recipient: "/root/worker",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK" },
          { type: "encrypted_content", encrypted_content: `gAAAAA${"A".repeat(120)}` },
        ],
      },
    ],
    null
  );
  assert.equal(sealedPayload.ok, true);
  assert.deepEqual(sealedPayload.value, [
    {
      role: "user",
      content: "[agent message] /root -> /root/worker:\nMessage Type: NEW_TASK\n[gateway: 1 sealed agent-message part(s) were not readable and omitted]",
    },
  ]);
});

test("deepseek responses: bounds oversized sub-agent payloads under the declared policy", () => {
  const oversized = "x".repeat(FORWARDED_PAYLOAD_POLICY.perMessageLimit + 1_000);
  const message = {
    type: "agent_message",
    author: "/root/worker",
    recipient: "/root",
    content: [{ type: "encrypted_content", encrypted_content: oversized }],
  };
  const elisions: ForwardedPayloadElision[] = [];
  const reduced = toDeepSeekChatMessages([message], null, "reduce", elisions);
  assert.equal(reduced.ok, true);
  const content = (reduced.value[0] as { content: string }).content;
  assert.ok(content.length < oversized.length, "the payload must be reduced below its original size");
  assert.ok(content.includes(FORWARDED_PAYLOAD_POLICY.version), "the elision marker must name the policy version");
  assert.equal(elisions.length, 1);
  assert.equal(elisions[0].kind, "agent_message");
  assert.ok(elisions[0].omittedBytes > 0);
  assert.equal(elisions[0].path, "input[0].content");

  // An explicit truncation "disabled" fails closed instead of mutating the input.
  const rejected = toDeepSeekChatMessages([message], null, "reject", []);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "context_length_exceeded");
});

test("deepseek responses: rejects unsupported wire requests instead of approximating them", () => {
  const schema = toDeepSeekResponsesChatBody({ input: "hi", text: { format: { type: "json_schema", name: "x" } } }, "deepseek-flash", false);
  assert.equal(schema.ok, false);
  assert.equal(schema.param, "text.format.type");
  const tokens = toDeepSeekResponsesChatBody({ input: "hi", max_output_tokens: 0 }, "deepseek-flash", false);
  assert.equal(tokens.ok, false);
  assert.equal(tokens.param, "max_output_tokens");
  const model = toDeepSeekResponsesChatBody({ input: "hi" }, "gpt-5.6-sol", false);
  assert.equal(model.ok, false);
  assert.equal(model.param, "model");
  const empty = toDeepSeekResponsesChatBody({ input: [] }, "deepseek-flash", false);
  assert.equal(empty.ok, false);
});

test("deepseek responses: streaming requests ask the provider for usage", () => {
  const result = toDeepSeekResponsesChatBody({ input: "hi" }, "deepseek-flash", true);
  assert.equal(result.ok, true);
  assert.equal(result.value.body.stream, true);
  assert.deepEqual(result.value.body.stream_options, { include_usage: true });
});

test("deepseek responses: builds a completed Responses object from a Chat completion", () => {
  const payload = toDeepSeekResponsesPayload(
    chatCompletion({
      role: "assistant",
      content: "42",
      reasoning_content: "because",
      tool_calls: [{ id: "call_9", type: "function", function: { name: "clock_now", arguments: "{}" } }],
    }),
    "deepseek-v4-flash",
    "resp_test",
    echo,
    new Map([["clock_now", { name: "now", namespace: "clock" }]])
  );
  assert.equal(payload.object, "response");
  assert.equal(payload.status, "completed");
  assert.equal(payload.model, "deepseek-v4-flash");
  const output = payload.output as Record<string, unknown>[];
  assert.deepEqual(
    output.map((item) => item.type),
    ["reasoning", "message", "function_call"]
  );
  assert.deepEqual(output[1].content, [{ type: "output_text", text: "42", annotations: [] }]);
  assert.equal(output[2].name, "now");
  assert.equal(output[2].call_id, "call_9");
  assert.deepEqual(payload.usage, {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
  });
});

test("deepseek responses: usage translation reports measured counters and never invents an unmeasured one", () => {
  assert.equal(toResponsesUsage({ prompt_tokens: 1 }), null);
  assert.equal(toResponsesUsage(null), null);
  // An upstream that reports no counter leaves the detail object absent: a
  // missing measurement must not be published as a measured zero.
  assert.deepEqual(toResponsesUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }), {
    input_tokens: 1,
    output_tokens: 2,
    total_tokens: 3,
  });
  // The provider's own spelling and the official nested spelling both map onto
  // the field Codex reads.
  assert.deepEqual(toResponsesUsage({ prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, prompt_cache_hit_tokens: 96 }), {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 96 },
    output_tokens: 2,
    total_tokens: 102,
  });
  assert.deepEqual(toResponsesUsage({ prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, prompt_tokens_details: { cached_tokens: 96 } }), {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 96 },
    output_tokens: 2,
    total_tokens: 102,
  });
  // Thinking mode's reasoning count is a second measured counter on the same
  // response, so both details travel together when the provider reports both.
  assert.deepEqual(
    toResponsesUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_cache_hit_tokens: 96,
      completion_tokens_details: { reasoning_tokens: 31 },
    }),
    {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 96 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 31 },
      total_tokens: 140,
    }
  );
  // A counter cannot exceed the total it is a subset of, so an impossible value
  // is reported as unknown rather than relayed.
  assert.deepEqual(toResponsesUsage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 11 }), {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
  });
  assert.deepEqual(toResponsesUsage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, completion_tokens_details: { reasoning_tokens: 3 } }), {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
  });
});

test("deepseek responses: stream translator emits the Responses event sequence", () => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_stream", echo, 1_780_000_000);
  const events: Record<string, unknown>[] = [];
  events.push(...translator.push(chatChunk({ role: "assistant", reasoning_content: "think " })));
  events.push(...translator.push(chatChunk({ content: "Hel" })));
  events.push(...translator.push(chatChunk({ content: "lo" }, { finish_reason: "stop" })));
  events.push(
    ...translator.push({
      ...chatChunk({}),
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
        prompt_cache_hit_tokens: 6,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })
  );
  events.push(...translator.finish());

  assert.deepEqual(eventTypes(events), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const completed = events.at(-1) as { response: Record<string, unknown> };
  assert.equal(completed.response.status, "completed");
  assert.deepEqual(completed.response.usage, {
    input_tokens: 7,
    input_tokens_details: { cached_tokens: 6 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 10,
  });
  const output = completed.response.output as Record<string, unknown>[];
  assert.deepEqual(
    output.map((item) => item.type),
    ["reasoning", "message"]
  );
});

test("deepseek responses: the reasoning item announces the index it answers for", () => {
  // The official client accumulates `response.output_item.added` in arrival
  // order and reads every later event's `output_index` out of that accumulated
  // output. Reserving a reasoning slot without announcing it made the following
  // message the client's first accumulated item while its content events still
  // named index 1, so the whole stream failed with `missing output at index 1`.
  // The item lifecycle must therefore exist before any later item advances the
  // index, and every reasoning event must name that item's own index and id.
  const responseId = "resp_reason_life";
  const reasoningId = `rs_${responseId}_0`;
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", responseId, echo, 1_780_000_000);
  const events: Record<string, unknown>[] = [];
  events.push(...translator.push(chatChunk({ role: "assistant", reasoning_content: "first " })));
  events.push(...translator.push(chatChunk({ reasoning_content: "second" })));
  events.push(...translator.push(chatChunk({ content: "answer" }, { finish_reason: "stop" })));
  events.push(...translator.finish());

  const added = events.filter((event) => event.type === "response.output_item.added");
  assert.deepEqual(
    added.map((event) => [event.output_index, (event.item as Record<string, unknown>).type]),
    [
      [0, "reasoning"],
      [1, "message"],
    ]
  );
  assert.deepEqual(added[0].item, { id: reasoningId, type: "reasoning", status: "in_progress", summary: [] });

  const partAdded = events.find((event) => event.type === "response.reasoning_summary_part.added");
  assert.deepEqual(partAdded, {
    type: "response.reasoning_summary_part.added",
    item_id: reasoningId,
    output_index: 0,
    summary_index: 0,
    part: { type: "summary_text", text: "" },
  });

  const deltas = events.filter((event) => event.type === "response.reasoning_summary_text.delta");
  assert.deepEqual(
    deltas.map((event) => event.delta),
    ["first ", "second"]
  );
  for (const event of deltas) {
    assert.equal(event.item_id, reasoningId);
    assert.equal(event.output_index, 0);
    assert.equal(event.summary_index, 0);
  }

  const textDone = events.find((event) => event.type === "response.reasoning_summary_text.done");
  assert.equal(textDone?.text, "first second");
  const partDone = events.find((event) => event.type === "response.reasoning_summary_part.done");
  assert.deepEqual(partDone?.part, { type: "summary_text", text: "first second" });

  // The terminal item is the completed form of the item the client accumulated
  // at index 0, and it sits at that index in the terminal output.
  const reasoningDone = events.find((event) => event.type === "response.output_item.done" && (event.item as Record<string, unknown>).type === "reasoning");
  assert.deepEqual(reasoningDone?.item, {
    id: reasoningId,
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: "first second" }],
  });
  const completed = events.at(-1) as { response: Record<string, unknown> };
  const output = completed.response.output as Record<string, unknown>[];
  // The first assertion narrowed `reasoningDone`, so this access needs no
  // optional chain; an absent item would already have failed there.
  assert.deepEqual(output[0], reasoningDone.item);
  assert.equal(output[1].type, "message");
});

test("deepseek responses: stream translator accumulates fragmented tool calls", () => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_tools", echo, 1_780_000_000);
  const events: Record<string, unknown>[] = [];
  events.push(
    ...translator.push(chatChunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: "" } }] }))
  );
  events.push(...translator.push(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] })));
  events.push(...translator.push(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, { finish_reason: "tool_calls" })));
  events.push(...translator.finish());

  assert.deepEqual(eventTypes(events), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const done = events.find((event) => event.type === "response.output_item.done") as { item: Record<string, unknown> };
  assert.deepEqual(done.item, {
    id: "fc_resp_tools_0",
    type: "function_call",
    status: "completed",
    call_id: "call_1",
    name: "shell",
    arguments: '{"cmd":"ls"}',
  });
});

test("deepseek responses: an argument-only tool-call delta is not answer-bearing", () => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_partial_call", echo, 1_780_000_000);
  translator.push(chatChunk({ content: "Step 11 of 16 complete." }));
  translator.push(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, { finish_reason: "stop" }));
  // A nameless argument-only delta answers nothing: it carries no tool name, so
  // the answer-bearing contract reports zero named tool calls.
  // The refusal field is part of the answer-bearing contract; an unrefused
  // answer reports it as the empty string.
  assert.deepEqual(translator.answerBearingOutput(), { text: "Step 11 of 16 complete.", refusal: "", toolCallCount: 0 });
});

test("deepseek responses: stream translator is idempotent at the terminal", () => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_once", echo, 1_780_000_000);
  assert.deepEqual(eventTypes(translator.finish()), ["response.created", "response.in_progress", "response.completed"]);
  assert.deepEqual(translator.finish(), []);
});

test("deepseek responses: maps the upstream stop reason onto the terminal vocabulary", () => {
  // The provider's documented set is [stop, length, content_filter, tool_calls,
  // insufficient_system_resource, aborted]; `content_filter` is an incomplete
  // with the official reason, and the two interruption reasons fail visibly
  // with their own code rather than being laundered into a completion.
  assert.equal(deepSeekResponsesTerminalKind(null), "completed");
  assert.equal(deepSeekResponsesTerminalKind("stop"), "completed");
  assert.equal(deepSeekResponsesTerminalKind("tool_calls"), "completed");
  assert.equal(deepSeekResponsesTerminalKind("length"), "incomplete");
  assert.equal(deepSeekResponsesTerminalKind("content_filter"), "incomplete");
  assert.equal(deepSeekResponsesTerminalKind("insufficient_system_resource"), "failed");
  assert.equal(deepSeekResponsesTerminalKind("aborted"), "failed");
  assert.equal(deepSeekResponsesTerminalKind("something_new"), "failed");
});

test("deepseek responses: a length stop becomes response.incomplete with max_output_tokens", () => {
  // The real terminal chunk carries the reason on a choice with no delta, so
  // the reason must survive independently of `choice.delta`.
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_length", echo, 1_780_000_000);
  translator.push(chatChunk({ role: "assistant", content: "cut off here" }));
  translator.push({ ...chatChunk({}), choices: [{ index: 0, finish_reason: "length" }] });
  const events = translator.finish();

  const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
  assert.equal(terminal.type, "response.incomplete");
  assert.equal(terminal.response.status, "incomplete");
  assert.equal(terminal.response.error, null);
  assert.deepEqual(terminal.response.incomplete_details, { reason: "max_output_tokens" });
  assert.deepEqual(
    (terminal.response.output as Record<string, unknown>[]).map((item) => item.type),
    ["message"]
  );
  const done = events.find((event) => event.type === "response.output_item.done") as { item: Record<string, unknown> };
  assert.equal(done.item.status, "completed");
});

test("deepseek responses: stop, tool_calls and an absent reason keep response.completed", () => {
  const terminalFor = (chunks: readonly Record<string, unknown>[]): Record<string, unknown> => {
    const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_completed", echo, 1_780_000_000);
    for (const chunk of chunks) translator.push(chunk);
    const terminal = translator.finish().at(-1);
    assert.ok(terminal);
    return terminal;
  };

  const stopped = terminalFor([chatChunk({ role: "assistant", content: "pong" }, { finish_reason: "stop" })]);
  assert.equal(stopped.type, "response.completed");
  assert.equal((stopped.response as Record<string, unknown>).status, "completed");
  assert.equal((stopped.response as Record<string, unknown>).incomplete_details, null);

  const toolCalls = terminalFor([
    chatChunk(
      { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: "{}" } }] },
      { finish_reason: "tool_calls" }
    ),
  ]);
  assert.equal(toolCalls.type, "response.completed");

  // A provider that ends its stream without a reason is not treated as a
  // truncation, and it is not treated as a failure either.
  const absent = terminalFor([chatChunk({ role: "assistant", content: "pong" })]);
  assert.equal(absent.type, "response.completed");
  assert.equal((absent.response as Record<string, unknown>).incomplete_details, null);
});

test("deepseek responses: a provider interruption names its own cause instead of succeeding", () => {
  // Each documented interruption keeps its own error code, so an operator can
  // tell a resource interruption from an unspecified abort.
  for (const [reason, code] of [
    ["insufficient_system_resource", "insufficient_system_resource"],
    ["aborted", "aborted"],
    ["something_new", "unrecognized_finish_reason:something_new"],
  ] as const) {
    const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_unrecognized", echo, 1_780_000_000);
    translator.push(chatChunk({ role: "assistant", content: "partial" }, { finish_reason: reason }));
    const terminal = translator.finish().at(-1) as { type: string; response: Record<string, unknown> };
    assert.equal(terminal.type, "response.failed");
    assert.equal(terminal.response.status, "failed");
    assert.equal((terminal.response.error as { code: string }).code, code);
  }
});

test("deepseek responses: encodes named SSE frames", () => {
  assert.equal(
    encodeResponsesEvent({ type: "response.completed", response: { id: "resp_1" } }),
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'
  );
});

const toolsForChoice = [{ type: "function", name: "exec", description: "Run.", parameters: { type: "object" } }];

test("deepseek responses: rejects tool_choice 'required' while thinking mode is active", () => {
  // The provider answers HTTP 400 "Thinking mode does not support this
  // tool_choice" for both of these (probed 2026-09-21 on the Chat endpoint and
  // on the provider's native Responses endpoint). Rejecting the combination
  // here means a client that sent a request our own contract advertises gets an
  // error naming both fields instead of the provider's message about a
  // parameter it believes it supports.
  for (const effort of ["low", "high", "max", "ultra", undefined]) {
    const required = toDeepSeekResponsesChatBody(
      { input: "hi", tools: toolsForChoice, tool_choice: "required", ...(effort ? { reasoning: { effort } } : {}) },
      "deepseek-flash",
      false
    );
    assert.equal(required.ok, false);
    assert.equal(required.param, "tool_choice");
    assert.match(required.message, /tool_choice 'required'/);
    assert.match(required.message, /reasoning\.effort/);

    const named = toDeepSeekResponsesChatBody(
      { input: "hi", tools: toolsForChoice, tool_choice: { type: "function", name: "exec" }, ...(effort ? { reasoning: { effort } } : {}) },
      "deepseek-flash",
      false
    );
    assert.equal(named.ok, false);
    assert.equal(named.param, "tool_choice");
    assert.match(named.message, /tool_choice 'function:exec'/);
  }
});

test("deepseek responses: accepts required tool_choice once thinking mode is disabled", () => {
  const disabledByEffort = toDeepSeekResponsesChatBody(
    { input: "hi", tools: toolsForChoice, tool_choice: "required", reasoning: { effort: "none" } },
    "deepseek-flash",
    false
  );
  assert.equal(disabledByEffort.ok, true);
  assert.equal(disabledByEffort.value.body.tool_choice, "required");
  assert.equal(disabledByEffort.value.body.reasoning_effort, "none");

  const disabledByThinking = toDeepSeekResponsesChatBody(
    { input: "hi", tools: toolsForChoice, tool_choice: { type: "function", name: "exec" }, thinking: { type: "disabled" } },
    "deepseek-flash",
    false
  );
  assert.equal(disabledByThinking.ok, true);
  assert.deepEqual(disabledByThinking.value.body.tool_choice, { type: "function", function: { name: "exec" } });

  // `none` and `auto` are valid in every mode.
  for (const value of ["none", "auto"] as const) {
    const accepted = toDeepSeekResponsesChatBody(
      { input: "hi", tools: toolsForChoice, tool_choice: value, reasoning: { effort: "max" } },
      "deepseek-flash",
      false
    );
    assert.equal(accepted.ok, true);
    assert.equal(accepted.value.body.tool_choice, value);
  }
});

test("deepseek responses: the thinking-mode tool_choice rule has one shared expression", () => {
  // The rule is consumed by both DeepSeek request seams, so it is asserted at
  // its own seam as well as through the Responses translation.
  assert.equal(deepSeekThinkingToolChoiceConflict("high", undefined, "required"), "required");
  assert.equal(deepSeekThinkingToolChoiceConflict(undefined, undefined, { type: "function", name: "exec" }), "function:exec");
  assert.equal(deepSeekThinkingToolChoiceConflict("none", { type: "enabled" }, "required"), null);
  assert.equal(deepSeekThinkingToolChoiceConflict("max", { type: "disabled" }, "required"), "required");
  assert.equal(deepSeekThinkingToolChoiceConflict("max", undefined, "auto"), null);
  assert.equal(deepSeekThinkingToolChoiceConflict("max", undefined, undefined), null);
});

test("deepseek responses: maps every documented finish_reason to a truthful terminal", () => {
  // The vocabulary is the provider's own: the Chat Completions reference lists
  // "stop, length, content_filter, tool_calls, insufficient_system_resource,
  // aborted" (read 2026-09-21).
  assert.deepEqual(deepSeekFinishDisposition("stop"), { kind: "completed" });
  assert.deepEqual(deepSeekFinishDisposition("tool_calls"), { kind: "completed" });
  assert.deepEqual(deepSeekFinishDisposition("length"), { kind: "incomplete", reason: "max_output_tokens" });
  assert.deepEqual(deepSeekFinishDisposition("content_filter"), { kind: "incomplete", reason: "content_filter" });
  assert.deepEqual(deepSeekFinishDisposition("insufficient_system_resource"), { kind: "failed", code: "insufficient_system_resource" });
  assert.deepEqual(deepSeekFinishDisposition("aborted"), { kind: "failed", code: "aborted" });
  // An absent reason defaults to a normal stop, matching the provider's own
  // client (`pendingFinish ?? { kind: "stop" }`), while an unrecognized value is
  // never silently treated as a normal stop.
  assert.deepEqual(deepSeekFinishDisposition(undefined), { kind: "completed" });
  assert.deepEqual(deepSeekFinishDisposition("something_new"), { kind: "unknown", value: "something_new" });
});

test("deepseek responses: a truncated stream reports response.incomplete instead of completed", () => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_len", echo, 1_780_000_000);
  const events: Record<string, unknown>[] = [];
  events.push(...translator.push(chatChunk({ role: "assistant", reasoning_content: "thinking about it" })));
  events.push(...translator.push(chatChunk({ content: "partial answer" }, { finish_reason: "length" })));
  assert.equal(translator.terminalKind(), "incomplete");
  events.push(...translator.finish());

  const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
  assert.equal(terminal.type, "response.incomplete");
  assert.equal(terminal.response.status, "incomplete");
  assert.deepEqual(terminal.response.incomplete_details, { reason: "max_output_tokens" });
  assert.equal(
    events.some((event) => event.type === "response.completed"),
    false
  );
});

test("deepseek responses: a length-truncated tool call closes incomplete before the terminal", () => {
  // A `length` stop can land mid-arguments. Closing the item as `completed`
  // before the `response.incomplete` terminal hands a status-aware consumer a
  // partial call it may execute, so the terminal disposition is decided first
  // and both tool kinds carry the official non-completed status in the done
  // event and in the delivered output.
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_len_tool", echo, 1_780_000_000, new Map(), new Set(["exec"]));
  const events: Record<string, unknown>[] = [];
  events.push(
    ...translator.push(
      chatChunk(
        {
          role: "assistant",
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"echo hi' } },
            { index: 1, id: "call_2", type: "function", function: { name: "exec", arguments: '{"input":"print(' } },
          ],
        },
        { finish_reason: "length" }
      )
    )
  );
  events.push(...translator.finish());

  const doneIndexes = events.flatMap((event, index) => (event.type === "response.output_item.done" ? [index] : []));
  assert.equal(doneIndexes.length, 2);
  const itemDones = doneIndexes.map((index) => events[index] as { item: Record<string, unknown> });
  assert.deepEqual(
    itemDones.map((done) => done.item),
    [
      { id: "fc_resp_len_tool_0", type: "function_call", status: "incomplete", call_id: "call_1", name: "shell", arguments: '{"cmd":"echo hi' },
      { id: "ctc_resp_len_tool_1", type: "custom_tool_call", status: "incomplete", call_id: "call_2", name: "exec", input: '{"input":"print(' },
    ]
  );
  // The terminal output carries the exact items the done events announced, and
  // every item closes before the terminal it now agrees with.
  const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
  assert.equal(terminal.type, "response.incomplete");
  assert.deepEqual(
    terminal.response.output,
    itemDones.map((done) => done.item)
  );
  assert.equal(doneIndexes[1] < events.length - 1, true);
  assert.equal(
    events.some((event) => event.type === "response.completed"),
    false
  );
});

test("deepseek responses: a provider interruption is a failed terminal, not a completion", () => {
  for (const [reason, code] of [
    ["insufficient_system_resource", "insufficient_system_resource"],
    ["aborted", "aborted"],
    ["unrecognized_reason", "unrecognized_finish_reason:unrecognized_reason"],
  ] as const) {
    const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_fail", echo, 1_780_000_000);
    const events: Record<string, unknown>[] = [];
    events.push(...translator.push(chatChunk({ content: "partial" })));
    events.push(...translator.push(chatChunk({}, { finish_reason: reason })));
    assert.equal(translator.terminalKind(), "failed");
    events.push(...translator.finish());

    const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
    assert.equal(terminal.type, "response.failed");
    assert.equal(terminal.response.status, "failed");
    assert.equal((terminal.response.error as { code: string }).code, code);
    assert.equal(
      events.some((event) => event.type === "response.completed"),
      false
    );
  }
});

test("deepseek responses: a truncated buffered completion is not reported as completed", () => {
  const payload = toDeepSeekResponsesPayload(
    {
      id: "chatcmpl-len",
      object: "chat.completion",
      created: 1_780_000_000,
      model: "deepseek-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "cut off" }, finish_reason: "length" }],
      usage: { prompt_tokens: 5, completion_tokens: 8192, total_tokens: 8197 },
    },
    "deepseek-flash",
    "resp_buf",
    echo
  );
  assert.equal(payload.status, "incomplete");
  assert.deepEqual(payload.incomplete_details, { reason: "max_output_tokens" });
});

test("deepseek responses: a normal stream is still reported as completed", () => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_ok", echo, 1_780_000_000);
  const events: Record<string, unknown>[] = [];
  events.push(...translator.push(chatChunk({ content: "hi" }, { finish_reason: "stop" })));
  assert.equal(translator.terminalKind(), "completed");
  events.push(...translator.finish());
  const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
  assert.equal(terminal.type, "response.completed");
  assert.equal(terminal.response.status, "completed");
  assert.equal(terminal.response.incomplete_details, null);
  assert.equal(terminal.response.error, null);
});

test("deepseek responses: bounds oversized forwarded payloads under the declared policy", () => {
  const limit = FORWARDED_PAYLOAD_POLICY.perMessageLimit;
  const messages = (result: ReturnType<typeof toDeepSeekChatMessages>): Record<string, unknown>[] => {
    if (!result.ok) throw new Error(`unexpected projection failure: ${result.message}`);
    return result.value;
  };

  // A single tool result larger than the per-message bound is cut, not forwarded
  // whole: the provider counts it as text tokens and one such result took a live
  // session past the 1,048,576-token window on 2026-09-24. The reduction is
  // visible - the marker names the declared policy version and says the model
  // did not receive the elided bytes - and the forwarded content stays inside
  // the declared limit.
  const oversized = "x".repeat(limit + 1_024);
  const bounded = messages(
    toDeepSeekChatMessages(
      [
        { type: "function_call", name: "read_file", arguments: "{}", call_id: "call_big" },
        { type: "function_call_output", call_id: "call_big", output: oversized },
      ],
      null
    )
  );
  const toolContent = (bounded.at(-1) as { content: string }).content;
  assert.equal(toolContent.length < oversized.length, true);
  assert.equal(toolContent.includes("bytes omitted"), true);
  assert.equal(toolContent.includes(FORWARDED_PAYLOAD_POLICY.version), true);
  assert.equal(toolContent.includes("the model did not receive the elided bytes"), true);
  assert.equal(new TextEncoder().encode(toolContent).byteLength <= limit, true);

  // Payloads inside the bound are untouched, so ordinary tool results replay verbatim.
  const verbatim = messages(toDeepSeekChatMessages([{ type: "function_call_output", call_id: "call_small", output: "2026-09-16" }], null));
  assert.deepEqual(verbatim.at(-1), { role: "tool", tool_call_id: "call_small", content: "2026-09-16" });

  // An oversized image data URL is dropped rather than cut (half a base64
  // payload is not an image) and the omission marker says the model did not
  // receive the image, while an ordinary data URL still forwards as an image.
  const hugeImage = `data:image/png;base64,${"A".repeat(limit + 10)}`;
  const dropped = messages(toDeepSeekChatMessages([{ type: "message", role: "user", content: [{ type: "input_image", image_url: hugeImage }] }], null));
  const droppedContent = (dropped.at(-1) as { content: unknown }).content;
  assert.equal(typeof droppedContent, "string");
  assert.equal(String(droppedContent).includes("image omitted"), true);
  assert.equal(String(droppedContent).includes(FORWARDED_PAYLOAD_POLICY.version), true);
  assert.equal(String(droppedContent).includes("the model did not receive this image"), true);

  const smallImage = "data:image/png;base64,AQID";
  const kept = messages(toDeepSeekChatMessages([{ type: "message", role: "user", content: [{ type: "input_image", image_url: smallImage }] }], null));
  assert.deepEqual((kept.at(-1) as { content: unknown }).content, [{ type: "image_url", image_url: { url: smallImage } }]);

  // The bound applies to the assembled message, not only to individual parts.
  const oversizedTextMessage = messages(
    toDeepSeekChatMessages([{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(limit + 4_464) }] }], null)
  );
  const boundedTextMessage = (oversizedTextMessage.at(-1) as { content: string }).content;
  assert.equal(new TextEncoder().encode(boundedTextMessage).byteLength <= limit, true);
  assert.equal(boundedTextMessage.includes("bytes omitted"), true);

  const imagePart = `data:image/png;base64,${"A".repeat(40 * 1024)}`;
  const boundedImageMessage = messages(
    toDeepSeekChatMessages(
      [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: imagePart },
            { type: "input_image", image_url: imagePart },
          ],
        },
      ],
      null
    )
  );
  const boundedImageContent = (boundedImageMessage.at(-1) as { content: Record<string, unknown>[] }).content;
  const assembledImageBytes = boundedImageContent.reduce((total, part) => {
    if (part.type === "text") return total + new TextEncoder().encode(String(part.text)).byteLength;
    const image = part.image_url as Record<string, unknown>;
    return total + new TextEncoder().encode(String(image.url)).byteLength;
  }, 0);
  assert.equal(assembledImageBytes <= limit, true);
  assert.equal(
    boundedImageContent.some((part) => part.type === "text" && String(part.text).includes("image omitted")),
    true
  );

  // An explicit `truncation: "disabled"` fails closed instead of reducing: the
  // error names the input path, the byte counts and the declared limit, and it
  // is recoverable without re-deriving which item was too large.
  const refused = toDeepSeekResponsesChatBody(
    {
      input: [
        { type: "function_call", name: "read_file", arguments: "{}", call_id: "call_big" },
        { type: "function_call_output", call_id: "call_big", output: oversized },
      ],
      truncation: "disabled",
    },
    "deepseek-flash",
    false
  );
  if (refused.ok) throw new Error("expected a fail-closed projection");
  assert.equal(refused.code, "context_length_exceeded");
  assert.equal(refused.param, "input[1].output");
  assert.equal(refused.message.includes(`carries ${oversized.length} bytes`), true);
  assert.equal(refused.message.includes(`at most ${limit} bytes per message under ${FORWARDED_PAYLOAD_POLICY.version}`), true);
  assert.equal(refused.message.includes("truncation 'disabled'"), true);

  // The request path records every reduction for the operator log, and the
  // absent field or an explicit `"auto"` keep the declared bounded policy.
  const elisionBody = (truncation: unknown) =>
    toDeepSeekResponsesChatBody(
      {
        input: [
          { type: "function_call", name: "read_file", arguments: "{}", call_id: "call_big" },
          { type: "function_call_output", call_id: "call_big", output: oversized },
          { type: "message", role: "user", content: [{ type: "input_image", image_url: hugeImage }] },
        ],
        ...(truncation === undefined ? {} : { truncation }),
      },
      "deepseek-flash",
      false
    );
  for (const truncation of [undefined, "auto"]) {
    const translated = elisionBody(truncation);
    if (!translated.ok) throw new Error("expected a bounded projection");
    assert.equal(translated.value.elisions.length, 2);
    const [toolElision, imageElision] = translated.value.elisions;
    assert.deepEqual(
      Object.keys(toolElision).sort((a, b) => a.localeCompare(b)),
      ["callId", "forwardedBytes", "kind", "omittedBytes", "originalBytes", "path"]
    );
    assert.equal(toolElision.path, "input[1].output");
    assert.equal(toolElision.callId, "call_big");
    assert.equal(toolElision.kind, "tool_output");
    assert.equal(toolElision.originalBytes, new TextEncoder().encode(oversized).byteLength);
    assert.equal(toolElision.forwardedBytes <= limit, true);
    assert.equal(toolElision.omittedBytes > 0, true);
    assert.equal(imageElision.path, "input[2].content[0]");
    assert.equal(imageElision.callId, null);
    assert.equal(imageElision.kind, "image");
    assert.equal(imageElision.originalBytes, new TextEncoder().encode(hugeImage).byteLength);
    assert.equal(imageElision.omittedBytes, new TextEncoder().encode(hugeImage).byteLength);
  }

  // Any other truncation value is rejected rather than guessed at.
  const bogus = toDeepSeekResponsesChatBody({ input: "hi", truncation: "sometimes" }, "deepseek-flash", false);
  if (bogus.ok) throw new Error("expected an unsupported-value failure");
  assert.equal(bogus.param, "truncation");
  assert.equal(bogus.code, undefined);
});

// ---------------------------------------------------------------------------
// Replayed Codex item shapes.
//
// A Codex thread replays its stored history on every request, so an item shape
// the adapter refuses cannot be cleared by repairing one thread.
// ---------------------------------------------------------------------------

test("deepseek responses: a call_id-less function_call_output is skipped, not fatal", () => {
  // Codex's app-server replays a named unpaired output (`name`/`namespace`, no
  // `call_id`) for a tool its own client ran. Chat can only answer a preceding
  // `tool_calls` entry, so the output is dropped rather than re-paired by name;
  // a paired output beside it still replays normally.
  const codexTuiToolOutput = {
    type: "function_call_output",
    name: "send_message_to_thread",
    namespace: "codex_tui",
    output: "<codex_delegation>\n  <input>Continue the task</input>\n</codex_delegation>",
  };
  const translated = toDeepSeekChatMessages(
    [
      { type: "message", role: "user", content: "deliver it" },
      codexTuiToolOutput,
      { type: "function_call_output", call_id: "call_1", output: "paired output" },
    ],
    null
  );
  assert.equal(translated.ok, true);
  assert.deepEqual(translated.value, [
    { role: "user", content: "deliver it" },
    { role: "tool", tool_call_id: "call_1", content: "paired output" },
  ]);

  // A freeform output shares the branch and the same rule.
  const customOutput = toDeepSeekChatMessages(
    [
      { type: "message", role: "user", content: "deliver it" },
      { type: "custom_tool_call_output", output: "freeform" },
    ],
    null
  );
  assert.equal(customOutput.ok, true);
  assert.deepEqual(customOutput.value, [{ role: "user", content: "deliver it" }]);

  // With nothing representable left to send, the request still fails, but for
  // the honest reason: there is no message, not a rejected item shape.
  const toolOutputOnly = toDeepSeekResponsesChatBody({ input: [codexTuiToolOutput] }, "deepseek-flash", false);
  assert.equal(toolOutputOnly.ok, false);
  assert.equal(toolOutputOnly.param, "input");
  assert.equal(toolOutputOnly.message, "input must contain at least one message");
});

test("deepseek responses: malformed function_call and unknown item types still fail", () => {
  // A function_call without its call_id/name pair remains a protocol violation.
  const callWithoutId = toDeepSeekChatMessages([{ type: "function_call", name: "lookup" }], null);
  assert.equal(callWithoutId.ok, false);
  assert.equal(callWithoutId.param, "input");
  assert.equal(callWithoutId.message, "function_call items require call_id and name");
  // An unknown item type is still refused instead of being approximated.
  const unknownItem = toDeepSeekChatMessages([{ type: "computer_call", call_id: "c" }], null);
  assert.equal(unknownItem.ok, false);
  assert.equal(unknownItem.param, "input.type");
  assert.equal(unknownItem.message, "input item type 'computer_call' is not supported");
});

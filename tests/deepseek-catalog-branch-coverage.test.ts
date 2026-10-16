import { test } from "bun:test";
import assert from "node:assert/strict";

import { toDeepSeekChatMessages, toDeepSeekResponsesChatBody } from "../src/deepseek/chat-projection.ts";
import { LITHOS_RESPONSES_PROFILE } from "../src/deepseek/responses.ts";
import { withDeepSeekOfficialModels } from "../src/catalog/models.ts";

/**
 * Branch coverage for the Responses-to-Chat projection.
 *
 * Both entry points are driven with the malformed value and the well-formed
 * value of every guard, and each case asserts the projection (or the exact
 * `{ ok: false, param, message }` rejection) the route returns to the client.
 */

const MODEL = "deepseek-flash";

test("official DeepSeek rows replace paid discovery duplicates", () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const paidRow = {
      slug: "deepseek-v4-pro",
      owned_by: "metered",
      supported_reasoning_levels: [{ effort: "none" }],
      default_reasoning_level: "none",
    };
    const models = withDeepSeekOfficialModels([paidRow]);
    const pro = models.find((model) => model.slug === "deepseek-v4-pro");

    assert.equal(models.filter((model) => model.slug === "deepseek-v4-pro").length, 1);
    assert.equal(pro?.owned_by, "deepseek");
    assert.deepEqual(
      (pro?.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort),
      ["none", "low", "high", "max"]
    );
    assert.equal(pro?.default_reasoning_level, "high");
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

const messagesOf = (input: unknown, instructions: string | null = null): Record<string, unknown>[] => {
  const result = toDeepSeekChatMessages(input, instructions);
  if (!result.ok) throw new Error(`expected an accepted projection, got ${result.param}: ${result.message}`);
  return [...result.value];
};

const rejectionOf = (input: unknown, instructions: string | null = null) => {
  const result = toDeepSeekChatMessages(input, instructions);
  if (result.ok) throw new Error("expected a rejected projection");
  return { ok: false as const, param: result.param, message: result.message };
};

const bodyOf = (rawRecord: Record<string, unknown>, stream = false) => {
  const result = toDeepSeekResponsesChatBody(rawRecord, MODEL, stream);
  if (!result.ok) throw new Error(`expected an accepted body, got ${result.param}: ${result.message}`);
  return result.value;
};

/** The projected message list, asserted to be an array before it is indexed. */
const bodyMessages = (body: Record<string, unknown>): Record<string, unknown>[] => {
  const messages = body.messages;
  assert.ok(Array.isArray(messages), "the projected body must carry a message array");
  return messages;
};

const bodyRejectionOf = (rawRecord: Record<string, unknown>, stream = false) => {
  const result = toDeepSeekResponsesChatBody(rawRecord, MODEL, stream);
  if (result.ok) throw new Error("expected a rejected body");
  return { ok: false as const, param: result.param, message: result.message };
};

test("chat projection: instructions and string inputs produce the plain user/system turn", () => {
  assert.deepEqual(messagesOf("hi"), [{ role: "user", content: "hi" }]);
  assert.deepEqual(messagesOf("hi", "be brief"), [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(messagesOf(""), []);
  assert.deepEqual(messagesOf(undefined), []);
  assert.deepEqual(messagesOf(null), []);
  assert.deepEqual(rejectionOf(42), { ok: false, param: "input", message: "input must be a string or an array" });
});

test("chat projection: a message item normalizes its role and content shapes", () => {
  assert.deepEqual(messagesOf([{ type: "message", role: "user", content: "hello" }]), [{ role: "user", content: "hello" }]);
  // A missing role defaults to user, and the developer role becomes system.
  assert.deepEqual(messagesOf([{ content: "hello" }]), [{ role: "user", content: "hello" }]);
  assert.deepEqual(messagesOf([{ type: "message", role: "developer", content: "rules" }]), [{ role: "system", content: "rules" }]);
  // A plain string item is a user turn.
  assert.deepEqual(messagesOf(["raw text"]), [{ role: "user", content: "raw text" }]);
  // Array content with only text collapses to the string form.
  assert.deepEqual(
    messagesOf([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "a" },
          { type: "output_text", text: "b" },
        ],
      },
    ]),
    [{ role: "user", content: "ab" }]
  );
  // An image part switches the content to the Chat content array, text first.
  assert.deepEqual(
    messagesOf([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", image_url: "https://example.test/a.png", detail: "high" },
          { type: "input_image", file_url: "https://example.test/b.png" },
        ],
      },
    ]),
    [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://example.test/a.png", detail: "high" } },
          { type: "image_url", image_url: { url: "https://example.test/b.png" } },
        ],
      },
    ]
  );
  // An assistant refusal replays as assistant text.
  assert.deepEqual(messagesOf([{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }]), [{ role: "assistant", content: "no" }]);
});

test("chat projection: every malformed content shape is rejected with its param", () => {
  assert.deepEqual(rejectionOf([42]), { ok: false, param: "input", message: "input items must be objects" });
  assert.deepEqual(rejectionOf([{ type: "message", role: "system", content: "x" }]), {
    ok: false,
    param: "input.role",
    message: "input role 'system' is not supported",
  });
  assert.deepEqual(rejectionOf([{ type: "message", role: "user", content: 42 }]), {
    ok: false,
    param: "input.content",
    message: "input.content must be a string or an array",
  });
  assert.deepEqual(rejectionOf([{ type: "message", role: "user", content: [42] }]), {
    ok: false,
    param: "input.content",
    message: "input.content items must be objects",
  });
  assert.deepEqual(rejectionOf([{ type: "message", role: "user", content: [{ type: "input_text", text: 42 }] }]), {
    ok: false,
    param: "input.content.text",
    message: "input.content text must be a string",
  });
  assert.deepEqual(rejectionOf([{ type: "message", role: "assistant", content: [{ type: "refusal" }] }]), {
    ok: false,
    param: "input.content.refusal",
    message: "input.content refusal must be a string",
  });
  // A refusal part is only assistant output, so another role keeps the rejection.
  assert.deepEqual(rejectionOf([{ type: "message", role: "user", content: [{ type: "refusal", refusal: "no" }] }]), {
    ok: false,
    param: "input.content.type",
    message: "input.content type 'refusal' is not supported",
  });
  // An unknown part type is named in the rejection.
  assert.deepEqual(rejectionOf([{ type: "message", role: "user", content: [{ type: "input_audio" }] }]), {
    ok: false,
    param: "input.content.type",
    message: "input.content type 'input_audio' is not supported",
  });
  assert.deepEqual(rejectionOf([{ type: "message", role: "user", content: [{ type: 5 }] }]), {
    ok: false,
    param: "input.content.type",
    message: "input.content type 'unknown' is not supported",
  });
  assert.deepEqual(rejectionOf([{ type: "message", role: "user", content: [{ type: "input_image" }] }]), {
    ok: false,
    param: "input.content.image_url",
    message: "input_image requires image_url",
  });
  assert.deepEqual(rejectionOf([{ type: "web_search" }]), {
    ok: false,
    param: "input.type",
    message: "input item type 'web_search' is not supported",
  });
});

test("chat projection: tool call and tool result items round-trip", () => {
  assert.deepEqual(messagesOf([{ type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" }]), [
    { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
  ]);
  // Consecutive calls merge into one assistant turn, and `id` is accepted as an alias.
  assert.deepEqual(
    messagesOf([
      { type: "function_call", call_id: "call-1", name: "a", arguments: "{}" },
      { type: "function_call", id: "call-2", name: "b", arguments: 5 },
    ]),
    [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "call-2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      },
    ]
  );
  // A freeform call travels as one JSON `input` argument.
  assert.deepEqual(messagesOf([{ type: "custom_tool_call", id: "call-3", name: "exec", input: "ls" }]), [
    { role: "assistant", content: null, tool_calls: [{ id: "call-3", type: "function", function: { name: "exec", arguments: '{"input":"ls"}' } }] },
  ]);
  assert.deepEqual(messagesOf([{ type: "custom_tool_call", id: "call-4", name: "exec" }]), [
    { role: "assistant", content: null, tool_calls: [{ id: "call-4", type: "function", function: { name: "exec", arguments: '{"input":""}' } }] },
  ]);
  // Results become tool turns; a structured output is serialized.
  assert.deepEqual(messagesOf([{ type: "function_call_output", call_id: "call-1", output: "42" }]), [{ role: "tool", tool_call_id: "call-1", content: "42" }]);
  assert.deepEqual(messagesOf([{ type: "custom_tool_call_output", call_id: "call-2", output: { ok: true } }]), [
    { role: "tool", tool_call_id: "call-2", content: '{"ok":true}' },
  ]);
  assert.deepEqual(messagesOf([{ type: "function_call_output", call_id: "call-3" }]), [{ role: "tool", tool_call_id: "call-3", content: '""' }]);

  assert.deepEqual(rejectionOf([{ type: "function_call", name: "lookup" }]), {
    ok: false,
    param: "input",
    message: "function_call items require call_id and name",
  });
  assert.deepEqual(rejectionOf([{ type: "custom_tool_call", input: "ls" }]), {
    ok: false,
    param: "input",
    message: "custom_tool_call items require call_id and name",
  });
  // An unpaired output has no Chat destination, so it is skipped rather than
  // rejected: the projection succeeds with no message for that item.
  assert.deepEqual(messagesOf([{ type: "function_call_output", output: "42" }]), []);
});

test("chat projection: replayed reasoning is carried onto the following assistant turn", () => {
  // Both the summary and the content parts are read, and a direct text is appended.
  const carried = messagesOf([
    { type: "reasoning", summary: [{ text: "sum-" }], content: [{ type: "text", text: "content-" }], text: "direct" },
    { type: "message", role: "assistant", content: "answer" },
  ]);
  assert.deepEqual(carried, [{ role: "assistant", content: "answer", reasoning_content: "sum-content-direct" }]);

  // Parts that are not objects or carry no text contribute nothing.
  const skipped = messagesOf([
    { type: "reasoning", summary: [42, { text: 5 }], content: [{ text: "kept" }] },
    { type: "message", role: "assistant", content: "answer" },
  ]);
  assert.deepEqual(skipped, [{ role: "assistant", content: "answer", reasoning_content: "kept" }]);

  // Reasoning ahead of a tool call lands on the tool-call turn.
  const toolTurn = messagesOf([
    { type: "reasoning", summary: [{ text: "thinking" }] },
    { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "42" },
  ]);
  assert.deepEqual(toolTurn, [
    {
      role: "assistant",
      content: null,
      reasoning_content: "thinking",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call-1", content: "42" },
  ]);

  // A reasoning item on its own leaves no message behind.
  assert.deepEqual(messagesOf([{ type: "reasoning", summary: [{ text: "orphan" }] }]), []);
});

test("chat projection: the request body carries the official model and the optional fields", () => {
  const minimal = bodyOf({ input: "hi" });
  assert.deepEqual(minimal.body, { model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.deepEqual([...minimal.toolNames.entries()], []);
  assert.deepEqual([...minimal.customToolNames], []);

  const streamed = bodyOf({ input: "hi" }, true);
  assert.deepEqual(streamed.body.stream_options, { include_usage: true });
  assert.equal(bodyOf({ input: "hi" }, false).body.stream_options, undefined);

  assert.deepEqual(bodyOf({ input: "hi", max_output_tokens: 100 }).body.max_tokens, 100);
  assert.equal(bodyOf({ input: "hi", max_output_tokens: undefined }).body.max_tokens, undefined);
  assert.equal(bodyOf({ input: "hi", max_output_tokens: null }).body.max_tokens, undefined);
  assert.deepEqual(bodyRejectionOf({ input: "hi", max_output_tokens: 0 }), {
    ok: false,
    param: "max_output_tokens",
    message: "max_output_tokens must be a positive integer",
  });
  assert.equal(bodyRejectionOf({ input: "hi", max_output_tokens: 1.5 }).param, "max_output_tokens");

  assert.equal(bodyOf({ input: "hi", reasoning: { effort: "max" } }).body.reasoning_effort, "max");
  assert.equal(bodyOf({ input: "hi", reasoning: {} }).body.reasoning_effort, undefined);
  assert.equal(bodyOf({ input: "hi", reasoning: { effort: "" } }).body.reasoning_effort, undefined);
  assert.deepEqual(bodyRejectionOf({ input: "hi", reasoning: "max" }), { ok: false, param: "reasoning", message: "reasoning must be an object" });
  // An unlisted tier is forwarded for the DeepSeek profile (the uploaded catalog
  // is authoritative), while the LithosAI profile rejects it through the same code.
  assert.equal(bodyOf({ input: "hi", reasoning: { effort: "impossible" } }).body.reasoning_effort, "impossible");
  const lithosRejection = toDeepSeekResponsesChatBody(
    { input: "hi", reasoning: { effort: "impossible" } },
    "deepseek-ai/DeepSeek-V4.1-Flash",
    false,
    LITHOS_RESPONSES_PROFILE
  );
  assert.deepEqual(lithosRejection, {
    ok: false,
    param: "reasoning.effort",
    message: "reasoning.effort 'impossible' is not supported by LithosAI",
  });

  assert.equal(bodyOf({ input: "hi", parallel_tool_calls: true }).body.parallel_tool_calls, true);
  assert.equal(bodyOf({ input: "hi", parallel_tool_calls: "yes" }).body.parallel_tool_calls, undefined);

  assert.deepEqual(bodyRejectionOf({}), { ok: false, param: "input", message: "input must contain at least one message" });
  // A blank instruction string is not instructions, so no system message appears.
  const blankInstructions = bodyOf({ input: "hi", instructions: "   " });
  assert.deepEqual(bodyMessages(blankInstructions.body), [{ role: "user", content: "hi" }]);
  assert.deepEqual(bodyRejectionOf({ input: "" }), { ok: false, param: "input", message: "input must contain at least one message" });
  const unknownModel = toDeepSeekResponsesChatBody({ input: "hi" }, "gpt-6", false);
  assert.deepEqual(unknownModel, { ok: false, param: "model", message: "model 'gpt-6' is not a DeepSeek official model" });
});

test("chat projection: tools are flattened, renamed on collision and filtered by type", () => {
  const named = bodyOf({
    input: "hi",
    tools: [
      { type: "function", name: "lookup", description: "d", parameters: { type: "object" }, strict: true },
      { type: "function", name: "lookup" },
      { type: "custom", name: "exec", description: "run" },
      { type: "custom", name: "exec" },
      { type: "web_search" },
      { function: { name: "nested", arguments: null } },
    ],
  });
  assert.deepEqual(named.body.tools, [
    { type: "function", function: { name: "lookup", description: "d", parameters: { type: "object" }, strict: true } },
    { type: "function", function: { name: "lookup_2" } },
    {
      type: "function",
      function: {
        name: "exec",
        description: "run",
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "Freeform input for the tool." } },
          required: ["input"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "exec_2",
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "Freeform input for the tool." } },
          required: ["input"],
          additionalProperties: false,
        },
      },
    },
    { type: "function", function: { name: "nested" } },
  ]);
  assert.deepEqual(
    [...named.toolNames.entries()],
    [
      ["lookup_2", { name: "lookup", namespace: null }],
      ["exec_2", { name: "exec", namespace: null }],
    ]
  );
  assert.deepEqual([...named.customToolNames], ["exec", "exec_2"]);

  // A namespace groups functions, prefixes a colliding name, and drops the rest.
  const namespaced = bodyOf({
    input: "hi",
    tools: [
      { type: "function", name: "lookup" },
      { type: "namespace", name: "ns", tools: [{ type: "function", name: "lookup" }] },
      { type: "namespace", name: "empty", tools: [{ type: "web_search" }] },
    ],
  });
  // The namespace prefixes only the colliding name, and records it for reverse translation.
  assert.deepEqual(namespaced.body.tools, [
    { type: "function", function: { name: "lookup" } },
    { type: "function", function: { name: "ns_lookup" } },
  ]);
  assert.deepEqual([...namespaced.toolNames.entries()], [["ns_lookup", { name: "lookup", namespace: "ns" }]]);

  const rejects: readonly Record<string, unknown>[] = [
    { input: "hi", tools: "none" },
    { input: "hi", tools: [42] },
    { input: "hi", tools: [{ type: "function" }] },
    { input: "hi", tools: [{ type: "custom" }] },
    { input: "hi", tools: [{ type: "namespace", name: "ns" }] },
    { input: "hi", tools: [{ type: "namespace", name: "ns", tools: [42] }] },
    { input: "hi", tools: [{ type: "namespace", name: "ns", tools: [{ type: "function" }] }] },
  ];
  assert.deepEqual(bodyRejectionOf(rejects[0]), { ok: false, param: "tools", message: "tools must be an array" });
  assert.deepEqual(bodyRejectionOf(rejects[1]), { ok: false, param: "tools", message: "tools must contain objects" });
  assert.deepEqual(bodyRejectionOf(rejects[2]), { ok: false, param: "tools.name", message: "function tools require a name" });
  assert.deepEqual(bodyRejectionOf(rejects[3]), { ok: false, param: "tools.name", message: "custom tools require a name" });
  assert.deepEqual(bodyRejectionOf(rejects[4]), { ok: false, param: "tools.tools", message: "namespace tools must nest a tools array" });
  assert.deepEqual(bodyRejectionOf(rejects[5]), { ok: false, param: "tools.tools", message: "namespace tools must contain objects" });
  assert.deepEqual(bodyRejectionOf(rejects[6]), { ok: false, param: "tools.name", message: "function tools require a name" });

  // An empty tool list leaves the body without tools.
  assert.equal(bodyOf({ input: "hi", tools: [] }).body.tools, undefined);
});

test("chat projection: tool choice and response format are translated or rejected", () => {
  // Thinking mode is active by default, so `required` and named choices conflict
  // unless the caller asks for no reasoning.
  assert.equal(bodyOf({ input: "hi", tool_choice: "auto" }).body.tool_choice, "auto");
  assert.equal(bodyOf({ input: "hi", reasoning: { effort: "none" }, tool_choice: "required" }).body.tool_choice, "required");
  assert.equal(bodyOf({ input: "hi", tool_choice: "none" }).body.tool_choice, "none");
  const conflict = bodyRejectionOf({ input: "hi", tool_choice: "required" });
  assert.equal(conflict.param, "tool_choice");
  assert.match(conflict.message, /required/);
  assert.equal(bodyOf({ input: "hi", tool_choice: undefined }).body.tool_choice, undefined);
  assert.deepEqual(bodyRejectionOf({ input: "hi", tool_choice: "sometimes" }), {
    ok: false,
    param: "tool_choice",
    message: "tool_choice 'sometimes' is not supported",
  });
  assert.deepEqual(bodyRejectionOf({ input: "hi", tool_choice: 42 }), {
    ok: false,
    param: "tool_choice",
    message: "tool_choice must be a string or an object",
  });

  // A named choice maps the renamed tool back to its original name.
  const renamed = bodyOf({
    input: "hi",
    tools: [
      { type: "function", name: "lookup" },
      { type: "namespace", name: "ns", tools: [{ type: "function", name: "lookup" }] },
    ],
    reasoning: { effort: "none" },
    tool_choice: { type: "function", function: { name: "ns_lookup" } },
  });
  assert.deepEqual(renamed.body.tool_choice, { type: "function", function: { name: "lookup" } });
  assert.deepEqual(bodyOf({ input: "hi", reasoning: { effort: "none" }, tool_choice: { name: "plain" } }).body.tool_choice, {
    type: "function",
    function: { name: "plain" },
  });
  assert.deepEqual(bodyRejectionOf({ input: "hi", tool_choice: {} }), {
    ok: false,
    param: "tool_choice.name",
    message: "a named tool_choice requires a name",
  });

  assert.deepEqual(bodyOf({ input: "hi", text: { format: { type: "json_object" } } }).body.response_format, { type: "json_object" });
  assert.equal(bodyOf({ input: "hi", text: { format: { type: "text" } } }).body.response_format, undefined);
  assert.equal(bodyOf({ input: "hi", text: {} }).body.response_format, undefined);
  assert.equal(bodyOf({ input: "hi", text: undefined }).body.response_format, undefined);
  assert.deepEqual(bodyRejectionOf({ input: "hi", text: "json" }), { ok: false, param: "text", message: "text must be an object" });
  assert.deepEqual(bodyRejectionOf({ input: "hi", text: { format: "json" } }), { ok: false, param: "text.format", message: "text.format must be an object" });
  assert.equal(bodyOf({ input: "hi", text: { format: { type: 5 } } }).body.response_format, undefined);
  assert.deepEqual(bodyRejectionOf({ input: "hi", text: { format: { type: "xml" } } }), {
    ok: false,
    param: "text.format.type",
    message: "text.format type 'xml' is not supported upstream",
  });
});

test("chat projection: a tool-bearing request gets the continuation instruction and replayed reasoning", () => {
  const instructionExtended = bodyOf({
    input: [{ type: "message", role: "user", content: "do it" }],
    instructions: "be terse",
    tools: [{ type: "function", name: "lookup" }],
  });
  const system = bodyMessages(instructionExtended.body)[0];
  assert.equal(system.role, "system");
  assert.match(String(system.content), /^be terse/);
  assert.match(String(system.content), /a progress update does not complete a requested action/);

  // Without instructions the reminder becomes the system message.
  const instructionAdded = bodyOf({
    input: [{ type: "message", role: "user", content: "do it" }],
    tools: [{ type: "function", name: "lookup" }],
  });
  const addedMessages = bodyMessages(instructionAdded.body);
  assert.equal(addedMessages[0].role, "system");
  assert.match(String(addedMessages[0].content), /^When tools are available/);

  // `tool_choice: "none"` is a hard no-tools request, so nothing is appended.
  const noTools = bodyOf({
    input: [{ type: "message", role: "user", content: "do it" }],
    tools: [{ type: "function", name: "lookup" }],
    tool_choice: "none",
  });
  const plainMessages = bodyMessages(noTools.body);
  assert.equal(plainMessages.length, 1);
  assert.equal(plainMessages[0].role, "user");

  // Assistant turns after the last user turn gain the reasoning field the
  // provider requires, while history before it stays untouched.
  const tail = bodyOf({
    input: [
      { type: "message", role: "assistant", content: "history" },
      { type: "message", role: "user", content: "continue" },
      { type: "message", role: "assistant", content: "progress" },
      { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "42" },
    ],
    tools: [{ type: "function", name: "lookup" }],
  });
  const projected = bodyMessages(tail.body);
  // The continuation reminder becomes the leading system message.
  assert.equal(projected[0].role, "system");
  assert.equal(projected.find((message) => message.content === "history")?.reasoning_content, undefined);
  assert.equal(projected.find((message) => message.content === "progress")?.reasoning_content, "");
  assert.equal(projected.find((message) => Array.isArray(message.tool_calls))?.reasoning_content, "");
  assert.equal(projected.at(-1)?.role, "tool");
});

test("chat projection: the caller's own reasoning survives the trailing fill", () => {
  const body = bodyOf({
    input: [
      { type: "message", role: "user", content: "continue" },
      { type: "reasoning", summary: [{ text: "planned" }] },
      { type: "message", role: "assistant", content: "using the tool" },
      { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
    ],
    tools: [{ type: "function", name: "lookup" }],
  });
  const projected = bodyMessages(body.body);
  assert.equal(projected.find((message) => message.content === "using the tool")?.reasoning_content, "planned");
  assert.equal(projected.filter((message) => message.reasoning_content === "").length, 1);
});
// --- src/deepseek/index.ts -------------------------------------------------

import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  DEEPSEEK_PRO_MODEL,
  DEEPSEEK_V4_FLASH_MODEL,
  DeepSeekError,
  deepSeekFinishDisposition,
  deepSeekThinkingModeForbiddenToolChoice,
  deepSeekThinkingToolChoiceConflict,
  deepSeekToolChoiceThinkingConflictMessage,
  deepSeekUpstreamModelFor,
  fetchDeepSeekChatCompletions,
  normalizeDeepSeekChatCompletion,
  normalizeDeepSeekChatCompletionChunk,
  normalizeDeepSeekProviderRequestId,
  projectDeepSeekRequest,
} from "../src/deepseek/index.ts";

test("DeepSeek model lookup preserves canonical models, the legacy alias and normalized ids", () => {
  for (const [requested, upstream] of [
    [MODEL, MODEL],
    [DEEPSEEK_PRO_MODEL, DEEPSEEK_PRO_MODEL],
    [DEEPSEEK_V4_FLASH_MODEL, MODEL],
    [" DEEPSEEK-FLASH ", MODEL],
    [" DEEPSEEK-V4-PRO ", DEEPSEEK_PRO_MODEL],
    [" DEEPSEEK-V4-FLASH ", MODEL],
  ]) {
    assert.equal(deepSeekUpstreamModelFor(requested), upstream);
    assert.equal(projectDeepSeekRequest({ messages: [{ role: "user", content: "hi" }] }, requested).model, upstream);
    const responses = toDeepSeekResponsesChatBody({ input: "hi" }, requested, false);
    assert.ok(responses.ok);
    assert.equal(responses.value.body.model, upstream);
  }
});

for (const model of ["constructor", "__proto__", "toString"]) {
  test(`DeepSeek model lookup rejects prototype name ${model} in both request projections`, () => {
    assert.equal(deepSeekUpstreamModelFor(model), null);
    assert.throws(
      () => projectDeepSeekRequest({ messages: [{ role: "user", content: "hi" }] }, model),
      (error: unknown) => error instanceof DeepSeekError && error.code === "deepseek_request_invalid" && error.status === 400
    );
    assert.deepEqual(toDeepSeekResponsesChatBody({ input: "hi" }, model, false), {
      ok: false,
      param: "model",
      message: `model '${model}' is not a DeepSeek official model`,
    });
  });
}

const completionPayload = (message: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-deepseek",
  object: "chat.completion",
  created: 1_800_000_000,
  model: MODEL,
  choices: [{ index: 0, message, finish_reason: "stop" }],
  ...extra,
});

const chunkPayload = (choice: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-deepseek",
  object: "chat.completion.chunk",
  created: 1_800_000_000,
  model: MODEL,
  choices: [choice],
  ...extra,
});

const completionRejection = (value: unknown): string => {
  const result = normalizeDeepSeekChatCompletion(value, MODEL);
  if (result.ok) throw new Error("expected a rejected completion");
  return result.message;
};

const chunkRejection = (value: unknown): string => {
  const result = normalizeDeepSeekChatCompletionChunk(value, MODEL);
  if (result.ok) throw new Error("expected a rejected chunk");
  return result.message;
};

test("deepseek normalizer: the completion envelope rejects each malformed field", () => {
  assert.equal(completionRejection(null), "Upstream did not return a Chat Completions object.");
  assert.equal(completionRejection([]), "Upstream did not return a Chat Completions object.");
  assert.equal(completionRejection(completionPayload({}, { id: "" })), "Upstream Chat Completion is missing an id.");
  assert.equal(completionRejection(completionPayload({}, { created: -1 })), "Upstream Chat Completion has an invalid creation time.");
  assert.equal(completionRejection(completionPayload({}, { object: "chat.completion.chunk" })), "Upstream did not return a Chat Completion.");
  assert.equal(completionRejection(completionPayload({}, { model: "some-other-model" })), "Upstream returned a different model than requested.");
  assert.equal(completionRejection(completionPayload({}, { choices: [] })), "Upstream Chat Completion has no choices.");
  assert.equal(completionRejection(completionPayload({}, { choices: "none" })), "Upstream Chat Completion has no choices.");
  assert.equal(completionRejection(completionPayload({ role: "assistant", content: "hi" }, { usage: "tokens" })), "Upstream usage is not an object.");
  assert.equal(completionRejection(completionPayload({ role: "assistant", content: "hi" }, { usage: { prompt_tokens: 1 } })), "Upstream usage is incomplete.");

  // A payload without an object field and with model omitted is still accepted.
  const accepted = normalizeDeepSeekChatCompletion(
    completionPayload({ role: "assistant", content: "hi" }, { object: undefined, model: undefined, usage: undefined }),
    MODEL
  );
  assert.equal(accepted.ok, true);
});

test("deepseek normalizer: every malformed choice and tool call is rejected with its message", () => {
  assert.equal(completionRejection(completionPayload({}, { choices: [42] })), "Upstream choice 0 is not an object.");
  assert.equal(completionRejection(completionPayload({}, { choices: [{ message: {} }] })), "Upstream choice 0 has an invalid index.");
  assert.equal(completionRejection(completionPayload({}, { choices: [{ index: 0 }] })), "Upstream choice 0 is missing an assistant message.");
  assert.equal(
    completionRejection(completionPayload({}, { choices: [{ index: 0, message: { role: "user" } }] })),
    "Upstream choice 0 does not contain an assistant message."
  );
  assert.equal(
    completionRejection(completionPayload({}, { choices: [{ index: 0, message: { role: "assistant", content: 42 } }] })),
    "Upstream choice 0 has unsupported message content."
  );
  assert.equal(
    completionRejection(completionPayload({}, { choices: [{ index: 0, message: { role: "assistant", reasoning_content: 42 } }] })),
    "Upstream choice 0 has invalid reasoning content."
  );
  assert.equal(
    completionRejection(completionPayload({}, { choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: 42 }] })),
    "Upstream choice 0 has an invalid finish reason."
  );
  assert.equal(
    completionRejection(completionPayload({}, { choices: [{ index: 0, message: { role: "assistant", refusal: 42 } }] })),
    "Upstream choice 0 has an invalid refusal."
  );
  // No payload at all is rejected rather than returned as an empty completion.
  assert.equal(
    completionRejection(completionPayload({}, { choices: [{ index: 0, message: { role: "assistant" } }] })),
    "Upstream choice 0 has neither content nor a tool call."
  );

  const toolCallRejection = (message: Record<string, unknown>) =>
    completionRejection(completionPayload({}, { choices: [{ index: 0, message: { role: "assistant", content: null, ...message } }] }));
  assert.equal(toolCallRejection({ tool_calls: "none" }), "Upstream choice 0 has invalid tool calls.");
  assert.equal(toolCallRejection({ tool_calls: [42] }), "Upstream tool call 0 is not an object.");
  assert.equal(toolCallRejection({ tool_calls: [{}] }), "Upstream tool call 0 is missing an id.");
  assert.equal(toolCallRejection({ tool_calls: [{ id: "call-1" }] }), "Upstream tool call 0 has an unsupported type.");
  assert.equal(toolCallRejection({ tool_calls: [{ id: "call-1", type: "function" }] }), "Upstream tool call 0 is missing its function.");
  assert.equal(
    toolCallRejection({ tool_calls: [{ id: "call-1", type: "function", function: { arguments: "{}" } }] }),
    "Upstream tool call 0 is missing a function name."
  );
  assert.equal(
    toolCallRejection({ tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: 5 } }] }),
    "Upstream tool call 0 has non-string arguments."
  );

  // A tool call without a finish reason reports tool_calls, and one without any
  // payload at all still stops.
  const toolCompletion = normalizeDeepSeekChatCompletion(
    completionPayload(
      {},
      {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
          },
        ],
      }
    ),
    MODEL
  );
  if (!toolCompletion.ok) throw new Error("expected an accepted completion");
  const acceptedToolTurn = toolCompletion.value;
  const choices = acceptedToolTurn.choices;
  assert.ok(Array.isArray(choices));
  const choice = choices[0];
  assert.ok(choice !== undefined);
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(choice.message, {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }],
  });
  assert.equal(acceptedToolTurn.object, "chat.completion");
});

test("deepseek normalizer: the chunk envelope and delta reject each malformed field", () => {
  assert.equal(chunkRejection(null), "Upstream did not return a Chat Completions chunk.");
  assert.equal(chunkRejection(chunkPayload({}, { id: "" })), "Upstream Chat Completion chunk is missing an id.");
  assert.equal(chunkRejection(chunkPayload({}, { created: "now" })), "Upstream Chat Completion chunk has an invalid creation time.");
  assert.equal(chunkRejection(chunkPayload({}, { object: "chat.completion" })), "Upstream did not return a Chat Completion chunk.");
  assert.equal(chunkRejection(chunkPayload({}, { model: "other" })), "Upstream returned a different model than requested.");
  assert.equal(chunkRejection(chunkPayload({}, { choices: "none" })), "Upstream Chat Completion chunk has no choices array.");
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: { content: "hi" } }, { usage: "tokens" })), "Upstream usage is not an object.");
  assert.equal(chunkRejection(chunkPayload(42)), "Upstream chunk choice 0 is not an object.");
  assert.equal(chunkRejection(chunkPayload({ delta: {} })), "Upstream chunk choice 0 has an invalid index.");
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: 42 })), "Upstream chunk choice 0 has an invalid delta.");
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: { role: 42 } })), "Upstream chunk choice 0 has an invalid delta role.");
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: { content: 42 } })), "Upstream chunk choice 0 has invalid content.");
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: { reasoning_content: 42 } })), "Upstream chunk choice 0 has invalid reasoning_content.");
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: { refusal: 42 } })), "Upstream chunk choice 0 has invalid refusal.");
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: { tool_calls: "none" } })), "Upstream chunk choice 0 has invalid tool calls.");
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: { tool_calls: [{ index: "0" }] } })), "Upstream tool call delta 0 has an invalid index.");
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: { tool_calls: [{ index: 0, id: "  " }] } })), "Upstream tool call delta 0 has an invalid id.");
  assert.equal(
    chunkRejection(chunkPayload({ index: 0, delta: { tool_calls: [{ index: 0, type: "text" }] } })),
    "Upstream tool call delta 0 has an unsupported type."
  );
  assert.equal(
    chunkRejection(chunkPayload({ index: 0, delta: { tool_calls: [{ index: 0, function: "later" }] } })),
    "Upstream tool call delta 0 has an invalid function."
  );
  assert.equal(
    chunkRejection(chunkPayload({ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 42 } }] } })),
    "Upstream tool call delta 0 has an invalid function name."
  );
  assert.equal(
    chunkRejection(chunkPayload({ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 42 } }] } })),
    "Upstream tool call delta 0 has non-string arguments."
  );
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: { tool_calls: [{}] } })), "Upstream tool call delta 0 carries no fields.");
  assert.equal(chunkRejection(chunkPayload({ index: 0, delta: {}, finish_reason: 42 })), "Upstream chunk choice 0 has an invalid finish reason.");

  // The empty-choices totals frame is valid and carries usage.
  const totals = normalizeDeepSeekChatCompletionChunk(
    chunkPayload({ index: 0, delta: {} }, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
    MODEL
  );
  if (!totals.ok) throw new Error("expected an accepted totals chunk");
  assert.deepEqual(totals.value.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });

  // A full delta keeps every field the frame carried.
  const full = normalizeDeepSeekChatCompletionChunk(
    chunkPayload({
      index: 0,
      delta: {
        role: "assistant",
        content: "hi",
        reasoning_content: "why",
        refusal: "no",
        tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    }),
    MODEL
  );
  if (!full.ok) throw new Error("expected an accepted chunk");
  assert.deepEqual(full.value.choices, [
    {
      index: 0,
      delta: {
        role: "assistant",
        content: "hi",
        reasoning_content: "why",
        refusal: "no",
        tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    },
  ]);
});

test("deepseek wire: finish dispositions cover the documented vocabulary", () => {
  assert.deepEqual(deepSeekFinishDisposition(""), { kind: "completed" });
  assert.deepEqual(deepSeekFinishDisposition("stop"), { kind: "completed" });
  assert.deepEqual(deepSeekFinishDisposition("tool_calls"), { kind: "completed" });
  assert.deepEqual(deepSeekFinishDisposition("length"), { kind: "incomplete", reason: "max_output_tokens" });
  assert.deepEqual(deepSeekFinishDisposition("content_filter"), { kind: "incomplete", reason: "content_filter" });
  assert.deepEqual(deepSeekFinishDisposition("insufficient_system_resource"), { kind: "failed", code: "insufficient_system_resource" });
  assert.deepEqual(deepSeekFinishDisposition("aborted"), { kind: "failed", code: "aborted" });
  assert.deepEqual(deepSeekFinishDisposition("something_new"), { kind: "unknown", value: "something_new" });
  // A non-string reason reads as the empty sentinel, which the provider's own
  // client maps to a normal stop.
  assert.deepEqual(deepSeekFinishDisposition(42), { kind: "completed" });
});

test("deepseek wire: thinking-mode tool-choice conflicts name the offending field", () => {
  assert.equal(deepSeekThinkingModeForbiddenToolChoice(undefined), null);
  assert.equal(deepSeekThinkingModeForbiddenToolChoice("auto"), null);
  assert.equal(deepSeekThinkingModeForbiddenToolChoice("required"), "required");
  assert.equal(deepSeekThinkingModeForbiddenToolChoice({ name: "lookup" }), "function:lookup");
  assert.equal(deepSeekThinkingModeForbiddenToolChoice({ function: { name: "lookup" } }), "function:lookup");
  assert.equal(deepSeekThinkingModeForbiddenToolChoice({}), null);

  assert.equal(deepSeekThinkingToolChoiceConflict("high", undefined, "required"), "required");
  assert.equal(deepSeekThinkingToolChoiceConflict("none", undefined, "required"), null);
  assert.equal(deepSeekThinkingToolChoiceConflict("high", false, "required"), "required");
  assert.equal(deepSeekThinkingToolChoiceConflict("none", false, "required"), null);
  assert.match(deepSeekToolChoiceThinkingConflictMessage("required", "reasoning.effort"), /reasoning\.effort/);
});

test("deepseek wire: provider request ids and dispatch failures keep their identity", async () => {
  assert.equal(normalizeDeepSeekProviderRequestId("req-1"), "req-1");
  assert.equal(normalizeDeepSeekProviderRequestId(undefined), null);
  assert.equal(normalizeDeepSeekProviderRequestId(""), null);
  assert.equal(normalizeDeepSeekProviderRequestId("bad\nheader"), null);
  assert.equal(normalizeDeepSeekProviderRequestId("x".repeat(257)), null);

  // A circular body cannot be serialized, so the dispatch fails as a request error.
  const circular: Record<string, unknown> = { messages: [] };
  circular.self = circular;
  const unserializable = fetchDeepSeekChatCompletions(circular, MODEL, { apiKey: "sk-test" });
  await assert.rejects(unserializable, (error: unknown) => error instanceof DeepSeekError && error.code === "deepseek_request_invalid");

  // An already-aborted request signal aborts before the transport is reached.
  const controller = new AbortController();
  controller.abort(new DOMException("deadline", "TimeoutError"));
  let dispatched = false;
  await assert.rejects(
    () =>
      fetchDeepSeekChatCompletions({ messages: [{ role: "user", content: "hi" }] }, MODEL, {
        apiKey: "sk-test",
        signal: controller.signal,
        fetcher: () => {
          dispatched = true;
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
        beforeDispatch: () => ({
          markTransportStarted: () => {},
          cancelBeforeTransport: () => Promise.resolve(),
        }),
      }),
    (error: unknown) => error instanceof DeepSeekError && error.code === "gateway_timeout"
  );
  assert.equal(dispatched, false);

  // A caller abort keeps the caller's own reason.
  const caller = new AbortController();
  const reason = new Error("client left");
  caller.abort(reason);
  await assert.rejects(
    () => fetchDeepSeekChatCompletions({ messages: [{ role: "user", content: "hi" }] }, MODEL, { apiKey: "sk-test", signal: caller.signal }),
    (error: unknown) => error === reason
  );

  // A transport failure becomes the unreachable error, and the URL is the official one.
  let requested: string | null = null;
  const failing = await fetchDeepSeekChatCompletions({ messages: [{ role: "user", content: "hi" }] }, MODEL, {
    apiKey: "sk-test",
    fetcher: (input) => {
      if (typeof input === "string") requested = input;
      else if (input instanceof URL) requested = input.toString();
      else requested = input.url;
      return Promise.reject(new TypeError("connect ECONNREFUSED"));
    },
  }).catch((error: unknown) => error);
  assert.ok(failing instanceof DeepSeekError);
  assert.equal(requested as string | null, DEEPSEEK_CHAT_COMPLETIONS_URL);

  // A provider error passed through by the adapter keeps its own class and status.
  const upstream = new DeepSeekError("upstream exploded", "deepseek_upstream_unreachable", 502);
  await assert.rejects(
    () => fetchDeepSeekChatCompletions({ messages: [{ role: "user", content: "hi" }] }, MODEL, { apiKey: "sk-test", fetcher: () => Promise.reject(upstream) }),
    (error: unknown) => error === upstream
  );

  // The projection rejects a model the provider does not serve.
  await assert.rejects(
    () => fetchDeepSeekChatCompletions({ messages: [] }, "not-a-deepseek-model", { apiKey: "sk-test" }),
    (error: unknown) => error instanceof DeepSeekError && error.code === "deepseek_request_invalid"
  );

  // A healthy dispatch returns the upstream response untouched.
  const healthy = await fetchDeepSeekChatCompletions({ messages: [{ role: "user", content: "hi" }] }, DEEPSEEK_PRO_MODEL, {
    apiKey: "sk-test",
    fetcher: () => Promise.resolve(new Response(JSON.stringify({ id: "chatcmpl-1" }), { status: 200 })),
  });
  assert.equal(healthy.status, 200);
});

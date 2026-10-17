import { test } from "bun:test";
import assert from "node:assert/strict";

import { buildCerebrasHarmonyRequest, createCerebrasTransport, normalizeHarmonyChatCompletion, runHarmonyTurn } from "../src/harmony/adapter.ts";
import { advanceConversation, appendToolResult, appendUser, createConversation } from "../src/harmony/conversation.ts";
import { HarmonyAdapterError } from "../src/harmony/types.ts";
import { NOTE_TOOL, WEATHER_TOOL } from "../src/harmony/probes.ts";

const chatCompletion = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: "cmpl-test",
    object: "chat.completion",
    created: 1234,
    model: "gpt-oss-120b",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "It is sunny in San Francisco." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    ...overrides,
  });

const okResponse = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("generic request carries normalized tools, reasoning effort and no analysis", () => {
  const conversation = createConversation([
    { role: "user", content: "Weather?" },
    {
      role: "assistant",
      content: "Calling the weather tool.",
      analysis: ["Need to use function get_weather."],
      toolCalls: [{ id: "call-1", name: "get_weather", arguments: '{"location":"SF"}' }],
      finishReason: "tool_calls",
    },
    { role: "tool", toolCallId: "call-1", name: "get_weather", content: '{"sunny": true}' },
  ]);
  const built = buildCerebrasHarmonyRequest({
    style: "generic",
    turns: conversation.turns,
    tools: [{ ...WEATHER_TOOL, strict: true }, NOTE_TOOL],
    reasoningEffort: "low",
    maxCompletionTokens: 64,
  });
  assert.equal(built.body.model as string, "gpt-oss-120b");
  assert.equal(built.body.reasoning_effort as string, "low");
  assert.equal(built.body.max_completion_tokens as number, 64);
  const tools = built.body.tools as Record<string, unknown>[];
  assert.equal(tools.length, 2);
  const functionValues = tools.map((tool) => (tool.function as Record<string, unknown>).strict);
  assert.deepEqual(functionValues, [false, false]); // default normalization, mixed input
  const messages = built.body.messages as Record<string, unknown>[];
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "tool"]
  );
  assert.ok(!JSON.stringify(built.body).includes("Need to use function get_weather"));
});

test("native request renders Harmony system/developer and omits tools and reasoning_effort fields", () => {
  const conversation = createConversation([{ role: "user", content: "Weather?" }]);
  const built = buildCerebrasHarmonyRequest({
    style: "native",
    turns: conversation.turns,
    tools: [WEATHER_TOOL],
    instructions: "You are a weather assistant.",
    reasoningEffort: "high",
  });
  assert.equal("tools" in built.body, false);
  assert.equal("reasoning_effort" in built.body, false);
  const messages = built.body.messages as Record<string, unknown>[];
  assert.deepEqual(
    messages.map((message) => message.role),
    ["system", "developer", "user"]
  );
  const system = messages[0].content as string;
  assert.match(system, /Reasoning: high/);
  assert.match(system, /Current date: 2026-01-01/);
  const developer = messages[1].content as string;
  assert.match(developer, /namespace functions \{/);
  assert.match(developer, /type get_weather = \(_: \{/);
});

test("tools combined with a structured response format is blocked unless probed", () => {
  const conversation = createConversation([{ role: "user", content: "Weather?" }]);
  assert.throws(
    () =>
      buildCerebrasHarmonyRequest({
        style: "generic",
        turns: conversation.turns,
        tools: [WEATHER_TOOL],
        responseFormat: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: {} } },
      }),
    (error: unknown) => error instanceof HarmonyAdapterError && error.code === "unproven-combination"
  );
  const probed = buildCerebrasHarmonyRequest({
    style: "generic",
    turns: conversation.turns,
    tools: [WEATHER_TOOL],
    responseFormat: { type: "json_object" },
    combinationPolicy: "probe",
  });
  assert.equal((probed.body.response_format as Record<string, unknown>).type, "json_object");
  assert.ok(Array.isArray(probed.body.tools));
});

test("preserve mode keeps per-tool strictness flags for protocol evidence", () => {
  const conversation = createConversation([{ role: "user", content: "Weather?" }]);
  const built = buildCerebrasHarmonyRequest({
    style: "generic",
    turns: conversation.turns,
    tools: [{ ...WEATHER_TOOL, strict: true }, NOTE_TOOL],
    toolStrictnessMode: "preserve",
  });
  const strictValues = (built.body.tools as Record<string, unknown>[]).map((tool) => (tool.function as Record<string, unknown>).strict);
  assert.deepEqual(strictValues, [true, undefined]);
});

test("normalizes reasoning_content, tool calls and finish reason from provider payloads", () => {
  const normalized = normalizeHarmonyChatCompletion(
    JSON.parse(
      chatCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "Need to use function get_weather.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"location": "SF"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    )
  );
  if ("error" in normalized) throw new Error(normalized.error);
  assert.deepEqual(normalized.analysis, ["Need to use function get_weather."]);
  assert.deepEqual(normalized.toolCalls, [{ id: "call_1", name: "get_weather", arguments: '{"location":"SF"}' }]);
  assert.equal(normalized.finishReason, "tool_calls");
  assert.equal(normalized.shape.reasoningField, "reasoning_content");
});

test("parses Harmony raw output from content when the provider does not translate calls", () => {
  const normalized = normalizeHarmonyChatCompletion(
    JSON.parse(
      chatCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "<|channel|>analysis<|message|>Need to use function get_weather.<|end|>" +
                "<|start|>assistant<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>" +
                '{"location":"SF"}<|call|>',
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    )
  );
  if ("error" in normalized) throw new Error(normalized.error);
  assert.deepEqual(normalized.toolCalls, [
    {
      id: "harmony-call-1",
      name: "get_weather",
      arguments: '{"location":"SF"}',
    },
  ]);
});

test("supports multiple parallel tool calls with distinct ids", () => {
  const normalized = normalizeHarmonyChatCompletion(
    JSON.parse(
      chatCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"location":"SF"}' } },
                {
                  id: "call_b",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    )
  );
  if ("error" in normalized) throw new Error(normalized.error);
  assert.equal(normalized.toolCalls.length, 2);
  assert.equal(normalized.toolCalls[0].id, "call_a");
  assert.equal(normalized.toolCalls[1].id, "call_b");
});

test("rejects a model mismatch in the upstream reply", () => {
  const normalized = normalizeHarmonyChatCompletion(JSON.parse(chatCompletion({ model: "some-other-model" })));
  assert.ok("error" in normalized);
  assert.match(normalized.error as string, /instead of/);
});

test("runHarmonyTurn surfaces upstream validation errors as sanitized fingerprints", async () => {
  const transport = createCerebrasTransport({
    apiKey: "test-key",
    fetcher: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "Tools with mixed values for 'strict' are not allowed", code: "invalid_request_error" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      ),
  });
  const conversation = createConversation([{ role: "user", content: "Weather?" }]);
  const result = await runHarmonyTurn({ style: "generic", turns: conversation.turns, tools: [WEATHER_TOOL, NOTE_TOOL] }, transport);
  assert.equal(result.ok, false);

  assert.equal(result.status, 400);
  assert.equal(result.upstreamError?.code, "invalid_request_error");
  assert.match(result.upstreamError.message ?? "", /mixed values/);
});

test("runHarmonyTurn completes a tool call then a final answer through the real transport", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const transport = createCerebrasTransport({
    apiKey: "test-key",
    fetcher: (_input, init) => {
      // The adapter always sends a JSON string body; anything else would parse
      // as "[object Object]" and hide the request under test.
      const rawBody = init?.body;
      const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<string, unknown>;
      requestBodies.push(body);
      const payload =
        requestBodies.length === 1
          ? JSON.parse(
              chatCompletion({
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      reasoning_content: "Private chain of thought.",
                      tool_calls: [
                        {
                          id: "call_a",
                          type: "function",
                          function: { name: "get_weather", arguments: '{"location":"SF"}' },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              })
            )
          : JSON.parse(chatCompletion());
      return Promise.resolve(okResponse(JSON.stringify(payload)));
    },
  });

  const conversation = createConversation([{ role: "user", content: "Weather?" }]);
  const first = await runHarmonyTurn({ style: "generic", turns: conversation.turns, tools: [WEATHER_TOOL], reasoningEffort: "low" }, transport);
  assert.equal(first.ok, true);

  assert.deepEqual(
    first.normalized.toolCalls.map((call) => call.name),
    ["get_weather"]
  );

  const afterCall = advanceConversation(conversation, first.normalized);
  const withResult = appendToolResult(afterCall, "call_a", "get_weather", '{"sunny": true}');
  const second = await runHarmonyTurn({ style: "generic", turns: withResult.turns, tools: [WEATHER_TOOL], reasoningEffort: "low" }, transport);
  assert.equal(second.ok, true);

  assert.equal(second.normalized.content, "It is sunny in San Francisco.");
  assert.equal(second.normalized.analysis.length, 0);

  const secondMessages = requestBodies[1].messages as Record<string, unknown>[];
  assert.deepEqual(
    secondMessages.map((message) => message.role),
    ["user", "assistant", "tool"]
  );
  assert.ok(!JSON.stringify(requestBodies[1]).includes("Private chain of thought"));
  assert.deepEqual(secondMessages[1].tool_calls, [{ id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"location":"SF"}' } }]);
});

test("native user-role replay renders the tool result as a user message", () => {
  const conversation = appendToolResult(createConversation([{ role: "user", content: "Weather?" }]), "call_a", "get_weather", '{"sunny": true}');
  const built = buildCerebrasHarmonyRequest({
    style: "native",
    turns: conversation.turns,
    instructions: "x",
    nativeToolResultStyle: "user-role",
  });
  const messages = built.body.messages as Record<string, unknown>[];
  assert.equal(messages[3].role, "user");
  assert.match(messages[3].content as string, /^Tool result from get_weather:\n/);
});

test("consecutive generic turns keep the conversation consistent", async () => {
  const transport = createCerebrasTransport({
    apiKey: "test-key",
    fetcher: () =>
      Promise.resolve(
        okResponse(
          chatCompletion({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Done.", reasoning_content: "think" },
                finish_reason: "stop",
              },
            ],
          })
        )
      ),
  });
  let conversation = appendUser(createConversation(), "First question.");
  const first = await runHarmonyTurn({ style: "generic", turns: conversation.turns, reasoningEffort: "low" }, transport);
  if (!first.ok) throw new Error("expected ok");
  conversation = advanceConversation(conversation, first.normalized);
  conversation = appendUser(conversation, "Follow-up.");
  const second = await runHarmonyTurn({ style: "generic", turns: conversation.turns, reasoningEffort: "low" }, transport);
  assert.equal(second.ok, true);

  assert.equal(second.normalized.analysis.length, 1);
});

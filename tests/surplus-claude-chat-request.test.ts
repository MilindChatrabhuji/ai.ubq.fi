import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildSurplusClaudeChatRequest } from "../src/provider/surplus-claude-chat-request.ts";
import { fetchSurplusResponses } from "../src/provider/surplus.ts";

const base = (): Record<string, unknown> => ({ model: "claude-opus-5.5", input: "hello", max_output_tokens: 128, stream: false, store: false });
const fetchUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};
const bodyText = (body: BodyInit | null | undefined): string => (typeof body === "string" ? body : JSON.stringify(body));

test("Surplus Claude Chat preserves Max, affinity, stream usage and original instruction order", () => {
  const body = {
    ...base(),
    stream: true,
    instructions: "global",
    input: [
      { role: "user", content: "first" },
      { role: "developer", content: "later instructions" },
      { role: "user", content: "next" },
    ],
    reasoning: { effort: "max", summary: "detailed" },
    prompt_cache_key: "stable-affinity",
  };
  const before = JSON.stringify(body);
  const result = buildSurplusClaudeChatRequest(body);
  assert.ok(result);
  assert.deepEqual(result.body, {
    model: "claude-opus-5.5",
    messages: [
      { role: "system", content: [{ type: "text", text: "global" }] },
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "developer", content: [{ type: "text", text: "later instructions" }] },
      { role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 128,
    reasoning_effort: "max",
    prompt_cache_key: "stable-affinity",
  });
  assert.equal(result.promptCacheMode, "implicit");
  assert.equal(JSON.stringify(body), before);
  assert.equal(buildSurplusClaudeChatRequest({ ...base(), reasoning: { effort: "ultra" } })?.body.reasoning_effort, "max");
});

test("Surplus Claude Chat preserves namespaced strict functions and reversible freeform tools", () => {
  const result = buildSurplusClaudeChatRequest({
    ...base(),
    tools: [
      { type: "namespace", name: "functions", tools: [{ type: "function", name: "read", strict: true, parameters: { type: "object", properties: {} } }] },
      { type: "custom", name: "execute", description: "Run source", format: { type: "text" } },
    ],
    input: [
      { role: "user", content: "run" },
      { type: "function_call", namespace: "functions", name: "read", call_id: "c1", arguments: "{}" },
      { type: "custom_tool_call", name: "execute", call_id: "c2", input: "print(1)" },
      { type: "function_call_output", call_id: "c1", output: "file" },
      { type: "custom_tool_call_output", call_id: "c2", output: "1" },
    ],
    tool_choice: { type: "function", namespace: "functions", name: "read" },
    parallel_tool_calls: false,
  });
  assert.ok(result);
  assert.deepEqual(result.toolNames.get("functions_read"), { name: "read", namespace: "functions" });
  assert.equal(result.customToolNames.has("execute"), true);
  assert.deepEqual(result.body.tool_choice, { type: "function", function: { name: "functions_read" } });
  const tools = result.body.tools as { function: Record<string, unknown> }[];
  assert.equal(tools[0].function.strict, true);
  const messages = result.body.messages as Record<string, unknown>[];
  assert.deepEqual(messages[1].tool_calls, [
    { id: "c1", type: "function", function: { name: "functions_read", arguments: "{}" } },
    { id: "c2", type: "function", function: { name: "execute", arguments: '{"input":"print(1)"}' } },
  ]);
  assert.deepEqual(messages[3], { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "1", cache_control: { type: "ephemeral" } }] });
});

test("Surplus Claude Chat retains image precision and explicit cache policy without adding a marker", () => {
  const result = buildSurplusClaudeChatRequest({
    ...base(),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } },
          { type: "input_image", image_url: "https://example.test/a.png", detail: "original" },
          { type: "input_text", text: "changing" },
        ],
      },
    ],
  });
  assert.ok(result);
  assert.equal(result.promptCacheMode, "explicit");
  assert.equal(result.explicitBreakpointCount, 1);
  assert.deepEqual(result.body.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
        { type: "image_url", image_url: { url: "https://example.test/a.png", detail: "original" } },
        { type: "text", text: "changing" },
      ],
    },
  ]);
  const disabled = buildSurplusClaudeChatRequest({ ...base(), prompt_cache_options: { mode: "explicit" } });
  assert.ok(disabled);
  assert.deepEqual(disabled.body.messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
});

test("Surplus Claude Chat uses the catalog output limit and falls back without losing incompatible controls", () => {
  assert.equal(buildSurplusClaudeChatRequest({ ...base(), max_output_tokens: undefined }, 128000)?.body.max_tokens, 128000);
  const bodies = [
    { ...base(), model: "gpt-6-sol" },
    { ...base(), input: [{ type: "reasoning", encrypted_content: "opaque" }] },
    { ...base(), input: [{ type: "function_call", name: "read", call_id: "c", arguments: "{}", prompt_cache_breakpoint: { mode: "explicit" } }] },
    { ...base(), tools: [{ type: "custom", name: "patch", format: { type: "grammar", syntax: "lark", definition: "start: WORD" } }] },
    { ...base(), tools: [{ type: "namespace", name: "functions", tools: [{ type: "web_search" }] }] },
    { ...base(), tools: [{ type: "web_search" }] },
    { ...base(), prompt_cache_retention: "24h" },
    { ...base(), prompt_cache_options: { ttl: "30m" } },
    { ...base(), previous_response_id: "resp_unknown" },
    { ...base(), context_management: [{ type: "compaction" }] },
    { ...base(), text: { verbosity: "high" } },
  ];
  for (const body of bodies) {
    const before = JSON.stringify(body);
    assert.equal(buildSurplusClaudeChatRequest(body), null, before);
    assert.equal(JSON.stringify(body), before);
  }
});

test("Surplus Claude Chat fetch preserves dispatch guards, Max, measured cache and authoritative cost", async () => {
  const actions: string[] = [];
  let requested = "";
  let wire: unknown;
  let headers = new Headers();
  const result = await fetchSurplusResponses(
    { ...base(), reasoning: { effort: "max" } },
    {
      apiKey: "test-provider-key",
      beforeDispatch: () => {
        actions.push("quota");
      },
      onDispatch: () => actions.push("dispatch"),
      fetcher: (url, init) => {
        actions.push("fetch");
        requested = fetchUrl(url);
        headers = new Headers(init?.headers);
        wire = JSON.parse(bodyText(init?.body));
        return Promise.resolve(
          Response.json(
            {
              id: "chatcmpl_test",
              object: "chat.completion",
              model: "claude-opus-5.5",
              created: 1,
              choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
              usage: { prompt_tokens: 1043, completion_tokens: 4, total_tokens: 1047, prompt_tokens_details: { cached_tokens: 1028 }, buyer_cost_micro: 69 },
            },
            { headers: { "X-Request-Id": "chat-request" } }
          )
        );
      },
    }
  );
  assert.equal(requested, "https://api.surplusintelligence.ai/v1/chat/completions");
  assert.equal(headers.get("Authorization"), "Bearer test-provider-key");
  for (const privateHeader of ["conversation_id", "session-id", "thread-id", "x-client-request-id"]) assert.equal(headers.has(privateHeader), false);
  assert.deepEqual(actions, ["quota", "dispatch", "fetch"]);
  assert.deepEqual(wire, buildSurplusClaudeChatRequest({ ...base(), reasoning: { effort: "max" } })?.body);
  assert.equal(result.request_id, "chat-request");
  assert.equal(result.prompt_cache_mode, "implicit");
  const response = await result.response.json();
  assert.equal(response.object, "response");
  assert.equal(response.usage.input_tokens, 1043);
  assert.equal(response.usage.input_tokens_details.cached_tokens, 1028);
  assert.equal(response.usage.buyer_cost_micro, 69);
});

test("Surplus incompatible Claude requests retain the original Responses wire and an honest cache warning", async () => {
  const body = { ...base(), input: [{ type: "reasoning", encrypted_content: "opaque" }], reasoning: { effort: "max" } };
  let requested = "";
  let wire: unknown;
  const result = await fetchSurplusResponses(body, {
    apiKey: "test-provider-key",
    fetcher: (url, init) => {
      requested = fetchUrl(url);
      wire = JSON.parse(bodyText(init?.body));
      return Promise.resolve(Response.json({ object: "response", status: "completed", usage: null }));
    },
  });
  assert.equal(requested, "https://api.surplusintelligence.ai/v1/responses");
  assert.deepEqual(wire, body);
  assert.equal(result.response.headers.get("x-uos-warning"), "surplus_claude_native_prompt_cache_unavailable");
});

test("Surplus Claude signed Chat thinking survives a namespaced tool loop only in its authenticated scope", async () => {
  const assistant = {
    role: "assistant",
    content: "Reading",
    reasoning_content: "Synthetic thought",
    reasoning_details: [{ type: "reasoning.text", text: "Synthetic thought", format: "anthropic-claude-v1", index: 0, signature: "signed-test-fixture" }],
    tool_calls: [{ id: "call-scoped", type: "function", function: { name: "functions_read", arguments: '{"path":"a.txt"}' } }],
  };
  const request = {
    ...base(),
    reasoning: { effort: "max" },
    tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }],
    input: [{ role: "user", content: "read" }],
  };
  const first = await fetchSurplusResponses(request, {
    apiKey: "test-provider-key",
    reasoningReplayScope: "caller-scope-chat-loop",
    fetcher: () =>
      Promise.resolve(
        Response.json({
          id: "chatcmpl_scoped_test",
          object: "chat.completion",
          model: "claude-opus-5.5",
          created: 1,
          choices: [{ index: 0, finish_reason: "tool_calls", message: assistant }],
          usage: { prompt_tokens: 1043, completion_tokens: 20, total_tokens: 1063, prompt_tokens_details: { cached_tokens: 1028 }, buyer_cost_micro: 100 },
        })
      ),
  });
  const reply = await first.response.json();
  const replay = { ...request, input: [...request.input, ...reply.output, { type: "function_call_output", call_id: "call-scoped", output: "file" }] };
  const converted = buildSurplusClaudeChatRequest(replay, undefined, { provider: "surplus", reasoningReplayScope: "caller-scope-chat-loop" });
  assert.ok(converted);
  const messages = converted.body.messages as Record<string, unknown>[];
  assert.deepEqual(messages[1], assistant);
  assert.equal(converted.body.reasoning_effort, "max");
  assert.equal(buildSurplusClaudeChatRequest(replay, undefined, { provider: "surplus", reasoningReplayScope: "other-caller" }), null);
  assert.equal(buildSurplusClaudeChatRequest(replay, undefined, { provider: "metered", reasoningReplayScope: "caller-scope-chat-loop" }), null);
  assert.equal(JSON.stringify(reply).includes("signed-test-fixture"), false);
});

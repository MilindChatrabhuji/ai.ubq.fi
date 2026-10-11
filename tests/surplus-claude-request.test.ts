import assert from "node:assert/strict";
import { buildSurplusClaudeRequest } from "../src/provider/surplus-claude-request.ts";

const base = (): Record<string, unknown> => ({ model: "claude-opus-5.5", input: "hello", max_output_tokens: 128, stream: true, store: false });

Deno.test("Surplus Claude native request keeps instructions and caller input unchanged", () => {
  const body = {
    ...base(),
    instructions: "global instructions",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "developer instructions" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] },
    ],
    prompt_cache_key: "caller-affinity-key",
  };
  const before = JSON.stringify(body);
  const result = buildSurplusClaudeRequest(body);
  assert.ok(result);
  assert.deepEqual(result.body, {
    model: "claude-opus-5.5",
    max_tokens: 128,
    messages: [{ role: "user", content: [{ type: "text", text: "question", cache_control: { type: "ephemeral" } }] }],
    stream: true,
    system: [
      { type: "text", text: "global instructions" },
      { type: "text", text: "developer instructions" },
    ],
    prompt_cache_key: "caller-affinity-key",
  });
  assert.ok(result);
  assert.equal(result.promptCacheMode, "implicit");
  assert.equal(result.explicitBreakpointCount, 0);
  assert.equal(JSON.stringify(body), before);
});

Deno.test("Surplus Claude replay preserves function names, call IDs, arguments, result and order", () => {
  const result = buildSurplusClaudeRequest({
    ...base(),
    input: [
      { type: "message", role: "user", content: "Read the file" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading" }] },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"a.txt","lines":3}' },
      { type: "function_call_output", call_id: "call-1", output: "file contents" },
    ],
    tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    parallel_tool_calls: false,
  });
  assert.ok(result);
  assert.deepEqual(result.body.tools, [
    { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  ]);
  assert.ok(result);
  assert.deepEqual(result.body.messages, [
    { role: "user", content: [{ type: "text", text: "Read the file" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Reading" },
        { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.txt", lines: 3 } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents", cache_control: { type: "ephemeral" } }] },
  ]);
  assert.deepEqual(result.body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
});

Deno.test("Surplus Claude images retain base64 media type and remote URL without fetching", () => {
  const result = buildSurplusClaudeRequest({
    ...base(),
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          { type: "input_image", image_url: "https://example.test/a.png" },
        ],
      },
    ],
  });
  assert.ok(result);
  assert.deepEqual(result.body.messages, [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "image", source: { type: "url", url: "https://example.test/a.png" }, cache_control: { type: "ephemeral" } },
      ],
    },
  ]);
});

Deno.test("Surplus Claude explicit block policies suppress automatic markers and preserve lifetime", () => {
  const result = buildSurplusClaudeRequest({
    ...base(),
    input: [
      { role: "user", content: [{ type: "input_text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      { role: "user", content: [{ type: "input_text", text: "changing" }] },
    ],
  });
  assert.ok(result);
  assert.equal(result.promptCacheMode, "explicit");
  assert.equal(result.explicitBreakpointCount, 1);
  assert.ok(result);
  assert.deepEqual(result.body.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "changing" },
      ],
    },
  ]);
});

Deno.test("Surplus Claude translates an explicit Responses breakpoint in a tool result", () => {
  const result = buildSurplusClaudeRequest({
    ...base(),
    input: [
      { role: "user", content: "run" },
      { type: "function_call", name: "run", call_id: "c", arguments: "{}" },
      { type: "function_call_output", call_id: "c", output: [{ type: "input_text", text: "result", prompt_cache_breakpoint: { mode: "explicit" } }] },
    ],
  });
  assert.ok(result);
  assert.equal(result.promptCacheMode, "explicit");
  assert.equal(result.explicitBreakpointCount, 1);
  const messages = result.body.messages as { content: Record<string, unknown>[] }[];
  assert.deepEqual(messages[2].content, [
    { type: "tool_result", tool_use_id: "c", content: [{ type: "text", text: "result", cache_control: { type: "ephemeral" } }] },
  ]);
});

Deno.test("Surplus Claude keeps explicit cache breakpoints on tool call and result blocks", () => {
  const result = buildSurplusClaudeRequest({
    ...base(),
    input: [
      { role: "user", content: "run" },
      { type: "function_call", name: "run", call_id: "c", arguments: "{}", prompt_cache_breakpoint: { mode: "explicit" } },
      { type: "function_call_output", call_id: "c", output: "result", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  });
  assert.ok(result);
  assert.equal(result.promptCacheMode, "explicit");
  assert.equal(result.explicitBreakpointCount, 2);
  const messages = result.body.messages as { content: Record<string, unknown>[] }[];
  assert.deepEqual(messages[1].content[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(messages[2].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
});

Deno.test("Surplus Claude explicit mode with no breakpoints stays without automatic caching", () => {
  const result = buildSurplusClaudeRequest({ ...base(), prompt_cache_options: { mode: "explicit" } });
  assert.ok(result);
  assert.equal(result.promptCacheMode, "explicit");
  assert.ok(result);
  assert.deepEqual(result.body.messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
});

Deno.test("Surplus Claude reasoning preserves requested effort and the Codex ultra translation", () => {
  assert.equal(buildSurplusClaudeRequest({ ...base(), reasoning: { effort: "max" } }), null);
  for (const [requested, expected] of [
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
    ["ultra", "max"],
  ]) {
    const result = buildSurplusClaudeRequest({ ...base(), reasoning: { effort: requested, summary: "none" } }, undefined, {
      supportsNativeReasoningEffort: true,
    });
    assert.ok(result);
    assert.deepEqual(result.body.thinking, { type: "adaptive" });
    assert.deepEqual(result.body.output_config, { effort: expected });
  }
});

Deno.test("Surplus Claude has no invented output cap when the caller omitted one", () => {
  const body = { ...base(), max_output_tokens: null };
  assert.equal(buildSurplusClaudeRequest(body), null);
  assert.equal(buildSurplusClaudeRequest(body, 128000)?.body.max_tokens, 128000);
  assert.equal(buildSurplusClaudeRequest(body, -1), null);
});

Deno.test("Surplus native adapter returns incompatible inputs intact to the existing Responses route", () => {
  const bodies = [
    { ...base(), model: "deepseek-v4.1-flash" },
    { ...base(), model: "gpt-6-sol" },
    { ...base(), input: [{ type: "reasoning", encrypted_content: "opaque" }] },
    { ...base(), input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "summary" }] }] },
    { ...base(), input: [{ type: "function_call", name: "run", call_id: "c", arguments: "not-json" }] },
    { ...base(), tools: [{ type: "web_search" }] },
    { ...base(), tools: [{ type: "namespace", name: "functions", tools: [] }] },
    { ...base(), tools: [{ type: "custom", name: "apply_patch" }] },
    { ...base(), tools: [{ type: "function", name: "run", strict: true }] },
    {
      ...base(),
      input: [
        { role: "user", content: "first" },
        { role: "developer", content: "later" },
      ],
    },
    { ...base(), prompt_cache_retention: "24h" },
    { ...base(), prompt_cache_options: { ttl: "30m" } },
    { ...base(), prompt_cache_options: { mode: "disabled" } },
    {
      ...base(),
      cache_control: { type: "unsupported" },
      input: [{ role: "user", content: [{ type: "input_text", text: "stable", cache_control: { type: "ephemeral" } }] }],
    },
    {
      ...base(),
      input: [{ role: "user", content: [{ type: "input_text", text: "stable", cache_control: { type: "ephemeral" }, prompt_cache_breakpoint: {} }] }],
    },
    { ...base(), text: { format: { type: "json_schema", schema: { type: "object" } } } },
    { ...base(), text: { format: "text" } },
    { ...base(), store: true },
    { ...base(), previous_response_id: "resp_other_provider" },
    { ...base(), input: [{ role: "user", content: [{ type: "input_file", file_id: "file_other_provider" }] }] },
    { ...base(), input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/a.png", detail: "original" }] }] },
  ];
  for (const body of bodies) {
    const before = JSON.stringify(body);
    assert.equal(buildSurplusClaudeRequest(body), null, before);
    assert.equal(JSON.stringify(body), before);
  }
});

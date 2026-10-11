import assert from "node:assert/strict";
import {
  fetchMeteredModels,
  fetchMeteredResponses,
  fetchMeteredTokenLogs,
  resetMeteredModelsCacheForTest,
  type MeteredFetch,
} from "../src/provider/metered.ts";
import { readResponsesStream } from "../src/responses-stream.ts";

type JsonRecord = Record<string, unknown>;
const model = "claude-opus-5-5";
const jsonResponse = (body: unknown, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) } });
const nativeMessage = (id = "native-openlux-cache", content: JsonRecord[] = [{ type: "text", text: "OK" }]): JsonRecord => ({
  id,
  type: "message",
  role: "assistant",
  model,
  content,
  stop_reason: "end_turn",
  usage: {
    input_tokens: 15,
    cache_read_input_tokens: 1028,
    cache_creation_input_tokens: 0,
    output_tokens: 64,
    output_tokens_details: { thinking_tokens: 60 },
  },
});
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
};
const capture = (upstream: () => Response = () => jsonResponse(nativeMessage())) => {
  const calls: { url: string; body: JsonRecord; headers: Headers }[] = [];
  const fetcher: MeteredFetch = (input, init) => {
    assert.ok(init && typeof init.body === "string");
    calls.push({ url: requestUrl(input), body: JSON.parse(init.body) as JsonRecord, headers: new Headers(init.headers) });
    return Promise.resolve(upstream());
  };
  return { calls, fetcher };
};

Deno.test("OpenLux Claude uses native block caching and preserves actual gross cache/thinking usage", async () => {
  resetMeteredModelsCacheForTest();
  const body = { model, instructions: "Reusable instructions", input: "Reply exactly OK.", max_output_tokens: 128, stream: false };
  const unchanged = structuredClone(body);
  const { calls, fetcher } = capture(() =>
    jsonResponse(nativeMessage(), { "x-api-request-id": "provider-billing-id", "x-oneapi-request-id": "legacy-id", "x-request-id": "trace-id" })
  );
  const result = await fetchMeteredResponses(body, { apiKey: "fixture-key", fetcher });
  assert.equal(calls[0].url, "https://api.openlux.ai/v1/messages");
  assert.deepEqual(calls[0].body, {
    model,
    max_tokens: 128,
    stream: false,
    system: [{ type: "text", text: body.instructions }],
    messages: [{ role: "user", content: [{ type: "text", text: body.input, cache_control: { type: "ephemeral" } }] }],
  });
  assert.equal(calls[0].headers.get("anthropic-version"), "2023-06-01");
  assert.equal(calls[0].headers.get("accept"), "application/json");
  assert.equal(result.request_id, "provider-billing-id");
  assert.equal(result.prompt_cache_mode, "implicit");
  assert.equal(result.explicit_breakpoint_count, 0);
  const response = await result.response.json();
  assert.equal(response.model, model);
  assert.deepEqual(response.usage, {
    input_tokens: 1043,
    input_tokens_details: { cached_tokens: 1028, cache_write_tokens: 0 },
    output_tokens: 64,
    output_tokens_details: { reasoning_tokens: 60 },
    total_tokens: 1107,
  });
  assert.deepEqual(body, unchanged);
});

Deno.test("OpenLux omitted generation budget uses the exact documented Opus5.5 maximum", async () => {
  resetMeteredModelsCacheForTest();
  const { calls, fetcher } = capture();
  const result = await fetchMeteredResponses({ model, input: "Hello" }, { apiKey: "fixture-key", fetcher });
  assert.equal(calls[0].body.max_tokens, 128_000);
  assert.equal(calls[0].body.model, model);
  await result.response.body?.cancel();
});

Deno.test("OpenLux uses catalog native capability and output caps without inventing limits for other Claude models", async () => {
  const previous = Deno.env.get("METERED_API_KEY");
  Deno.env.set("METERED_API_KEY", "discovery-fixture-key");
  resetMeteredModelsCacheForTest();
  try {
    await fetchMeteredModels({
      force: true,
      fetcher: () =>
        Promise.resolve(
          jsonResponse({
            data: [
              { id: "claude-catalog-native", supported_endpoint_types: ["anthropic", "openai"], top_provider: { max_completion_tokens: 2048 } },
              { id: "claude-unknown-cap", supported_endpoint_types: ["anthropic"], max_output_tokens: "2048" },
              { id: "claude-openai-only", supported_endpoint_types: ["openai"], max_completion_tokens: 2048 },
            ],
          })
        ),
    });
    for (const [id, expectedUrl, expectedMax] of [
      ["claude-catalog-native", "https://api.openlux.ai/v1/messages", 2048],
      ["claude-unknown-cap", "https://api.openlux.ai/v1/responses", undefined],
      ["claude-openai-only", "https://api.openlux.ai/v1/responses", undefined],
    ] as const) {
      const { calls, fetcher } = capture();
      const result = await fetchMeteredResponses({ model: id, input: "Hello" }, { apiKey: "fixture-key", fetcher });
      assert.equal(calls[0].url, expectedUrl);
      assert.equal(calls[0].body.max_tokens, expectedMax);
      await result.response.body?.cancel();
    }
  } finally {
    if (previous === undefined) Deno.env.delete("METERED_API_KEY");
    else Deno.env.set("METERED_API_KEY", previous);
    resetMeteredModelsCacheForTest();
  }
});

Deno.test("OpenLux native streaming exposes reasoning and text through canonical Responses events", async () => {
  const events = [
    {
      type: "message_start",
      message: { ...nativeMessage("native-openlux-stream"), content: [], usage: { input_tokens: 15, cache_read_input_tokens: 1028, output_tokens: 0 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspect the prompt" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "stream-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 64, output_tokens_details: { thinking_tokens: 60 } } },
    { type: "message_stop" },
  ];
  const { calls, fetcher } = capture(
    () =>
      new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
  );
  const result = await fetchMeteredResponses({ model, input: "Hello", stream: true, reasoning: { summary: "auto" } }, { apiKey: "fixture-key", fetcher });
  assert.equal(calls[0].url, "https://api.openlux.ai/v1/messages");
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].headers.get("accept"), "text/event-stream");
  assert.ok(result.response.body);
  const delivered: JsonRecord[] = [];
  for await (const event of readResponsesStream(result.response.body)) delivered.push(event.value);
  assert.ok(delivered.some((event) => event.type === "response.reasoning_summary_text.delta" && event.delta === "Inspect the prompt"));
  assert.ok(delivered.some((event) => event.type === "response.output_text.delta" && event.delta === "OK"));
  const terminal = delivered.at(-1)?.response;
  assert.ok(terminal && typeof terminal === "object" && "usage" in terminal);
  assert.deepEqual(terminal.usage, {
    input_tokens: 1043,
    input_tokens_details: { cached_tokens: 1028 },
    output_tokens: 64,
    output_tokens_details: { reasoning_tokens: 60 },
    total_tokens: 1107,
  });
});

Deno.test("OpenLux preserves explicit cache breakpoints without adding another marker", async () => {
  const { calls, fetcher } = capture();
  const body = {
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "stable prefix", prompt_cache_breakpoint: { mode: "explicit" } },
          { type: "input_text", text: "tail" },
        ],
      },
    ],
    prompt_cache_options: { mode: "explicit" },
    max_output_tokens: 128,
  };
  const result = await fetchMeteredResponses(body, { apiKey: "fixture-key", fetcher });
  assert.equal(result.prompt_cache_mode, "explicit");
  assert.equal(result.explicit_breakpoint_count, 1);
  assert.deepEqual(calls[0].body.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "stable prefix", cache_control: { type: "ephemeral" } },
        { type: "text", text: "tail" },
      ],
    },
  ]);
  await result.response.body?.cancel();
});

Deno.test("OpenLux keeps requested effort and unrepresentable controls on the original Responses route", async () => {
  resetMeteredModelsCacheForTest();
  for (const extra of [
    { reasoning: { effort: "max", summary: "auto" } },
    { reasoning: { effort: "none" } },
    { prompt_cache_retention: "24h" },
    { text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } } },
    { input: [{ type: "reasoning", id: "external-reasoning", encrypted_content: "opaque" }] },
    { model: "claude-unadvertised", max_output_tokens: 128 },
  ]) {
    const body = { model, input: "Hello", max_output_tokens: 128, ...extra };
    const { calls, fetcher } = capture(() => new Response("upstream rejected", { status: 400, headers: { "x-uos-warning": "existing-warning" } }));
    const result = await fetchMeteredResponses(body, { apiKey: "fixture-key", fetcher, reasoningReplayScope: "fixture-principal" });
    assert.equal(calls[0].url, "https://api.openlux.ai/v1/responses");
    assert.deepEqual(calls[0].body, body);
    assert.equal(result.response.status, 400);
    assert.equal(result.response.headers.get("x-uos-warning"), "existing-warning, openlux_claude_native_prompt_cache_unavailable");
    assert.equal(result.prompt_cache_mode, undefined);
    await result.response.body?.cancel();
  }
});

Deno.test("OpenLux transport restores native signed tool history only within the authenticated provider scope", async () => {
  const scope = "metered-cache-fixture-principal";
  const blocks = [
    { type: "thinking", thinking: "Inspect the file", signature: "signed-provider-fixture" },
    { type: "tool_use", id: "read-cache-file", name: "read_file", input: { path: "a.txt" } },
  ];
  const first = capture(() => jsonResponse({ ...nativeMessage("native-openlux-tool-cache", blocks), stop_reason: "tool_use" }));
  const result = await fetchMeteredResponses(
    { model, input: "Read a.txt", reasoning: { summary: "auto" } },
    { apiKey: "fixture-key", fetcher: first.fetcher, reasoningReplayScope: scope }
  );
  const response = await result.response.json();
  assert.ok(Array.isArray(response.output));
  assert.equal(JSON.stringify(response).includes("signed-provider-fixture"), false);
  const body = {
    model,
    input: [{ role: "user", content: "Read a.txt" }, ...response.output, { type: "function_call_output", call_id: "read-cache-file", output: "file contents" }],
  };
  const same = capture();
  const replay = await fetchMeteredResponses(body, { apiKey: "fixture-key", fetcher: same.fetcher, reasoningReplayScope: scope });
  assert.equal(same.calls[0].url, "https://api.openlux.ai/v1/messages");
  const messages = same.calls[0].body.messages;
  assert.ok(Array.isArray(messages));
  assert.deepEqual(messages[1], { role: "assistant", content: blocks });
  await replay.response.body?.cancel();
  const other = capture(() => jsonResponse({ preserved: true }));
  const rejected = await fetchMeteredResponses(body, { apiKey: "fixture-key", fetcher: other.fetcher, reasoningReplayScope: "other-principal" });
  assert.equal(other.calls[0].url, "https://api.openlux.ai/v1/responses");
  assert.deepEqual(other.calls[0].body, body);
  await rejected.response.body?.cancel();
});

const log = (id: string, other: JsonRecord, overrides: JsonRecord = {}): JsonRecord => ({
  request_id: id,
  model_name: model,
  prompt_tokens: 15,
  completion_tokens: 4,
  quota: 466,
  created_at: 1_791_704_855,
  other: JSON.stringify({ request_id: "metadata-id", ...other }),
  ...overrides,
});
const readLogs = (items: JsonRecord[]) =>
  fetchMeteredTokenLogs({ apiKey: "fixture-key", fetcher: () => Promise.resolve(jsonResponse({ success: true, data: { items, total: items.length } })) });

Deno.test("OpenLux settled native logs preserve actual cache reads/writes and authoritative quota", async () => {
  const logs = await readLogs([
    log("cache-write", { claude: true, cache_tokens: 0, cache_creation_tokens: 1028, cache_creation_tokens_5m: 1028 }),
    log("cache-read", { claude: true, cache_tokens: 1028 }, { quota: 136, completion_tokens: 64 }),
  ]);
  assert.deepEqual(logs, [
    {
      request_id: "cache-write",
      model,
      prompt_tokens: 1043,
      cached_prompt_tokens: 0,
      cache_write_prompt_tokens: 1028,
      completion_tokens: 4,
      quota: 466,
      created_at: 1_791_704_855,
    },
    { request_id: "cache-read", model, prompt_tokens: 1043, cached_prompt_tokens: 1028, completion_tokens: 64, quota: 136, created_at: 1_791_704_855 },
  ]);
});

Deno.test("OpenLux does not infer native net input for unknown routes or malformed cache metadata", async () => {
  const rows = [
    log("unknown-model", { claude: true, cache_tokens: 1028 }, { model_name: "gpt-5.6-sol" }),
    log("unknown-flag", { cache_tokens: 1028 }),
    log("invalid-read", { claude: true, cache_tokens: "1028" }),
    log("invalid-write", { claude: true, cache_tokens: 1028, cache_creation_tokens: -1 }),
    log("overflow", { claude: true, cache_tokens: Number.MAX_SAFE_INTEGER }),
    log("malformed", {}, { other: "{" }),
  ];
  const logs = await readLogs(rows);
  assert.equal(logs.length, rows.length);
  for (const normalized of logs) {
    assert.equal(normalized.prompt_tokens, 15);
    assert.equal(normalized.cached_prompt_tokens, undefined);
    assert.equal(normalized.cache_write_prompt_tokens, undefined);
    assert.equal(normalized.quota, 466);
  }
  const [standard] = await readLogs([log("standard-cache", { cache_tokens: 999 }, { model_name: "other-model", cached_prompt_tokens: 7 })]);
  assert.equal(standard.prompt_tokens, 15);
  assert.equal(standard.cached_prompt_tokens, 7);
});

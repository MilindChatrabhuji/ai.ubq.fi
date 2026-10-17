import { test } from "bun:test";
import assert from "node:assert/strict";
import { fetchSurplusModels, fetchSurplusResponses, resetSurplusModelsCacheForTest, type SurplusFetch } from "../src/provider/surplus.ts";

/**
 * `jsonResponse` only composes extra plain headers on top of the JSON
 * content type, so it takes a record rather than a full `HeadersInit` (object
 * spread over a `Headers` instance or a `string[][]` silently loses entries).
 */
const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** Request URL as text; `String(input)` would render a `Request` as "[object Object]". */
const fetchUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

/** Request body as text; the gateway always encodes it as a JSON string. */
const bodyText = (body: BodyInit | null | undefined): string => {
  if (typeof body === "string") return body;
  return JSON.stringify(body);
};

test("fetchSurplusModels preserves exact IDs and exposes text-capable routes only", async () => {
  resetSurplusModelsCacheForTest();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: SurplusFetch = (input, init) => {
    calls.push({ url: fetchUrl(input), init });
    return Promise.resolve(
      jsonResponse({
        object: "list",
        data: [
          {
            id: "gpt-5.6-sol",
            created: 1_735_000_000,
            provider: "openai",
            architecture: { modality: "text->text" },
            supported_parameters: ["reasoning", "tools", "tool_choice", "parallel_tool_calls"],
            supported_features: ["streaming", "tools", "reasoning"],
            pricing: {
              prompt: "0.000001",
              completion: "0.000003",
              input_cache_read: "0.0000001",
              input_cache_write: "0.000002",
            },
          },
          {
            id: "image-model-that-must-not-route",
            architecture: { output_modalities: ["image"] },
          },
          {
            id: "audio-to-text-model-that-must-not-route",
            architecture: { modality: "audio->text" },
          },
          {
            id: "claude-opus-5",
            provider: "anthropic",
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            supported_parameters: ["tools"],
            supported_features: ["tools"],
            description: "test model",
            top_provider: { max_completion_tokens: 128000 },
          },
        ],
      })
    );
  };

  const snapshot = await fetchSurplusModels({
    apiKey: "inf_test",
    fetcher,
    force: true,
  });

  assert.deepEqual(
    snapshot?.models.map((model) => model.id),
    ["gpt-5.6-sol", "claude-opus-5"]
  );
  assert.equal(snapshot.models[0].owned_by, "openai");
  assert.equal(snapshot.models[0].input_price_per_token, 0.000001);
  assert.equal(snapshot.models[0].cache_read_price_per_token, 0.0000001);
  assert.equal(snapshot.models[0].cache_write_price_per_token, 0.000002);
  assert.equal(snapshot.models[0].supports_tools, true);
  assert.equal(snapshot.models[0].supports_parallel_tool_calls, true);
  assert.deepEqual(snapshot.models[0].supported_endpoint_types, ["openai", "openai-response"]);
  assert.equal(snapshot.models[1].description, "test model");
  assert.equal(snapshot.models[1].max_output_tokens, 128000);
  assert.equal(snapshot.models[1].supports_tools, undefined);
  assert.equal(snapshot.models[1].supports_parallel_tool_calls, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.surplusintelligence.ai/v1/models");
  assert.equal(new Headers(calls[0].init?.headers).get("Accept"), "application/json");
  assert.equal(new Headers(calls[0].init?.headers).has("Authorization"), false);
});

test("fetchSurplusResponses omits unsupported parallel-tool control and returns the request ID", async () => {
  const body = {
    model: "gpt-6-sol",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: true,
    parallel_tool_calls: true,
  };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: SurplusFetch = (input, init) => {
    calls.push({ url: fetchUrl(input), init });
    return Promise.resolve(
      new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "X-Request-Id": " surplus-request-1 " },
      })
    );
  };

  const result = await fetchSurplusResponses(body, {
    apiKey: "inf_test",
    fetcher,
    supportsParallelToolCalls: false,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.surplusintelligence.ai/v1/responses");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(bodyText(calls[0].init.body)), {
    model: "gpt-6-sol",
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    stream: true,
  });
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("Authorization"), "Bearer inf_test");
  assert.equal(headers.get("Accept"), "text/event-stream");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(result.request_id, "surplus-request-1");
});

test("fetchSurplusResponses translates Codex ultra reasoning to the upstream max preset", async () => {
  let forwarded: Record<string, unknown> | null = null;
  const fetcher: SurplusFetch = (_input, init) => {
    forwarded = JSON.parse(bodyText(init?.body)) as Record<string, unknown>;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  await fetchSurplusResponses({ model: "gpt-5.6-sol", input: "hello", reasoning: { effort: "ultra" } }, { apiKey: "inf_test", fetcher });

  assert.deepEqual(forwarded, {
    model: "gpt-5.6-sol",
    input: "hello",
    reasoning: { effort: "max" },
  });
});

test("fetchSurplusResponses maps Codex developer messages to Surplus system messages", async () => {
  let forwardedInput: unknown;

  await fetchSurplusResponses(
    {
      model: "deepseek-v4-flash",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "Be concise." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Reply." }] },
      ],
      stream: true,
    },
    {
      apiKey: "test-key",
      fetcher: (_input, init) => {
        forwardedInput = (JSON.parse(bodyText(init?.body)) as Record<string, unknown>).input;
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    }
  );

  assert.deepEqual(forwardedInput, [
    { type: "message", role: "system", content: [{ type: "input_text", text: "Be concise." }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Reply." }] },
  ]);
});

test("fetchSurplusResponses completes sparse Surplus text streams for Codex", async () => {
  const sparse = [
    { type: "response.created", response: { id: "resp_test", status: "in_progress" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello" },
    { type: "response.completed", response: { id: "resp_test", status: "completed" } },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");

  const result = await fetchSurplusResponses(
    { model: "deepseek-v4-flash", input: "hello", stream: true },
    {
      apiKey: "test-key",
      fetcher: () => Promise.resolve(new Response(sparse, { headers: { "Content-Type": "text/event-stream" } })),
    }
  );
  const output = await result.response.text();

  assert.match(output, /"type":"response.output_text.done"/);
  assert.match(output, /"type":"response.output_item.done"/);
  assert.match(output, /"output":\[\{"type":"message","role":"assistant"/);
  assert.match(output, /"text":"hello"/);
});

test("fetchSurplusResponses runs the quota hook immediately before transport", async () => {
  const events: string[] = [];
  const fetcher: SurplusFetch = (_input, init) => {
    events.push("fetch");
    assert.equal(init?.signal?.aborted, false);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  await fetchSurplusResponses(
    { model: "gpt-5.6-sol", input: "hello" },
    {
      apiKey: "inf_test",
      fetcher,
      beforeDispatch: () => {
        events.push("before-dispatch");
        return Promise.resolve({
          markTransportStarted: () => {
            events.push("started");
          },
          cancelBeforeTransport: () =>
            Promise.resolve().then(() => {
              events.push("cancelled");
            }),
        });
      },
    }
  );
  assert.deepEqual(events, ["before-dispatch", "started", "fetch"]);
});

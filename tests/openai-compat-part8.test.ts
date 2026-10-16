import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 8 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  DEFAULT_TEST_MODEL,
  TEST_CODEX_MODELS_KEY,
  TEXT_ENCODER,
  baseSseChunks,
  handleChatCompletions,
  handleResponses,
  keyToString,
  kvStore,
  resetRuntimeConfigCacheForTest,
  responsesRequest,
  sseResponse,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";

test("openai: active provider cache capabilities reject only known unsupported controls", async () =>
  runSequence(async (step) => {
    const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
    const runtimeConfigKey = keyToString(["uos_ai", "runtime_config", "v2"]);
    const previousSnapshot = kvStore.get(snapshotKey);
    const previousRuntimeConfig = kvStore.get(runtimeConfigKey);
    const controls = (fields: Record<string, unknown>) => ({
      ...fields,
      source: "catalog",
      verified_at_ms: 1_000,
    });
    const setPromptCacheCapabilities = (promptCache: unknown) => {
      kvStore.set(snapshotKey, {
        source: "chatgpt_codex",
        client_version: "0.125.0",
        updated_at_ms: Date.now(),
        models: [
          {
            slug: DEFAULT_TEST_MODEL,
            supported_reasoning_levels: ["none", "medium"],
            prompt_cache: promptCache,
          },
        ],
      });
    };
    const cases = [
      {
        route: "responses",
        controls: controls({ key: false }),
        body: { input: "ping", prompt_cache_key: "stable-prefix" },
        param: "prompt_cache_key",
      },
      {
        route: "chat.completions",
        controls: controls({ key: false }),
        body: { messages: [{ role: "user", content: "ping" }], prompt_cache_key: "stable-prefix" },
        param: "prompt_cache_key",
      },
      {
        route: "responses",
        controls: controls({ implicit: false }),
        body: { input: "ping", prompt_cache_options: { ttl: "30m" } },
        param: "prompt_cache_options",
      },
      {
        route: "chat.completions",
        controls: controls({ modes: ["explicit"] }),
        body: {
          messages: [{ role: "user", content: "ping" }],
          prompt_cache_options: { mode: "implicit" },
        },
        param: "prompt_cache_options.mode",
      },
      {
        route: "responses",
        controls: controls({ explicit_breakpoints: false }),
        body: {
          input: [{ type: "input_text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }],
          prompt_cache_options: { mode: "explicit" },
        },
        param: "input[0].prompt_cache_breakpoint",
      },
      {
        route: "chat.completions",
        controls: controls({ modes: ["implicit"] }),
        body: {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }],
            },
          ],
          prompt_cache_options: { mode: "explicit" },
        },
        param: "messages[0].content[0].prompt_cache_breakpoint",
      },
      {
        route: "responses",
        controls: controls({ explicit_breakpoints: false }),
        body: { input: "ping", prompt_cache_options: { mode: "explicit" } },
        param: "prompt_cache_options.mode",
      },
      {
        route: "responses",
        controls: controls({ legacy_retentions: ["in_memory"] }),
        body: { input: "ping", prompt_cache_retention: "24h" },
        param: "prompt_cache_retention",
      },
      {
        route: "chat.completions",
        controls: controls({ legacy_retentions: ["in_memory"] }),
        body: { messages: [{ role: "user", content: "ping" }], prompt_cache_retention: "24h" },
        param: "prompt_cache_retention",
      },
      {
        route: "responses",
        controls: controls({ breakpoint_block_types: { responses: ["input_text"] } }),
        body: {
          input: [
            {
              type: "input_image",
              image_url: "https://example.test/stable.png",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
        param: "input[0].prompt_cache_breakpoint",
      },
      {
        route: "responses",
        controls: controls({ breakpoint_block_types: { responses: ["input_text"] } }),
        body: {
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } },
                {
                  type: "input_image",
                  image_url: "https://example.test/later-unsupported.png",
                  prompt_cache_breakpoint: { mode: "explicit" },
                },
              ],
            },
          ],
        },
        param: "input[0].content[1].prompt_cache_breakpoint",
      },
      {
        route: "chat.completions",
        controls: controls({ breakpoint_block_types: { chat_completions: ["text"] } }),
        body: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "https://example.test/stable.png" },
                  prompt_cache_breakpoint: { mode: "explicit" },
                },
              ],
            },
          ],
        },
        param: "messages[0].content[0].prompt_cache_breakpoint",
      },
    ] as const;

    try {
      for (const testCase of cases) {
        await step(`${testCase.route}/${testCase.param}`, async () => {
          setPromptCacheCapabilities({
            version: 1,
            providers: [{ id: "codex_chatgpt", controls: testCase.controls }],
          });

          let dispatches = 0;
          const response = await withFetchMock(
            () => {
              dispatches += 1;
              return sseResponse(baseSseChunks());
            },
            () =>
              testCase.route === "chat.completions"
                ? handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                    })
                  )
                : handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                    })
                  )
          );
          assert.equal(response.status, 400);
          assert.equal(dispatches, 0);
          const payload = (await response.json()) as { error?: { message?: string; type?: string; param?: string } };
          assert.equal(payload.error?.message, `Prompt cache control '${testCase.param}' is not supported for model '${DEFAULT_TEST_MODEL}'.`);
          assert.equal(payload.error.type, "invalid_request_error");
          assert.equal(payload.error.param, testCase.param);
        });
      }

      await step("unsupported catalog TTL metadata remains unknown instead of rejecting the public 30m value", async () => {
        setPromptCacheCapabilities({
          version: 1,
          providers: [{ id: "codex_chatgpt", controls: controls({ ttls: ["5m"] }) }],
        });

        let dispatches = 0;
        const response = await withFetchMock(
          () => {
            dispatches += 1;
            return sseResponse(baseSseChunks());
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  input: "ping",
                  prompt_cache_options: { ttl: "30m" },
                }),
              })
            )
        );
        assert.equal(response.status, 200);
        assert.equal(dispatches, 1);
      });

      await step("omitted active-provider fields and other providers remain unknown", async () => {
        setPromptCacheCapabilities({
          version: 1,
          providers: [
            { id: "codex_chatgpt", controls: controls({}) },
            { id: "metered", controls: controls({ key: false, explicit_breakpoints: false }) },
          ],
        });

        let dispatches = 0;
        const response = await withFetchMock(
          () => {
            dispatches += 1;
            return sseResponse(baseSseChunks());
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  prompt_cache_key: "stable-prefix",
                  prompt_cache_options: { mode: "explicit", ttl: "30m" },
                  input: [{ type: "input_text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }],
                }),
              })
            )
        );
        assert.equal(response.status, 200);
        assert.equal(dispatches, 1);
      });

      await step("malformed capability metadata remains unknown", async () => {
        setPromptCacheCapabilities({ version: 1, providers: [] });

        let dispatches = 0;
        const response = await withFetchMock(
          () => {
            dispatches += 1;
            return sseResponse(baseSseChunks());
          },
          () =>
            handleChatCompletions(
              new Request("https://ai.ubq.fi/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  prompt_cache_key: "stable-prefix",
                  prompt_cache_options: { mode: "explicit", ttl: "30m" },
                  messages: [
                    {
                      role: "user",
                      content: [{ type: "text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }],
                    },
                  ],
                }),
              })
            )
        );
        assert.equal(response.status, 200);
        assert.equal(dispatches, 1);
      });
    } finally {
      if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
      else kvStore.set(snapshotKey, previousSnapshot);
      if (previousRuntimeConfig === undefined) kvStore.delete(runtimeConfigKey);
      else kvStore.set(runtimeConfigKey, previousRuntimeConfig);
      resetRuntimeConfigCacheForTest();
    }
  }));

test("openai: rejects lossy Chat cache breakpoint content before dispatch", async () =>
  runSequence(async (step) => {
    const cases = [
      {
        route: "chat.completions",
        body: {
          messages: [
            {
              role: "system",
              content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }],
            },
          ],
        },
        param: "messages[0].content[0].type",
      },
      {
        route: "chat.completions",
        body: {
          messages: [{ role: "developer", content: [{ type: "file", file: { file_id: "file_stable" } }] }],
        },
        param: "messages[0].content[0].type",
      },
      {
        route: "chat.completions",
        body: {
          messages: [
            {
              role: "developer",
              content: [{ type: "input_audio", input_audio: { data: "abc", format: "wav" } }],
            },
          ],
        },
        param: "messages[0].content[0].type",
      },
      {
        route: "chat.completions",
        body: {
          messages: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/a.png" }] }],
        },
        param: "messages[0].content[0].type",
      },
      {
        route: "chat.completions",
        body: {
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" }, detail: "high" }],
            },
          ],
        },
        param: "messages[0].content[0].detail",
      },
      {
        route: "chat.completions",
        body: {
          messages: [{ role: "user", content: [{ type: "text", text: "stable", unexpected: true }] }],
        },
        param: "messages[0].content[0].unexpected",
      },
      {
        route: "chat.completions",
        body: {
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "https://example.test/a.png", unexpected: true } }],
            },
          ],
        },
        param: "messages[0].content[0].image_url.unexpected",
      },
      {
        route: "chat.completions",
        body: {
          messages: [{ role: "assistant", content: [{ type: "refusal", refusal: "No", unexpected: true }] }],
        },
        param: "messages[0].content[0].unexpected",
      },
      {
        route: "chat.completions",
        body: {
          messages: [
            {
              role: "user",
              content: "stable",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
        param: "messages[0].prompt_cache_breakpoint",
      },
      {
        route: "chat.completions",
        body: {
          messages: [
            {
              role: "assistant",
              content: [{ type: "refusal", refusal: "No", prompt_cache_breakpoint: { mode: "explicit" } }],
            },
          ],
        },
        param: "messages[0].content[0].prompt_cache_breakpoint",
      },
      {
        route: "chat.completions",
        body: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: { data: "abc", format: "wav" },
                  prompt_cache_breakpoint: { mode: "explicit" },
                },
              ],
            },
          ],
        },
        param: "messages[0].content[0].prompt_cache_breakpoint",
      },
      {
        route: "responses",
        body: {
          input: [
            {
              type: "message",
              role: "user",
              content: "stable",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
        param: "input[0].prompt_cache_breakpoint",
      },
      {
        route: "responses",
        body: {
          input: [
            {
              type: "function_call_output",
              call_id: "call_stable",
              output: "stable",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
        param: "input[0].prompt_cache_breakpoint",
      },
    ] as const;

    for (const testCase of cases) {
      await step(`${testCase.route}/${testCase.param}`, async () => {
        let dispatches = 0;
        const response = await withFetchMock(
          () => {
            dispatches += 1;
            return sseResponse(baseSseChunks());
          },
          () =>
            testCase.route === "chat.completions"
              ? handleChatCompletions(
                  new Request("https://ai.ubq.fi/v1/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                  })
                )
              : handleResponses(
                  new Request("https://ai.ubq.fi/v1/responses", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                  })
                )
        );
        assert.equal(response.status, 400);
        assert.equal(dispatches, 0);
        const payload = (await response.json()) as { error?: { param?: string; type?: string } };
        assert.equal(payload.error?.type, "invalid_request_error");
        assert.equal(payload.error.param, testCase.param);
      });
    }
  }));

test("openai: Responses preserves an explicit empty instructions string", async () => {
  let recordedBody: Record<string, unknown> | null = null;
  const response = await withFetchMock(
    (_url, bodyText) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", instructions: "" }),
        })
      )
  );
  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  assert.equal((recordedBody as Record<string, unknown>).instructions, "");
});

test("openai: strict request fields reject malformed values without dispatch", async () =>
  runSequence(async (step) => {
    const cases = [
      {
        route: "responses",
        body: { input: "ping", stream: null },
        param: "stream",
      },
      {
        route: "chat.completions",
        body: { messages: [{ role: "user", content: "ping" }], stream: "true" },
        param: "stream",
      },
      {
        route: "responses",
        body: { input: "ping", reasoning: [] },
        param: "reasoning",
      },
      {
        route: "responses",
        body: { input: [{ role: "user", content: [{ type: "input_image", image_url: "x", unexpected: true }] }] },
        param: "input[0].content[0].unexpected",
      },
      {
        route: "chat.completions",
        body: { messages: [{ role: "tool", tool_call_id: "call", content: "result", tool_calls: [] }] },
        param: "messages[0].tool_calls",
      },
      {
        route: "chat.completions",
        body: {
          messages: [{ role: "tool", tool_call_id: "call", content: [{ type: "input_text", text: "result" }] }],
        },
        param: "messages[0].content[0].type",
      },
      {
        route: "chat.completions",
        body: {
          messages: [{ role: "tool", tool_call_id: "call", content: [{ type: "output_text", text: "result" }] }],
        },
        param: "messages[0].content[0].type",
      },
      {
        route: "responses",
        body: { input: [{ type: "message", role: "tool", content: "result" }] },
        param: "input[0].role",
      },
      {
        route: "responses",
        body: { input: [{ type: "message", role: "user", content: [{ type: "output_text", text: "result" }] }] },
        param: "input[0].content[0].type",
      },
      {
        route: "chat.completions",
        body: {
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call",
                  type: "function",
                  function: { name: "tool", arguments: "{}" },
                  unexpected: true,
                },
              ],
            },
          ],
        },
        param: "messages[0].tool_calls[0].unexpected",
      },
      {
        route: "chat.completions",
        body: {
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call",
                  type: "function",
                  function: { name: "tool", arguments: "{}", unexpected: true },
                },
              ],
            },
          ],
        },
        param: "messages[0].tool_calls[0].function.unexpected",
      },
    ] as const;
    for (const testCase of cases) {
      await step(`${testCase.route}/${testCase.param}`, async () => {
        let calls = 0;
        const response = await withFetchMock(
          () => {
            calls += 1;
            return sseResponse(baseSseChunks());
          },
          () =>
            testCase.route === "responses"
              ? handleResponses(
                  new Request("https://ai.ubq.fi/v1/responses", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                  })
                )
              : handleChatCompletions(
                  new Request("https://ai.ubq.fi/v1/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                  })
                )
        );
        assert.equal(response.status, 400);
        assert.equal(calls, 0);
        const payload = (await response.json()) as { error?: { param?: string } };
        assert.equal(payload.error?.param, testCase.param);
      });
    }
    await step("input[0].type", async () => {
      let dispatches = 0;
      const response = await withFetchMock(
        () => {
          dispatches += 1;
          return sseResponse(baseSseChunks());
        },
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: [{ type: "text", text: "Chat-only alias" }] }),
            })
          )
      );
      assert.equal(response.status, 400);
      assert.equal(dispatches, 0);
      const payload = (await response.json()) as { error?: { param?: string } };
      assert.equal(payload.error?.param, "input[0].type");
    });
  }));

test("openai: validates standard prompt-cache controls before dispatch", async () =>
  runSequence(async (step) => {
    const cases = [
      {
        route: "responses",
        body: { input: "ping", prompt_cache_key: 1 },
        param: "prompt_cache_key",
      },
      {
        route: "chat.completions",
        body: { messages: [{ role: "user", content: "ping" }], prompt_cache_options: null },
        param: "prompt_cache_options",
      },
      {
        route: "responses",
        body: { input: "ping", prompt_cache_options: { mode: "automatic" } },
        param: "prompt_cache_options.mode",
      },
      {
        route: "chat.completions",
        body: { messages: [{ role: "user", content: "ping" }], prompt_cache_options: { ttl: "24h" } },
        param: "prompt_cache_options.ttl",
      },
      {
        route: "responses",
        body: { input: "ping", prompt_cache_options: { mode: "implicit", unexpected: true } },
        param: "prompt_cache_options.unexpected",
      },
      {
        route: "chat.completions",
        body: { messages: [{ role: "user", content: "ping" }], prompt_cache_retention: "forever" },
        param: "prompt_cache_retention",
      },
    ] as const;

    for (const testCase of cases) {
      await step(`${testCase.route}/${testCase.param}`, async () => {
        let calls = 0;
        const response = await withFetchMock(
          () => {
            calls += 1;
            return sseResponse(baseSseChunks());
          },
          () =>
            testCase.route === "responses"
              ? handleResponses(
                  new Request("https://ai.ubq.fi/v1/responses", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                  })
                )
              : handleChatCompletions(
                  new Request("https://ai.ubq.fi/v1/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                  })
                )
        );
        assert.equal(response.status, 400);
        assert.equal(calls, 0);
        const payload = (await response.json()) as { error?: { param?: string } };
        assert.equal(payload.error?.param, testCase.param);
      });
    }
  }));

test("openai: rejects gateway-only cache aliases before dispatch", async () =>
  runSequence(async (step) => {
    const cases = [
      { route: "responses", body: { input: "ping", cache_key: "not-standard" }, field: "cache_key" },
      {
        route: "chat.completions",
        body: { messages: [{ role: "user", content: "ping" }], cache_affinity: "not-standard" },
        field: "cache_affinity",
      },
    ] as const;

    for (const testCase of cases) {
      await step(`${testCase.route}/${testCase.field}`, async () => {
        let calls = 0;
        const response = await withFetchMock(
          () => {
            calls += 1;
            return sseResponse(baseSseChunks());
          },
          () =>
            testCase.route === "responses"
              ? handleResponses(
                  new Request("https://ai.ubq.fi/v1/responses", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                  })
                )
              : handleChatCompletions(
                  new Request("https://ai.ubq.fi/v1/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, ...testCase.body }),
                  })
                )
        );
        assert.equal(response.status, 400);
        assert.equal(calls, 0);
        const payload = (await response.json()) as { error?: { message?: string } };
        assert.match(payload.error?.message ?? "", new RegExp(testCase.field));
      });
    }
  }));

test("openai: both endpoints reject every non-boolean stream shape before dispatch", async () =>
  runSequence(async (step) => {
    const invalidValues: (readonly [string, unknown])[] = [
      ["null", null],
      ["string", "true"],
      ["number", 1],
      ["array", []],
      ["object", {}],
    ];
    for (const route of ["chat.completions", "responses"] as const) {
      for (const [label, stream] of invalidValues) {
        await step(`${route}/${label}`, async () => {
          let dispatches = 0;
          const response = await withFetchMock(
            () => {
              dispatches += 1;
              return sseResponse(baseSseChunks());
            },
            () =>
              route === "chat.completions"
                ? handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        stream,
                        messages: [{ role: "user", content: "ping" }],
                      }),
                    })
                  )
                : handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ model: DEFAULT_TEST_MODEL, stream, input: "ping" }),
                    })
                  )
          );
          assert.equal(response.status, 400);
          assert.equal(dispatches, 0);
          const payload = (await response.json()) as { error?: { param?: string } };
          assert.equal(payload.error?.param, "stream");
        });
      }
    }
  }));

test("openai: buffered Responses preserve nested response.output items", async () => {
  const item = {
    id: "call_nested_output",
    type: "function_call",
    call_id: "call_nested_output",
    name: "lookup",
    arguments: "{}",
    status: "completed",
  };
  const response = await withFetchMock(
    () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "response.output", response: { output: [item] } })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
      ]),
    () => handleResponses(responsesRequest({ stream: false }))
  );
  const payload = (await response.json()) as { output?: unknown[] };
  assert.equal(response.status, 200);
  assert.deepEqual(payload.output, [item]);
});

test("openai: native Responses reject malformed known content fields and unsupported content types", async () =>
  runSequence(async (step) => {
    const cases = [
      {
        content: [{ type: "input_image", image_url: "https://example.test/image", file_id: "file_image" }],
        param: "input[0].content[0].image_url",
      },
      {
        content: [{ type: "input_image", detail: "low" }],
        param: "input[0].content[0].image_url",
      },
      {
        content: [{ type: "input_file", file_id: 3 }],
        param: "input[0].content[0].file_id",
      },
      {
        content: [{ type: "input_file", filename: "missing-source.txt" }],
        param: "input[0].content[0].file_id",
      },
      {
        content: [{ type: "input_audio", data: "ignored" }],
        param: "input[0].content[0].type",
      },
      {
        content: [{ type: "text", text: "Chat-only alias" }],
        param: "input[0].content[0].type",
      },
      {
        content: [{ type: "image_url", image_url: "https://example.test/image" }],
        param: "input[0].content[0].type",
      },
      {
        content: [{ type: "input_text" }],
        param: "input[0].content[0].text",
      },
    ] as const;
    for (const testCase of cases) {
      await step(testCase.param, async () => {
        let dispatches = 0;
        const response = await withFetchMock(
          () => {
            dispatches += 1;
            return sseResponse(baseSseChunks());
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  input: [{ type: "message", role: "user", content: testCase.content }],
                }),
              })
            )
        );
        assert.equal(response.status, 400);
        assert.equal(dispatches, 0);
        const payload = (await response.json()) as { error?: { param?: string } };
        assert.equal(payload.error?.param, testCase.param);
      });
    }
  }));

test("openai: buffered Chat Completions release the upstream stream reader", async () => {
  let upstreamBody: ReadableStream<Uint8Array> | null = null;
  const response = await withFetchMock(
    () => {
      upstreamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of baseSseChunks()) controller.enqueue(TEXT_ENCODER.encode(chunk));
          controller.close();
        },
      });
      return new Response(upstreamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            messages: [{ role: "user", content: "ping" }],
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  await response.text();
  const body = upstreamBody as ReadableStream<Uint8Array> | null;
  assert.ok(body);
  assert.equal(body.locked, false);
});

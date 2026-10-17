import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 5 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  ApiKeyQuotaDispatchError,
  DEFAULT_TEST_MODEL,
  RELEASE_GIT_SHA,
  TEXT_ENCODER,
  authoritativeCodexQuotaResponse,
  baseSseChunks,
  fetchMeteredModels,
  fetchSurplusModels,
  getResponseTelemetry,
  getStoredPaidFallbackRequest,
  handleChatCompletions,
  handleResponses,
  keyToString,
  kvStore,
  resetMeteredModelsCacheForTest,
  resetSurplusModelsCacheForTest,
  seedPaidFallbackKey,
  sseResponse,
  waitForPaidFallbackTerminal,
  withCors,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";

test("openai: Codex model-unsupported responses never enter paid fallback", async () =>
  runSequence(async (step) => {
    const originalMeteredApiKey = process.env.METERED_API_KEY;
    const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
    const routeCases = [
      { route: "responses", keyId: "fallback-codex-model-unsupported-responses" },
      { route: "chat", keyId: "fallback-codex-model-unsupported-chat" },
    ] as const;
    try {
      process.env.METERED_API_KEY = "metered-test-key";
      process.env.SURPLUS_API_KEY = "surplus-test-key";
      resetMeteredModelsCacheForTest();
      resetSurplusModelsCacheForTest();
      await fetchMeteredModels({
        force: true,
        fetcher: () =>
          Promise.resolve(
            Response.json({
              data: [{ id: DEFAULT_TEST_MODEL, supported_endpoint_types: ["openai", "openai-response"] }],
            })
          ),
      });
      await fetchSurplusModels({
        apiKey: "surplus-test-key",
        force: true,
        fetcher: () =>
          Promise.resolve(
            Response.json({
              data: [{ id: DEFAULT_TEST_MODEL, pricing: { prompt: 0.000001, completion: 0.000003 } }],
            })
          ),
      });
      for (const routeCase of routeCases) {
        await step(`${routeCase.route} returns the primary 400 without paid exposure`, async () => {
          const { keyId } = routeCase;
          const requestId = `request-${keyId}`;
          seedPaidFallbackKey(keyId);
          let codexCalls = 0;
          let surplusCalls = 0;
          let meteredCalls = 0;

          const response = await withFetchMock(
            (url) => {
              if (url === "https://chatgpt.com/backend-api/codex/responses") {
                codexCalls += 1;
                return new Response(
                  JSON.stringify({
                    message: "The 'gpt-5-fixture-default' model is not supported when using Codex with a ChatGPT account.",
                    type: "invalid_request_error",
                    code: "upstream_error",
                  }),
                  { status: 400, headers: { "Content-Type": "application/json" } }
                );
              }
              if (url === "https://api.surplusintelligence.ai/v1/responses") {
                surplusCalls += 1;
                throw new Error("model-support errors must not dispatch to Surplus");
              }
              if (url === "https://api.openlux.ai/v1/responses") {
                meteredCalls += 1;
                throw new Error("model-support errors must not dispatch to OpenLux");
              }
              throw new Error(`Unexpected upstream dispatch in Codex model unsupported test: ${url}`);
            },
            () => {
              const usageContext = {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: true,
                requestId,
                startedAtMs: Date.now(),
              };
              return routeCase.route === "responses"
                ? handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        input: "inspect the workspace",
                        tools: [
                          {
                            type: "function",
                            name: "inspect_workspace",
                            description: "Inspect the workspace before continuing.",
                            parameters: { type: "object", properties: {}, additionalProperties: false },
                          },
                        ],
                        tool_choice: "none",
                      }),
                    }),
                    usageContext
                  )
                : handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        messages: [{ role: "user", content: "inspect the workspace" }],
                      }),
                    }),
                    usageContext
                  );
            }
          );

          assert.equal(response.status, 400);
          assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
          assert.equal(getResponseTelemetry(response)?.provider, "chatgpt_codex");
          assert.equal(getResponseTelemetry(response)?.fallbackReason, null);
          assert.equal(codexCalls, 1);
          assert.equal(surplusCalls, 0);
          assert.equal(meteredCalls, 0);
          const payload = (await response.json()) as { error?: Record<string, unknown> };
          assert.equal(payload.error?.code, "upstream_error");
          assert.equal(payload.error.message, "The 'gpt-5-fixture-default' model is not supported when using Codex with a ChatGPT account.");
          assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
          const keyRecord = kvStore.get(keyToString(["ubq_ai", "api_keys", "id", keyId])) as {
            usage_reset_at_ms: number;
            paid_fallback_spent_microcredits: number;
            paid_fallback_reserved_microcredits: number;
            paid_fallback_reservation_request_id: string | null;
          };
          assert.equal(keyRecord.paid_fallback_spent_microcredits, 0);
          assert.equal(keyRecord.paid_fallback_reserved_microcredits, 0);
          assert.equal(keyRecord.paid_fallback_reservation_request_id, null);
          assert.equal(kvStore.get(keyToString(["uos_ai", "paid_fallback", "v3", "window", keyId, keyRecord.usage_reset_at_ms])), undefined);
        });
      }
    } finally {
      for (const { keyId } of routeCases) {
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
      }
      resetMeteredModelsCacheForTest();
      resetSurplusModelsCacheForTest();
      if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
      else process.env.METERED_API_KEY = originalMeteredApiKey;
      if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
      else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
    }
  }));

test("openai: inter-provider abort and quota rejection retain the responding provider request ID", async () => {
  const originalMeteredApiKey = process.env.METERED_API_KEY;
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  try {
    process.env.METERED_API_KEY = "metered-test-key";
    process.env.SURPLUS_API_KEY = "surplus-test-key";
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    await fetchMeteredModels({
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [{ id: DEFAULT_TEST_MODEL, supported_endpoint_types: ["openai-response"] }],
          })
        ),
    });
    await fetchSurplusModels({
      apiKey: "surplus-test-key",
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [
              {
                id: DEFAULT_TEST_MODEL,
                pricing: { prompt: 0.000001, completion: 0.000003 },
              },
            ],
          })
        ),
    });

    const abortKeyId = "fallback-inter-provider-abort";
    const abortRequestId = `request-${abortKeyId}`;
    seedPaidFallbackKey(abortKeyId);
    const controller = new AbortController();
    let abortMeteredCalls = 0;
    const abortedResponse = await withFetchMock(
      (url) => {
        if (url === "https://api.surplusintelligence.ai/v1/responses") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                streamController.enqueue(TEXT_ENCODER.encode("provider one limited"));
              },
              cancel() {
                controller.abort(new DOMException("client disconnected", "AbortError"));
              },
            }),
            {
              status: 429,
              headers: { "X-Oneapi-Request-Id": "provider-1-abort-id" },
            }
          );
        }
        if (url === "https://api.openlux.ai/v1/responses") {
          abortMeteredCalls += 1;
          return sseResponse(baseSseChunks());
        }
        return authoritativeCodexQuotaResponse();
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
            signal: controller.signal,
          }),
          {
            keyId: abortKeyId,
            kernelRepo: null,
            kernelOrg: null,
            requestId: abortRequestId,
            startedAtMs: Date.now(),
          }
        )
    );
    assert.equal(abortedResponse.status, 499);
    assert.equal(abortMeteredCalls, 0);
    const abortedTelemetry = getResponseTelemetry(abortedResponse);
    assert.equal(abortedTelemetry?.provider, "surplus");
    assert.equal(abortedTelemetry.providerRequestId, "provider-1-abort-id");
    assert.equal(abortedResponse.headers.get("x-uos-upstream"), "surplus");
    const aborted = await waitForPaidFallbackTerminal(abortKeyId, abortRequestId, "ambiguous");
    assert.equal(aborted.dispatch_state, "dispatched");
    assert.equal(aborted.provider, "surplus");
    assert.equal(aborted.provider_request_id, "provider-1-abort-id");
    assert.equal(aborted.billing_state, "pending");

    const quotaKeyId = "fallback-provider-two-quota";
    const quotaRequestId = `request-${quotaKeyId}`;
    seedPaidFallbackKey(quotaKeyId);
    let quotaMeteredCalls = 0;
    const quotaResponse = await withFetchMock(
      (url) => {
        if (url === "https://api.surplusintelligence.ai/v1/responses") {
          return new Response("provider one limited", {
            status: 429,
            headers: { "X-Oneapi-Request-Id": "provider-1-quota-id" },
          });
        }
        if (url === "https://api.openlux.ai/v1/responses") {
          quotaMeteredCalls += 1;
          return sseResponse(baseSseChunks());
        }
        return authoritativeCodexQuotaResponse();
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
          }),
          {
            keyId: quotaKeyId,
            kernelRepo: null,
            kernelOrg: null,
            requestId: quotaRequestId,
            startedAtMs: Date.now(),
            beforeProviderDispatch: (provider) =>
              provider === "metered" ? Promise.reject(new ApiKeyQuotaDispatchError("API key quota reservation is unavailable")) : Promise.resolve(undefined),
          }
        )
    );
    assert.equal(quotaResponse.status, 503);
    assert.equal(quotaMeteredCalls, 0);
    const quotaTelemetry = getResponseTelemetry(quotaResponse);
    assert.equal(quotaTelemetry?.provider, "surplus");
    assert.equal(quotaTelemetry.providerRequestId, "provider-1-quota-id");
    assert.equal(quotaResponse.headers.get("x-uos-upstream"), "surplus");
    const quotaRejected = await waitForPaidFallbackTerminal(quotaKeyId, quotaRequestId, "ambiguous");
    assert.equal(quotaRejected.dispatch_state, "dispatched");
    assert.equal(quotaRejected.provider, "surplus");
    assert.equal(quotaRejected.provider_request_id, "provider-1-quota-id");
    assert.equal(quotaRejected.billing_state, "pending");
  } finally {
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = originalMeteredApiKey;
    if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
  }
});

/** Asserts one validated terminal survives a later client-body cancellation in ledger and health writes. */

test("http: CORS wrapper exposes a gateway request id", () => {
  const response = withCors(new Response("{}", { headers: { "Content-Type": "application/json" } }));
  assert.ok(response.headers.get("x-uos-request-id"));
  assert.match(response.headers.get("Access-Control-Expose-Headers") ?? "", /x-uos-request-id/);
  assert.match(response.headers.get("Access-Control-Expose-Headers") ?? "", /x-uos-provider-request-id/);
  assert.match(response.headers.get("Access-Control-Expose-Headers") ?? "", /x-uos-upstream/);
  assert.match(response.headers.get("Access-Control-Expose-Headers") ?? "", /x-ratelimit-remaining-tokens-minute/);
});

test("http: CORS wrapper exposes baked source identity and deployment headers", () => {
  const originalGitRevision = process.env.GIT_REVISION;
  const originalGithubSha = process.env.GITHUB_SHA;
  const originalBuildId = process.env.DENO_DEPLOY_BUILD_ID;
  const originalDeploymentId = process.env.DENO_DEPLOYMENT_ID;
  try {
    process.env.GIT_REVISION = "git-test-revision";
    process.env.GITHUB_SHA = "github-test-sha";
    process.env.DENO_DEPLOY_BUILD_ID = "build-test-id";
    process.env.DENO_DEPLOYMENT_ID = "deployment-test-id";
    const response = withCors(new Response("{}", { headers: { "Content-Type": "application/json" } }));
    assert.equal(response.headers.get("x-uos-git-sha"), RELEASE_GIT_SHA);
    assert.equal(response.headers.get("x-uos-deployment-id"), "build-test-id");
    const exposed = response.headers.get("Access-Control-Expose-Headers") ?? "";
    assert.match(exposed, /x-uos-git-sha/);
    assert.match(exposed, /x-uos-deployment-id/);
  } finally {
    if (originalGitRevision === undefined) Reflect.deleteProperty(process.env, "GIT_REVISION");
    else process.env.GIT_REVISION = originalGitRevision;
    if (originalGithubSha === undefined) Reflect.deleteProperty(process.env, "GITHUB_SHA");
    else process.env.GITHUB_SHA = originalGithubSha;
    if (originalBuildId === undefined) Reflect.deleteProperty(process.env, "DENO_DEPLOY_BUILD_ID");
    else process.env.DENO_DEPLOY_BUILD_ID = originalBuildId;
    if (originalDeploymentId === undefined) Reflect.deleteProperty(process.env, "DENO_DEPLOYMENT_ID");
    else process.env.DENO_DEPLOYMENT_ID = originalDeploymentId;
  }
});

test("openai: normalize function-style tools for codex compatibility", async () =>
  runSequence(async (step) => {
    await step("chat completions flattens tools and tool_choice", async () => {
      let recordedBody: Record<string, unknown> | null = null;

      const response = await withFetchMock(
        (_url, bodyText) => {
          recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
          return sseResponse(baseSseChunks());
        },
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                messages: [{ role: "user", content: "get weather" }],
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "fetch_weather",
                      description: "Fetch weather for a city.",
                      parameters: { type: "object", properties: { city: { type: "string" } } },
                    },
                  },
                  {
                    type: "function",
                    name: "legacy_tool",
                    description: "Already top-level tool name.",
                    parameters: { type: "object", properties: {} },
                    function: { strict: true },
                  },
                ],
                tool_choice: {
                  type: "function",
                  name: "forced_choice",
                  function: { name: "fetch_weather", strict: true },
                },
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      const recordedTools = recorded.tools as Record<string, unknown>[] | undefined;
      assert.ok(Array.isArray(recordedTools));
      assert.equal(recordedTools.length, 2);
      assert.equal(recordedTools[0]?.name, "fetch_weather");
      assert.equal(recordedTools[1]?.name, "legacy_tool");
      assert.equal(recordedTools[0]?.description, "Fetch weather for a city.");
      assert.deepEqual(recordedTools[0]?.parameters, {
        type: "object",
        properties: { city: { type: "string" } },
      });
      assert.equal(recordedTools[1]?.strict, true);
      assert.equal(Object.prototype.hasOwnProperty.call(recordedTools[0], "function"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(recordedTools[1], "function"), false);
      const recordedToolChoice = recorded.tool_choice as Record<string, unknown> | undefined;
      assert.ok(recordedToolChoice);
      assert.equal(recordedToolChoice.type, "function");
      assert.equal(recordedToolChoice.name, "forced_choice");
      assert.equal(Object.prototype.hasOwnProperty.call(recordedToolChoice, "strict"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(recordedToolChoice, "function"), false);
    });

    await step("responses preserves official direct tools and tool_choice", async () => {
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
              body: JSON.stringify({
                input: "get weather",
                tools: [
                  {
                    type: "function",
                    name: "fetch_weather",
                    description: "Fetch weather for a city.",
                    parameters: { type: "object", properties: { city: { type: "string" } } },
                    strict: true,
                  },
                ],
                tool_choice: { type: "function", name: "fetch_weather" },
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      const recordedTools = recorded.tools as Record<string, unknown>[] | undefined;
      assert.ok(Array.isArray(recordedTools));
      assert.equal(recordedTools.length, 1);
      assert.equal(recordedTools[0]?.name, "fetch_weather");
      assert.equal(recordedTools[0]?.description, "Fetch weather for a city.");
      assert.deepEqual(recordedTools[0]?.parameters, { type: "object", properties: { city: { type: "string" } } });
      assert.equal(recordedTools[0]?.strict, true);
      assert.equal(Object.prototype.hasOwnProperty.call(recordedTools[0], "function"), false);
      const recordedToolChoice = recorded.tool_choice as Record<string, unknown> | undefined;
      assert.ok(recordedToolChoice);
      assert.equal(recordedToolChoice.type, "function");
      assert.equal(recordedToolChoice.name, "fetch_weather");
      assert.equal(Object.prototype.hasOwnProperty.call(recordedToolChoice, "function"), false);
    });

    await step("responses flattens nested compatibility tools and tool_choice", async () => {
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
              body: JSON.stringify({
                input: "get weather",
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "fetch_weather",
                      description: "Fetch weather for a city.",
                      parameters: { type: "object", properties: { city: { type: "string" } } },
                    },
                  },
                ],
                tool_choice: { type: "function", function: { name: "fetch_weather" } },
              }),
            })
          )
      );

      assert.equal(response.status, 200);
      assert.ok(recordedBody);
      const recorded = recordedBody as Record<string, unknown>;
      const recordedTools = recorded.tools as Record<string, unknown>[] | undefined;
      assert.ok(Array.isArray(recordedTools));
      assert.equal(recordedTools.length, 1);
      assert.equal(recordedTools[0]?.name, "fetch_weather");
      assert.equal(recordedTools[0]?.description, "Fetch weather for a city.");
      assert.deepEqual(recordedTools[0]?.parameters, { type: "object", properties: { city: { type: "string" } } });
      assert.equal(Object.prototype.hasOwnProperty.call(recordedTools[0], "function"), false);
      const recordedToolChoice = recorded.tool_choice as Record<string, unknown> | undefined;
      assert.ok(recordedToolChoice);
      assert.equal(recordedToolChoice.type, "function");
      assert.equal(recordedToolChoice.name, "fetch_weather");
      assert.equal(Object.prototype.hasOwnProperty.call(recordedToolChoice, "function"), false);
    });
  }));

test("openai: chat completions accept system-only messages", async () => {
  let recordedBody: Record<string, unknown> | null = null;

  const response = await withFetchMock(
    (_url, bodyText) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "system", content: "Only system." }],
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  const recorded = recordedBody as Record<string, unknown>;
  assert.equal(recorded.instructions, "Only system.");
  const input = recorded.input;
  assert.ok(Array.isArray(input));
  assert.ok(input.length > 0);
  const first = input[0] as Record<string, unknown>;
  assert.equal(first.type, "message");
  assert.equal(first.role, "user");
  const content = first.content;
  assert.ok(Array.isArray(content));
  const firstContent = (content as Record<string, unknown>[]).at(0) ?? null;
  assert.equal(firstContent?.type, "input_text");
});

test("openai: responses accept non-message input items", async () => {
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
          body: JSON.stringify({
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "ping" }],
              },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Prior answer", annotations: [] }],
              },
              { type: "reasoning", summary: "thinking..." },
              { type: "function_call", name: "test", call_id: "call_1", arguments: "{}" },
              { type: "function_call_output", call_id: "call_1", output: "ok" },
            ],
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  const recorded = recordedBody as Record<string, unknown>;

  const input = recorded.input;
  assert.ok(Array.isArray(input));

  const types = (input as (Record<string, unknown> | null)[])
    .map((item) => (item && typeof item === "object" ? item.type : null))
    .filter((value): value is string => typeof value === "string");

  assert.ok(types.includes("reasoning"));
  assert.ok(types.includes("function_call"));
  assert.ok(types.includes("function_call_output"));
  const assistant = (input as Record<string, unknown>[]).find((item) => item.role === "assistant");
  assert.deepEqual(assistant?.content, [{ type: "output_text", text: "Prior answer" }]);
});

test("openai: buffered responses preserve function calls emitted as output items", async () => {
  const functionCall = {
    id: "fc_test",
    type: "function_call",
    status: "completed",
    name: "assistant_exports_download",
    call_id: "call_export",
    arguments: '{"format":"csv"}',
  };
  const response = await withFetchMock(
    () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: functionCall,
        })}\n\n`,
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            model: DEFAULT_TEST_MODEL,
            output: [],
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          },
        })}\n\n`,
      ]),
    () =>
      handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: "export csv",
            tools: [
              {
                type: "function",
                name: "assistant_exports_download",
                description: "Download the selected records.",
                parameters: {
                  type: "object",
                  properties: { format: { type: "string", enum: ["csv", "json"] } },
                  required: ["format"],
                  additionalProperties: false,
                },
                strict: true,
              },
            ],
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { output?: unknown[] };
  assert.deepEqual(payload.output, [functionCall]);
});

test("openai: responses preserve image detail on normalized input images", async () => {
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
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            reasoning: { effort: "low" },
            input: [
              {
                role: "user",
                content: [
                  { type: "input_text", text: "Read this." },
                  {
                    type: "input_image",
                    image_url: "data:image/jpeg;base64,/9j/4AAQ",
                    detail: "high",
                  },
                ],
              },
            ],
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  const recorded = recordedBody as Record<string, unknown>;
  const input = recorded.input;
  assert.ok(Array.isArray(input));
  const message = (input as Record<string, unknown>[]).at(0);
  const content = message?.content;
  assert.ok(Array.isArray(content));
  const image = (content as Record<string, unknown>[]).find((part) => part.type === "input_image");
  assert.equal(image?.image_url, "data:image/jpeg;base64,/9j/4AAQ");
  assert.equal(image.detail, "high");
});

test("openai: Chat tool conversations retain tool-call order and opaque arguments", async () => {
  let recordedBody: Record<string, unknown> | null = null;
  let upstreamCalls = 0;
  const response = await withFetchMock(
    (_url, bodyText) => {
      upstreamCalls += 1;
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            messages: [
              { role: "user", content: "Schedule it." },
              {
                role: "assistant",
                content: "I need two details.",
                tool_calls: [
                  { id: "call_calendar", type: "function", function: { name: "calendar", arguments: " { bad json" } },
                  { id: "call_weather", type: "function", function: { name: "weather", arguments: "{}" } },
                ],
              },
              { role: "tool", tool_call_id: "call_calendar", content: "Calendar is free." },
              {
                role: "tool",
                tool_call_id: "call_weather",
                content: [
                  { type: "text", text: "Sunny" },
                  { type: "text", text: " and warm" },
                ],
              },
            ],
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.ok(recordedBody);
  const recorded = recordedBody as Record<string, unknown>;
  const input = recorded.input as Record<string, unknown>[];
  assert.deepEqual(
    input.map((item) => item.type),
    ["message", "message", "function_call", "function_call", "function_call_output", "function_call_output"]
  );
  assert.deepEqual(input[2], {
    type: "function_call",
    call_id: "call_calendar",
    name: "calendar",
    arguments: " { bad json",
  });
  assert.deepEqual(input[5], {
    type: "function_call_output",
    call_id: "call_weather",
    output: [
      { type: "input_text", text: "Sunny" },
      { type: "input_text", text: " and warm" },
    ],
  });
});

test("openai: Chat assistant refusal content replays as output text", async () => {
  let recordedBody: Record<string, unknown> | null = null;
  const response = await withFetchMock(
    (_url, bodyText) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            messages: [{ role: "assistant", content: [{ type: "refusal", refusal: "Cannot help." }] }],
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  const requestBody = recordedBody as Record<string, unknown>;
  assert.deepEqual(requestBody.input, [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Cannot help." }],
    },
  ]);
});

test("openai: Chat assistant top-level refusal replays as output text", async () => {
  let recordedBody: Record<string, unknown> | null = null;
  const response = await withFetchMock(
    (_url, bodyText) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            messages: [{ role: "assistant", content: null, refusal: "Cannot help." }],
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  const requestBody = recordedBody as Record<string, unknown>;
  assert.deepEqual(requestBody.input, [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Cannot help." }],
    },
  ]);
});

test("openai: malformed Chat tool calls are rejected before provider dispatch", async () => {
  let upstreamCalls = 0;
  const response = await withFetchMock(
    () => {
      upstreamCalls += 1;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            messages: [
              {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_bad", type: "function", function: { name: "bad", arguments: {} } }],
              },
            ],
          }),
        })
      )
  );
  assert.equal(response.status, 400);
  assert.equal(upstreamCalls, 0);
  const payload = (await response.json()) as { error?: { param?: string } };
  assert.equal(payload.error?.param, "messages[0].tool_calls[0].function.arguments");
});

test("openai: Chat accepts a tool-call-only assistant message with omitted content", async () => {
  let recordedBody: Record<string, unknown> | null = null;
  const response = await withFetchMock(
    (_url, bodyText) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            messages: [
              {
                role: "assistant",
                tool_calls: [{ id: "call_omitted", type: "function", function: { name: "lookup", arguments: "{}" } }],
              },
            ],
          }),
        })
      )
  );
  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  assert.deepEqual((recordedBody as Record<string, unknown>).input, [
    {
      type: "function_call",
      call_id: "call_omitted",
      name: "lookup",
      arguments: "{}",
    },
  ]);
});

test("openai: Chat function calls translate consistently in buffered and streamed output", async () =>
  runSequence(async (step) => {
    const callOne = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_one",
      name: "first",
      arguments: '{"a":1}',
    };
    const callTwo = {
      id: "fc_2",
      type: "function_call",
      call_id: "call_two",
      name: "second",
      arguments: '{"b":2}',
    };
    const chunks = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_calls", created_at: 1 } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Before tools. " })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 9, item: callOne })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 9, item: callOne })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 4, item: { ...callTwo, arguments: "" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '{"b":' })}\n\n`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_2", arguments: '{"b":2}' })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 9, item: callOne })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 4, item: callTwo })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          output: [callOne, callTwo],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      })}\n\n`,
    ];

    await step("buffered", async () => {
      const response = await withFetchMock(
        () => sseResponse(chunks),
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, messages: [{ role: "user", content: "tools" }] }),
            })
          )
      );
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        choices: { message: Record<string, unknown>; finish_reason: string }[];
      };
      assert.equal(payload.choices[0]?.finish_reason, "tool_calls");
      assert.equal(payload.choices[0]?.message.content, "Before tools. ");
      assert.deepEqual(payload.choices[0]?.message.tool_calls, [
        { id: "call_one", type: "function", function: { name: "first", arguments: '{"a":1}' } },
        { id: "call_two", type: "function", function: { name: "second", arguments: '{"b":2}' } },
      ]);
    });

    await step("streamed", async () => {
      const response = await withFetchMock(
        () => sseResponse(chunks),
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: DEFAULT_TEST_MODEL,
                stream: true,
                messages: [{ role: "user", content: "tools" }],
              }),
            })
          )
      );
      const text = await response.text();
      assert.match(text, /"tool_calls"/);
      assert.match(text, /"finish_reason":"tool_calls"/);
      assert.match(text, /data: \[DONE\]/);
      const toolArgumentDeltas = text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: {") && frame.includes("tool_calls"))
        .flatMap((frame) => {
          const payload = JSON.parse(frame.slice("data: ".length)) as {
            choices?: { delta?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
          };
          return payload.choices?.flatMap((choice) => choice.delta?.tool_calls ?? []) ?? [];
        })
        .map((call) => call.function?.arguments);
      // A duplicate added event does not replay its complete argument string.
      assert.deepEqual(toolArgumentDeltas, ['{"a":1}', "", '{"b":', "2}"]);
    });
  }));

test("openai: inconsistent function-call stream arguments never emit Chat [DONE]", async () => {
  const response = await withFetchMock(
    () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "fc_bad", type: "function_call", call_id: "call_bad", name: "bad", arguments: "" },
        })}\n\n`,
        `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_bad", delta: "{" })}\n\n`,
        `data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_bad", arguments: "[]" })}\n\n`,
      ]),
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            stream: true,
            messages: [{ role: "user", content: "tools" }],
          }),
        })
      )
  );
  const text = await response.text();
  assert.match(text, /upstream_stream_error/);
  assert.doesNotMatch(text, /data: \[DONE\]/);
});

test("openai: malformed preflight terminal emits a Chat stream error", async () => {
  const observedTerminalUsages: { completed: boolean; inputTokens: number | null }[] = [];
  const response = await withFetchMock(
    () =>
      sseResponse([
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            output: [{ id: "fc_preflight_bad", type: "function_call", call_id: "call_bad", name: "bad" }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        })}\n\n`,
      ]),
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            stream: true,
            messages: [{ role: "user", content: "tools" }],
          }),
        }),
        {
          keyId: null,
          kernelRepo: null,
          kernelOrg: null,
          onTerminalUsage: (usage, completed) => {
            observedTerminalUsages.push({ completed, inputTokens: usage?.inputTokens ?? null });
          },
        }
      )
  );

  const text = await response.text();
  assert.match(text, /upstream_stream_error/);
  assert.doesNotMatch(text, /data: \[DONE\]/);
  assert.deepEqual(observedTerminalUsages, [{ completed: false, inputTokens: 1 }]);
});

test("openai: terminal function calls without arguments fail for buffered and streamed Chat", async () =>
  runSequence(async (step) => {
    const malformedEvents = [
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_missing_args", type: "function_call", call_id: "call_missing_args", name: "bad" },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "fc_missing_args", type: "function_call", call_id: "call_missing_args", name: "bad" },
      })}\n\n`,
    ];
    for (const stream of [false, true]) {
      await step(stream ? "streamed" : "buffered", async () => {
        const response = await withFetchMock(
          () => sseResponse(malformedEvents),
          () =>
            handleChatCompletions(
              new Request("https://ai.ubq.fi/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  stream,
                  messages: [{ role: "user", content: "tools" }],
                }),
              })
            )
        );
        if (stream) {
          const text = await response.text();
          assert.match(text, /upstream_stream_error/);
          assert.doesNotMatch(text, /data: \[DONE\]/);
        } else {
          assert.equal(response.status, 502);
        }
      });
    }
  }));

test("openai: late function-call argument deltas never produce a successful Chat terminal", async () =>
  runSequence(async (step) => {
    const malformedEvents = [
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_late_delta",
          type: "function_call",
          call_id: "call_late_delta",
          name: "bad",
          arguments: "",
        },
      })}\n\n`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_late_delta", arguments: "{}" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_late_delta", delta: "x" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
    ];
    for (const stream of [false, true]) {
      await step(stream ? "streamed" : "buffered", async () => {
        const response = await withFetchMock(
          () => sseResponse(malformedEvents),
          () =>
            handleChatCompletions(
              new Request("https://ai.ubq.fi/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  stream,
                  messages: [{ role: "user", content: "tools" }],
                }),
              })
            )
        );
        if (stream) {
          const text = await response.text();
          assert.match(text, /upstream_stream_error/);
          assert.doesNotMatch(text, /data: \[DONE\]/);
        } else {
          assert.equal(response.status, 502);
        }
      });
    }
  }));

test("openai: unfinished function calls never produce a successful Chat terminal", async () =>
  runSequence(async (step) => {
    const malformedEvents = [
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_unfinished", type: "function_call", call_id: "call_unfinished", name: "bad" },
      })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
    ];
    for (const stream of [false, true]) {
      await step(stream ? "streamed" : "buffered", async () => {
        const response = await withFetchMock(
          () => sseResponse(malformedEvents),
          () =>
            handleChatCompletions(
              new Request("https://ai.ubq.fi/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  stream,
                  messages: [{ role: "user", content: "tools" }],
                }),
              })
            )
        );
        if (stream) {
          const text = await response.text();
          assert.match(text, /upstream_stream_error/);
          assert.doesNotMatch(text, /data: \[DONE\]/);
        } else {
          assert.equal(response.status, 502);
        }
      });
    }
  }));

test("openai: malformed output-text deltas never produce a successful Chat terminal", async () =>
  runSequence(async (step) => {
    const malformedEvents = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: null })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
    ];
    for (const stream of [false, true]) {
      await step(stream ? "streamed" : "buffered", async () => {
        const response = await withFetchMock(
          () => sseResponse(malformedEvents),
          () =>
            handleChatCompletions(
              new Request("https://ai.ubq.fi/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  stream,
                  messages: [{ role: "user", content: "text" }],
                }),
              })
            )
        );
        if (stream) {
          const text = await response.text();
          assert.match(text, /upstream_stream_error/);
          assert.doesNotMatch(text, /data: \[DONE\]/);
        } else {
          assert.equal(response.status, 502);
        }
      });
    }
  }));

test("openai: tool-call-only buffered Chat output uses null content", async () => {
  const call = { id: "fc_only", type: "function_call", call_id: "call_only", name: "only", arguments: "{}" };
  const response = await withFetchMock(
    () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: call })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { output: [call] } })}\n\n`,
      ]),
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_TEST_MODEL, messages: [{ role: "user", content: "tools" }] }),
        })
      )
  );
  const payload = (await response.json()) as { choices: { message: { content: unknown }; finish_reason: string }[] };
  assert.equal(payload.choices[0]?.message.content, null);
  assert.equal(payload.choices[0]?.finish_reason, "tool_calls");
});

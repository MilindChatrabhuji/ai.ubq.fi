import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 11 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import { resetOpenRouterModelsCacheForTest, setOpenRouterModelsFetchForTest } from "../src/models/openrouter-models.ts";
import {
  DEEPSEEK_FLASH_MODEL,
  DEFAULT_TEST_MODEL,
  MAX_RESPONSES_SSE_EVENT_BYTES,
  type OpenAiAtomicOp,
  TEXT_ENCODER,
  atomicCommitObservation,
  atomicWritesForKey,
  authoritativeCodexQuotaResponse,
  baseSseChunks,
  clearMeteredAndSurplusProviderHealth,
  deepSeekResponsesRequest,
  deepSeekStreamChunk,
  encodeBase64Url,
  encodeJsonBase64Url,
  fetchMeteredModels,
  getResponseTelemetry,
  handleChatCompletions,
  handleResponses,
  isAnswerBearingCompletion,
  keyToString,
  kvStub,
  kvStore,
  parseResponsesSseEvents,
  rejectOnAbort,
  resetMeteredModelsCacheForTest,
  resetProviderHealthThrottleForTest,
  resetSurplusModelsCacheForTest,
  responsesRequest,
  seedPaidFallbackKey,
  seedPaidFallthroughProviders,
  setPaidProviderFirstHeadersDeadlineMsForTest,
  sha256Base64Url,
  specialProviderChatRequest,
  sseResponse,
  toPublicKeyPem,
  waitForPaidFallbackTerminal,
  withDiscoveryKeys,
  withFetchMock,
  withProviderSelection,
  withTerminalRequestLog,
} from "./helpers/openai-compat-harness.ts";

test("openai: DeepSeek routes report the effective output allowance without inventing one", async () =>
  runSequence(async (step) => {
    const envKey = "DEEPSEEK_API_KEY";
    const originalApiKey = process.env[envKey];
    process.env[envKey] = "deepseek-test-key";
    const streamChunk = deepSeekStreamChunk;
    const bufferedCompletion = (): Record<string, unknown> => ({
      id: "deepseek-allowance-buffered",
      object: "chat.completion",
      created: 1_780_000_201,
      model: DEEPSEEK_FLASH_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    const upstreamBodies: Record<string, unknown>[] = [];
    try {
      await step("reports the client's Responses cap in the terminal telemetry and sends exactly that cap", async () => {
        const logs: unknown[][] = [];
        const originalInfo = console.info;
        console.info = (...args: unknown[]) => logs.push(args);
        try {
          upstreamBodies.length = 0;
          const response = await withFetchMock(
            (_url, bodyText) => {
              upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
              return sseResponse([streamChunk({ role: "assistant", content: "ok" }, { finish_reason: "stop" }), "data: [DONE]\n\n"]);
            },
            () => handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: true, max_output_tokens: 512 }))
          );
          const logged = await withTerminalRequestLog(response, {
            route: "responses",
            telemetryResponse: response,
            startedAtMonotonicMs: performance.now(),
            requestId: "deepseek-allowance-cap",
          });
          await logged.text();
          assert.equal(upstreamBodies.length, 1);
          assert.equal(upstreamBodies[0].max_tokens, 512);
          assert.equal(getResponseTelemetry(response)?.outputTokenAllowance, 512);
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (logs.some((entry) => entry[0] === "[ai.ubq.fi] request_terminal")) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
          }
          const terminal = logs
            .filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal")
            .map((entry) => JSON.parse(String(entry[1])) as Record<string, unknown>);
          assert.equal(terminal.length, 1);
          assert.equal(terminal[0].output_token_allowance, 512);
        } finally {
          console.info = originalInfo;
        }
      });

      await step("reports the allowance on the buffered Responses branch too", async () => {
        upstreamBodies.length = 0;
        const response = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            return Response.json(bufferedCompletion());
          },
          () => handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: false, max_output_tokens: 256 }))
        );
        await response.json();
        assert.equal(upstreamBodies[0].max_tokens, 256);
        assert.equal(getResponseTelemetry(response)?.outputTokenAllowance, 256);
      });

      await step("a truncated buffered completion is not recorded as completed", async () => {
        // The buffered path must report the terminal the client receives. Before
        // this, `recordCompletionUsage` ran before the payload's own status was
        // read, so a truncated buffered reply was persisted as `completed: true`.
        upstreamBodies.length = 0;
        const truncated = {
          ...bufferedCompletion(),
          choices: [{ index: 0, message: { role: "assistant", content: "cut off" }, finish_reason: "length" }],
        };
        const response = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            return Response.json(truncated);
          },
          () => handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: false }))
        );
        const payload = (await response.json()) as Record<string, unknown>;
        assert.equal(payload.status, "incomplete");
        assert.deepEqual(payload.incomplete_details, { reason: "max_output_tokens" });
        const telemetry = getResponseTelemetry(response);
        assert.ok(telemetry);
        assert.equal(telemetry.streamTerminalType, "response.incomplete");
        assert.equal(telemetry.completed, false);
        assert.equal(telemetry.failureKind, "incomplete_response");
      });

      await step("keeps an omitted cap unknown at a tier whose provider default was never measured", async () => {
        upstreamBodies.length = 0;
        const response = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            return sseResponse([streamChunk({ role: "assistant", content: "ok" }, { finish_reason: "stop" }), "data: [DONE]\n\n"]);
          },
          // No `reasoning` at all is the provider's `high` default, and omitting
          // the cap must not be reported as a gateway-invented allowance.
          () => handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: true }))
        );
        await response.text();
        assert.equal(upstreamBodies.length, 1);
        assert.equal("max_tokens" in upstreamBodies[0], false, "the gateway must not invent a cap on the wire");
        assert.equal(getResponseTelemetry(response)?.reasoning, "high");
        assert.equal(getResponseTelemetry(response)?.outputTokenAllowance, null);
      });

      await step("reports the provider's measured default for the tier that has one", async () => {
        upstreamBodies.length = 0;
        const response = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            return sseResponse([streamChunk({ role: "assistant", content: "ok" }, { finish_reason: "stop" }), "data: [DONE]\n\n"]);
          },
          () => handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: true, reasoning: { effort: "none" } }))
        );
        await response.text();
        assert.equal(upstreamBodies[0].reasoning_effort, "none");
        assert.equal("max_tokens" in upstreamBodies[0], false);
        // 8,192 is the measured `none`-tier default (handoff 2026-09-21, Delta 3).
        assert.equal(getResponseTelemetry(response)?.outputTokenAllowance, 8192);
      });

      await step("reports the Chat route's cap and keeps an omitted one unknown", async () => {
        const withCap = await withFetchMock(
          () => Response.json(bufferedCompletion()),
          () =>
            handleChatCompletions(
              specialProviderChatRequest({ model: DEEPSEEK_FLASH_MODEL, messages: [{ role: "user", content: "hi" }], max_completion_tokens: 321 })
            )
        );
        await withCap.json();
        assert.equal(getResponseTelemetry(withCap)?.outputTokenAllowance, 321);

        const withoutCap = await withFetchMock(
          () => Response.json(bufferedCompletion()),
          () => handleChatCompletions(specialProviderChatRequest({ model: DEEPSEEK_FLASH_MODEL, messages: [{ role: "user", content: "hi" }] }))
        );
        await withoutCap.json();
        assert.equal(getResponseTelemetry(withoutCap)?.reasoning, "high");
        assert.equal(getResponseTelemetry(withoutCap)?.outputTokenAllowance, null);
      });
    } finally {
      if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
      else process.env[envKey] = originalApiKey;
    }
  }));

test("openai: a reasoning-only DeepSeek Responses stream fails closed instead of completing", async () =>
  runSequence(async (step) => {
    const envKey = "DEEPSEEK_API_KEY";
    const originalApiKey = process.env[envKey];
    process.env[envKey] = "deepseek-test-key";
    const responsesBody = deepSeekResponsesRequest;
    const chunk = deepSeekStreamChunk;
    const responsesEvents = parseResponsesSseEvents;
    const request = (): Promise<Response> => handleResponses(responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: true }));
    try {
      await step("a stream whose only output is reasoning is empty_upstream_completion", async () => {
        const response = await withFetchMock(
          () =>
            sseResponse([
              chunk({ role: "assistant", reasoning_content: "The whole budget went into thinking." }),
              chunk({}, { finish_reason: "stop" }),
              "data: [DONE]\n\n",
            ]),
          request
        );
        assert.equal(response.status, 200);
        const events = responsesEvents(await response.text());
        assert.deepEqual(
          events.map((event) => event.type),
          [
            "response.created",
            "response.in_progress",
            "response.output_item.added",
            "response.reasoning_summary_part.added",
            "response.reasoning_summary_text.delta",
            "response.failed",
          ]
        );
        const failed = events.at(-1) as { response: Record<string, unknown> };
        assert.equal(failed.response.status, "failed");
        assert.deepEqual(failed.response.error, {
          code: "empty_upstream_completion",
          message: "Upstream response completed with no translated semantic output.",
        });
        assert.deepEqual(failed.response.output ?? [], []);
        const telemetry = getResponseTelemetry(response);
        assert.ok(telemetry);
        assert.equal(telemetry.streamTerminalType, "response.failed");
        assert.equal(telemetry.failureKind, "empty_upstream_completion");
        assert.equal(telemetry.completed, false);
        assert.equal(telemetry.semanticOutputObserved, false);
      });

      await step("a normal text completion is untouched", async () => {
        const response = await withFetchMock(
          () => sseResponse([chunk({ role: "assistant", content: "pong" }, { finish_reason: "stop" }), "data: [DONE]\n\n"]),
          request
        );
        const events = responsesEvents(await response.text());
        const completed = events.at(-1) as { type: string; response: Record<string, unknown> };
        assert.equal(completed.type, "response.completed");
        assert.equal(completed.response.status, "completed");
        assert.deepEqual(
          (completed.response.output as Record<string, unknown>[]).map((item) => item.type),
          ["message"]
        );
        assert.equal(getResponseTelemetry(response)?.streamTerminalType, "response.completed");
        assert.equal(getResponseTelemetry(response)?.completed, true);
        assert.equal(getResponseTelemetry(response)?.failureKind, null);
      });

      await step("a normal tool-call completion is untouched", async () => {
        const response = await withFetchMock(
          () =>
            sseResponse([
              chunk(
                {
                  role: "assistant",
                  tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "clock_now", arguments: "{}" } }],
                },
                { finish_reason: "tool_calls" }
              ),
              "data: [DONE]\n\n",
            ]),
          request
        );
        const events = responsesEvents(await response.text());
        const completed = events.at(-1) as { type: string; response: Record<string, unknown> };
        assert.equal(completed.type, "response.completed");
        assert.deepEqual(
          (completed.response.output as Record<string, unknown>[]).map((item) => item.type),
          ["function_call"]
        );
        assert.equal(getResponseTelemetry(response)?.streamTerminalType, "response.completed");
        assert.equal(getResponseTelemetry(response)?.completed, true);
      });
    } finally {
      if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
      else process.env[envKey] = originalApiKey;
    }
  }));

test("openai: a truncated DeepSeek Responses stream reports response.incomplete", async () =>
  runSequence(async (step) => {
    const envKey = "DEEPSEEK_API_KEY";
    const originalApiKey = process.env[envKey];
    process.env[envKey] = "deepseek-test-key";
    const responsesBody = deepSeekResponsesRequest;
    const chunk = deepSeekStreamChunk;
    const responsesEvents = parseResponsesSseEvents;
    const request = (): Promise<Response> => handleResponses(responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: true, max_output_tokens: 16 }));
    try {
      await step("length becomes response.incomplete with max_output_tokens", async () => {
        const response = await withFetchMock(
          () =>
            sseResponse([chunk({ role: "assistant", content: "the visible start of an answer" }), chunk({}, { finish_reason: "length" }), "data: [DONE]\n\n"]),
          request
        );
        const events = responsesEvents(await response.text());
        const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
        assert.equal(terminal.type, "response.incomplete");
        assert.equal(terminal.response.status, "incomplete");
        assert.deepEqual(terminal.response.incomplete_details, { reason: "max_output_tokens" });
        assert.equal(terminal.response.error, null);
        assert.deepEqual(
          (terminal.response.output as Record<string, unknown>[]).map((item) => item.type),
          ["message"]
        );
        const telemetry = getResponseTelemetry(response);
        assert.ok(telemetry);
        assert.equal(telemetry.streamTerminalType, "response.incomplete");
        assert.equal(telemetry.completed, false);
        assert.equal(telemetry.outputTokenAllowance, 16);
        // A truncation is classified, not left indistinguishable from a clean
        // completion; the classification matches the buffered path.
        assert.equal(telemetry.failureKind, "incomplete_response");
      });

      await step("an empty length completion is incomplete, not a fail-closed empty completion", async () => {
        // G1 wins over G3: the upstream said why it stopped.
        const response = await withFetchMock(
          () =>
            sseResponse([
              chunk({ role: "assistant", reasoning_content: "thinking used the whole budget" }),
              chunk({}, { finish_reason: "length" }),
              "data: [DONE]\n\n",
            ]),
          request
        );
        const events = responsesEvents(await response.text());
        const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
        assert.equal(terminal.type, "response.incomplete");
        assert.deepEqual(terminal.response.incomplete_details, { reason: "max_output_tokens" });
        const telemetry = getResponseTelemetry(response);
        assert.ok(telemetry);
        assert.equal(telemetry.streamTerminalType, "response.incomplete");
        assert.equal(telemetry.failureKind, "incomplete_response");
        assert.equal(telemetry.completed, false);
      });

      await step("stop and tool_calls still complete", async () => {
        const stopped = await withFetchMock(
          () => sseResponse([chunk({ role: "assistant", content: "pong" }, { finish_reason: "stop" }), "data: [DONE]\n\n"]),
          request
        );
        const stoppedEvents = responsesEvents(await stopped.text());
        assert.equal((stoppedEvents.at(-1) as { type: string }).type, "response.completed");
        assert.equal(getResponseTelemetry(stopped)?.completed, true);

        const toolCalls = await withFetchMock(
          () =>
            sseResponse([
              chunk(
                {
                  role: "assistant",
                  tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "clock_now", arguments: "{}" } }],
                },
                { finish_reason: "tool_calls" }
              ),
              "data: [DONE]\n\n",
            ]),
          request
        );
        const toolEvents = responsesEvents(await toolCalls.text());
        assert.equal((toolEvents.at(-1) as { type: string }).type, "response.completed");
        assert.equal(getResponseTelemetry(toolCalls)?.completed, true);
      });

      await step("an unrecognized reason fails visibly instead of completing", async () => {
        const response = await withFetchMock(
          () => sseResponse([chunk({ role: "assistant", content: "partial" }, { finish_reason: "insufficient_system_resource" }), "data: [DONE]\n\n"]),
          request
        );
        const events = responsesEvents(await response.text());
        assert.equal((events.at(-1) as { type: string }).type, "response.failed");
        const telemetry = getResponseTelemetry(response);
        assert.ok(telemetry);
        assert.equal(telemetry.streamTerminalType, "response.failed");
        assert.equal(telemetry.completed, false);
        assert.equal(telemetry.failureKind, "deepseek_finish_reason:insufficient_system_resource");
      });
    } finally {
      if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
      else process.env[envKey] = originalApiKey;
    }
  }));

test("openai: the buffered DeepSeek Responses path fails a degenerate completion closed too", async () =>
  runSequence(async (step) => {
    // The streamed path (previous test) already fails closed. The buffered path
    // is a different branch of the same route, and before this test it reported
    // the same degenerate completion as `completed` with `error: null` - one
    // request shape must not report success on one transport and failure on the
    // other.
    const envKey = "DEEPSEEK_API_KEY";
    const originalApiKey = process.env[envKey];
    process.env[envKey] = "deepseek-test-key";
    const buffered = (choices: readonly Record<string, unknown>[]): Promise<Response> =>
      withFetchMock(
        () =>
          Response.json({
            id: "deepseek-buffered-terminal",
            object: "chat.completion",
            created: 1_780_000_600,
            model: DEEPSEEK_FLASH_MODEL,
            choices,
            usage: { prompt_tokens: 5, completion_tokens: 30, total_tokens: 35 },
          }),
        () => handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: false }))
      );
    try {
      await step("a buffered reasoning-only completion is empty_upstream_completion", async () => {
        const response = await buffered([
          { index: 0, message: { role: "assistant", reasoning_content: "The whole budget went into thinking." }, finish_reason: "stop" },
        ]);
        assert.equal(response.status, 502);
        const payload = (await response.json()) as { error?: Record<string, unknown> };
        const error = payload.error;
        assert.ok(error);
        // Same code and message the ordinary routes already return for this
        // classification, so a caller cannot tell the transports apart.
        assert.equal(error.code, "empty_upstream_completion");
        assert.equal(error.message, "Upstream response completed with no translated semantic output.");
        assert.equal(error.type, "server_error");
        const telemetry = getResponseTelemetry(response);
        assert.ok(telemetry);
        assert.equal(telemetry.completed, false);
        assert.equal(telemetry.failureKind, "empty_upstream_completion");
        assert.equal(telemetry.semanticOutputObserved, false);
      });

      await step("a buffered empty completion is also empty_upstream_completion", async () => {
        const response = await buffered([{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }]);
        assert.equal(response.status, 502);
        const payload = (await response.json()) as { error?: Record<string, unknown> };
        const error = payload.error;
        assert.ok(error);
        assert.equal(error.code, "empty_upstream_completion");
      });

      await step("an explicit truncation still wins over the empty-completion guard", async () => {
        const response = await buffered([{ index: 0, message: { role: "assistant", reasoning_content: "thinking" }, finish_reason: "length" }]);
        assert.equal(response.status, 200);
        const payload = (await response.json()) as Record<string, unknown>;
        assert.equal(payload.status, "incomplete");
        assert.deepEqual(payload.incomplete_details, { reason: "max_output_tokens" });
        assert.equal(getResponseTelemetry(response)?.failureKind, "incomplete_response");
      });

      await step("a buffered text completion is untouched", async () => {
        const response = await buffered([{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }]);
        assert.equal(response.status, 200);
        const payload = (await response.json()) as Record<string, unknown>;
        assert.equal(payload.status, "completed");
        assert.equal(getResponseTelemetry(response)?.completed, true);
        assert.equal(getResponseTelemetry(response)?.failureKind, null);
      });

      await step("a buffered tool-call completion is untouched", async () => {
        const response = await buffered([
          {
            index: 0,
            message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "clock_now", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          },
        ]);
        assert.equal(response.status, 200);
        const payload = (await response.json()) as Record<string, unknown>;
        assert.equal(payload.status, "completed");
        assert.deepEqual(
          (payload.output as Record<string, unknown>[]).map((item) => item.type),
          ["function_call"]
        );
      });
    } finally {
      if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
      else process.env[envKey] = originalApiKey;
    }
  }));

test("openai: a DeepSeek Responses refusal output replays as assistant history", async () =>
  runSequence(async (step) => {
    // The refusal content part this adapter emits was rejected by its own request
    // translator: a client that sent the response output back as `input` got
    // HTTP 400 `input.content type 'refusal' is not supported`, so a single
    // refusal ended the conversation. Both transports' output must replay as the
    // assistant text the established Chat message shape carries.
    const envKey = "DEEPSEEK_API_KEY";
    const originalApiKey = process.env[envKey];
    process.env[envKey] = "deepseek-test-key";
    const refusal = "I cannot help with that request.";
    const completion = (message: Record<string, unknown>): Response =>
      Response.json({
        id: "deepseek-refusal-replay",
        object: "chat.completion",
        created: 1_780_000_700,
        model: DEEPSEEK_FLASH_MODEL,
        choices: [{ index: 0, message, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
      });
    const continuationInput = (output: Record<string, unknown>[]): Record<string, unknown>[] => [
      ...output,
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ];

    try {
      await step("buffered refusal output replays without a 400", async () => {
        const upstreamBodies: Record<string, unknown>[] = [];
        const result = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            return upstreamBodies.length === 1
              ? completion({ role: "assistant", content: null, refusal })
              : completion({ role: "assistant", content: "Continuing." });
          },
          async () => {
            const first = await handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: false }));
            assert.equal(first.status, 200);
            const payload = (await first.json()) as Record<string, unknown>;
            const output = payload.output as Record<string, unknown>[];
            assert.deepEqual(output[0].content, [{ type: "refusal", refusal }]);
            return handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: continuationInput(output), stream: false }));
          }
        );
        assert.equal(result.status, 200);
        const messages = upstreamBodies[1].messages as Record<string, unknown>[];
        assert.deepEqual(messages.at(-2), { role: "assistant", content: refusal });
        assert.deepEqual(messages.at(-1), { role: "user", content: "continue" });
      });

      await step("streamed terminal refusal output replays without a 400", async () => {
        const upstreamBodies: Record<string, unknown>[] = [];
        const result = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            if (upstreamBodies.length === 1) {
              return sseResponse([deepSeekStreamChunk({ role: "assistant", refusal }), deepSeekStreamChunk({}, { finish_reason: "stop" }), "data: [DONE]\n\n"]);
            }
            return completion({ role: "assistant", content: "Continuing." });
          },
          async () => {
            const first = await handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: true }));
            assert.equal(first.status, 200);
            const events = parseResponsesSseEvents(await first.text());
            const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
            assert.equal(terminal.type, "response.completed");
            const output = terminal.response.output as Record<string, unknown>[];
            assert.deepEqual(output[0].content, [{ type: "refusal", refusal }]);
            return handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: continuationInput(output), stream: false }));
          }
        );
        assert.equal(result.status, 200);
        const messages = upstreamBodies[1].messages as Record<string, unknown>[];
        assert.deepEqual(messages.at(-2), { role: "assistant", content: refusal });
      });
    } finally {
      if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
      else process.env[envKey] = originalApiKey;
    }
  }));

test("openai: the DeepSeek route accepts the provider's own `thinking` field", async () =>
  runSequence(async (step) => {
    const envKey = "DEEPSEEK_API_KEY";
    const original = process.env[envKey];
    process.env[envKey] = "deepseek-test-key";
    const { handleChatCompletions } = await import("../src/chat/envelope.ts");
    const seen: Record<string, unknown>[] = [];
    const withFetchMock = async <T>(handler: () => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = createFetchMock((_u: unknown, init?: RequestInit) => {
        seen.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
        return Promise.resolve(handler());
      });
      try {
        return await fn();
      } finally {
        globalThis.fetch = originalFetch;
      }
    };
    const ok = (): Response =>
      Response.json({
        id: "c",
        object: "chat.completion",
        created: 1780000000,
        model: "deepseek-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    const post = (extra: Record<string, unknown>): Promise<Response> =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], stream: false, ...extra }),
        })
      );
    try {
      await step("thinking {type:disabled} is accepted and does not reach the wire", async () => {
        seen.length = 0;
        const res = await withFetchMock(ok, () => post({ thinking: { type: "disabled" } }));
        console.log("  thinking disabled -> HTTP", res.status);
        await res.json();
        console.log("  wire reasoning_effort:", seen[0]?.reasoning_effort, "| thinking present:", "thinking" in (seen[0] ?? {}));
        assert.equal(res.status, 200);
        assert.equal(seen[0]?.reasoning_effort, "none");
        assert.equal("thinking" in (seen[0] ?? {}), false);
      });
      await step("thinking {type:enabled} keeps thinking on", async () => {
        seen.length = 0;
        const res = await withFetchMock(ok, () => post({ thinking: { type: "enabled" } }));
        await res.json();
        console.log("  thinking enabled -> HTTP", res.status, "| wire reasoning_effort:", seen[0]?.reasoning_effort);
        assert.equal(res.status, 200);
        assert.equal(seen[0]?.reasoning_effort, "high");
      });
      await step("tool_choice follows the canonical resolved thinking mode", async () => {
        const tools = [{ type: "function", function: { name: "exec", parameters: { type: "object" } } }];

        seen.length = 0;
        const disabled = await withFetchMock(ok, () => post({ thinking: { type: "enabled" }, reasoning_effort: "none", tools, tool_choice: "required" }));
        await disabled.json();
        assert.equal(disabled.status, 200);
        assert.equal(seen[0]?.reasoning_effort, "none");
        assert.equal("thinking" in (seen[0] ?? {}), false);

        seen.length = 0;
        const enabled = await withFetchMock(ok, () => post({ thinking: { type: "disabled" }, reasoning_effort: "max", tools, tool_choice: "required" }));
        assert.equal(enabled.status, 400);
        const error = (await enabled.json()) as { error: { message: string; param: string } };
        assert.equal(error.error.param, "tool_choice");
        assert.match(error.error.message, /tool_choice 'required'/);
        assert.match(error.error.message, /reasoning_effort/);
        assert.equal(seen.length, 0);
      });
      await step("a non-DeepSeek route still rejects `thinking`", async () => {
        const res = await withFetchMock(ok, () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled" } }),
            })
          )
        );
        console.log("  non-deepseek model with thinking -> HTTP", res.status);
        assert.equal(res.status, 400);
      });
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, envKey);
      else process.env[envKey] = original;
    }
  }));

test("openai: one shared completion-validity rule governs the DeepSeek and Cerebras routes", async () =>
  runSequence(async (step) => {
    // The rule itself. A reasoning-only completion reaches the predicate with
    // empty text and no tool calls: the provider's reasoning field (`reasoning`
    // on Cerebras, `reasoning_content` on DeepSeek) is not part of the view.
    assert.equal(isAnswerBearingCompletion({ text: "", toolCallCount: 0 }), false);
    assert.equal(isAnswerBearingCompletion({ text: "", refusal: "", toolCallCount: 0 }), false);
    assert.equal(isAnswerBearingCompletion({ text: "pong", toolCallCount: 0 }), true);
    assert.equal(isAnswerBearingCompletion({ text: "", refusal: "I cannot comply.", toolCallCount: 0 }), true);
    assert.equal(isAnswerBearingCompletion({ text: "", toolCallCount: 1 }), true);

    const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
    const originalCerebrasKey = process.env.CEREBRAS_API_KEY;
    process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
    process.env.CEREBRAS_API_KEY = "cerebras-test-key";
    const chatCompletion = (model: string, message: Record<string, unknown>, finishReason = "stop"): Record<string, unknown> => ({
      id: "shared-validity-rule",
      object: "chat.completion",
      created: 1_780_000_500,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    const messages = [{ role: "user", content: "hi" }];
    try {
      await step("Cerebras: reasoning-only is not answer-bearing and fails closed", async () => {
        const response = await withFetchMock(
          // `content` is absent, so the completion carries reasoning only.
          () => Response.json(chatCompletion("gpt-oss-120b", { role: "assistant", reasoning: "thinking only" })),
          () => handleChatCompletions(specialProviderChatRequest({ model: "gpt-oss-120b", messages, reasoning_effort: "medium" }))
        );
        assert.equal(response.status, 502);
        assert.equal(((await response.json()) as { error?: { code?: string } }).error?.code, "cerebras_upstream_invalid_response");
        assert.equal(getResponseTelemetry(response)?.failureKind, "invalid_completion_schema");
      });

      await step("Cerebras: explicit null content in a budget-stopped reasoning-only completion also fails closed", async () => {
        const response = await withFetchMock(
          () => Response.json(chatCompletion("gpt-oss-120b", { role: "assistant", content: null, reasoning: "thinking only" }, "length")),
          () => handleChatCompletions(specialProviderChatRequest({ model: "gpt-oss-120b", messages, reasoning_effort: "medium" }))
        );
        assert.equal(response.status, 502);
        assert.equal(((await response.json()) as { error?: { code?: string } }).error?.code, "cerebras_upstream_invalid_response");
        assert.equal(getResponseTelemetry(response)?.failureKind, "invalid_completion_schema");
      });

      await step("DeepSeek Chat: reasoning-only is not answer-bearing, an answer is", async () => {
        const reasoningOnly = await withFetchMock(
          () => Response.json(chatCompletion(DEEPSEEK_FLASH_MODEL, { role: "assistant", reasoning_content: "thinking only" })),
          () => handleChatCompletions(specialProviderChatRequest({ model: DEEPSEEK_FLASH_MODEL, messages }))
        );
        await reasoningOnly.json();
        assert.equal(reasoningOnly.status, 200);
        assert.notEqual(getResponseTelemetry(reasoningOnly)?.semanticOutputObserved, true);

        const answered = await withFetchMock(
          () => Response.json(chatCompletion(DEEPSEEK_FLASH_MODEL, { role: "assistant", content: "pong" })),
          () => handleChatCompletions(specialProviderChatRequest({ model: DEEPSEEK_FLASH_MODEL, messages }))
        );
        await answered.json();
        assert.equal(getResponseTelemetry(answered)?.semanticOutputObserved, true);
      });

      await step("DeepSeek Responses: reasoning-only fails closed, an answer completes", async () => {
        const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
          `data: ${JSON.stringify({
            id: "shared-validity-stream",
            object: "chat.completion.chunk",
            created: 1_780_000_501,
            model: DEEPSEEK_FLASH_MODEL,
            choices: [{ index: 0, delta, finish_reason: null, ...extra }],
          })}\n\n`;
        const responsesRequest = (): Request =>
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: true }),
          });
        const reasoningOnly = await withFetchMock(
          () => sseResponse([chunk({ role: "assistant", reasoning_content: "thinking only" }), chunk({}, { finish_reason: "stop" }), "data: [DONE]\n\n"]),
          () => handleResponses(responsesRequest())
        );
        const reasoningText = await reasoningOnly.text();
        assert.match(reasoningText, /"type":"response\.failed"/);
        assert.match(reasoningText, /"code":"empty_upstream_completion"/);
        assert.equal(getResponseTelemetry(reasoningOnly)?.completed, false);

        const answered = await withFetchMock(
          () => sseResponse([chunk({ role: "assistant", content: "pong" }, { finish_reason: "stop" }), "data: [DONE]\n\n"]),
          () => handleResponses(responsesRequest())
        );
        const answeredText = await answered.text();
        assert.match(answeredText, /"type":"response\.completed"/);
        assert.equal(getResponseTelemetry(answered)?.completed, true);
      });
    } finally {
      if (originalDeepSeekKey === undefined) Reflect.deleteProperty(process.env, "DEEPSEEK_API_KEY");
      else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
      if (originalCerebrasKey === undefined) Reflect.deleteProperty(process.env, "CEREBRAS_API_KEY");
      else process.env.CEREBRAS_API_KEY = originalCerebrasKey;
    }
  }));

test("openai: oversized Responses events retain their redacted failure classification", async () => {
  const response = await withFetchMock(
    () => sseResponse([`data: ${"x".repeat(MAX_RESPONSES_SSE_EVENT_BYTES + 1)}\n\n`]),
    () =>
      handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }),
        })
      )
  );
  assert.equal(response.status, 502);
  assert.equal(getResponseTelemetry(response)?.failureKind, "event_too_large");
  assert.equal(getResponseTelemetry(response)?.responseCreatedObserved, false);
  assert.equal(getResponseTelemetry(response)?.syntheticTerminalType, null);
});

test("openai: precommit telemetry records response.created before a malformed event", async () => {
  const response = await withFetchMock(
    () => sseResponse([`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_precommit_malformed" } })}\n\n`, 'data: {"type":\n\n']),
    () =>
      handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }),
        }),
        {
          keyId: null,
          kernelRepo: null,
          kernelOrg: null,
          requestId: "responses-precommit-telemetry",
          startedAtMs: Date.now(),
          startedAtMonotonicMs: performance.now(),
        }
      )
  );
  assert.equal(response.status, 502);
  const telemetry = getResponseTelemetry(response);
  assert.ok(telemetry);
  assert.equal(telemetry.failureKind, "malformed_event");
  assert.equal(telemetry.responseCreatedObserved, true);
  assert.equal(telemetry.syntheticTerminalType, null);
  assert.ok(typeof telemetry.firstUpstreamSseEventMs === "number");
  assert.equal(telemetry.firstSemanticCommitmentMs, null);
  assert.ok(typeof telemetry.streamTerminalMs === "number");
  assert.ok(telemetry.firstUpstreamSseEventMs <= telemetry.streamTerminalMs);
});

test("openai: Chat precommit telemetry separates upstream arrival from semantic commitment", async () => {
  const response = await withFetchMock(
    () => sseResponse([`data: ${JSON.stringify({ type: "response.created", response: { id: "chat_precommit_malformed" } })}\n\n`, 'data: {"type":\n\n']),
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            messages: [{ role: "user", content: "ping" }],
            stream: true,
          }),
        }),
        {
          keyId: null,
          kernelRepo: null,
          kernelOrg: null,
          requestId: "chat-precommit-telemetry",
          startedAtMs: Date.now(),
          startedAtMonotonicMs: performance.now(),
        }
      )
  );
  assert.equal(response.status, 502);
  const telemetry = getResponseTelemetry(response);
  assert.ok(telemetry);
  assert.equal(telemetry.failureKind, "malformed_event");
  assert.ok(typeof telemetry.firstUpstreamSseEventMs === "number");
  assert.equal(telemetry.firstSemanticCommitmentMs, null);
  assert.ok(typeof telemetry.streamTerminalMs === "number");
  assert.ok(telemetry.firstUpstreamSseEventMs <= telemetry.streamTerminalMs);
});

test("openai: streamed Responses force the SSE content type", async () => {
  const response = await withFetchMock(
    () =>
      new Response(sseResponse(baseSseChunks()).body, {
        status: 200,
        headers: {
          "Content-Encoding": "gzip",
          "Content-Length": "12345",
        },
        // Deliberately omit Content-Type to model a compatible upstream that
        // returns valid SSE bytes with an incomplete header set.
      }),
    () =>
      handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_TEST_MODEL,
            input: "ping",
            stream: true,
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.equal(response.headers.get("Content-Length"), null);
  assert.match(await response.text(), /response.completed/);
});

test("openai: invalid route-dependent Responses fields fail before dispatch", async () =>
  runSequence(async (step) => {
    const cases = [
      { param: "max_output_tokens", value: 0 },
      { param: "max_output_tokens", value: 1.5 },
      { param: "max_output_tokens", value: "12" },
      { param: "parallel_tool_calls", value: null },
      { param: "parallel_tool_calls", value: "true" },
      { param: "parallel_tool_calls", value: 1 },
    ] as const;
    for (const scenario of cases) {
      await step(`${scenario.param}=${String(scenario.value)}`, async () => {
        let fetches = 0;
        const response = await withFetchMock(
          () => {
            fetches += 1;
            return sseResponse(baseSseChunks());
          },
          () => handleResponses(responsesRequest({ [scenario.param]: scenario.value }))
        );
        assert.equal(response.status, 400);
        assert.equal(((await response.json()) as { error?: { param?: unknown } }).error?.param, scenario.param);
        assert.equal(fetches, 0);
      });
    }
  }));

test("openai: buffered Responses observe each real or synthetic terminal once", async () =>
  runSequence(async (step) => {
    await step("real response.completed usage", async () => {
      const observations: { completed: boolean; totalTokens: number | null }[] = [];
      const response = await withFetchMock(
        () => sseResponse(baseSseChunks()),
        () =>
          handleResponses(responsesRequest({ stream: false }), {
            keyId: null,
            kernelRepo: null,
            kernelOrg: null,
            onTerminalUsage: (usage, completed) =>
              observations.push({
                completed,
                totalTokens: usage?.totalTokens ?? null,
              }),
          })
      );
      await response.text();
      assert.deepEqual(observations, [{ completed: true, totalTokens: 2 }]);
    });
  }));

test("openai: buffered committed Responses failures use the official server_error code", async () => {
  const response = await withFetchMock(
    () => sseResponse([...baseSseChunks().slice(0, -1), 'data: {"type":\n\n']),
    () => handleResponses(responsesRequest({ stream: false }))
  );
  assert.equal(response.status, 502);
  const payload = (await response.json()) as { error?: { code?: string } };
  assert.equal(payload.error?.code, "server_error");
});

test("auth: kernel attestation tokens are reusable within TTL", async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );

  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const publicPem = toPublicKeyPem(spki);
  kvStore.set(keyToString(["uos_ai", "kernel_pubkeys"]), [{ pem: publicPem }]);

  const bearerToken = "ghs_test_token";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "ubiquity-os-kernel",
    aud: "ai.ubq.fi",
    iat: nowSeconds,
    exp: nowSeconds + 600,
    jti: `jti_${crypto.randomUUID()}`,
    owner: "acme",
    repo: "demo",
    installation_id: null,
    auth_token_sha256: await sha256Base64Url(bearerToken),
    state_id: "state_test",
  };

  const header = { alg: "RS256", typ: "JWT" };
  const headerB64 = encodeJsonBase64Url(header);
  const payloadB64 = encodeJsonBase64Url(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, TEXT_ENCODER.encode(signingInput)));
  const kernelToken = `${signingInput}.${encodeBase64Url(signature)}`;

  const { getKernelAttestationContext } = await import("../src/kernel/attestation.ts");

  const req = new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { "X-Ubiquity-Kernel-Token": kernelToken },
    body: "{}",
  });

  const first = await getKernelAttestationContext(req, bearerToken);
  const second = await getKernelAttestationContext(req, bearerToken);
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(second, first);
});

// ── Admin provider selection ─────────────────────────────────────────────────

test("openai: a switched-off Codex provider with no paid tier fails closed instead of dispatching", async () => {
  await withDiscoveryKeys(null, async () => {
    await withProviderSelection(["deepseek"], async () => {
      const dispatched: string[] = [];
      const response = await withFetchMock(
        (url) => {
          dispatched.push(url);
          throw new Error(`a switched-off provider must not be dispatched to: ${url}`);
        },
        () => handleResponses(responsesRequest({ input: "codex switched off" }))
      );
      assert.deepEqual(dispatched, [], "neither Codex nor a paid tier may be reached");
      assert.equal(response.status, 503);
      const payload = (await response.json()) as { error?: { code?: unknown; type?: unknown } };
      assert.ok(payload.error, "a terminal provider error must carry an error body");
      assert.equal(payload.error.code, "provider_disabled");
      assert.equal(payload.error.type, "server_error");
    });
  });
});

test("openai: a switched-off Codex provider hands the request to the enabled paid tier", async () => {
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  await withDiscoveryKeys("metered-provider-selection-key", async () => {
    try {
      await fetchMeteredModels({
        force: true,
        fetcher: () =>
          Promise.resolve(
            Response.json({
              data: [
                {
                  id: DEFAULT_TEST_MODEL,
                  owned_by: "openlux",
                  supported_endpoint_types: ["openai-response"],
                },
              ],
            })
          ),
      });
      await withProviderSelection(["openlux"], async () => {
        const dispatched: string[] = [];
        const response = await withFetchMock(
          (url) => {
            dispatched.push(url);
            throw new Error(`the Codex transport must be skipped: ${url}`);
          },
          () => handleResponses(responsesRequest({ input: "paid tier only" }))
        );
        assert.deepEqual(dispatched, [], "a disabled Codex provider is not even probed");
        assert.notEqual(response.headers.get("x-uos-upstream"), "chatgpt_codex");
        // The request now needs paid admission, which this fixture deliberately
        // cannot complete: what matters is that only the paid path was selected.
        assert.equal(response.status, 503);
        const payload = (await response.json()) as { error?: { code?: unknown } };
        assert.equal(payload.error?.code, "paid_fallback_invalid_policy");
      });
    } finally {
      resetMeteredModelsCacheForTest();
      resetSurplusModelsCacheForTest();
    }
  });
});

test("openai: an empty provider selection keeps Codex as the primary provider", async () => {
  for (const providerIds of [null, []] as const) {
    let dispatched = 0;
    const response = await withProviderSelection(providerIds, () =>
      withFetchMock(
        () => {
          dispatched += 1;
          return sseResponse(baseSseChunks());
        },
        () => handleResponses(responsesRequest({ input: "no provider filter" }))
      )
    );
    assert.equal(dispatched, 1, `${JSON.stringify(providerIds)}: the Codex transport still runs`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
    await response.text();
  }
});

test("openai: a switched-off DeepSeek provider is not dispatched on the Responses route", async () => {
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  // The following sibling branch resolves OpenRouter's catalogue before it
  // consults the selection; without a key it answers not-served without a fetch.
  Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  try {
    await withDiscoveryKeys(null, async () => {
      await withProviderSelection(["cerebras"], async () => {
        // Both transports take the same gate before transport selection, so one
        // loop covers the buffered and streamed branches without extra nesting.
        for (const stream of [false, true]) {
          const dispatched: string[] = [];
          const response = await withFetchMock(
            (url) => {
              dispatched.push(url);
              throw new Error(`a switched-off DeepSeek provider must not be dispatched to: ${url}`);
            },
            () => handleResponses(deepSeekResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream }))
          );
          assert.deepEqual(dispatched, [], `stream=${stream}: the DeepSeek upstream must not be reached`);
          assert.equal(response.headers.get("x-uos-upstream"), null, `stream=${stream}: the ordinary availability path answers, not the DeepSeek handler`);
          assert.equal(response.status, 404);
          const payload = (await response.json()) as { error?: { code?: unknown; param?: unknown } };
          assert.ok(payload.error, `stream=${stream}: a terminal availability error must carry an error body`);
          assert.equal(payload.error.code, "model_not_found");
          assert.equal(payload.error.param, "model");
        }
      });
    });
  } finally {
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalApiKey === undefined) Reflect.deleteProperty(process.env, "DEEPSEEK_API_KEY");
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
    if (originalOpenRouterApiKey === undefined) Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
    else process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
  }
});

test("openai: a switched-off OpenRouter provider does not refresh a cold catalogue", async () => {
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  resetOpenRouterModelsCacheForTest();
  let catalogueFetches = 0;
  setOpenRouterModelsFetchForTest(() => {
    catalogueFetches += 1;
    return Promise.reject(new Error("a switched-off OpenRouter provider must not refresh its catalogue"));
  });
  try {
    await withDiscoveryKeys(null, async () => {
      await withProviderSelection(["cerebras"], async () => {
        const response = await withFetchMock(
          () => {
            throw new Error("the ordinary availability path must not dispatch an upstream request");
          },
          () => handleResponses(responsesRequest({ model: "vendor/alpha", input: "hi" }))
        );
        assert.equal(catalogueFetches, 0);
        assert.equal(response.status, 404);
        await response.text();
      });
    });
  } finally {
    setOpenRouterModelsFetchForTest(null);
    resetOpenRouterModelsCacheForTest();
    if (originalApiKey === undefined) Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
    else process.env.OPENROUTER_API_KEY = originalApiKey;
  }
});

/** Seeds both paid catalogs for the model the paid-attempt fixtures route. */

test("openai: non-capacity first-tier paid failures fail closed on Surplus", async () =>
  runSequence(async (step) => {
    const originalMeteredApiKey = process.env.METERED_API_KEY;
    const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
    const previousAtomicObserver = atomicCommitObservation.observer;
    const atomicCommits: OpenAiAtomicOp[][] = [];
    const keyIds: string[] = [];
    atomicCommitObservation.observer = (operations) => atomicCommits.push([...operations]);
    const paidRequestKeyFor = (keyId: string, requestId: string) => ["uos_ai", "paid_fallback", "v3", "request", keyId, requestId] as const;

    try {
      process.env.METERED_API_KEY = "metered-fallthrough-test-key";
      process.env.SURPLUS_API_KEY = "surplus-fallthrough-test-key";
      resetProviderHealthThrottleForTest();
      clearMeteredAndSurplusProviderHealth();
      await seedPaidFallthroughProviders();

      const runPaidAttempt = async (
        name: string,
        surplusResponse: (signal: AbortSignal | undefined) => Response | Promise<Response>
      ): Promise<
        Readonly<{
          keyId: string;
          requestId: string;
          status: number;
          upstream: string | null;
          body: string;
          surplusCalls: number;
          meteredCalls: number;
        }>
      > => {
        const keyId = `fallthrough-${name}`;
        const requestId = `request-${keyId}`;
        keyIds.push(keyId);
        seedPaidFallbackKey(keyId);
        let surplusCalls = 0;
        let meteredCalls = 0;
        const response = await withFetchMock(
          (url, _bodyText, init) => {
            if (url === "https://api.surplusintelligence.ai/v1/responses") {
              surplusCalls += 1;
              return surplusResponse(init?.signal ?? undefined);
            }
            if (url === "https://api.openlux.ai/v1/responses") {
              meteredCalls += 1;
              return sseResponse(baseSseChunks());
            }
            return authoritativeCodexQuotaResponse();
          },
          () =>
            handleResponses(responsesRequest({ stream: false }), {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              requestId,
              startedAtMs: Date.now(),
            })
        );
        const body = await response.text();
        return {
          keyId,
          requestId,
          status: response.status,
          upstream: response.headers.get("x-uos-upstream"),
          body,
          surplusCalls,
          meteredCalls,
        };
      };

      await step("a Surplus transport failure fails closed without trying OpenLux", async () => {
        const result = await runPaidAttempt("transport-failure", () => {
          throw new TypeError("network connection reset before response headers");
        });
        assert.equal(result.status, 502);
        assert.equal(result.upstream, "surplus");
        assert.equal(result.surplusCalls, 1);
        assert.equal(result.meteredCalls, 0);
        // The original Surplus transport detail is preserved, and the attempt
        // that reached transport stays a pending ambiguous exposure.
        const payload = JSON.parse(result.body) as { error?: { type?: unknown; code?: unknown } };
        assert.equal(payload.error?.type, "server_error");
        assert.equal(payload.error.code, "surplus_upstream_unreachable");
        const stored = await waitForPaidFallbackTerminal(result.keyId, result.requestId, "ambiguous");
        assert.equal(stored.provider, "surplus");
        assert.equal(stored.dispatch_state, "dispatched");
        assert.equal(stored.provider_request_id, null);
        assert.equal(stored.billing_state, "pending");
      });

      await step("a Surplus 5xx stays delivered and never tries OpenLux", async () => {
        const result = await runPaidAttempt(
          "upstream-5xx",
          () =>
            new Response(JSON.stringify({ error: { message: "surplus exploded", code: "surplus_server_error" } }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            })
        );
        assert.equal(result.status, 503);
        assert.equal(result.upstream, "surplus");
        assert.equal(result.surplusCalls, 1);
        assert.equal(result.meteredCalls, 0);
        const payload = JSON.parse(result.body) as { error?: { type?: unknown; code?: unknown } };
        const error = payload.error ?? {};
        assert.equal(error.type, "server_error");
        assert.equal(error.code, "surplus_server_error");
        const stored = await waitForPaidFallbackTerminal(result.keyId, result.requestId, "failed");
        assert.equal(stored.provider, "surplus");
      });

      await step("a stalled Surplus attempt fails closed at the bounded first-headers deadline", async () => {
        setPaidProviderFirstHeadersDeadlineMsForTest(30);
        try {
          const result = await runPaidAttempt("stalled-headers", (signal) => rejectOnAbort(signal ?? new AbortController().signal));
          assert.equal(result.status, 504);
          assert.equal(result.upstream, "surplus");
          assert.equal(result.surplusCalls, 1);
          assert.equal(result.meteredCalls, 0);
          const payload = JSON.parse(result.body) as { error?: { type?: unknown; code?: unknown } };
          assert.equal(payload.error?.type, "server_error");
          assert.equal(payload.error.code, "gateway_timeout");
          const stored = await waitForPaidFallbackTerminal(result.keyId, result.requestId, "ambiguous");
          assert.equal(stored.provider, "surplus");
          assert.equal(stored.dispatch_state, "dispatched");
          assert.equal(stored.provider_request_id, null);
          assert.equal(stored.billing_state, "pending");
        } finally {
          setPaidProviderFirstHeadersDeadlineMsForTest(null);
        }
      });

      await step("a definitive Surplus 400 stays delivered and never tries OpenLux", async () => {
        const result = await runPaidAttempt(
          "definitive-400",
          () =>
            new Response(JSON.stringify({ error: { message: "surplus rejected the request body", code: "surplus_bad_request" } }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            })
        );
        assert.equal(result.status, 400);
        assert.equal(result.upstream, "surplus");
        assert.equal(result.surplusCalls, 1);
        assert.equal(result.meteredCalls, 0);
        const payload = JSON.parse(result.body) as { error?: { type?: unknown; code?: unknown } };
        const error = payload.error ?? {};
        assert.equal(error.type, "invalid_request_error");
        assert.equal(error.code, "surplus_bad_request");
        const stored = await waitForPaidFallbackTerminal(result.keyId, result.requestId, "failed");
        assert.equal(stored.provider, "surplus");
      });

      await step("every failed paid reservation records exactly one terminal provider pair", () => {
        for (const keyId of keyIds) {
          const terminalWrites = atomicWritesForKey(atomicCommits, paidRequestKeyFor(keyId, `request-${keyId}`)).filter((operation) => {
            const value = operation.value;
            if (typeof value !== "object" || value === null) return false;
            const state = (value as { terminal_state?: unknown }).terminal_state;
            return typeof state === "string" && state !== "pending";
          });
          assert.equal(terminalWrites.length, 1, `${keyId} terminal provider/request-id pair`);
        }
      });

      await step("delivered Surplus headers release the attempt deadline before slow health bookkeeping", async () => {
        const originalAtomic = kvStub.atomic.bind(kvStub);
        let attemptSignal: AbortSignal | undefined;
        let healthDelayMs = 0;
        let abortedDuringHealth: boolean | undefined;
        let bodyAborted = false;
        let deliverBody = () => {};
        const delayHealth = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
        resetProviderHealthThrottleForTest();
        setPaidProviderFirstHeadersDeadlineMsForTest(30);
        kvStub.atomic = () => {
          const operation = originalAtomic();
          const originalSet = operation.set.bind(operation);
          const originalCommit = operation.commit.bind(operation);
          let slowHealthCommit = false;
          operation.set = (key, value, options) => {
            if (key[1] === "provider_health" && key[3] === "surplus" && key[5] === "reachable") slowHealthCommit = true;
            return originalSet(key, value, options);
          };
          operation.commit = async () => {
            if (slowHealthCommit) {
              const startedAtMs = performance.now();
              await delayHealth();
              healthDelayMs = performance.now() - startedAtMs;
              abortedDuringHealth = attemptSignal?.aborted;
              deliverBody();
            }
            return await originalCommit();
          };
          return operation;
        };
        try {
          const result = await runPaidAttempt("headers-before-slow-health", (signal) => {
            assert.ok(signal);
            assert.equal(signal.aborted, false, "headers arrived before the attempt deadline");
            attemptSignal = signal;
            let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
            const onAbort = () => {
              bodyAborted = true;
              bodyController?.error(signal.reason);
            };
            deliverBody = () => {
              signal.removeEventListener("abort", onAbort);
              if (bodyAborted) return;
              assert.ok(bodyController);
              for (const chunk of baseSseChunks()) bodyController.enqueue(TEXT_ENCODER.encode(chunk));
              bodyController.close();
            };
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                bodyController = controller;
              },
            });
            signal.addEventListener("abort", onAbort, { once: true });
            return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
          });
          assert.ok(healthDelayMs > 30, "health bookkeeping remained pending beyond the 30 ms headers deadline");
          assert.equal(abortedDuringHealth, false, "the headers deadline cannot abort a delivered body during bookkeeping");
          assert.equal(bodyAborted, false);
          assert.equal(result.status, 200);
          assert.equal(result.upstream, "surplus");
          assert.equal(result.surplusCalls, 1);
          assert.equal(result.meteredCalls, 0);
          const payload = JSON.parse(result.body) as { output?: { status?: unknown; content?: { text?: unknown }[] }[] };
          const output = payload.output?.at(-1);
          assert.ok(output);
          assert.equal(output.status, "completed");
          const content = output.content?.at(0);
          assert.ok(content);
          assert.equal(content.text, "pong");
          await waitForPaidFallbackTerminal(result.keyId, result.requestId, "completed");
        } finally {
          kvStub.atomic = originalAtomic;
          setPaidProviderFirstHeadersDeadlineMsForTest(null);
        }
      });
    } finally {
      atomicCommitObservation.observer = previousAtomicObserver;
      setPaidProviderFirstHeadersDeadlineMsForTest(null);
      resetMeteredModelsCacheForTest();
      resetSurplusModelsCacheForTest();
      resetProviderHealthThrottleForTest();
      clearMeteredAndSurplusProviderHealth();
      for (const keyId of keyIds) {
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
      }
      if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
      else process.env.METERED_API_KEY = originalMeteredApiKey;
      if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
      else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
    }
  }));

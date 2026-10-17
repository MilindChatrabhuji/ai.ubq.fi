import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 10 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "../src/inference-deadline.ts";
import { deepSeekChatBodyDiagnostic } from "../src/upstream-wire.ts";
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_V4_FLASH_MODEL,
  Deferred,
  TEXT_ENCODER,
  deepSeekResponsesRequest,
  deepSeekStreamChunk,
  getResponseTelemetry,
  handleChatCompletions,
  handleResponses,
  parseResponsesSseEvents,
  rejectOnAbort,
  setDeepSeekFetchTimeoutMsForTest,
  specialProviderChatRequest,
  specialProviderResponsesRequest,
  sseResponse,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";

test("openai: DeepSeek official Chat Completions adapter streams natively and stays content-safe", async () =>
  runSequence(async (step) => {
    const envKey = "DEEPSEEK_API_KEY";
    const fakeApiKey = "deepseek-test-key";
    const originalApiKey = process.env[envKey];
    const restoreApiKey = (): void => {
      if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
      else process.env[envKey] = originalApiKey;
    };
    const request = specialProviderChatRequest;
    const messages = [
      { role: "developer", content: "Answer in one short sentence." },
      { role: "user", content: "Summarize the deployment status." },
    ];
    // The DeepSeek Chat wire projection translates the caller's developer message
    // to the provider's system role. `messages` stays the caller's own request
    // fixture; only the expected upstream bodies use this projected wire form.
    const wireMessages = [{ role: "system", content: "Answer in one short sentence." }, ...messages.slice(1)];
    const tools = [
      {
        type: "function",
        function: {
          name: "assistant_message",
          description: "Return the assistant response envelope.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      },
    ];
    const canonicalBody = {
      model: DEEPSEEK_V4_FLASH_MODEL,
      messages,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning_effort: "high",
      temperature: 0,
      max_completion_tokens: 2048,
      stream: false,
    };
    const completion = (id: string, message: Record<string, unknown>): Record<string, unknown> => ({
      id,
      object: "chat.completion",
      created: 1_780_000_000,
      model: DEEPSEEK_FLASH_MODEL,
      choices: [{ index: 0, message, finish_reason: "stop" }],
      // Provider-only cache and fingerprint fields must never reach the client.
      system_fingerprint: "fp_deepseek_provider_only",
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 11 },
    });
    const streamChunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: "deepseek-stream-1",
      object: "chat.completion.chunk",
      created: 1_780_000_001,
      model: DEEPSEEK_FLASH_MODEL,
      choices: [{ index: 0, delta, finish_reason: null, ...extra }],
    });
    const dataFrames = (text: string): Record<string, unknown>[] =>
      text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
        .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
    const usageContext = (requestId: string) => ({
      keyId: null,
      kernelRepo: null,
      kernelOrg: null,
      requestId,
      startedAtMs: Date.now(),
      startedAtMonotonicMs: performance.now(),
    });

    process.env[envKey] = fakeApiKey;
    try {
      await step("routes the interchangeable alias to the official endpoint and projects the documented wire contract", async () => {
        const upstreamCalls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
        const response = await withFetchMock(
          (url, bodyText, init) => {
            upstreamCalls.push({ url, body: JSON.parse(String(bodyText)) as Record<string, unknown>, headers: new Headers(init?.headers) });
            return Response.json(
              completion("deepseek-completion-1", {
                role: "assistant",
                content: "Deployment is green.",
                reasoning_content: "Checked the release identity first.",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "assistant_message", arguments: '{"message":"ok"}' } }],
              }),
              { headers: { "Content-Type": "application/json", "X-Request-Id": "deepseek-header-request-1" } }
            );
          },
          () => handleChatCompletions(request(canonicalBody), usageContext("deepseek-buffered-success"))
        );
        assert.equal(response.status, 200);
        assert.equal(upstreamCalls.length, 1);
        assert.equal(upstreamCalls[0].url, DEEPSEEK_CHAT_COMPLETIONS_URL);
        assert.equal(upstreamCalls[0].headers.get("authorization"), `Bearer ${fakeApiKey}`);
        // The legacy alias reaches the API as the model it actually serves, and
        // the OpenAI output cap becomes DeepSeek's documented `max_tokens`.
        assert.deepEqual(upstreamCalls[0].body, {
          model: DEEPSEEK_FLASH_MODEL,
          messages: wireMessages,
          tools,
          tool_choice: "auto",
          parallel_tool_calls: false,
          reasoning_effort: "high",
          temperature: 0,
          max_tokens: 2048,
          stream: false,
        });

        assert.equal(response.headers.get("x-uos-upstream"), "deepseek");
        assert.equal(response.headers.get("x-uos-provider-request-id"), "deepseek-header-request-1");
        assert.equal(response.headers.get("x-uos-warning"), null);
        assert.deepEqual(await response.json(), {
          id: "deepseek-completion-1",
          object: "chat.completion",
          created: 1_780_000_000,
          model: DEEPSEEK_FLASH_MODEL,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Deployment is green.",
                reasoning_content: "Checked the release identity first.",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "assistant_message", arguments: '{"message":"ok"}' } }],
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 0 } },
        });

        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.provider, "deepseek");
        assert.equal(telemetry.providerRequestId, "deepseek-header-request-1");
        assert.equal(telemetry.reasoning, "high");
        assert.equal(telemetry.inputTokens, 11);
        // The provider's cache counter reaches gateway telemetry as a cache read,
        // not as a zero: the reported field is the measurement, and an explicit
        // provider zero stays a reported zero.
        assert.equal(telemetry.cachedInputTokens, 0);
        assert.equal(telemetry.usageTelemetryStatus, "reported");
        assert.equal(telemetry.outputTokens, 7);
        assert.equal(telemetry.completed, true);
        assert.equal(telemetry.stream, false);
        assert.deepEqual(telemetry.attemptedProviders, ["deepseek"]);
        assert.equal(telemetry.failureKind, null);
        assert.equal(typeof telemetry.firstProviderDispatchMs, "number");
        assert.equal(typeof telemetry.firstProviderHeadersMs, "number");
      });

      await step("publishes the provider cache-read counter instead of dropping it", async () => {
        const cachedCompletion = (usage: Record<string, unknown>): Record<string, unknown> => ({
          id: "deepseek-completion-cache",
          object: "chat.completion",
          created: 1_780_000_002,
          model: DEEPSEEK_FLASH_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "cached" }, finish_reason: "stop" }],
          usage,
        });
        const response = await withFetchMock(
          () =>
            Response.json(
              cachedCompletion({
                prompt_tokens: 100,
                completion_tokens: 5,
                total_tokens: 105,
                prompt_cache_hit_tokens: 90,
                prompt_cache_miss_tokens: 10,
              })
            ),
          () => handleChatCompletions(request({ model: DEEPSEEK_FLASH_MODEL, messages, stream: false }), usageContext("deepseek-cache-read"))
        );
        assert.equal(response.status, 200);
        // The provider-only name never reaches the client; the measurement does,
        // under the official Chat Completions cache-read field.
        assert.deepEqual(((await response.json()) as Record<string, unknown>).usage, {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 90 },
        });
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.inputTokens, 100);
        assert.equal(telemetry.cachedInputTokens, 90);
        assert.equal(telemetry.usageTelemetryStatus, "reported");
      });

      await step("reports an absent provider cache counter as unknown instead of as a measured zero", async () => {
        const response = await withFetchMock(
          () =>
            Response.json({
              id: "deepseek-completion-no-cache",
              object: "chat.completion",
              created: 1_780_000_003,
              model: DEEPSEEK_FLASH_MODEL,
              choices: [{ index: 0, message: { role: "assistant", content: "uncounted" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
            }),
          () => handleChatCompletions(request({ model: DEEPSEEK_FLASH_MODEL, messages, stream: false }), usageContext("deepseek-cache-absent"))
        );
        assert.equal(response.status, 200);
        assert.deepEqual(((await response.json()) as Record<string, unknown>).usage, {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
        });
        const telemetry = getResponseTelemetry(response);
        assert.ok(telemetry);
        assert.equal(telemetry.cachedInputTokens, null);
        assert.equal(telemetry.usageTelemetryStatus, "partial");
      });

      await step("defaults omitted reasoning to the documented official default without inventing other fields", async () => {
        let forwarded: Record<string, unknown> | null = null;
        const response = await withFetchMock(
          (_url, bodyText) => {
            forwarded = JSON.parse(String(bodyText)) as Record<string, unknown>;
            return Response.json(completion("deepseek-completion-2", { role: "assistant", content: "ok" }));
          },
          () => handleChatCompletions(request({ model: DEEPSEEK_FLASH_MODEL, messages, stream: false }))
        );
        assert.equal(response.status, 200);
        assert.deepEqual(forwarded, { model: DEEPSEEK_FLASH_MODEL, messages: wireMessages, stream: false, reasoning_effort: "high" });
        assert.equal(getResponseTelemetry(response)?.reasoning, "high");
      });

      await step("records a truncated buffered completion as an incomplete terminal", async () => {
        // The provider's `finish_reason: "length"` reaches the client as
        // `status: "incomplete"` with the official reason, and telemetry records
        // the same terminal rather than assuming success.
        const response = await withFetchMock(
          () =>
            Response.json({
              id: "deepseek-truncated-1",
              object: "chat.completion",
              created: 1_780_000_000,
              model: DEEPSEEK_FLASH_MODEL,
              choices: [{ index: 0, message: { role: "assistant", content: "cut off mid-sentence" }, finish_reason: "length" }],
              usage: { prompt_tokens: 11, completion_tokens: 8192, total_tokens: 8203 },
            }),
          () =>
            handleResponses(
              specialProviderResponsesRequest({ model: DEEPSEEK_FLASH_MODEL, input: "write forever", stream: false }),
              usageContext("deepseek-truncated-buffered")
            )
        );
        assert.equal(response.status, 200);
        const payload = (await response.json()) as Record<string, unknown>;
        assert.equal(payload.status, "incomplete");
        assert.deepEqual(payload.incomplete_details, { reason: "max_output_tokens" });
        const telemetry = getResponseTelemetry(response);
        assert.ok(telemetry);
        assert.equal(telemetry.streamTerminalType, "response.incomplete");
        assert.equal(telemetry.failureKind, "incomplete_response");
        assert.equal(telemetry.outputTokens, 8192);
      });

      await step("rejects a thinking-mode tool_choice at the boundary without dispatching upstream", async () => {
        // The provider answers HTTP 400 "Thinking mode does not support this
        // tool_choice" for `required` and the named-function form while thinking
        // is active. The request is refused here, so no upstream call is made and
        // the client sees an error naming both conflicting fields.
        let upstreamCalls = 0;
        const required = await withFetchMock(
          () => {
            upstreamCalls += 1;
            return Response.json(completion("deepseek-should-not-be-called", { role: "assistant", content: "ok" }));
          },
          () =>
            handleChatCompletions(request({ model: DEEPSEEK_FLASH_MODEL, messages, tools, tool_choice: "required", reasoning_effort: "high", stream: false }))
        );
        assert.equal(required.status, 400);
        const requiredError = ((await required.json()) as { error: { message: string; param: string; type: string } }).error;
        assert.equal(requiredError.type, "invalid_request_error");
        assert.equal(requiredError.param, "tool_choice");
        assert.match(requiredError.message, /tool_choice 'required'/);
        assert.match(requiredError.message, /reasoning_effort/);

        const named = await withFetchMock(
          () => {
            upstreamCalls += 1;
            return Response.json(completion("deepseek-should-not-be-called", { role: "assistant", content: "ok" }));
          },
          () =>
            handleChatCompletions(
              request({
                model: DEEPSEEK_FLASH_MODEL,
                messages,
                tools,
                tool_choice: { type: "function", function: { name: "assistant_message" } },
                stream: false,
              })
            )
        );
        assert.equal(named.status, 400);
        const namedError = ((await named.json()) as { error: { message: string; param: string } }).error;
        assert.equal(namedError.param, "tool_choice");
        assert.match(namedError.message, /tool_choice 'function:assistant_message'/);
        // The rejected requests never reached the provider.
        assert.equal(upstreamCalls, 0);
      });

      await step("serves required tool_choice when thinking mode is disabled", async () => {
        // `reasoning_effort: "none"` disables thinking mode, so the same request
        // is dispatched normally and the provider's own answer is relayed.
        const upstreamCalls: Record<string, unknown>[] = [];
        const response = await withFetchMock(
          (_url, bodyText) => {
            upstreamCalls.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            return Response.json(completion("deepseek-thinking-off", { role: "assistant", content: "ok" }));
          },
          () =>
            handleChatCompletions(request({ model: DEEPSEEK_FLASH_MODEL, messages, tools, tool_choice: "required", reasoning_effort: "none", stream: false }))
        );
        assert.equal(response.status, 200);
        assert.equal(upstreamCalls.length, 1);
        assert.equal(upstreamCalls[0].tool_choice, "required");
        assert.equal(upstreamCalls[0].reasoning_effort, "none");
      });

      await step("relays upstream SSE chunks, keep-alive comments and [DONE] without downgrading the stream", async () => {
        const upstreamCalls: { url: string; body: Record<string, unknown> }[] = [];
        const upstreamFrames = [
          ": keep-alive\n\n",
          `data: ${JSON.stringify(streamChunk({ role: "assistant", reasoning_content: "Considering" }))}\n\n`,
          `data: ${JSON.stringify(streamChunk({ content: "Green" }))}\n\n`,
          `data: ${JSON.stringify({
            ...streamChunk({}, { finish_reason: "stop" }),
            // DeepSeek rides usage on the final content chunk rather than a
            // separate usage-only frame.
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_cache_hit_tokens: 0 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ];
        const response = await withFetchMock(
          (url, bodyText) => {
            upstreamCalls.push({ url, body: JSON.parse(String(bodyText)) as Record<string, unknown> });
            return sseResponse(upstreamFrames);
          },
          () =>
            handleChatCompletions(
              request({ model: DEEPSEEK_V4_FLASH_MODEL, messages, reasoning_effort: "high", stream: true }),
              usageContext("deepseek-stream")
            )
        );

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Content-Type"), "text/event-stream");
        assert.equal(response.headers.get("x-uos-upstream"), "deepseek");
        // Native streaming is not a downgrade: no buffered-replay warning.
        assert.equal(response.headers.get("x-uos-warning"), null);
        assert.deepEqual(upstreamCalls, [
          {
            url: DEEPSEEK_CHAT_COMPLETIONS_URL,
            body: { model: DEEPSEEK_FLASH_MODEL, messages: wireMessages, reasoning_effort: "high", stream: true, stream_options: { include_usage: true } },
          },
        ]);

        const text = await response.text();
        const frames = text.split("\n\n").filter((frame) => frame.length > 0);
        assert.equal(frames[0], ": keep-alive");
        assert.equal(frames.at(-1), "data: [DONE]");
        assert.deepEqual(dataFrames(text), [
          {
            id: "deepseek-stream-1",
            object: "chat.completion.chunk",
            created: 1_780_000_001,
            model: DEEPSEEK_FLASH_MODEL,
            choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Considering" }, finish_reason: null }],
          },
          {
            id: "deepseek-stream-1",
            object: "chat.completion.chunk",
            created: 1_780_000_001,
            model: DEEPSEEK_FLASH_MODEL,
            choices: [{ index: 0, delta: { content: "Green" }, finish_reason: null }],
          },
          {
            id: "deepseek-stream-1",
            object: "chat.completion.chunk",
            created: 1_780_000_001,
            model: DEEPSEEK_FLASH_MODEL,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 0 } },
          },
        ]);

        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.provider, "deepseek");
        assert.equal(telemetry.stream, true);
        assert.equal(typeof telemetry.firstUpstreamSseEventMs, "number");
        assert.equal(typeof telemetry.firstSemanticCommitmentMs, "number");
        assert.equal(telemetry.semanticOutputObserved, true);
        assert.equal(telemetry.streamTerminalType, "response.completed");
        assert.equal(telemetry.inputTokens, 11);
        assert.equal(telemetry.outputTokens, 7);
        assert.equal(telemetry.completed, true);
      });

      await step("delivers the first client-visible frame before the upstream stream ends", async () => {
        let releaseUpstream = (): void => {};
        const gate = new Promise<void>((resolve) => {
          releaseUpstream = resolve;
        });
        const firstFrame = `data: ${JSON.stringify(streamChunk({ role: "assistant", content: "Ready" }))}\n\n`;
        const upstream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(TEXT_ENCODER.encode(firstFrame));
            await gate;
            controller.enqueue(TEXT_ENCODER.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });

        const observed = await withFetchMock(
          () => new Response(upstream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
          async () => {
            const response = await handleChatCompletions(request({ model: DEEPSEEK_FLASH_MODEL, messages, stream: true }));
            const reader = response.body?.getReader();
            assert.ok(reader);
            const first = await reader.read();
            const firstText = first.value ? new TextDecoder().decode(first.value) : "";
            releaseUpstream();
            let rest = "";
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              rest += new TextDecoder().decode(next.value);
            }
            return { status: response.status, firstText, rest };
          }
        );

        assert.equal(observed.status, 200);
        // The first frame is readable while the upstream response is still open.
        assert.equal(observed.firstText, firstFrame);
        assert.equal(observed.rest, "data: [DONE]\n\n");
      });

      await step("keeps a producing stream alive past the buffered deadline", async () => {
        const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
        const bufferedDeadline = new AbortController();
        const deadlineTimer = setTimeout(() => bufferedDeadline.abort(new DOMException("buffered deadline", "TimeoutError")), 20);
        const firstFrame = `data: ${JSON.stringify(streamChunk({ content: "first" }))}\n\n`;
        const secondFrame = `data: ${JSON.stringify(streamChunk({ content: "second" }, { finish_reason: "stop" }))}\n\n`;
        let cancelled = false;
        const upstream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(TEXT_ENCODER.encode(firstFrame));
            await new Promise<void>((resolve) => setTimeout(resolve, 60));
            if (cancelled) return;
            controller.enqueue(TEXT_ENCODER.encode(`${secondFrame}data: [DONE]\n\n`));
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        });

        (AbortSignal as unknown as { timeout: (milliseconds: number) => AbortSignal }).timeout = (milliseconds) =>
          milliseconds === BUFFERED_INFERENCE_DEADLINE_MS ? bufferedDeadline.signal : originalTimeout(milliseconds);
        try {
          const response = await withFetchMock(
            () => new Response(upstream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
            () => handleChatCompletions(request({ model: DEEPSEEK_FLASH_MODEL, messages, stream: true }))
          );
          assert.equal(response.status, 200);
          assert.equal(await response.text(), `${firstFrame}${secondFrame}data: [DONE]\n\n`);
          assert.equal(bufferedDeadline.signal.aborted, true, "the producing stream must outlive the simulated buffered deadline");
          // The stream path must not install the buffered signal; its reader's
          // first-event watchdog becomes renewable inactivity instead.
        } finally {
          clearTimeout(deadlineTimer);
          (AbortSignal as unknown as { timeout: (milliseconds: number) => AbortSignal }).timeout = originalTimeout;
        }
      });

      await step("forwards the bounded upstream error without relaying unlisted provider headers", async () => {
        const response = await withFetchMock(
          () =>
            Response.json(
              { error: { message: "Rate limit reached for requests", code: "rate_limit_reached", provider_debug_marker: "must-not-be-relayed" } },
              {
                status: 429,
                headers: {
                  "Content-Type": "application/json",
                  "Retry-After": "17",
                  "X-Request-Id": "deepseek-error-request-1",
                  // DeepSeek documents no capacity headers; a passthrough would
                  // be inventing a contract the provider does not publish.
                  "x-ratelimit-limit-requests-minute": "2500",
                },
              }
            ),
          () => handleChatCompletions(request(canonicalBody))
        );

        assert.equal(response.status, 429);
        assert.equal(response.headers.get("x-uos-upstream"), "deepseek");
        assert.equal(response.headers.get("x-uos-provider-request-id"), "deepseek-error-request-1");
        assert.equal(response.headers.get("Retry-After"), "17");
        assert.equal(response.headers.get("x-ratelimit-limit-requests-minute"), null);
        const payload = (await response.json()) as { error?: { message?: string; type?: string; code?: string } };
        assert.equal(payload.error?.code, "rate_limit_reached");
        assert.equal(payload.error.message, "Rate limit reached for requests");
        assert.equal(payload.error.type, "rate_limit_error");
        assert.doesNotMatch(JSON.stringify(payload), /provider_debug_marker/);
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.failureKind, "upstream_http_error");
        assert.deepEqual(telemetry.attemptedProviders, ["deepseek"]);
      });

      await step("logs the bounded diagnostic of the serialized projected dispatch body", async () => {
        const privateMarker = "private-diagnostic-payload";
        const privateMessages = [
          { role: "developer", content: privateMarker },
          { role: "user", content: privateMarker },
          {
            role: "assistant",
            content: null,
            reasoning_content: privateMarker,
            tool_calls: [{ id: privateMarker, type: "function", function: { name: privateMarker, arguments: privateMarker } }],
          },
          { role: "tool", tool_call_id: privateMarker, content: privateMarker },
        ];
        for (const testCase of [
          { model: DEEPSEEK_V4_FLASH_MODEL, reasoning_effort: "ultra", max_completion_tokens: 321, stream: false },
          { model: DEEPSEEK_FLASH_MODEL, reasoning_effort: "none", stream: true },
        ]) {
          const logs: unknown[][] = [];
          const originalConsoleWarn = console.warn;
          let wireBody: Record<string, unknown> | null = null;
          console.warn = (...args: unknown[]) => {
            logs.push(args);
          };
          try {
            const response = await withFetchMock(
              (_url, bodyText) => {
                wireBody = JSON.parse(String(bodyText)) as Record<string, unknown>;
                return Response.json({ error: { message: "Synthetic provider failure", code: "invalid_request" } }, { status: 400 });
              },
              () =>
                handleChatCompletions(
                  request({
                    ...testCase,
                    messages: privateMessages,
                    tools: [{ type: "function", function: { name: privateMarker, description: privateMarker, parameters: { type: "object" } } }],
                  })
                )
            );
            assert.equal(response.status, 400);
            await response.json();
          } finally {
            console.warn = originalConsoleWarn;
          }
          assert.ok(wireBody);
          const diagnosticLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] deepseek_upstream_error");
          assert.equal(diagnosticLogs.length, 1);
          const diagnostic = JSON.parse(String(diagnosticLogs[0][1])) as { request: Record<string, unknown> };
          assert.deepEqual(diagnostic.request, deepSeekChatBodyDiagnostic(wireBody));
          assert.equal(diagnostic.request.model, DEEPSEEK_FLASH_MODEL);
          assert.equal(diagnostic.request.max_tokens, testCase.max_completion_tokens ?? null);
          assert.equal(diagnostic.request.reasoning_effort, testCase.reasoning_effort === "ultra" ? "max" : "none");
          assert.equal((diagnostic.request.messages as { role: string }[])[0].role, "system");
          assert.doesNotMatch(JSON.stringify(logs), new RegExp(`${privateMarker}|${fakeApiKey}`));
        }
        assert.equal(privateMessages[0].role, "developer");
      });

      await step("keeps the generic error when the upstream failure body is not JSON", async () => {
        const response = await withFetchMock(
          () => new Response("<html>provider-only-body</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
          () => handleChatCompletions(request(canonicalBody))
        );
        assert.equal(response.status, 502);
        assert.equal(response.headers.get("x-uos-upstream"), "deepseek");
        const payload = (await response.json()) as { error?: { message?: string; code?: string } };
        assert.equal(payload.error?.code, "deepseek_upstream_error");
        assert.equal(payload.error.message, "DeepSeek upstream returned an error.");
        assert.doesNotMatch(JSON.stringify(payload), /provider-only-body/);
      });

      await step("rejects a missing server credential without provider dispatch", async () => {
        Reflect.deleteProperty(process.env, envKey);
        try {
          let dispatchCalls = 0;
          const response = await withFetchMock(
            () => {
              dispatchCalls += 1;
              throw new Error("a missing DeepSeek credential must not dispatch");
            },
            () => handleChatCompletions(request(canonicalBody))
          );
          assert.equal(dispatchCalls, 0);
          assert.equal(response.status, 503);
          assert.equal(response.headers.get("x-uos-upstream"), "deepseek");
          assert.equal(((await response.json()) as { error?: { code?: string } }).error?.code, "deepseek_api_key_missing");
          assert.equal(getResponseTelemetry(response)?.failureKind, "deepseek_api_key_missing");
          assert.deepEqual(getResponseTelemetry(response)?.attemptedProviders, []);
        } finally {
          process.env[envKey] = fakeApiKey;
        }
      });

      await step("routes every published DeepSeek id to the official provider and nothing else", async () => {
        for (const model of ["deepseek-v4-pro", "deepseek-v4-flash"]) {
          const urls: string[] = [];
          const response = await withFetchMock(
            (url) => {
              urls.push(url);
              if (url !== DEEPSEEK_CHAT_COMPLETIONS_URL) {
                throw new Error(`unexpected upstream request for ${model}: ${url}`);
              }
              return Promise.resolve(
                Response.json({
                  id: "chatcmpl-deepseek-published",
                  object: "chat.completion",
                  created: 1_800_000_000,
                  model,
                  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                })
              );
            },
            () => handleChatCompletions(request({ model, messages, stream: false }))
          );
          assert.equal(response.status, 200, model);
          assert.deepEqual(urls, [DEEPSEEK_CHAT_COMPLETIONS_URL], model);
          assert.deepEqual(getResponseTelemetry(response)?.attemptedProviders, ["deepseek"], model);
          await response.arrayBuffer();
        }
      });

      await step("classifies malformed, truncated, and invalid buffered payloads without reflecting provider content", async () => {
        const truncated = await withFetchMock(
          () => sseResponse([`data: ${JSON.stringify(streamChunk({ content: "partial" }))}\n\n`, 'data: {"id":"deepseek-broken"\n\n']),
          () => handleChatCompletions(request({ model: DEEPSEEK_FLASH_MODEL, messages, stream: true }))
        );
        assert.equal(truncated.status, 200);
        const truncatedText = await truncated.text();
        assert.match(truncatedText, /"code":"deepseek_upstream_stream_error"/);
        assert.doesNotMatch(truncatedText, /deepseek-broken/);
        assert.equal(getResponseTelemetry(truncated)?.streamTerminalType, "error");
        assert.equal(getResponseTelemetry(truncated)?.failureKind, "invalid_json");

        const prematureEof = await withFetchMock(
          () => sseResponse([`data: ${JSON.stringify(streamChunk({ content: "partial" }))}\n\n`]),
          () => handleChatCompletions(request({ model: DEEPSEEK_FLASH_MODEL, messages, stream: true }))
        );
        assert.equal(prematureEof.status, 200);
        await prematureEof.text();
        assert.equal(getResponseTelemetry(prematureEof)?.failureKind, "incomplete_response");
        assert.equal(getResponseTelemetry(prematureEof)?.streamTerminalType, "eof");

        const invalidBuffered = await withFetchMock(
          () => new Response("{not json", { status: 200, headers: { "Content-Type": "application/json" } }),
          () => handleChatCompletions(request(canonicalBody))
        );
        assert.equal(invalidBuffered.status, 502);
        assert.equal(invalidBuffered.headers.get("x-uos-upstream"), "deepseek");
        assert.equal(((await invalidBuffered.json()) as { error?: { code?: string } }).error?.code, "deepseek_upstream_invalid_response");
        assert.equal(getResponseTelemetry(invalidBuffered)?.failureKind, "invalid_json");
      });

      await step("rejects an invalid upstream chunk schema without reflecting provider content", async () => {
        const response = await withFetchMock(
          () =>
            sseResponse([
              `data: ${JSON.stringify({ id: "deepseek-invalid-chunk", object: "chat.completion.chunk", created: 1, model: DEEPSEEK_FLASH_MODEL, choices: [{ index: 0, delta: { content: 5 } }] })}\n\n`,
            ]),
          () => handleChatCompletions(request({ model: DEEPSEEK_FLASH_MODEL, messages, stream: true }))
        );
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.deepEqual(dataFrames(text), [
          { error: { message: "Upstream Chat Completions stream failed.", type: "server_error", code: "deepseek_upstream_stream_error", param: null } },
        ]);
        assert.doesNotMatch(text, /deepseek-invalid-chunk/);
        assert.equal(getResponseTelemetry(response)?.failureKind, "invalid_stream_chunk");
      });

      await step("bounds a pre-header timeout and forwards downstream cancellation", async () => {
        setDeepSeekFetchTimeoutMsForTest(10);
        try {
          let timeoutCalls = 0;
          const timeoutResponse = await withFetchMock(
            (url, _body, init) => {
              timeoutCalls += 1;
              assert.equal(url, DEEPSEEK_CHAT_COMPLETIONS_URL);
              const signal = init?.signal;
              if (!signal) return Promise.reject(new Error("DeepSeek request did not receive a cancellation signal"));
              return rejectOnAbort(signal);
            },
            () => handleChatCompletions(request(canonicalBody))
          );
          assert.equal(timeoutCalls, 1);
          assert.equal(timeoutResponse.status, 504);
          assert.equal(timeoutResponse.headers.get("x-uos-upstream"), "deepseek");
          assert.equal(((await timeoutResponse.json()) as { error?: { code?: string } }).error?.code, "gateway_timeout");
          assert.equal(getResponseTelemetry(timeoutResponse)?.streamTerminalType, "deadline");
          assert.equal(getResponseTelemetry(timeoutResponse)?.failureKind, "deadline");
        } finally {
          setDeepSeekFetchTimeoutMsForTest(null);
        }

        const controller = new AbortController();
        let downstreamAbortObserved = false;
        let cancellationCalls = 0;
        const cancelledResponse = await withFetchMock(
          (url, _body, init) => {
            cancellationCalls += 1;
            assert.equal(url, DEEPSEEK_CHAT_COMPLETIONS_URL);
            const signal = init?.signal;
            if (!signal) return Promise.reject(new Error("DeepSeek request did not receive a cancellation signal"));
            const pending = rejectOnAbort(signal, () => {
              downstreamAbortObserved = true;
            });
            controller.abort(new DOMException("client disconnected", "AbortError"));
            return pending;
          },
          () => handleChatCompletions(request(canonicalBody, controller.signal))
        );
        assert.equal(cancellationCalls, 1);
        assert.equal(downstreamAbortObserved, true);
        assert.equal(cancelledResponse.status, 499);
        assert.equal(cancelledResponse.headers.get("x-uos-upstream"), "deepseek");
        assert.equal(getResponseTelemetry(cancelledResponse)?.streamTerminalType, "cancelled");
        assert.equal(getResponseTelemetry(cancelledResponse)?.failureKind, "cancellation");
      });

      await step("never logs the provider credential or the upstream body", async () => {
        const originalConsoleError = console.error;
        const logs: unknown[] = [];
        console.error = (...args: unknown[]) => {
          logs.push(args);
        };
        try {
          await withFetchMock(
            () => Response.json(completion("deepseek-log-proof", { role: "assistant", content: "provider-body-must-not-be-logged" })),
            () => handleChatCompletions(request(canonicalBody))
          );
          await withFetchMock(
            () => new Response("provider-body-must-not-be-logged", { status: 503, headers: { "Content-Type": "text/plain" } }),
            () => handleChatCompletions(request(canonicalBody))
          );
        } finally {
          console.error = originalConsoleError;
        }
        const logText = JSON.stringify(logs);
        assert.doesNotMatch(logText, new RegExp(fakeApiKey));
        assert.doesNotMatch(logText, /provider-body-must-not-be-logged/);
      });
    } finally {
      restoreApiKey();
      setDeepSeekFetchTimeoutMsForTest(null);
    }
  }));

test("openai: DeepSeek official Responses adapter serves the Codex wire protocol", async () =>
  runSequence(async (step) => {
    const envKey = "DEEPSEEK_API_KEY";
    const fakeApiKey = "deepseek-test-key";
    const originalApiKey = process.env[envKey];
    const responsesBody = deepSeekResponsesRequest;
    const chatCompletion = (message: Record<string, unknown>): Record<string, unknown> => ({
      id: "deepseek-responses-1",
      object: "chat.completion",
      created: 1_780_000_100,
      model: DEEPSEEK_FLASH_MODEL,
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14, prompt_cache_hit_tokens: 0, completion_tokens_details: { reasoning_tokens: 3 } },
    });
    const responsesEvents = parseResponsesSseEvents;

    process.env[envKey] = fakeApiKey;
    try {
      await step("translates a Responses request before the Codex catalog lookup", async () => {
        const upstreamCalls: { url: string; body: Record<string, unknown> }[] = [];
        const response = await withFetchMock(
          (url, bodyText) => {
            upstreamCalls.push({ url, body: JSON.parse(String(bodyText)) as Record<string, unknown> });
            return Response.json(
              chatCompletion({
                role: "assistant",
                content: "42",
                reasoning_content: "because",
                tool_calls: [{ id: "call_7", type: "function", function: { name: "clock_now", arguments: "{}" } }],
              })
            );
          },
          () =>
            handleResponses(
              responsesBody({
                model: "deepseek-v4-flash",
                instructions: "Be terse.",
                input: [
                  { type: "message", role: "user", content: [{ type: "input_text", text: "what time is it?" }] },
                  { type: "function_call", name: "clock_now", arguments: "{}", call_id: "call_7" },
                  { type: "function_call_output", call_id: "call_7", output: "noon" },
                ],
                max_output_tokens: 512,
                reasoning: { effort: "ultra" },
                tools: [{ type: "namespace", name: "clock", tools: [{ type: "function", name: "clock_now", parameters: { type: "object" } }] }],
              })
            )
        );

        assert.equal(response.status, 200);
        assert.equal(upstreamCalls.length, 1);
        assert.equal(upstreamCalls[0].url, DEEPSEEK_CHAT_COMPLETIONS_URL);
        const forwardedSystemContent = (upstreamCalls[0].body.messages as { role: string; content: unknown }[])[0].content;
        assert.ok(typeof forwardedSystemContent === "string", "the forwarded system content must be a string");
        assert.ok(forwardedSystemContent.startsWith("Be terse.\n\n"), "the forwarded system content must keep the caller instructions");
        assert.ok(forwardedSystemContent.length > "Be terse.\n\n".length, "the forwarded system content must append nonempty continuation guidance");
        assert.deepEqual(upstreamCalls[0].body, {
          model: DEEPSEEK_FLASH_MODEL,
          stream: false,
          messages: [
            { role: "system", content: forwardedSystemContent },
            { role: "user", content: "what time is it?" },
            // The provider requires replayed reasoning on a tool-bearing request, so
            // a historical tool turn without captured reasoning carries an empty string.
            {
              role: "assistant",
              content: null,
              reasoning_content: "",
              tool_calls: [{ id: "call_7", type: "function", function: { name: "clock_now", arguments: "{}" } }],
            },
            { role: "tool", tool_call_id: "call_7", content: "noon" },
          ],
          max_tokens: 512,
          reasoning_effort: "max",
          tools: [{ type: "function", function: { name: "clock_now", parameters: { type: "object" } } }],
        });

        assert.equal(response.headers.get("x-uos-upstream"), "deepseek");
        const payload = (await response.json()) as Record<string, unknown>;
        assert.equal(payload.object, "response");
        assert.equal(payload.status, "completed");
        assert.equal(payload.model, "deepseek-v4-flash");
        assert.equal(payload.instructions, "Be terse.");
        assert.deepEqual(
          (payload.output as Record<string, unknown>[]).map((item) => item.type),
          ["reasoning", "message", "function_call"]
        );
        assert.deepEqual(payload.usage, {
          input_tokens: 9,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 14,
        });
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.provider, "deepseek");
        assert.equal(telemetry.reasoning, "max");
        // The Responses route reports the same cache measurement the client sees.
        assert.equal(telemetry.cachedInputTokens, 0);
        assert.equal(telemetry.usageTelemetryStatus, "reported");
        assert.deepEqual(telemetry.attemptedProviders, ["deepseek"]);
      });

      await step("streams the Responses event sequence from Chat chunks", async () => {
        const chunk = deepSeekStreamChunk;
        const response = await withFetchMock(
          () =>
            sseResponse([
              chunk({ role: "assistant", reasoning_content: "thinking" }),
              chunk({ content: "po" }),
              chunk({ content: "ng" }, { finish_reason: "stop" }),
              `data: ${JSON.stringify({
                id: "deepseek-responses-stream",
                object: "chat.completion.chunk",
                created: 1_780_000_101,
                model: DEEPSEEK_FLASH_MODEL,
                choices: [],
                usage: {
                  prompt_tokens: 9,
                  completion_tokens: 5,
                  total_tokens: 14,
                  prompt_cache_hit_tokens: 0,
                  completion_tokens_details: { reasoning_tokens: 3 },
                },
              })}\n\n`,
              "data: [DONE]\n\n",
            ]),
          () =>
            handleResponses(responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "hi", stream: true }), {
              keyId: null,
              kernelRepo: null,
              kernelOrg: null,
              requestId: "deepseek-responses-stream",
              startedAtMs: Date.now(),
              startedAtMonotonicMs: performance.now(),
            })
        );

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Content-Type"), "text/event-stream");
        assert.equal(response.headers.get("x-uos-upstream"), "deepseek");
        const events = responsesEvents(await response.text());
        assert.deepEqual(
          events.map((event) => event.type),
          [
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
          ]
        );
        const completed = events.at(-1) as { response: Record<string, unknown> };
        assert.equal(completed.response.status, "completed");
        assert.deepEqual(completed.response.usage, {
          input_tokens: 9,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 14,
        });
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.stream, true);
        assert.equal(telemetry.streamTerminalType, "response.completed");
        assert.equal(typeof telemetry.firstSemanticCommitmentMs, "number");
      });

      const progressTools = [{ type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
      const progressUsage = {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_cache_hit_tokens: 40,
        completion_tokens_details: { reasoning_tokens: 4 },
      };
      const progressResponsesUsage = {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 4 },
        total_tokens: 110,
      };
      const progressCompletion = (): Response =>
        Response.json({
          id: "deepseek-progress-stop",
          object: "chat.completion",
          created: 1_780_000_102,
          model: DEEPSEEK_FLASH_MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Step 11 of 16 complete.", reasoning_content: "I read ten files." },
              finish_reason: "stop",
            },
          ],
          usage: progressUsage,
        });
      const progressStopChunks = (): Response =>
        sseResponse([
          deepSeekStreamChunk({ role: "assistant", reasoning_content: "I read ten files." }),
          deepSeekStreamChunk({ content: "Step 11 of 16 complete." }),
          deepSeekStreamChunk({}, { finish_reason: "stop" }),
          `data: ${JSON.stringify({
            id: "deepseek-progress-stop",
            object: "chat.completion.chunk",
            created: 1_780_000_102,
            model: DEEPSEEK_FLASH_MODEL,
            choices: [],
            usage: progressUsage,
          })}\n\n`,
          "data: [DONE]\n\n",
        ]);

      await step("a streamed progress-like stop completes once with the first text and its measured usage", async () => {
        const upstreamBodies: Record<string, unknown>[] = [];
        const { response, text } = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            return progressStopChunks();
          },
          async () => {
            const response = await handleResponses(
              responsesBody({
                model: DEEPSEEK_FLASH_MODEL,
                input: "read all 16 files",
                stream: true,
                max_output_tokens: 512,
                tools: progressTools,
              })
            );
            // The handler dispatches nothing else while the first body is consumed,
            // so the body is drained before the fetch mock is restored.
            return { response, text: await response.text() };
          }
        );

        // Exactly one provider request, with the caller's cap and automatic tool
        // choice: the progress-like text is the provider's answer, not a draft.
        assert.equal(upstreamBodies.length, 1);
        assert.equal(upstreamBodies[0].max_tokens, 512);
        assert.equal("tool_choice" in upstreamBodies[0], false);
        const forwardedTools = upstreamBodies[0].tools as { function?: { name?: string } }[];
        assert.equal(forwardedTools.length, 1);
        assert.equal(forwardedTools[0]?.function?.name, "read_file");
        const events = responsesEvents(text);
        assert.equal(events.filter((event) => event.type === "response.created").length, 1);
        assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
        const completed = events.at(-1) as { type: string; response: Record<string, unknown> };
        assert.equal(completed.type, "response.completed");
        assert.equal(completed.response.status, "completed");
        const output = completed.response.output as { type: string; content?: { text?: string }[] }[];
        // The original first response is the terminal one; no extra text or tool.
        assert.deepEqual(
          output.map((item) => item.type),
          ["reasoning", "message"]
        );
        assert.equal(output[1]?.content?.[0]?.text, "Step 11 of 16 complete.");
        // The envelope reports the first call's own measured usage, never a sum.
        assert.deepEqual(completed.response.usage, progressResponsesUsage);
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.completed, true);
        assert.equal(telemetry.usageTelemetryStatus, "reported");
        assert.equal(telemetry.inputTokens, 100);
        assert.equal(telemetry.outputTokens, 10);
        assert.equal(telemetry.cachedInputTokens, 40);
        assert.equal(telemetry.outputTokenAllowance, 512);
      });

      await step("a buffered progress-like stop completes once with the first text and its measured usage", async () => {
        const upstreamBodies: Record<string, unknown>[] = [];
        const response = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            return progressCompletion();
          },
          () =>
            handleResponses(
              responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "read all 16 files", stream: false, max_output_tokens: 512, tools: progressTools })
            )
        );

        assert.equal(upstreamBodies.length, 1);
        assert.equal(upstreamBodies[0].max_tokens, 512);
        assert.equal("tool_choice" in upstreamBodies[0], false);
        const payload = (await response.json()) as Record<string, unknown>;
        assert.equal(payload.status, "completed");
        const output = payload.output as { type: string; content?: { text?: string }[] }[];
        assert.deepEqual(
          output.map((item) => item.type),
          ["reasoning", "message"]
        );
        assert.equal(output[1]?.content?.[0]?.text, "Step 11 of 16 complete.");
        assert.deepEqual(payload.usage, progressResponsesUsage);
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.completed, true);
        assert.equal(telemetry.usageTelemetryStatus, "reported");
        assert.equal(telemetry.inputTokens, 100);
        assert.equal(telemetry.outputTokens, 10);
        assert.equal(telemetry.cachedInputTokens, 40);
        assert.equal(telemetry.outputTokenAllowance, 512);
      });

      await step("an omitted output cap still completes once on the streamed branch", async () => {
        const upstreamBodies: Record<string, unknown>[] = [];
        const { response, text } = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            return progressStopChunks();
          },
          async () => {
            const response = await handleResponses(
              // Real Codex `max` traffic omits `max_output_tokens` entirely, so the
              // gateway knows no original cap and no measured provider default.
              responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "read all 16 files", stream: true, reasoning: { effort: "max" }, tools: progressTools })
            );
            return { response, text: await response.text() };
          }
        );

        assert.equal(upstreamBodies.length, 1);
        // The original request stays uncapped on the wire, exactly as Codex sends it.
        assert.equal("max_tokens" in upstreamBodies[0], false);
        assert.equal(upstreamBodies[0].reasoning_effort, "max");
        const events = responsesEvents(text);
        const completed = events.at(-1) as { type: string; response: Record<string, unknown> };
        assert.equal(completed.type, "response.completed");
        assert.deepEqual(completed.response.usage, progressResponsesUsage);
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.completed, true);
        assert.equal(telemetry.outputTokens, 10);
        // The omitted cap stays unknown; nothing was back-filled for it.
        assert.equal(telemetry.outputTokenAllowance, null);
      });

      await step("an omitted output cap still completes once on the buffered branch", async () => {
        const upstreamBodies: Record<string, unknown>[] = [];
        const response = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            return progressCompletion();
          },
          () =>
            handleResponses(
              responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "read all 16 files", stream: false, reasoning: { effort: "max" }, tools: progressTools })
            )
        );

        assert.equal(upstreamBodies.length, 1);
        assert.equal("max_tokens" in upstreamBodies[0], false);
        assert.equal(upstreamBodies[0].reasoning_effort, "max");
        const payload = (await response.json()) as Record<string, unknown>;
        assert.equal(payload.status, "completed");
        assert.deepEqual(payload.usage, progressResponsesUsage);
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.completed, true);
        assert.equal(telemetry.outputTokens, 10);
        assert.equal(telemetry.outputTokenAllowance, null);
      });

      await step("an argument-only first-leg delta is not reported as a tool call", async () => {
        const upstreamBodies: Record<string, unknown>[] = [];
        const { text } = await withFetchMock(
          (_url, bodyText) => {
            upstreamBodies.push(JSON.parse(String(bodyText)) as Record<string, unknown>);
            // A nameless index-0 argument fragment occupies a tool-call map slot
            // while answering nothing; it must never become client-visible output.
            return sseResponse([
              deepSeekStreamChunk({ role: "assistant", content: "Step 11 of 16 complete." }),
              deepSeekStreamChunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
              deepSeekStreamChunk({}, { finish_reason: "stop" }),
              `data: ${JSON.stringify({
                id: "deepseek-partial-call",
                object: "chat.completion.chunk",
                created: 1_780_000_150,
                model: DEEPSEEK_FLASH_MODEL,
                choices: [],
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
              })}\n\n`,
              "data: [DONE]\n\n",
            ]);
          },
          async () => {
            const response = await handleResponses(
              responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "read all 16 files", stream: true, max_output_tokens: 512, tools: progressTools })
            );
            return { response, text: await response.text() };
          }
        );

        assert.equal(upstreamBodies.length, 1);
        const events = responsesEvents(text);
        const completed = events.at(-1) as { type: string; response: Record<string, unknown> };
        assert.equal(completed.type, "response.completed");
        assert.equal(completed.response.status, "completed");
        const output = completed.response.output as Record<string, unknown>[];
        // The original text survives and no named tool call is introduced.
        assert.deepEqual(
          output.map((item) => item.type),
          ["message"]
        );
        assert.deepEqual(output[0].content, [{ type: "output_text", text: "Step 11 of 16 complete.", annotations: [] }]);
        assert.equal(
          events.some((event) => event.type === "response.function_call_arguments.delta"),
          false
        );
      });

      await step("every non-answer first leg still makes exactly one provider request", async () => {
        const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
        const completion = (finishReason: string, message: Record<string, unknown>, completionUsage?: Record<string, unknown>) => ({
          id: `deepseek-shape-${finishReason}`,
          object: "chat.completion",
          created: 1_780_000_400,
          model: DEEPSEEK_FLASH_MODEL,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          ...(completionUsage ? { usage: completionUsage } : {}),
        });
        const cases: {
          name: string;
          request: Record<string, unknown>;
          first: Record<string, unknown>;
          responseStatus: number;
          payloadStatus?: string;
          errorCode?: string;
        }[] = [
          {
            name: "no mapped executable tools",
            request: { tools: [{ type: "web_search" }] },
            first: completion("stop", { role: "assistant", content: "progress" }, usage),
            responseStatus: 200,
            payloadStatus: "completed",
          },
          {
            name: "tool_choice none",
            request: { tools: progressTools, tool_choice: "none" },
            first: completion("stop", { role: "assistant", content: "progress" }, usage),
            responseStatus: 200,
            payloadStatus: "completed",
          },
          {
            // A truncated first leg is reported as an incomplete provider terminal,
            // never promoted to a completion or extended by hidden work.
            name: "a truncated first leg",
            request: { tools: progressTools },
            first: completion("length", { role: "assistant", content: "progress" }, usage),
            responseStatus: 200,
            payloadStatus: "incomplete",
          },
          {
            // A would-be completion with nothing a client can act on fails closed.
            name: "an empty first leg",
            request: { tools: progressTools },
            first: completion("stop", { role: "assistant", content: "" }, usage),
            responseStatus: 502,
            errorCode: "empty_upstream_completion",
          },
          {
            name: "an unobserved first usage",
            request: { tools: progressTools },
            first: completion("stop", { role: "assistant", content: "progress" }),
            responseStatus: 200,
            payloadStatus: "completed",
          },
          {
            // The official refusal metadata is preserved beside the answer text and
            // never triggers additional work.
            name: "a refusal with text",
            request: { tools: progressTools },
            first: completion("stop", { role: "assistant", content: "progress", refusal: "I cannot read the remaining files." }, usage),
            responseStatus: 200,
            payloadStatus: "completed",
          },
          {
            name: "a first-leg tool call",
            request: { tools: progressTools },
            first: completion(
              "stop",
              { role: "assistant", content: "progress", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
              usage
            ),
            responseStatus: 200,
            payloadStatus: "completed",
          },
        ];
        for (const testCase of cases) {
          let upstreamCalls = 0;
          const response = await withFetchMock(
            () => {
              upstreamCalls += 1;
              return Response.json(testCase.first);
            },
            () =>
              handleResponses(
                responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "read all 16 files", stream: false, max_output_tokens: 512, ...testCase.request })
              )
          );
          const payload = (await response.json()) as Record<string, unknown>;
          assert.equal(upstreamCalls, 1, testCase.name);
          assert.equal(response.status, testCase.responseStatus, testCase.name);
          if (testCase.payloadStatus) assert.equal(payload.status, testCase.payloadStatus, testCase.name);
          if (testCase.errorCode) assert.equal((payload.error as { code?: string } | undefined)?.code, testCase.errorCode, testCase.name);
          if (testCase.name === "a refusal with text") {
            // The refusal is metadata, not a replacement for the answer the provider
            // also returned, and the route still makes exactly one call.
            const output = payload.output as { type: string; content?: { text?: string }[] }[];
            assert.deepEqual(
              output.map((item) => item.type),
              ["message"],
              testCase.name
            );
            assert.equal(output[0]?.content?.[0]?.text, "progress", testCase.name);
          }
        }
      });

      await step("a streamed refusal with text keeps its answer and makes one provider request", async () => {
        let upstreamCalls = 0;
        const streamUsage = {
          id: "deepseek-refusal-stream",
          object: "chat.completion.chunk",
          created: 1_780_000_700,
          model: DEEPSEEK_FLASH_MODEL,
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 40 },
        };
        const { response, text } = await withFetchMock(
          () => {
            upstreamCalls += 1;
            return sseResponse([
              deepSeekStreamChunk({ role: "assistant", content: "Step 11 of 16 complete." }),
              deepSeekStreamChunk({ refusal: "I cannot read the remaining files." }),
              deepSeekStreamChunk({}, { finish_reason: "stop" }),
              `data: ${JSON.stringify(streamUsage)}\n\n`,
              "data: [DONE]\n\n",
            ]);
          },
          async () => {
            const response = await handleResponses(
              responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "read all 16 files", stream: true, max_output_tokens: 512, tools: progressTools })
            );
            return { response, text: await response.text() };
          }
        );

        assert.equal(upstreamCalls, 1);
        const events = responsesEvents(text);
        const completed = events.at(-1) as { type: string; response: Record<string, unknown> };
        assert.equal(completed.type, "response.completed");
        const output = completed.response.output as { type: string; content: { text: string }[] }[];
        assert.deepEqual(
          output.map((item) => item.type),
          ["message"]
        );
        assert.equal(output[0]?.content[0]?.text, "Step 11 of 16 complete.");
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.completed, true);
        assert.equal(telemetry.usageTelemetryStatus, "reported");
        assert.equal(telemetry.inputTokens, 100);
      });

      await step("cancelling a streamed progress stop never dispatches a second provider request", async () => {
        const firstFrame = new Deferred<void>();
        let upstreamCalls = 0;
        const { response } = await withFetchMock(
          () => {
            upstreamCalls += 1;
            // One progress frame, then a source that stays open until the gateway
            // cancels it: the client's own cancellation ends this stream.
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(TEXT_ENCODER.encode(deepSeekStreamChunk({ role: "assistant", content: "Step 11 of 16 complete." })));
                firstFrame.resolve();
              },
            });
            return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
          },
          async () => {
            const response = await handleResponses(
              responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "read all 16 files", stream: true, max_output_tokens: 512, tools: progressTools })
            );
            assert.ok(response.body);
            const reader = response.body.getReader();
            const pump = (async () => {
              for (;;) {
                const next = await reader.read();
                if (next.done) return;
              }
            })().catch(() => {});
            await firstFrame.promise;
            await reader.cancel("client cancelled the progress stop");
            await pump;
            return { response };
          }
        );

        // A cancelled first request is never followed by hidden extra work.
        assert.equal(upstreamCalls, 1, "cancellation must never dispatch a second provider request");
        const telemetry = getResponseTelemetry(response);
        assert.equal(telemetry?.streamTerminalType, "cancelled");
        assert.equal(telemetry.completed, false);
      });

      await step("rejects an untranslatable Responses field before provider dispatch", async () => {
        let dispatchCalls = 0;
        const response = await withFetchMock(
          () => {
            dispatchCalls += 1;
            throw new Error("an untranslatable Responses request must not dispatch");
          },
          () => handleResponses(responsesBody({ model: DEEPSEEK_FLASH_MODEL, input: "hi", text: { format: { type: "json_schema", name: "x", schema: {} } } }))
        );
        assert.equal(dispatchCalls, 0);
        assert.equal(response.status, 400);
        assert.equal(((await response.json()) as { error?: { param?: string } }).error?.param, "text.format.type");
      });
    } finally {
      if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
      else process.env[envKey] = originalApiKey;
    }
  }));

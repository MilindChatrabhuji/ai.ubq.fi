import assert from "node:assert/strict";
import { DEEPSEEK_RESPONSES_PROFILE } from "../src/deepseek/responses.ts";
import { createResponseTelemetryState, type UsageContext } from "../src/openai-telemetry.ts";
import { type ProviderStreamAdapter, relayChatCompletionStream, relayResponsesStream } from "../src/provider/stream-relay.ts";

const measuredUsage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 } };

const failingAdapter = (usage: unknown): ProviderStreamAdapter => ({
  responseHeaders: () => ({}),
  async *frames() {
    await Promise.resolve();
    yield {
      kind: "chunk",
      value: { choices: [{ index: 0, delta: { role: "assistant", content: "partial answer" }, finish_reason: null }], ...(usage ? { usage } : {}) },
    };
    throw new Error("upstream failed after reporting usage");
  },
  recordResponseHealth: () => {},
  recordProviderError: () => {},
  recordCancellation: () => {},
  recordIncompleteResponse: () => {},
  recordFinishFailureKind: () => {},
  recordTransportFailure: () => {},
  terminalTypeForError: () => "error",
  streamErrorCode: "fixture_stream_failed",
  responsesProfile: DEEPSEEK_RESPONSES_PROFILE,
});

Deno.test("Chat and translated Responses preserve observed cache usage after a stream failure", async () => {
  for (const wire of ["chat", "responses"]) {
    for (const usage of [measuredUsage, null]) {
      const telemetry = createResponseTelemetryState();
      const context: UsageContext = { keyId: null, kernelRepo: null, kernelOrg: null, responseTelemetry: telemetry };
      const adapter = failingAdapter(usage);
      const signal = new AbortController().signal;
      const upstream = new Response("fixture", { status: 200 });
      const response =
        wire === "chat"
          ? relayChatCompletionStream(adapter, upstream, null, context, signal, signal, "deepseek-flash")
          : relayResponsesStream(adapter, {
              upstream,
              requestedModel: "deepseek-flash",
              responseId: "resp_failed_usage",
              createdAtSeconds: 1_780_000_000,
              echo: { tools: [], tool_choice: "auto", parallel_tool_calls: true, instructions: null },
              toolNames: new Map(),
              customToolNames: new Set(),
              providerRequestId: null,
              usageContext: context,
              downstreamSignal: signal,
              requestSignal: signal,
              upstreamModel: "deepseek-flash",
            });
      assert.match(await response.text(), /fixture_stream_failed/);
      assert.equal(telemetry.completed, false);
      assert.equal(telemetry.streamTerminalType, "error");
      assert.equal(telemetry.usageObserved, usage !== null);
      const actualUsage = {
        status: telemetry.usageTelemetryStatus,
        inputTokens: telemetry.inputTokens,
        cachedInputTokens: telemetry.cachedInputTokens,
        cacheWriteInputTokens: telemetry.cacheWriteInputTokens,
        outputTokens: telemetry.outputTokens,
      };
      const expectedUsage =
        usage === null
          ? { status: "missing", inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null }
          : { status: "reported", inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 20, outputTokens: 10 };
      assert.deepEqual(actualUsage, expectedUsage);
    }
  }
});

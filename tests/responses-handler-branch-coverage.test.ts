import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/openai-compat-harness.ts";
import assert from "node:assert/strict";

import {
  ApiKeyQuotaDispatchError,
  baseSseChunks,
  DEBUG_ROUTING_KEY,
  DEFAULT_TEST_MODEL,
  getResponseTelemetry,
  handleResponses,
  keyToString,
  kvStore,
  parseResponsesSseValues,
  resetDebugRoutingCacheForTest,
  runValidatedTerminalCancellationCase,
  setRemovedProviderApiKeyForTest,
  setRemovedProviderTestAdapterForTest,
  sseResponse,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";

const responsesPost = (body: Record<string, unknown>, signal?: AbortSignal): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

const contextFor = (requestId: string): Record<string, unknown> => ({
  keyId: null,
  kernelRepo: null,
  kernelOrg: null,
  requestId,
  startedAtMs: Date.now(),
});

const setDebugScenario = (scenario: string): void => {
  kvStore.set(keyToString(DEBUG_ROUTING_KEY), { scenario, expires_at_ms: Date.now() + 60_000, updated_at_ms: Date.now() });
  resetDebugRoutingCacheForTest();
};

const clearDebugScenario = (): void => {
  kvStore.delete(keyToString(DEBUG_ROUTING_KEY));
  resetDebugRoutingCacheForTest();
};

const streamingCodexResponse = (requestId: string): Response =>
  new Response(sseResponse(baseSseChunks()).body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "X-Request-Id": requestId },
  });

type RemovedProviderRun = Readonly<{
  response: Response;
  removedCalls: number;
  codexCalls: number;
  telemetry: Record<string, unknown>;
}>;

/**
 * Drives one `removed_provider_first` request: the removed-provider attempt
 * always fails with HTTP 503, and `codexReply` answers the codex recovery
 * attempt that the handler then makes.
 */
const runRemovedProviderCase = async (
  requestId: string,
  codexReply: () => Response,
  options: Readonly<{ abortInsideRemovedProvider?: boolean }> = {}
): Promise<RemovedProviderRun> => {
  setDebugScenario("removed_provider_first");
  setRemovedProviderApiKeyForTest("removed-provider-test-key");
  const controller = new AbortController();
  let removedCalls = 0;
  let codexCalls = 0;
  setRemovedProviderTestAdapterForTest({
    fetchResponses: async (_body, adapterOptions) => {
      removedCalls += 1;
      await adapterOptions.beforeDispatch?.();
      adapterOptions.timing?.onDispatch?.();
      adapterOptions.timing?.onHeaders?.();
      if (options.abortInsideRemovedProvider) controller.abort(new Error("client cancelled"));
      return { response: new Response("removed provider unavailable", { status: 503, headers: { "Content-Type": "text/plain" } }) };
    },
    modelFromEvent: () => DEFAULT_TEST_MODEL,
    isEligibleModel: (candidate) => candidate === DEFAULT_TEST_MODEL,
  });

  try {
    const request = responsesPost({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }, controller.signal);
    const response = await withFetchMock(
      () => {
        codexCalls += 1;
        return codexReply();
      },
      () => handleResponses(request, contextFor(requestId) as never)
    );
    const telemetry = getResponseTelemetry(response);
    assert.ok(telemetry, `${requestId} must report response telemetry`);
    return { response, removedCalls, codexCalls, telemetry: telemetry as unknown as Record<string, unknown> };
  } finally {
    setRemovedProviderTestAdapterForTest(null);
    setRemovedProviderApiKeyForTest(undefined);
    clearDebugScenario();
  }
};

const sseEventTypes = async (response: Response): Promise<string[]> => {
  const text = await response.text();
  return parseResponsesSseValues(text).map((event) => String(event.type));
};

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("a terminal buffered during preflight survives a client cancellation", async () => {
  await runValidatedTerminalCancellationCase({ provider: "chatgpt_codex", route: "responses", terminalType: "response.completed" });
  await runValidatedTerminalCancellationCase({ provider: "chatgpt_codex", route: "responses", terminalType: "response.incomplete" });
});

test("a failed removed-provider attempt recovers on the codex primary", async () => {
  const run = await runRemovedProviderCase("recovery-ready", () => streamingCodexResponse("codex-recovery"));

  assert.equal(run.response.status, 200);
  assert.equal(run.removedCalls, 1);
  assert.equal(run.codexCalls, 1);
  assert.deepEqual(run.telemetry.attemptedProviders, ["removed_provider", "chatgpt_codex"]);
  assert.equal(run.telemetry.provider, "chatgpt_codex");
  assert.equal(run.telemetry.streamTerminalType, null);
  const events = await sseEventTypes(run.response);
  assert.equal(events[0], "response.created");
  assert.equal(events.at(-1), "response.completed");
  assert.ok(events.includes("response.output_text.delta"));
});

test("a removed-provider-first request served upstream never touches codex", async () => {
  setDebugScenario("removed_provider_first");
  setRemovedProviderApiKeyForTest("removed-provider-test-key");
  let codexCalls = 0;
  setRemovedProviderTestAdapterForTest({
    fetchResponses: async (_body, adapterOptions) => {
      await adapterOptions.beforeDispatch?.();
      adapterOptions.timing?.onDispatch?.();
      adapterOptions.timing?.onHeaders?.();
      return { response: streamingCodexResponse("removed-provider") };
    },
    modelFromEvent: () => DEFAULT_TEST_MODEL,
    isEligibleModel: (candidate) => candidate === DEFAULT_TEST_MODEL,
  });

  try {
    const response = await withFetchMock(
      () => {
        codexCalls += 1;
        throw new Error("codex must not run when the removed provider serves the request");
      },
      () => handleResponses(responsesPost({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }), contextFor("removed-ready") as never)
    );
    const telemetry = getResponseTelemetry(response);

    assert.equal(response.status, 200);
    assert.equal(codexCalls, 0);
    assert.ok(telemetry);
    assert.deepEqual(telemetry.attemptedProviders, ["removed_provider"]);
    assert.equal(telemetry.provider, "removed_provider");
    assert.equal(telemetry.removedProviderSelectedModel, DEFAULT_TEST_MODEL);
    assert.equal(telemetry.removedProviderSemanticCommitment, "text");
    const events = await sseEventTypes(response);
    assert.equal(events[0], "response.created");
    assert.equal(events.at(-1), "response.completed");
    assert.ok(events.includes("response.output_text.delta"));
    assert.ok(events.includes("response.output_item.done"));
  } finally {
    setRemovedProviderTestAdapterForTest(null);
    setRemovedProviderApiKeyForTest(undefined);
    clearDebugScenario();
  }
});

test("a codex recovery rejected before its headers returns the removed-provider fallback", async () => {
  const run = await runRemovedProviderCase("recovery-400", () => new Response("bad request", { status: 400, headers: { "Content-Type": "text/plain" } }));

  assert.equal(run.response.status, 503);
  assert.equal(run.codexCalls, 1);
  assert.deepEqual(run.telemetry.attemptedProviders, ["removed_provider", "chatgpt_codex"]);
  assert.equal(run.telemetry.provider, "removed_provider");
  assert.equal(run.telemetry.removedProviderTriggerClass, "http_5xx");
  assert.equal(run.telemetry.removedProviderTerminalStatus, "failed_before_commit");
  assert.equal(run.telemetry.failureKind, null);
});

test("an eligible codex recovery failure still returns the removed-provider fallback", async () => {
  const run = await runRemovedProviderCase("recovery-500", () => new Response("upstream down", { status: 500, headers: { "Content-Type": "text/plain" } }));

  assert.equal(run.response.status, 503);
  assert.equal(run.codexCalls, 1);
  assert.equal(run.telemetry.provider, "removed_provider");
  assert.deepEqual(run.telemetry.attemptedProviders, ["removed_provider", "chatgpt_codex"]);
  assert.equal(run.telemetry.removedProviderTriggerClass, "http_5xx");
});

test("an empty codex recovery completion fails closed with the empty-completion kind", async () => {
  const run = await runRemovedProviderCase(
    "recovery-empty",
    () =>
      new Response(
        sseResponse([
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_empty",
              status: "completed",
              model: DEFAULT_TEST_MODEL,
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
            },
          })}\n\n`,
        ]).body,
        { status: 200, headers: { "Content-Type": "text/event-stream", "X-Request-Id": "empty-completion" } }
      )
  );

  assert.equal(run.response.status, 502);
  assert.equal(run.codexCalls, 1);
  assert.equal(run.telemetry.failureKind, "empty_upstream_completion");
  assert.equal(run.telemetry.streamTerminalType, "response.failed");
  assert.equal(run.telemetry.provider, "chatgpt_codex");
  assert.equal(run.telemetry.completed, false);
});

test("a client cancellation before the codex recovery returns a cancellation error", async () => {
  const run = await runRemovedProviderCase("recovery-cancelled", () => streamingCodexResponse("unused"), { abortInsideRemovedProvider: true });

  assert.equal(run.response.status, 499);
  assert.equal(run.codexCalls, 0);
  assert.equal(run.telemetry.streamTerminalType, "cancelled");
  assert.equal(run.telemetry.provider, "chatgpt_codex");
  assert.deepEqual(run.telemetry.attemptedProviders, ["removed_provider", "chatgpt_codex"]);
});

test("a malformed responses request body is rejected before any provider runs", async () => {
  let codexCalls = 0;
  const response = await withFetchMock(
    () => {
      codexCalls += 1;
      return streamingCodexResponse("unused");
    },
    () =>
      handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{not json",
        }),
        contextFor("malformed-body") as never
      )
  );

  assert.equal(response.status, 400);
  assert.equal(codexCalls, 0);
  const payload = (await response.json()) as { error?: { message?: unknown } };
  assert.equal(typeof payload.error?.message, "string");
});

test("a quota dispatch error during the codex recovery returns the removed-provider fallback", async () => {
  const run = await runRemovedProviderCase("recovery-quota-error", () => {
    throw new ApiKeyQuotaDispatchError("API key quota reservation is unavailable");
  });

  assert.equal(run.response.status, 503);
  assert.equal(run.codexCalls, 1);
  assert.deepEqual(run.telemetry.attemptedProviders, ["removed_provider", "chatgpt_codex"]);
  assert.equal(run.telemetry.provider, "removed_provider");
});

test("a removed-provider failure after a codex primary failure returns the primary response", async () => {
  setRemovedProviderApiKeyForTest("removed-provider-test-key");
  let removedCalls = 0;
  let codexCalls = 0;
  setRemovedProviderTestAdapterForTest({
    fetchResponses: async (_body, adapterOptions) => {
      removedCalls += 1;
      await adapterOptions.beforeDispatch?.();
      adapterOptions.timing?.onDispatch?.();
      adapterOptions.timing?.onHeaders?.();
      return { response: new Response("removed provider unavailable", { status: 503, headers: { "Content-Type": "text/plain" } }) };
    },
    modelFromEvent: () => DEFAULT_TEST_MODEL,
    isEligibleModel: (candidate) => candidate === DEFAULT_TEST_MODEL,
  });

  try {
    const response = await withFetchMock(
      () => {
        codexCalls += 1;
        return new Response(sseResponse([`data: ${JSON.stringify({ type: "error", code: "server_error", message: "codex down" })}\n\n`]).body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "X-Request-Id": "codex-failed" },
        });
      },
      () => handleResponses(responsesPost({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }), contextFor("primary-then-removed") as never)
    );
    const telemetry = getResponseTelemetry(response);

    assert.ok(codexCalls >= 1);
    assert.equal(removedCalls, 1);
    assert.ok(telemetry);
    assert.deepEqual(telemetry.attemptedProviders, ["chatgpt_codex", "removed_provider"]);
    assert.ok(response.status >= 400);
  } finally {
    setRemovedProviderTestAdapterForTest(null);
    setRemovedProviderApiKeyForTest(undefined);
  }
});

test("an empty removed-provider completion fails closed without a codex recovery", async () => {
  setDebugScenario("removed_provider_first");
  setRemovedProviderApiKeyForTest("removed-provider-test-key");
  let codexCalls = 0;
  setRemovedProviderTestAdapterForTest({
    fetchResponses: async (_body, adapterOptions) => {
      await adapterOptions.beforeDispatch?.();
      adapterOptions.timing?.onDispatch?.();
      adapterOptions.timing?.onHeaders?.();
      return {
        response: new Response(
          sseResponse([
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_empty",
                status: "completed",
                model: DEFAULT_TEST_MODEL,
                output: [],
                usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
              },
            })}\n\n`,
          ]).body,
          { status: 200, headers: { "Content-Type": "text/event-stream", "X-Request-Id": "removed-empty" } }
        ),
      };
    },
    modelFromEvent: () => DEFAULT_TEST_MODEL,
    isEligibleModel: (candidate) => candidate === DEFAULT_TEST_MODEL,
  });

  try {
    const response = await withFetchMock(
      () => {
        codexCalls += 1;
        throw new Error("codex must not run for an empty removed-provider completion");
      },
      () => handleResponses(responsesPost({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }), contextFor("removed-empty") as never)
    );
    const telemetry = getResponseTelemetry(response);

    assert.equal(response.status, 502);
    assert.equal(codexCalls, 0);
    assert.ok(telemetry);
    assert.deepEqual(telemetry.attemptedProviders, ["removed_provider"]);
    assert.equal(telemetry.failureKind, "empty_upstream_completion");
    assert.equal(telemetry.streamTerminalType, "response.failed");
  } finally {
    setRemovedProviderTestAdapterForTest(null);
    setRemovedProviderApiKeyForTest(undefined);
    clearDebugScenario();
  }
});

const stalledSseChunks = (chunks: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
};

test("a mid-stream client cancellation reconciles the committed failure", async () => {
  const controller = new AbortController();
  let codexCalls = 0;
  const response = await withFetchMock(
    () => {
      codexCalls += 1;
      return new Response(stalledSseChunks(baseSseChunks()), {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "X-Request-Id": "codex-stalled" },
      });
    },
    () =>
      handleResponses(responsesPost({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }, controller.signal), contextFor("mid-stream-cancel") as never)
  );

  assert.equal(response.status, 200);
  assert.equal(codexCalls, 1);
  controller.abort(new Error("client cancelled mid-stream"));
  const text = await response.text();
  const telemetry = getResponseTelemetry(response);

  assert.ok(telemetry);
  assert.equal(telemetry.streamTerminalType, "cancelled");
  assert.equal(telemetry.completed, false);
  assert.ok(text.length > 0);
});

test("a removed-provider stream that changes its model after release fails the stream", async () => {
  setDebugScenario("removed_provider_first");
  setRemovedProviderApiKeyForTest("removed-provider-test-key");
  let codexCalls = 0;
  const swappedModelChunk = `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_swapped", status: "in_progress", model: "other-model", output: [] } })}\n\n`;
  setRemovedProviderTestAdapterForTest({
    fetchResponses: async (_body, adapterOptions) => {
      await adapterOptions.beforeDispatch?.();
      adapterOptions.timing?.onDispatch?.();
      adapterOptions.timing?.onHeaders?.();
      const [created, delta, terminal] = baseSseChunks();
      return {
        response: new Response(stalledSseChunks([created, delta, swappedModelChunk, terminal]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "X-Request-Id": "removed-provider-swap" },
        }),
      };
    },
    modelFromEvent: (value) => {
      const response = value.response;
      const model = typeof response === "object" && response !== null ? (response as { model?: unknown }).model : undefined;
      return model === "other-model" ? "other-model" : DEFAULT_TEST_MODEL;
    },
    isEligibleModel: (candidate) => candidate === DEFAULT_TEST_MODEL,
  });

  try {
    const response = await withFetchMock(
      () => {
        codexCalls += 1;
        throw new Error("codex must not run when the removed provider serves the request");
      },
      () => handleResponses(responsesPost({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }), contextFor("removed-model-swap") as never)
    );
    const text = await response.text();
    const telemetry = getResponseTelemetry(response);

    assert.equal(codexCalls, 0);
    assert.ok(telemetry);
    assert.equal(telemetry.provider, "removed_provider");
    assert.equal(telemetry.removedProviderSelectedModel, DEFAULT_TEST_MODEL);
    // The owned stream fails the release on the swapped model and reconciles the
    // committed failure as a provider-level response.failed terminal.
    assert.deepEqual(
      { terminal: telemetry.removedProviderTerminalStatus, stream: telemetry.streamTerminalType },
      { terminal: "response.failed", stream: "response.failed" }
    );
    assert.equal(telemetry.completed, false);
    assert.equal(typeof telemetry.removedProviderLatencyMs, "number");
    assert.match(text, /response\.failed|event: error/);
  } finally {
    setRemovedProviderTestAdapterForTest(null);
    setRemovedProviderApiKeyForTest(undefined);
    clearDebugScenario();
  }
});

test("a streaming upstream that ends without a terminal reconciles the committed failure", async () => {
  const [created, delta] = baseSseChunks();
  let codexCalls = 0;
  const response = await withFetchMock(
    () => {
      codexCalls += 1;
      return new Response(sseResponse([created, delta]).body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "X-Request-Id": "codex-truncated" },
      });
    },
    () => handleResponses(responsesPost({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }), contextFor("premature-eof") as never)
  );

  assert.equal(response.status, 200);
  assert.equal(codexCalls, 1);
  const text = await response.text();
  const telemetry = getResponseTelemetry(response);

  assert.ok(telemetry);
  assert.equal(telemetry.completed, false);
  assert.notEqual(telemetry.streamTerminalType, null);
  assert.ok(text.includes("response"));
});

test("a removed-provider stream that ends without a terminal reconciles the committed failure", async () => {
  setDebugScenario("removed_provider_first");
  setRemovedProviderApiKeyForTest("removed-provider-test-key");
  let codexCalls = 0;
  const [created, delta] = baseSseChunks();
  setRemovedProviderTestAdapterForTest({
    fetchResponses: async (_body, adapterOptions) => {
      await adapterOptions.beforeDispatch?.();
      adapterOptions.timing?.onDispatch?.();
      adapterOptions.timing?.onHeaders?.();
      return {
        response: new Response(sseResponse([created, delta]).body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "X-Request-Id": "removed-provider-truncated" },
        }),
      };
    },
    modelFromEvent: () => DEFAULT_TEST_MODEL,
    isEligibleModel: (candidate) => candidate === DEFAULT_TEST_MODEL,
  });

  try {
    const response = await withFetchMock(
      () => {
        codexCalls += 1;
        throw new Error("codex must not run when the removed provider serves the request");
      },
      () => handleResponses(responsesPost({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }), contextFor("removed-premature-eof") as never)
    );
    const text = await response.text();
    const telemetry = getResponseTelemetry(response);

    assert.equal(codexCalls, 0);
    assert.ok(telemetry);
    assert.equal(telemetry.provider, "removed_provider");
    assert.equal(telemetry.completed, false);
    assert.notEqual(telemetry.streamTerminalType, null);
    assert.equal(telemetry.removedProviderTerminalStatus, telemetry.streamTerminalType);
    assert.equal(typeof telemetry.removedProviderLatencyMs, "number");
    assert.ok(text.includes("response"));
  } finally {
    setRemovedProviderTestAdapterForTest(null);
    setRemovedProviderApiKeyForTest(undefined);
    clearDebugScenario();
  }
});

test("a streaming upstream read error reconciles the committed failure", async () => {
  const [created, delta] = baseSseChunks();
  const encoder = new TextEncoder();
  let pulls = 0;
  const failingBody = new ReadableStream<Uint8Array>({
    // The first pull feeds the semantic commitment that releases the client
    // stream; the second pull is the post-release read that fails.
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(encoder.encode(created));
        controller.enqueue(encoder.encode(delta));
        return;
      }
      controller.error(new TypeError("network connection lost"));
    },
  });
  let codexCalls = 0;
  const response = await withFetchMock(
    () => {
      codexCalls += 1;
      return new Response(failingBody, { status: 200, headers: { "Content-Type": "text/event-stream", "X-Request-Id": "codex-read-error" } });
    },
    () => handleResponses(responsesPost({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }), contextFor("read-error") as never)
  );

  assert.equal(response.status, 200);
  assert.equal(codexCalls, 1);
  const text = await response.text();
  const telemetry = getResponseTelemetry(response);

  assert.ok(telemetry);
  assert.equal(telemetry.completed, false);
  assert.notEqual(telemetry.streamTerminalType, null);
  assert.deepEqual(
    parseResponsesSseValues(text).map((event) => String(event.type)),
    ["response.created", "response.output_text.delta", "response.failed"]
  );
});

test("a buffered upstream read error is delivered as a classified failure", async () => {
  const [created, delta] = baseSseChunks();
  const encoder = new TextEncoder();
  let pulls = 0;
  const failingBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(encoder.encode(created));
        controller.enqueue(encoder.encode(delta));
        return;
      }
      controller.error(new TypeError("network connection lost"));
    },
  });
  let codexCalls = 0;
  const response = await withFetchMock(
    () => {
      codexCalls += 1;
      return new Response(failingBody, { status: 200, headers: { "Content-Type": "text/event-stream", "X-Request-Id": "codex-buffered-read-error" } });
    },
    () => handleResponses(responsesPost({ model: DEFAULT_TEST_MODEL, input: "ping", stream: false }), contextFor("buffered-read-error") as never)
  );

  assert.equal(codexCalls, 1);
  assert.equal(response.status, 502);
  const payload = (await response.json()) as { error: { message: string; code: string } };
  assert.equal(payload.error.message, "Upstream Responses stream ended unexpectedly.");
  assert.equal(payload.error.code, "server_error");
});

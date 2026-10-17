import { test } from "bun:test";
import { serveHttp, type NetAddr } from "#http";
import { openKv, type Kv } from "#kv";
import assert from "node:assert/strict";
import { ADMIN_ERROR_LOG_PREFIX } from "../src/admin/error-log.ts";
import { PAID_FALLBACK_NO_LIMIT } from "../src/api-keys.ts";
import {
  type ApiKeyPolicy,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
  apiKeyPolicyFromHashRecord,
  resetApiKeyPolicyCacheForTest,
} from "../src/api-key-policy.ts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL } from "../src/deepseek/index.ts";
import { setInferenceAdmissionControllerForTest } from "../src/handler/admission.ts";
import { createInferenceAdmissionController } from "../src/inference-admission.ts";
import { setKvForTest } from "../src/kv.ts";
import { enqueuePromptCacheAnalytics, optionalPromptCacheAnalyticsSnapshot } from "../src/cache/prompt-analytics.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "../src/types.ts";
import { sha256Base64Url } from "../src/utils.ts";

/**
 * Real HTTP acceptance for the canonical gateway: one task-owned loopback
 * upstream (controlled DeepSeek frames), one loopback server running the actual
 * `createServeHandler(handler)`, real KV-backed authentication and quota
 * accounting, and no paid provider, credential or external network.
 *
 * The normal Bun test runner starts this file in its own isolated process with `SURPLUS_API_KEY` and `METERED_API_KEY`
 * removed and without dotenv discovery, so an ordinarily configured checkout
 * still proves the fixture starts credential-free. Every test asserts that
 * absence before installing its dummy values, so a direct run needs the same
 * isolation.
 *
 * Every scenario uses a real native Bun KV (`:memory:`) and a real HTTP client, so the
 * assertions exercise the production seams: admission, quota reservation and
 * dispatch, upstream translation, downstream delivery, cancellation and the
 * terminal accounting handoff.
 *
 * Every scenario explicitly cancels readers, releases held producers, shuts down
 * both servers and closes its native KV in finally.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type UpstreamMode =
  | "chat-stream-answer"
  | "chat-buffered-answer"
  | "responses-stream-refusal"
  | "responses-stream-truncated"
  | "responses-buffered-truncated"
  | "stream-hold"
  | "responses-progress-stop"
  | "upstream-500";

type RecordedCall = Readonly<{ url: string; body: string }>;

const sseHeaders = (requestId: string): HeadersInit => ({
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "x-request-id": requestId,
});

const chatChunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-oss-http",
    object: "chat.completion.chunk",
    created: 1_780_000_001,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`;

const sseBody = (frames: readonly string[]): string => `${frames.join("")}data: [DONE]\n\n`;

const jsonChatCompletion = (content: string | null, finishReason: string, refusal?: string): Response =>
  Response.json({
    id: "chatcmpl-oss-buffered",
    object: "chat.completion",
    created: 1_780_000_002,
    model: "deepseek-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...(refusal ? { refusal } : {}) },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_cache_hit_tokens: 1 },
  });

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(5);
  }
};

/** One SSE response body read frame by frame, so a test can stop mid-stream. */
const readSseUntil = async (
  response: Response,
  predicate: (text: string) => boolean,
  options: Readonly<{ timeoutMs?: number }> = {}
): Promise<{ text: string; reader: ReadableStreamDefaultReader<Uint8Array>; reached: boolean }> => {
  assert.ok(response.body, "the gateway SSE response must carry a body");
  const reader = response.body.getReader();
  const deadline = performance.now() + (options.timeoutMs ?? 4_000);
  let text = "";
  // One pending read is kept across ticks: racing a fresh read each tick would
  // leave the loser's chunk stranded and silently drop stream bytes.
  let pending: ReturnType<typeof reader.read> | null = null;
  for (;;) {
    if (predicate(text)) return { text, reader, reached: true };
    pending ??= reader.read();
    const next = await Promise.race([pending, delay(25).then(() => "tick" as const)]);
    if (next === "tick") {
      if (performance.now() >= deadline) return { text, reader, reached: predicate(text) };
      continue;
    }
    pending = null;
    if (next.done) return { text, reader, reached: predicate(text) };
    text += decoder.decode(next.value, { stream: true });
  }
};

const dataPayloads = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .filter((payload) => payload !== "[DONE]")
    .flatMap((payload) => {
      try {
        const parsed = JSON.parse(payload) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });

type Harness = Readonly<{
  gatewayUrl: string;
  token: string;
  policy: ApiKeyPolicy;
  kv: Kv;
  controller: ReturnType<typeof createInferenceAdmissionController>;
  calls: RecordedCall[];
  /** Bounded chronology evidence: producer cancellation and client/terminal markers. */
  events: string[];
  setMode: (mode: UpstreamMode) => void;
  releaseHold: () => void;
  stop: () => Promise<void>;
}>;

const startHarness = async (): Promise<Harness> => {
  const kv = await openKv(":memory:");
  const keyId = "oss-gateway-http-key";
  const token = `u_${"b".repeat(64)}`;
  const tokenHash = await sha256Base64Url(token);
  const now = Date.now();
  const windowMs = 60 * 60_000;
  const windowResetAtMs = now + windowMs;
  const commonPolicy = {
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 500,
    usage_requests: 0,
    usage_reset_at_ms: windowResetAtMs,
    window_ms: windowMs,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: PAID_FALLBACK_NO_LIMIT,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  } satisfies Omit<ApiKeyHashRecord, "id">;
  const keyRecord: ApiKeyRecord = {
    id: keyId,
    name: "OSS gateway HTTP acceptance key",
    prefix: token.slice(0, 10),
    hash: tokenHash,
    created_at_ms: now,
    ...commonPolicy,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: now,
  };
  const hashRecord: ApiKeyHashRecord = { id: keyId, ...commonPolicy };
  await kv.set(["ubq_ai", "api_keys", "id", keyId], keyRecord);
  await kv.set(["ubq_ai", "api_keys", "hash", tokenHash], hashRecord);
  const resolvedPolicy = apiKeyPolicyFromHashRecord(tokenHash, hashRecord, now);
  assert.ok(resolvedPolicy, "the seeded API key hash record must produce a live policy");
  const policy: ApiKeyPolicy = resolvedPolicy;

  const calls: RecordedCall[] = [];
  const holdReleases: (() => void)[] = [];
  /** Bounded chronology evidence: producer cancellation and client/terminal markers. */
  const events: string[] = [];
  let mode: UpstreamMode = "chat-stream-answer";
  const upstream = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (request) => {
    const body = await request.text();
    calls.push({ url: request.url, body });
    const callNumber = calls.length;
    if (mode === "upstream-500") {
      return Response.json({ error: { message: "controlled upstream fault", type: "server_error" } }, { status: 500 });
    }
    if (mode === "responses-progress-stop") {
      // A completed text-only progress stop: assistant text, a clean stop, and
      // measured usage with cache reads. One provider request serves this
      // client request, and the gateway completes with the provider's output.
      return new Response(
        sseBody([
          chatChunk({ role: "assistant", content: "Step 11 of 16 complete." }, null),
          chatChunk({}, "stop", { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140, prompt_tokens_details: { cached_tokens: 64 } }),
        ]),
        { headers: sseHeaders(`ds-progress-stop-${callNumber}`) }
      );
    }
    if (mode === "stream-hold") {
      let release: () => void = () => {};
      let cancelled = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holdReleases.push(() => {
        release();
      });
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // The first frame is a bare chunk without the `[DONE]` sentinel: an
          // `sseBody` here would terminate the stream on the first enqueue, so
          // the gateway would legitimately finish and release the permit before
          // the test can observe downstream retention. `[DONE]` follows the
          // gate, which is what keeps this upstream genuinely open. The first
          // frame carries the usage counters too, so a disconnecting client has
          // already received answer and usage while the source stays open.
          controller.enqueue(encoder.encode(chatChunk({ content: "held" }, null, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })));
          await gate;
          // A cancelled holder must not enqueue on a closed controller.
          if (cancelled) return;
          controller.enqueue(encoder.encode(chatChunk({}, "stop", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
        cancel() {
          cancelled = true;
          events.push("producer_cancelled");
          release();
        },
      });
      return new Response(stream, { headers: sseHeaders(`ds-hold-${callNumber}`) });
    }
    if (mode === "responses-stream-refusal") {
      return new Response(
        sseBody([
          chatChunk({ refusal: "I cannot" }, null),
          chatChunk({ refusal: " do that" }, "stop", { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }),
        ]),
        { headers: sseHeaders(`ds-refusal-${callNumber}`) }
      );
    }
    if (mode === "responses-stream-truncated") {
      return new Response(sseBody([chatChunk({ content: "partial answer" }, "length", { prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 })]), {
        headers: sseHeaders(`ds-truncated-${callNumber}`),
      });
    }
    if (mode === "responses-buffered-truncated") {
      return jsonChatCompletion("partial answer", "length");
    }
    if (mode === "chat-buffered-answer") {
      return jsonChatCompletion("buffered answer", "stop");
    }
    return new Response(
      sseBody([
        chatChunk({ role: "assistant", content: "streamed " }, null),
        chatChunk({ content: "answer" }, null),
        chatChunk({}, "stop", { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9, prompt_cache_hit_tokens: 2 }),
      ]),
      { headers: sseHeaders(`ds-answer-${callNumber}`) }
    );
  });
  await upstream.ready;
  const providerOrigin = `http://127.0.0.1:${(upstream.addr as NetAddr).port}`;
  const originalFetch = globalThis.fetch;
  const fetchInputUrl = (input: RequestInfo | URL): string => {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  };
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = fetchInputUrl(input);
      if (url === DEEPSEEK_CHAT_COMPLETIONS_URL) return originalFetch(`${providerOrigin}/chat/completions`, init);
      if (new URL(url).hostname !== "127.0.0.1") return Promise.reject(new Error("Unmapped external URL refused by loopback HTTP fixture"));
      return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect }
  );

  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 1, maxQueueWaitMs: 150 });
  setInferenceAdmissionControllerForTest(controller);
  // The gateway reads its KV through `getKv()`. Without this the process would
  // open the default persistent KV, find no seeded hash record and answer every request
  // 401 `invalid_or_limited` before provider dispatch.
  setKvForTest(kv);
  // A cached policy from an earlier test would outlive this test's fresh KV.
  resetApiKeyPolicyCacheForTest();
  const { default: handler } = await import("../src/handler/index.ts");
  const { createServeHandler } = await import("../src/handler/serve-handler.ts");
  const gateway = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, createServeHandler(handler));
  await gateway.ready;

  return {
    gatewayUrl: `http://127.0.0.1:${(gateway.addr as NetAddr).port}`,
    token,
    policy,
    kv,
    controller,
    calls,
    events,
    setMode: (next) => {
      mode = next;
    },
    releaseHold: () => {
      for (const release of holdReleases.splice(0)) release();
    },
    stop: async () => {
      for (const release of holdReleases.splice(0)) release();
      try {
        await Promise.all([gateway.shutdown(), upstream.shutdown()]);
      } finally {
        globalThis.fetch = originalFetch;
        setInferenceAdmissionControllerForTest(null);
        setKvForTest(null);
        kv.close();
      }
    },
  };
};

const postJson = (
  harness: Harness,
  path: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal
): Promise<Response> =>
  fetch(`${harness.gatewayUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${harness.token}`, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

const responsesBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ model: "deepseek-flash", input: "hello", ...overrides });
const chatBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: "deepseek-flash",
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
});

test("oss gateway real HTTP: terminal delivery, refusal sequence numbers, truncation and single dispatch", async () => {
  const originalInfo = console.info;
  const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  const originalMeteredKey = process.env.METERED_API_KEY;
  const logs: string[] = [];
  const harness = await startHarness();
  const stop = harness.stop;
  try {
    // Credential presence is verified before any dummy value replaces it, and
    // the paid tiers are removed for the duration so a fault cannot advance.
    assert.equal(originalSurplusKey, undefined, "no paid Surplus credential may be present; `bun run test` removes it and skips .env");
    assert.equal(originalMeteredKey, undefined, "no paid Metered credential may be present; `bun run test` removes it and skips .env");
    delete process.env.SURPLUS_API_KEY;
    delete process.env.METERED_API_KEY;
    process.env.DEEPSEEK_API_KEY = "oss-http-dummy-deepseek-key";
    const { config } = await import("../src/config.ts");
    const originalDeployFlag = config.isDeploy;
    (config as { isDeploy: boolean }).isDeploy = true;
    console.info = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      // 1. A normal streamed Chat completion delivers and completes.
      harness.setMode("chat-stream-answer");
      const chatStream = await postJson(harness, "/v1/chat/completions", chatBody({ stream: true }));
      assert.equal(chatStream.status, 200);
      const chatText = await chatStream.text();
      assert.match(chatText, /streamed /);
      assert.match(chatText, /answer/);
      assert.equal(chatStream.headers.get("x-uos-upstream"), "deepseek");
      assert.ok(chatStream.headers.get("x-uos-request-id"));

      // 2. A buffered Chat completion delivers the provider's own JSON.
      harness.setMode("chat-buffered-answer");
      const chatBuffered = await postJson(harness, "/v1/chat/completions", chatBody({ stream: false }));
      assert.equal(chatBuffered.status, 200);
      const chatPayload = (await chatBuffered.json()) as Record<string, unknown>;
      assert.equal((chatPayload.choices as { message: { content: string } }[])[0].message.content, "buffered answer");

      // 3. A refusal-only Responses stream is answer-bearing, ordered and sequenced.
      harness.setMode("responses-stream-refusal");
      const refusal = await postJson(harness, "/v1/responses", responsesBody({ stream: true }));
      assert.equal(refusal.status, 200);
      const refusalEvents = dataPayloads(await refusal.text());
      assert.ok(refusalEvents.length > 0, "the refusal stream must emit events");
      for (const [index, event] of refusalEvents.entries()) {
        assert.equal(event.sequence_number, index, `event ${index} must carry contiguous sequence_number ${index}`);
      }
      const refusalDelta = refusalEvents.find((event) => event.type === "response.refusal.delta");
      const refusalDone = refusalEvents.find((event) => event.type === "response.refusal.done");
      assert.ok(refusalDelta && refusalDone, "a refusal payload must emit both delta and done events");
      assert.equal(refusalDelta.output_index, refusalDone.output_index, "the refusal item index must not move");
      assert.equal(refusalDelta.content_index, refusalDone.content_index, "the refusal content index must not move");
      assert.equal(refusalDone.refusal, "I cannot do that");

      // 4. A truncated stream is a truthful incomplete terminal, not a completion.
      harness.setMode("responses-stream-truncated");
      const truncatedStream = await postJson(harness, "/v1/responses", responsesBody({ stream: true }));
      assert.equal(truncatedStream.status, 200);
      const truncatedEvents = dataPayloads(await truncatedStream.text());
      const terminal = truncatedEvents.at(-1);
      assert.ok(terminal, "the truncated stream must emit a terminal event");
      assert.equal(terminal.type, "response.incomplete");
      assert.deepEqual((terminal.response as Record<string, unknown>).incomplete_details, { reason: "max_output_tokens" });
      assert.ok(
        truncatedEvents.every((event, index) => event.sequence_number === index),
        "every truncated-stream event must keep a contiguous sequence_number"
      );

      // 5. A buffered truncation reports the same truthful contract as JSON.
      harness.setMode("responses-buffered-truncated");
      const truncatedBuffered = await postJson(harness, "/v1/responses", responsesBody({ stream: false }));
      assert.equal(truncatedBuffered.status, 200);
      const truncatedPayload = (await truncatedBuffered.json()) as Record<string, unknown>;
      assert.equal(truncatedPayload.status, "incomplete");
      assert.deepEqual(truncatedPayload.incomplete_details, { reason: "max_output_tokens" });

      // 6. A controlled upstream fault dispatches exactly once and advances nothing.
      harness.setMode("upstream-500");
      const dispatchesBeforeFault = harness.calls.length;
      const faulted = await postJson(harness, "/v1/responses", responsesBody({ stream: true }));
      assert.ok(faulted.status >= 500, `an upstream fault must fail closed, received ${faulted.status}`);
      await faulted.body?.cancel().catch(() => {});
      assert.equal(harness.calls.length, dispatchesBeforeFault + 1, "one request must produce exactly one provider dispatch");
      assert.notEqual(faulted.headers.get("x-uos-upstream"), "surplus");
      assert.notEqual(faulted.headers.get("x-uos-upstream"), "metered");

      // 7. The gateway owns the accounting identity: a caller-supplied id cannot collide.
      harness.setMode("chat-buffered-answer");
      const first = await postJson(harness, "/v1/chat/completions", chatBody({ stream: false }), {
        "x-uos-request-id": "client-chosen-1",
        "Idempotency-Key": "client-chosen-1",
      });
      const second = await postJson(harness, "/v1/chat/completions", chatBody({ stream: false }), {
        "x-uos-request-id": "client-chosen-1",
        "Idempotency-Key": "client-chosen-1",
      });
      const firstId = first.headers.get("x-uos-request-id");
      const secondId = second.headers.get("x-uos-request-id");
      assert.ok(firstId && secondId && firstId !== secondId, "the gateway must generate a distinct request id per request");
      assert.match(firstId, /^[0-9a-f-]{36}$/);
      await first.body?.cancel().catch(() => {});
      await second.body?.cancel().catch(() => {});
    } finally {
      console.info = originalInfo;
      (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    }
  } finally {
    await stop();
    if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
    assert.ok(logs.every((line) => typeof line === "string"));
  }
}, 300_000);

test("oss gateway real HTTP: admission bounds, waiting abort, disconnect release and dispatched accounting", async () => {
  const originalInfo = console.info;
  const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  const originalMeteredKey = process.env.METERED_API_KEY;
  const terminals: Record<string, unknown>[] = [];
  const accepted: Record<string, unknown>[] = [];
  const harness = await startHarness();
  const stop = harness.stop;
  try {
    assert.equal(originalSurplusKey, undefined, "no paid Surplus credential may be present; `bun run test` removes it and skips .env");
    assert.equal(originalMeteredKey, undefined, "no paid Metered credential may be present; `bun run test` removes it and skips .env");
    delete process.env.SURPLUS_API_KEY;
    delete process.env.METERED_API_KEY;
    process.env.DEEPSEEK_API_KEY = "oss-http-dummy-deepseek-key";
    const { config } = await import("../src/config.ts");
    const originalDeployFlag = config.isDeploy;
    (config as { isDeploy: boolean }).isDeploy = true;
    console.info = (...args: unknown[]) => {
      const [label, payload] = args.map(String);
      if (label === "[ai.ubq.fi] request_terminal" && payload) terminals.push(JSON.parse(payload) as Record<string, unknown>);
      if (label === "[ai.ubq.fi] request_accepted" && payload) accepted.push(JSON.parse(payload) as Record<string, unknown>);
    };

    try {
      // One request holds the only permit while its client retains the body.
      harness.setMode("stream-hold");
      const holder = await postJson(harness, "/v1/responses", responsesBody({ stream: true }));
      assert.equal(holder.status, 200);
      const holderId = holder.headers.get("x-uos-request-id");
      assert.ok(holderId, "the holder response must carry the gateway request id");
      const held = await readSseUntil(holder, (text) => text.includes("data: "));
      assert.ok(held.reached, "the holder must receive its first event");
      assert.equal(harness.controller.snapshot().active, 1, "the holder owns the single permit");

      // A second request waits inside the five-second queue bound.
      const waitingAbort = new AbortController();
      const waiting = postJson(harness, "/v1/responses", responsesBody({ stream: true }), {}, waitingAbort.signal);
      await waitFor(() => harness.controller.snapshot().waiting === 1, "the second request to queue");

      // A third request finds the queue full and is refused locally.
      const overloaded = await postJson(harness, "/v1/responses", responsesBody({ stream: true }));
      assert.equal(overloaded.status, 503);
      const overloadPayload = (await overloaded.json()) as { error: { code: string; message: string } };
      assert.equal(overloadPayload.error.code, "local_inference_overload");
      assert.ok(overloaded.headers.get("retry-after"), "a local overload must carry Retry-After");
      assert.equal(harness.calls.length, 1, "a refused request must never dispatch upstream");

      // A queued caller that aborts never dispatches, and never holds a permit.
      waitingAbort.abort(new DOMException("client disconnected while queued", "AbortError"));
      const waitingSettled = await waiting.catch(() => null);
      if (waitingSettled) {
        assert.equal(waitingSettled.status, 499, "an aborted waiter must be refused as a cancellation, never dispatched");
        await waitingSettled.body?.cancel().catch(() => {});
      }
      await waitFor(() => harness.controller.snapshot().waiting === 0, "the aborted waiter to leave the queue");
      assert.equal(harness.calls.length, 1, "an aborted waiter must not reach the provider");

      // Releasing the holder frees the permit, and a later request recovers.
      await held.reader.cancel("acceptance: release the holder").catch(() => {});
      await waitFor(() => harness.controller.snapshot().active === 0, "the holder permit to be released");
      harness.releaseHold();
      harness.setMode("chat-stream-answer");
      const recovered = await postJson(harness, "/v1/chat/completions", chatBody({ stream: true }));
      assert.equal(recovered.status, 200);
      assert.match(await recovered.text(), /streamed /);
      await waitFor(() => harness.controller.snapshot().active === 0, "the recovered permit to be released");

      // A disconnect mid-stream keeps the dispatched accounting and returns the permit once.
      const committedBeforeDisconnect =
        (await harness.kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(harness.policy), { consistency: "strong" })).value?.committed_requests ?? 0;
      // The source is held open behind an explicit gate: a small finite body
      // can be fully sent before the client cancels, and that is a delivered
      // response, not an interruption. The gate resolves only from the
      // producer's own cancel, so the client abort below is what ends a
      // demonstrably still-open upstream.
      // The chronology is per-scenario: the holder above already cancelled its
      // own source, so this window starts empty for the disconnect evidence.
      harness.events.length = 0;
      harness.setMode("stream-hold");
      const disconnectAbort = new AbortController();
      const disconnect = await postJson(harness, "/v1/chat/completions", chatBody({ stream: true }), {}, disconnectAbort.signal);
      const disconnectId = disconnect.headers.get("x-uos-request-id");
      assert.ok(disconnectId, "the disconnect response must carry the gateway request id");
      const partial = await readSseUntil(disconnect, (text) => text.includes("held"));
      assert.ok(partial.reached, "the disconnecting client must receive answer and usage while the source is open");
      assert.equal(harness.events.includes("producer_cancelled"), false, "the controlled source must still be open at disconnect time");
      harness.events.push("client_aborted");
      disconnectAbort.abort(new DOMException("client disconnected after output", "AbortError"));
      await partial.reader.cancel(disconnectAbort.signal.reason).catch(() => {});
      await waitFor(() => harness.events.includes("producer_cancelled"), "the gateway to cancel the still-open upstream");
      await waitFor(() => terminals.some((entry) => entry.request_id === disconnectId), "the disconnect terminal log");
      await waitFor(() => harness.controller.snapshot().active === 0, "the disconnect permit to be released");
      await delay(50);
      assert.equal(harness.controller.snapshot().active, 0, "a settled request must not release its permit twice");
      const disconnectTerminal = terminals.filter((entry) => entry.request_id === disconnectId);
      assert.equal(disconnectTerminal.length, 1, "one request must produce exactly one terminal record");
      assert.equal(disconnectTerminal[0].delivery_outcome, "interrupted");
      assert.ok(
        harness.events.indexOf("client_aborted") < harness.events.indexOf("producer_cancelled"),
        `client abort must precede producer cancellation, observed ${JSON.stringify(harness.events)}`
      );
      // The chat request stays dispatched and charged exactly once, and the
      // usage the provider already sent survives the interruption.
      const chatRequestRow = await harness.kv.get<ApiKeyUsageRequestV3>(apiKeyUsageV3RequestKey(harness.policy, disconnectId), { consistency: "strong" });
      assert.equal(chatRequestRow.value?.state, "dispatched", "a disconnect must not refund a dispatched reservation");
      const chatWindowRow = await harness.kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(harness.policy), { consistency: "strong" });
      assert.equal(chatWindowRow.value?.committed_requests, committedBeforeDisconnect + 1, "the chat disconnect must add exactly one charge");
      assert.equal(disconnectTerminal[0].usage_observed, true, "chat usage observed before the disconnect must be reported");
      assert.equal(disconnectTerminal[0].input_tokens, 3, "the observed chat input tokens must survive the interruption");
      assert.equal(disconnectTerminal[0].output_tokens, 1, "the observed chat output tokens must survive the interruption");
      assert.equal(disconnectTerminal[0].total_tokens, 4, "the observed chat total tokens must survive the interruption");
      assert.equal(disconnectTerminal[0].cached_input_tokens, null, "cache usage the provider never sent stays unknown");
      assert.equal(disconnectTerminal[0].usage_telemetry_status, "partial", "core counters with an unsent cache read stay partial, never completed");

      // The Responses adapter owns the same local cancellation, so the same
      // held-open source and real abort must interrupt it as well.
      const committedBeforeResponses =
        (await harness.kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(harness.policy), { consistency: "strong" })).value?.committed_requests ?? 0;
      harness.events.length = 0;
      harness.setMode("stream-hold");
      const responsesAbort = new AbortController();
      const responsesDisconnect = await postJson(harness, "/v1/responses", responsesBody({ stream: true }), {}, responsesAbort.signal);
      const responsesId = responsesDisconnect.headers.get("x-uos-request-id");
      assert.ok(responsesId, "the Responses disconnect response must carry the gateway request id");
      const responsesPartial = await readSseUntil(responsesDisconnect, (text) => text.includes("held"));
      assert.ok(responsesPartial.reached, "the Responses client must receive output while the source is open");
      assert.equal(harness.events.includes("producer_cancelled"), false, "the Responses source must still be open at disconnect time");
      harness.events.push("client_aborted");
      responsesAbort.abort(new DOMException("client disconnected after output", "AbortError"));
      await responsesPartial.reader.cancel(responsesAbort.signal.reason).catch(() => {});
      await waitFor(() => harness.events.includes("producer_cancelled"), "the gateway to cancel the still-open Responses upstream");
      await waitFor(() => terminals.some((entry) => entry.request_id === responsesId), "the Responses disconnect terminal log");
      await waitFor(() => harness.controller.snapshot().active === 0, "the Responses disconnect permit to be released");
      const responsesTerminals = terminals.filter((entry) => entry.request_id === responsesId);
      assert.equal(responsesTerminals.length, 1, "the Responses disconnect must produce exactly one terminal record");
      assert.equal(responsesTerminals[0].delivery_outcome, "interrupted");
      const responsesRequestRow = await harness.kv.get<ApiKeyUsageRequestV3>(apiKeyUsageV3RequestKey(harness.policy, responsesId), { consistency: "strong" });
      assert.equal(responsesRequestRow.value?.state, "dispatched", "the Responses disconnect must not refund a dispatched reservation");
      const responsesWindowRow = await harness.kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(harness.policy), { consistency: "strong" });
      assert.equal(responsesWindowRow.value?.committed_requests, committedBeforeResponses + 1, "the Responses disconnect must add exactly one charge");
      assert.equal(responsesTerminals[0].usage_observed, true, "Responses usage observed before the disconnect must be reported");
      assert.equal(responsesTerminals[0].input_tokens, 3, "the observed Responses input tokens must survive the interruption");
      assert.equal(responsesTerminals[0].output_tokens, 1, "the observed Responses output tokens must survive the interruption");
      assert.equal(responsesTerminals[0].total_tokens, 4, "the observed Responses total tokens must survive the interruption");
      assert.equal(responsesTerminals[0].cached_input_tokens, null, "cache usage the provider never sent stays unknown");

      // Queue waiting is reported separately from provider latency.
      const acceptedWithWait = accepted.find((entry) => entry.request_id === holderId);
      assert.ok(acceptedWithWait, "the holder must publish its accepted record");
      assert.equal(typeof acceptedWithWait.queue_wait_ms, "number");
    } finally {
      console.info = originalInfo;
      (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    }
  } finally {
    harness.releaseHold();
    await stop();
    if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
  }
}, 300_000);

test("oss gateway real HTTP: durable failure evidence survives a stalled optional-analytics shutdown", async () => {
  const originalInfo = console.info;
  const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  const originalMeteredKey = process.env.METERED_API_KEY;
  const terminalLogs: Record<string, unknown>[] = [];
  const info: unknown[][] = [];
  const harness = await startHarness();
  const stop = harness.stop;
  try {
    assert.equal(originalSurplusKey, undefined, "no paid Surplus credential may be present; `bun run test` removes it and skips .env");
    assert.equal(originalMeteredKey, undefined, "no paid Metered credential may be present; `bun run test` removes it and skips .env");
    delete process.env.SURPLUS_API_KEY;
    delete process.env.METERED_API_KEY;
    process.env.DEEPSEEK_API_KEY = "oss-http-dummy-deepseek-key";
    const { config } = await import("../src/config.ts");
    const originalDeployFlag = config.isDeploy;
    (config as { isDeploy: boolean }).isDeploy = true;
    console.info = (...args: unknown[]) => {
      info.push(args);
      const [label, payload] = args.map(String);
      if (label === "[ai.ubq.fi] request_terminal" && payload) terminalLogs.push(JSON.parse(payload) as Record<string, unknown>);
    };

    try {
      // A controlled transport fault produces a durable admin-error record.
      harness.setMode("upstream-500");
      const faulted = await postJson(harness, "/v1/responses", responsesBody({ stream: true }));
      const faultedId = faulted.headers.get("x-uos-request-id");
      assert.ok(faultedId, "the failed response must carry the gateway request id");
      assert.ok(faulted.status >= 500);
      await faulted.body?.cancel().catch(() => {});
      let adminError: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 100 && adminError === null; attempt += 1) {
        for await (const entry of harness.kv.list<Record<string, unknown>>({ prefix: [...ADMIN_ERROR_LOG_PREFIX] }, { consistency: "strong" })) {
          if (entry.value.request_id === faultedId) {
            adminError = entry.value;
            break;
          }
        }
        if (adminError === null) await delay(10);
      }
      assert.ok(adminError, "the durable admin error evidence must be written for a failed request");
      assert.equal(typeof adminError.failure_kind, "string", "the durable record must name the failure kind");
      assert.ok(
        terminalLogs.some((entry) => entry.request_id === faultedId),
        "the terminal record must be published"
      );

      // The optional analytics path is optional: the local artifact's unknown
      // release gate keeps it inactive, and the response/durable evidence above
      // never depended on it.
      assert.equal(optionalPromptCacheAnalyticsSnapshot(), null, "no optional sample is required to serve a request");

      // The real module queue is exercised through its existing seam with a
      // sink that never progresses. The exported bounded shutdown must settle
      // under its own absolute deadline, retain the in-flight entry and report
      // that incompleteness with sanitized counters only.
      const RELEASE = "0123456789abcdef0123456789abcdef01234567";
      // Every terminal write through this handle parks forever: the cohort
      // admission awaits `getMany` and the counter commit awaits `commit`, so
      // the optional writer can neither settle nor throw. Nothing here touches
      // the real KV, so durable evidence above stays provably independent.
      const neverSettles = (): Promise<never> => new Promise<never>(() => {});
      const stalledOperation = new Proxy({} as Record<string, unknown>, {
        get: (_target, property) => (property === "commit" ? neverSettles : () => stalledOperation),
      });
      const stalledKv = new Proxy({} as Kv, {
        get: (_target, property) => (property === "atomic" ? () => stalledOperation : neverSettles),
      });
      const queued = await enqueuePromptCacheAnalytics(
        {
          provider: "chatgpt_codex",
          model: "oss-http-optional-analytics",
          route: "responses",
          status: 200,
          completed: true,
          usageTelemetryStatus: "reported",
          inputTokens: 120,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          promptCacheKeyPresent: true,
          promptCacheMode: "explicit",
          fallbackReason: null,
        },
        { release: RELEASE, kv: stalledKv, now: () => Date.now() }
      );
      assert.equal(queued.status, "queued", "the optional sample must enter the bounded queue");
      const { shutdownOptionalTelemetry } = await import("../serve.ts");
      const shutdownStartedAt = performance.now();
      await shutdownOptionalTelemetry();
      const shutdownMs = performance.now() - shutdownStartedAt;
      assert.ok(shutdownMs < 8_000, `bounded shutdown must settle near its own deadline, observed ${Math.round(shutdownMs)}ms`);

      const shutdownLines = info.filter((args) => String(args[0]) === "[ai.ubq.fi] optional_telemetry_shutdown");
      assert.equal(shutdownLines.length, 1, "shutdown must publish exactly one sanitized snapshot");
      const snapshot = JSON.parse(String(shutdownLines[0][1])) as Record<string, unknown>;
      assert.equal(snapshot.shutdown_incomplete, true, "a stalled optional write must be reported as an incomplete drain");
      assert.ok(Number(snapshot.drain_timeouts) >= 1);
      assert.ok(Number(snapshot.writes_in_flight) >= 1, "the unresolved write stays retained as bounded capacity");
      assert.ok(Number(snapshot.retained_entries) >= 1, "charged entries must include the unresolved in-flight write");
      assert.deepEqual(
        Object.keys(snapshot).sort((a, b) => a.localeCompare(b)),
        [
          "delivered",
          "drain_timeouts",
          "dropped_after_closed",
          "dropped_by_age",
          "dropped_by_bytes",
          "dropped_by_entries",
          "enqueued",
          "failed",
          "last_error_class",
          "queued_entries",
          "retained_bytes",
          "retained_entries",
          "shutdown_incomplete",
          "writes_in_flight",
        ],
        "the shutdown snapshot carries counters only, never model text, prompts or keys"
      );
    } finally {
      console.info = originalInfo;
      (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    }
  } finally {
    harness.releaseHold();
    await stop();
    if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
  }
}, 300_000);

test("oss gateway real HTTP: a completed text-only progress stop makes exactly one provider dispatch", async () => {
  const originalInfo = console.info;
  const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  const originalMeteredKey = process.env.METERED_API_KEY;
  const terminalLogs: Record<string, unknown>[] = [];
  const harness = await startHarness();
  const stop = harness.stop;
  try {
    assert.equal(originalSurplusKey, undefined, "no paid Surplus credential may be present; `bun run test` removes it and skips .env");
    assert.equal(originalMeteredKey, undefined, "no paid Metered credential may be present; `bun run test` removes it and skips .env");
    delete process.env.SURPLUS_API_KEY;
    delete process.env.METERED_API_KEY;
    process.env.DEEPSEEK_API_KEY = "oss-http-dummy-deepseek-key";
    const { config } = await import("../src/config.ts");
    const originalDeployFlag = config.isDeploy;
    (config as { isDeploy: boolean }).isDeploy = true;
    console.info = (...args: unknown[]) => {
      const [label, payload] = args.map(String);
      if (label === "[ai.ubq.fi] request_terminal" && payload) terminalLogs.push(JSON.parse(payload) as Record<string, unknown>);
    };

    try {
      const committedBefore =
        (await harness.kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(harness.policy), { consistency: "strong" })).value?.committed_requests ?? 0;
      harness.events.length = 0;
      harness.setMode("responses-progress-stop");
      const response = await postJson(
        harness,
        "/v1/responses",
        responsesBody({
          stream: true,
          max_output_tokens: 64,
          tool_choice: "auto",
          tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
        })
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-uos-upstream"), "deepseek");
      const requestId = response.headers.get("x-uos-request-id");
      assert.ok(requestId, "the client request must carry the gateway request id");

      // The first leg streams progressively and is drained to its terminal.
      const received = await response.text();
      assert.ok(received.includes("Step 11 of 16 complete."), "the provider's own text must reach the client");
      assert.equal(received.split('"type":"response.completed"').length - 1, 1, "one client response must produce exactly one completed terminal");
      assert.equal(received.includes("function_call"), false, "a text-only answer must not carry a tool call");

      // Exactly one provider dispatch, carrying the caller's cap and tool.
      assert.equal(harness.calls.length, 1, "a completed text-only progress stop must make exactly one provider request");
      const firstLegBody = JSON.parse(harness.calls[0].body) as Record<string, unknown>;
      assert.equal(firstLegBody.max_tokens, 64, "the first leg must send the caller's measured allowance");
      assert.equal(firstLegBody.tool_choice, "auto", "the caller's automatic tool choice must reach the provider");
      assert.equal(Array.isArray(firstLegBody.tools) ? firstLegBody.tools.length : 0, 1, "the advertised tool must reach the provider");

      await waitFor(() => terminalLogs.some((entry) => entry.request_id === requestId), "the completed terminal record");
      await waitFor(() => harness.controller.snapshot().active === 0, "the single permit release");
      await delay(50);
      assert.equal(harness.controller.snapshot().active, 0, "the permit must not be released twice");
      // No dispatch may be issued after the response completed.
      assert.equal(harness.calls.length, 1, "the completed response must never dispatch a second provider request");

      const terminals = terminalLogs.filter((entry) => entry.request_id === requestId);
      assert.equal(terminals.length, 1, "one client request must produce exactly one terminal record");
      assert.equal(terminals[0].delivery_outcome, "delivered");
      // The one measured first call's usage and cache details are reported as-is.
      assert.equal(terminals[0].usage_observed, true);
      assert.equal(terminals[0].input_tokens, 120);
      assert.equal(terminals[0].output_tokens, 20);
      assert.equal(terminals[0].total_tokens, 140);
      assert.equal(terminals[0].cached_input_tokens, 64, "measured cache reads must be preserved");
      assert.equal(terminals[0].usage_telemetry_status, "reported", "one measured call is a complete total");

      // One flat client-request charge with no paid fallback.
      const requestRow = await harness.kv.get<ApiKeyUsageRequestV3>(apiKeyUsageV3RequestKey(harness.policy, requestId), { consistency: "strong" });
      assert.equal(requestRow.value?.state, "dispatched", "the client request stays charged");
      const windowRow = await harness.kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(harness.policy), { consistency: "strong" });
      assert.equal(windowRow.value?.committed_requests, committedBefore + 1, "one provider dispatch is exactly one client-request charge");
    } finally {
      console.info = originalInfo;
      (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    }
  } finally {
    harness.releaseHold();
    await stop();
    if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
  }
}, 300_000);

test("oss gateway real HTTP: a call_id-less function_call_output is dropped before dispatch", async () => {
  const originalInfo = console.info;
  const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  const originalMeteredKey = process.env.METERED_API_KEY;
  const harness = await startHarness();
  const stop = harness.stop;
  try {
    assert.equal(originalSurplusKey, undefined, "no paid Surplus credential may be present; `bun run test` removes it and skips .env");
    assert.equal(originalMeteredKey, undefined, "no paid Metered credential may be present; `bun run test` removes it and skips .env");
    delete process.env.SURPLUS_API_KEY;
    delete process.env.METERED_API_KEY;
    process.env.DEEPSEEK_API_KEY = "oss-http-dummy-deepseek-key";
    const { config } = await import("../src/config.ts");
    const originalDeployFlag = config.isDeploy;
    (config as { isDeploy: boolean }).isDeploy = true;
    console.info = () => {};

    try {
      // A stored Codex thread can replay a named unpaired output (no call_id)
      // beside a normal user message. Chat cannot answer it, so the projection
      // drops it and the request still completes.
      harness.setMode("chat-buffered-answer");
      const completed = await postJson(
        harness,
        "/v1/responses",
        responsesBody({
          stream: false,
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "deliver it" }] },
            {
              type: "function_call_output",
              name: "send_message_to_thread",
              namespace: "codex_tui",
              output: "<codex_delegation>\n  <input>Continue the task</input>\n</codex_delegation>",
            },
          ],
        })
      );
      assert.equal(completed.status, 200);
      const payload = (await completed.json()) as Record<string, unknown>;
      assert.equal(payload.status, "completed");
      assert.equal(payload.error, null);

      // The provider body carries only the user turn: the unpaired output has
      // no Chat destination, and a bare `tool` message would be a protocol error.
      assert.equal(harness.calls.length, 1, "the completed request must dispatch exactly once");
      const upstreamBody = JSON.parse(harness.calls[0].body) as { messages: Record<string, unknown>[] };
      assert.deepEqual(upstreamBody.messages, [{ role: "user", content: "deliver it" }]);

      // The malformed shapes still fail closed before any provider dispatch.
      const malformedCall = await postJson(harness, "/v1/responses", responsesBody({ stream: false, input: [{ type: "function_call", name: "lookup" }] }));
      assert.equal(malformedCall.status, 400);
      const malformedError = (await malformedCall.json()) as { error: { message: string; param: string } };
      assert.equal(malformedError.error.param, "input");
      assert.equal(malformedError.error.message, "function_call items require call_id and name");

      const unknownType = await postJson(harness, "/v1/responses", responsesBody({ stream: false, input: [{ type: "computer_call", call_id: "c" }] }));
      assert.equal(unknownType.status, 400);
      const unknownError = (await unknownType.json()) as { error: { message: string; param: string } };
      assert.equal(unknownError.error.param, "input.type");
      assert.equal(unknownError.error.message, "input item type 'computer_call' is not supported");

      assert.equal(harness.calls.length, 1, "rejected item shapes must never reach the provider");
    } finally {
      console.info = originalInfo;
      (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    }
  } finally {
    harness.releaseHold();
    await stop();
    if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
  }
}, 300_000);

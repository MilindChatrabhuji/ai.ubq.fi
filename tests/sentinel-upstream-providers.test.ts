import assert from "node:assert/strict";
import { apiKeyHashKey, apiKeyIdKey } from "../src/api-keys.ts";
import { ApiKeyQuotaDispatchError } from "../src/api-key-policy.ts";
import { CEREBRAS_CHAT_COMPLETIONS_URL, fetchCerebrasChatCompletions } from "../src/provider/cerebras.ts";
import { CLAUDE_CODE_BASE_URL } from "../src/provider/claude-code.ts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL, fetchDeepSeekChatCompletions } from "../src/deepseek/index.ts";
import { LITHOS_CHAT_COMPLETIONS_URL } from "../src/provider/lithos.ts";
import { OPENROUTER_CHAT_COMPLETIONS_URL } from "../src/provider/openrouter.ts";
import {
  CODEX_AUTH_POOL_KV_KEY,
  fetchCodexResponses,
  getCodexResponseActiveTelemetry,
  getCodexResponseSlot,
  markCodexResponseCompleted,
  resetCodexAuthCacheForTest,
} from "../src/codex/index.ts";
import { resetCodexAccountRoutingForTest } from "../src/codex/account-routing.ts";
import { config } from "../src/config.ts";
import { setKvForTest } from "../src/kv.ts";
import { fetchMeteredResponses, METERED_BASE_URL } from "../src/provider/metered.ts";
import { resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import { resetRuntimeConfigCacheForTest, RUNTIME_CONFIG_V2_KEY } from "../src/runtime-config.ts";
import { fetchSurplusResponses, SURPLUS_BASE_URL, SurplusError } from "../src/provider/surplus.ts";
import {
  decryptExportedSentinelReplay,
  type ExportedSentinelReplayCapture,
  inspectSentinelSse,
  resolveSentinelClientFailureObservation,
  type SentinelFailureObservation,
  shouldPersistSentinelReplay,
} from "../src/sentinel/replay-capture.ts";
import {
  createSentinelUpstreamRecorder,
  type SentinelUpstreamAttempt,
  type SentinelUpstreamContentType,
  type SentinelUpstreamProvider,
  type SentinelUpstreamTerminal,
  type SentinelUpstreamTrace,
} from "../src/sentinel/upstream-capture.ts";
import { createRecordedUpstreamReplay } from "./helpers/sentinel-recorded-upstream.ts";
import sentinelHistoricalFraming from "./fixtures/sentinel-historical-framing.json" with { type: "json" };
import { base64UrlDecode, base64UrlEncode, encodeHex, sha256Base64Url } from "../src/utils.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../src/types.ts";

const { default: handler } = await import("../src/handler/index.ts");

const kvAvailable = typeof Deno.openKv === "function";

const encoder = new TextEncoder();

const CODEX_RESPONSES_URL = `${config.codexBaseUrl}/responses`;
const CODEX_REFRESH_URL = "https://auth.openai.com/oauth/token";

/**
 * Trusted fixture route map: distinct exact HTTPS endpoint strings per provider
 * enum. Only synthetic public test data is committed; nothing here is a secret.
 */
const REPLAY_ROUTES: Readonly<Record<SentinelUpstreamProvider, string>> = Object.freeze({
  chatgpt_codex: CODEX_RESPONSES_URL,
  claude_code: `${CLAUDE_CODE_BASE_URL}/v1/messages`,
  surplus: `${SURPLUS_BASE_URL}/v1/responses`,
  metered: `${METERED_BASE_URL}/v1/responses`,
  cerebras: CEREBRAS_CHAT_COMPLETIONS_URL,
  deepseek: DEEPSEEK_CHAT_COMPLETIONS_URL,
  lithos: LITHOS_CHAT_COMPLETIONS_URL,
  openrouter: OPENROUTER_CHAT_COMPLETIONS_URL,
});

const decodeChunks = (trace: ReturnType<ReturnType<typeof createSentinelUpstreamRecorder>["snapshotAndSeal"]>): string =>
  trace.attempts
    .flatMap((attempt) => attempt.chunks_base64.map((chunk) => base64UrlDecode(chunk)))
    .reduce((text, bytes) => text + new TextDecoder().decode(bytes), "");

/**
 * Base64url of a JSON fixture value. Padding is stripped by one backward scan
 * from the end instead of a quantified matcher anchored to the end of the
 * subject, which re-tried every start position and was non-linear on a long run
 * of padding characters. The result is the same for every input: only the
 * trailing run of `=` is ever removed.
 */
const base64Url = (value: unknown): string => {
  const encoded = btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_");
  let end = encoded.length;
  while (end > 0 && encoded[end - 1] === "=") end -= 1;
  return encoded.slice(0, end);
};

const replayAttempt = (
  provider: SentinelUpstreamProvider,
  status: number | null,
  contentType: SentinelUpstreamContentType | null,
  terminal: SentinelUpstreamTerminal,
  chunksText: readonly string[] = []
): SentinelUpstreamAttempt => ({
  provider,
  status,
  content_type: contentType,
  chunks_base64: chunksText.map((text) => btoa(text)),
  terminal,
});

const replayTrace = (
  attempts: readonly SentinelUpstreamAttempt[],
  flags: Partial<Pick<SentinelUpstreamTrace, "attempts_truncated" | "bytes_truncated" | "chunks_truncated">> = {}
): SentinelUpstreamTrace => ({
  version: 1,
  attempts,
  attempts_truncated: false,
  bytes_truncated: false,
  chunks_truncated: false,
  ...flags,
});

Deno.test({
  name: "actual Surplus fetch captures pre-normalization SSE bytes and stays lazy until the consumer reads",
  async fn() {
    const recorder = createSentinelUpstreamRecorder();
    const rawChunks: string[] = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_raw", created_at: 0 } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello" })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_raw", model: "surplus-fixture", output: [] },
      })}\n\n`,
    ];
    const rawText = rawChunks.join("");
    let pulls = 0;
    const pending = [...rawChunks];
    const fetcher = (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls += 1;
                const next = pending.shift() ?? null;
                if (next === null) {
                  controller.close();
                  return;
                }
                controller.enqueue(encoder.encode(next));
              },
            },
            { highWaterMark: 0 }
          ),
          { status: 200, headers: { "Content-Type": "text/event-stream", "X-Request-Id": "surplus-raw-1" } }
        )
      );
    const result = await fetchSurplusResponses(
      { model: "surplus-fixture", input: "hello" },
      { apiKey: "surplus-fixture-key", fetcher, sentinelUpstreamRecorder: recorder }
    );
    assert.equal(result.request_id, "surplus-raw-1");
    assert.equal(result.response.status, 200);
    // The normalizer's existing ReadableStream may prefetch exactly one chunk
    // (its own default high-water-mark); the recorder itself never reads
    // ahead, which the recorder-level lazy test proves directly. No drain may
    // occur here.
    assert.equal(pulls <= 1, true, "the provider must not drain the raw upstream bytes");
    const normalizedText = await result.response.text();
    assert.equal(pulls, rawChunks.length, "each raw chunk is read exactly once");
    const trace = recorder.snapshotAndSeal();
    assert.equal(trace.attempts.length, 1);
    const attempt = trace.attempts[0];
    assert.equal(attempt.provider, "surplus");
    assert.equal(attempt.status, 200);
    assert.equal(attempt.content_type, "text/event-stream");
    // The normalizer returns after the parsed terminal event and cancels the
    // source, so this is a consumed prefix: cancelled is the truthful
    // terminal, never a claim of complete raw network EOF.
    assert.equal(attempt.terminal, "cancelled");
    // The captured bytes are the raw pre-normalization SSE framing, while the
    // returned body is the normalizer's re-encoded event stream.
    assert.equal(decodeChunks(trace), rawText, "captured bytes must be the exact raw upstream SSE");
    assert.equal(decodeChunks(trace).startsWith("data: "), true);
    assert.equal(normalizedText.startsWith("event: response.created"), true);
    assert.equal(normalizedText.includes("output_text.done"), true);
    recorder.dispose();
  },
});

Deno.test("actual Surplus no-header fetch failure records fetch_error without inventing headers", async () => {
  const recorder = createSentinelUpstreamRecorder();
  await assert.rejects(
    fetchSurplusResponses(
      { model: "surplus-fixture", input: "hello" },
      {
        apiKey: "surplus-fixture-key",
        fetcher: () => Promise.reject(new TypeError("surplus socket closed")),
        sentinelUpstreamRecorder: recorder,
      }
    ),
    (error: unknown) => error instanceof SurplusError && error.code === "surplus_upstream_unreachable"
  );
  const trace = recorder.snapshotAndSeal();
  assert.equal(trace.attempts.length, 1);
  assert.deepEqual(
    trace.attempts.map(({ status, content_type: contentType, terminal, chunks_base64: chunksBase64 }) => ({
      status,
      content_type: contentType,
      terminal,
      chunks_base64: chunksBase64,
    })),
    [{ status: null, content_type: null, terminal: "fetch_error", chunks_base64: [] }]
  );
  recorder.dispose();
});

Deno.test("quota denial never opens a dispatch slot on any paid provider", async () => {
  const quota = new ApiKeyQuotaDispatchError("quota denied", {
    status: 429,
    code: "quota_denied",
    errorType: "server_error",
  });
  let dispatchAttempts = 0;
  const untouchedFetcher = (): Promise<Response> => {
    dispatchAttempts += 1;
    return Promise.reject(new Error("must not dispatch"));
  };

  const surplusRecorder = createSentinelUpstreamRecorder();
  await assert.rejects(
    fetchSurplusResponses(
      { model: "surplus-fixture", input: "hello" },
      {
        apiKey: "surplus-fixture-key",
        beforeDispatch: () => Promise.reject(quota),
        fetcher: untouchedFetcher,
        sentinelUpstreamRecorder: surplusRecorder,
      }
    ),
    ApiKeyQuotaDispatchError
  );
  assert.equal(surplusRecorder.snapshotAndSeal().attempts.length, 0);

  const meteredRecorder = createSentinelUpstreamRecorder();
  await assert.rejects(
    fetchMeteredResponses(
      { model: "metered-fixture", input: "hello" },
      {
        apiKey: "metered-fixture-key",
        beforeDispatch: () => Promise.reject(quota),
        fetcher: untouchedFetcher,
        sentinelUpstreamRecorder: meteredRecorder,
      }
    ),
    ApiKeyQuotaDispatchError
  );
  assert.equal(meteredRecorder.snapshotAndSeal().attempts.length, 0);

  const cerebrasRecorder = createSentinelUpstreamRecorder();
  await assert.rejects(
    fetchCerebrasChatCompletions(
      { model: "gpt-oss-120b", messages: [{ role: "user", content: "hello" }] },
      {
        apiKey: "cerebras-fixture-key",
        beforeDispatch: () => Promise.reject(quota),
        fetcher: untouchedFetcher,
        sentinelUpstreamRecorder: cerebrasRecorder,
      }
    ),
    ApiKeyQuotaDispatchError
  );
  assert.equal(cerebrasRecorder.snapshotAndSeal().attempts.length, 0);
  assert.equal(dispatchAttempts, 0, "no provider fetch may run after admission denial");
});

Deno.test("actual Metered dispatch returns the exact upstream body and bounded headers", async () => {
  const recorder = createSentinelUpstreamRecorder();
  const rawSse =
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_metered", created_at: 0 } })}\n\n` +
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_metered" } })}\n\n`;
  const fetcher = (): Promise<Response> =>
    Promise.resolve(
      new Response(rawSse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "X-Oneapi-Request-Id": "metered-id-1" },
      })
    );
  const result = await fetchMeteredResponses(
    { model: "metered-fixture", input: "hello" },
    { apiKey: "metered-fixture-key", fetcher, sentinelUpstreamRecorder: recorder }
  );
  assert.equal(result.request_id, "metered-id-1");
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), rawSse);
  const attempt = recorder.snapshotAndSeal().attempts[0];
  assert.ok(attempt, "a dispatched provider must record its attempt");
  assert.equal(attempt.provider, "metered");
  assert.equal(attempt.status, 200);
  assert.equal(attempt.content_type, "text/event-stream");
  assert.equal(attempt.terminal, "eof");
  recorder.dispose();

  const noHeaderRecorder = createSentinelUpstreamRecorder();
  await assert.rejects(
    fetchMeteredResponses(
      { model: "metered-fixture", input: "hello" },
      {
        apiKey: "metered-fixture-key",
        fetcher: () => Promise.reject(new TypeError("metered socket closed")),
        sentinelUpstreamRecorder: noHeaderRecorder,
      }
    ),
    (error: unknown) => error instanceof Error && error.name === "MeteredError"
  );
  assert.equal(noHeaderRecorder.snapshotAndSeal().attempts[0]?.terminal, "fetch_error");
  noHeaderRecorder.dispose();
});

Deno.test("actual Cerebras dispatch returns the exact upstream body and records the attempt", async () => {
  const recorder = createSentinelUpstreamRecorder();
  const rawJson = JSON.stringify({ id: "cerebras-1", object: "chat.completion", choices: [{ index: 0 }] });
  const fetcher = (): Promise<Response> => Promise.resolve(new Response(rawJson, { status: 200, headers: { "Content-Type": "application/json" } }));
  const response = await fetchCerebrasChatCompletions(
    { model: "gpt-oss-120b", messages: [{ role: "user", content: "hello" }] },
    { apiKey: "cerebras-fixture-key", fetcher, sentinelUpstreamRecorder: recorder }
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), rawJson);
  const attempt = recorder.snapshotAndSeal().attempts[0];
  assert.ok(attempt, "a dispatched provider must record its attempt");
  assert.equal(attempt.provider, "cerebras");
  assert.equal(attempt.status, 200);
  assert.equal(attempt.content_type, "application/json");
  assert.equal(attempt.terminal, "eof");
  recorder.dispose();

  const noHeaderRecorder = createSentinelUpstreamRecorder();
  await assert.rejects(
    fetchCerebrasChatCompletions(
      { model: "gpt-oss-120b", messages: [{ role: "user", content: "hello" }] },
      {
        apiKey: "cerebras-fixture-key",
        fetcher: () => Promise.reject(new TypeError("cerebras socket closed")),
        sentinelUpstreamRecorder: noHeaderRecorder,
      }
    ),
    (error: unknown) => error instanceof Error && error.name === "CerebrasError"
  );
  assert.equal(noHeaderRecorder.snapshotAndSeal().attempts[0]?.terminal, "fetch_error");
  noHeaderRecorder.dispose();
});

Deno.test("actual DeepSeek dispatch returns the exact upstream body and records the attempt", async () => {
  const recorder = createSentinelUpstreamRecorder();
  const rawJson = JSON.stringify({ id: "deepseek-1", object: "chat.completion", choices: [{ index: 0 }] });
  let dispatchedBody: Record<string, unknown> | null = null;
  const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let requestUrl: string;
    if (typeof input === "string") requestUrl = input;
    else if (input instanceof URL) requestUrl = input.href;
    else requestUrl = input.url;
    assert.equal(requestUrl, DEEPSEEK_CHAT_COMPLETIONS_URL);
    if (typeof init?.body !== "string") throw new Error("DeepSeek sentinel fixture expected a string request body");
    dispatchedBody = JSON.parse(init.body) as Record<string, unknown>;
    return Promise.resolve(new Response(rawJson, { status: 200, headers: { "Content-Type": "application/json" } }));
  };
  const response = await fetchDeepSeekChatCompletions(
    { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hello" }], max_completion_tokens: 512 },
    "deepseek-v4-flash",
    { apiKey: "deepseek-fixture-key", fetcher, sentinelUpstreamRecorder: recorder }
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), rawJson);
  assert.deepEqual(dispatchedBody, { model: "deepseek-flash", messages: [{ role: "user", content: "hello" }], max_tokens: 512 });
  const attempt = recorder.snapshotAndSeal().attempts[0];
  assert.ok(attempt, "a dispatched provider must record its attempt");
  assert.equal(attempt.provider, "deepseek");
  assert.equal(attempt.status, 200);
  assert.equal(attempt.content_type, "application/json");
  assert.equal(attempt.terminal, "eof");
  recorder.dispose();

  const noHeaderRecorder = createSentinelUpstreamRecorder();
  await assert.rejects(
    fetchDeepSeekChatCompletions({ model: "deepseek-flash", messages: [{ role: "user", content: "hello" }] }, "deepseek-flash", {
      apiKey: "deepseek-fixture-key",
      fetcher: () => Promise.reject(new TypeError("deepseek socket closed")),
      sentinelUpstreamRecorder: noHeaderRecorder,
    }),
    (error: unknown) => error instanceof Error && error.name === "DeepSeekError"
  );
  assert.equal(noHeaderRecorder.snapshotAndSeal().attempts[0]?.terminal, "fetch_error");
  noHeaderRecorder.dispose();
});

Deno.test({
  name: "actual Codex intermediate retries each count as an attempt and the wrapper is the WeakMap identity",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const nowMs = 1_700_000_000_000;
    Date.now = () => nowMs;
    const auth = (label: string): CodexAuthState => ({
      access_token: `${base64Url({ alg: "none" })}.${base64Url({ exp: (nowMs + 60 * 60_000) / 1_000 })}.${label}`,
      refresh_token: `refresh-${label}`,
      account_id: `account-${label}`,
      updated_at_ms: nowMs,
    });
    const pool = (...accounts: CodexAuthState[]): CodexAuthPoolState => ({ accounts, updated_at_ms: nowMs });
    await kv.set(CODEX_AUTH_POOL_KV_KEY, pool(auth("one"), auth("two")));
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    resetProviderHealthThrottleForTest();
    let shouldQuotaFailOne = false;
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      if (request.url === CODEX_REFRESH_URL) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "refreshed-one" }), { status: 200 }));
      }
      const accountId = request.headers.get("ChatGPT-Account-ID") ?? "";
      if (shouldQuotaFailOne && accountId === "account-one") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": new Date(nowMs + 60_000).toUTCString() },
          })
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const body = () => ({ model: "gpt-5.6-luna", prompt_cache_key: "cache-recorder-weakmap", input: "fixture" });
    try {
      const recorder = createSentinelUpstreamRecorder();
      const first = await fetchCodexResponses(body(), {
        cacheScope: "api-key:recorder-weakmap",
        sentinelUpstreamRecorder: recorder,
      });
      assert.equal(getCodexResponseSlot(first), 1, "the wrapper must be the registered WeakMap identity");
      await markCodexResponseCompleted(first);
      recorder.dispose();
      assert.equal(recorder.snapshotAndSeal().attempts.length, 1);

      shouldQuotaFailOne = true;
      const remapRecorder = createSentinelUpstreamRecorder();
      const remapped = await fetchCodexResponses(body(), {
        cacheScope: "api-key:recorder-weakmap",
        sentinelUpstreamRecorder: remapRecorder,
      });
      shouldQuotaFailOne = false;
      assert.equal(remapped.status, 200);
      assert.equal(getCodexResponseSlot(remapped), 2, "account two is the canonical wrapper identity");
      assert.deepEqual(getCodexResponseActiveTelemetry(remapped), { activeGeneration: 2, activeTransitionReason: "quota_exhausted" });
      await remapped.text();
      const trace = remapRecorder.snapshotAndSeal();
      assert.deepEqual(
        trace.attempts.map(({ provider, status, terminal }) => ({ provider, status, terminal })),
        [
          { provider: "chatgpt_codex", status: 429, terminal: "eof" },
          { provider: "chatgpt_codex", status: 200, terminal: "eof" },
        ],
        "each intermediate retry counts as its own attempt in dispatch order"
      );
      assert.equal(trace.attempts[0].chunks_base64.length > 0, true, "the 429 body read for classification is raw evidence");
      remapRecorder.dispose();
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      resetCodexAuthCacheForTest();
      resetCodexAccountRoutingForTest();
      resetProviderHealthThrottleForTest();
      kv.close();
      setKvForTest(null);
    }
  },
});

const SUPER_ADMIN_TOKEN = "sentinel-upstream-provider-super-admin";
const MARKER = "sentinel-upstream-handler-marker-71c3e59a";
const RAW_UPSTREAM_BODY = JSON.stringify({
  error: { message: "Codex fixture upstream failure", type: "server_error", code: "fixture_500", param: null },
});
const CAPTURE_BODY = new TextEncoder().encode(
  JSON.stringify({
    model: "gpt-5.6-sol",
    stream: false,
    input: MARKER,
  })
);

const exportUrl = (params: Record<string, string>): string => `https://ai.ubq.fi/admin/sentinel/replay-captures?${new URLSearchParams(params).toString()}`;

const seedAuthenticatedKey = async (kv: Deno.Kv, token: string): Promise<void> => {
  const now = Date.now();
  const hash = await sha256Base64Url(token);
  const id = `upstream-provider-${hash.slice(0, 12)}`;
  const policyBase = {
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 100,
    usage_requests: 0,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: 1_000_000,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  await kv.set(apiKeyHashKey(hash), { id, ...policyBase });
  await kv.set(apiKeyIdKey(id), {
    id,
    name: "sentinel upstream provider test key",
    prefix: token.slice(0, 12),
    hash,
    created_at_ms: now,
    ...policyBase,
    paid_fallback_model_ids: ["gpt-5.6-sol"],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_max_exposure_microcredits: { "gpt-5.6-sol": 250_000 },
    paid_fallback_pricing_checked_at_ms: now,
  });
};

Deno.test({
  name: "real handler failure captures exact raw Codex upstream bytes through encrypted export and decrypt",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const adminTokens = config.adminTokens as Set<string>;
    adminTokens.add(SUPER_ADMIN_TOKEN);
    const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
    Deno.env.set("SENTINEL_REPLAY_KEY", base64UrlEncode(keyBytes));
    const token = `u_${encodeHex(crypto.getRandomValues(new Uint8Array(32)))}`;
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const nowMs = 1_700_000_000_000;
    Date.now = () => nowMs;
    const accessToken = `${base64Url({ alg: "none" })}.${base64Url({ exp: (nowMs + 60 * 60_000) / 1_000 })}.handler-fixture`;
    const authState: CodexAuthState = {
      access_token: accessToken,
      refresh_token: "refresh-handler-fixture",
      account_id: "account-handler-fixture",
      updated_at_ms: nowMs,
    };
    const authPool: CodexAuthPoolState = { accounts: [authState], updated_at_ms: nowMs };
    const runtimeConfig = {
      version: 2,
      default_model: "gpt-5.6-sol",
      default_reasoning_effort: "low",
      codex_models: {
        source: "chatgpt_codex",
        client_version: "0.100.0",
        updated_at_ms: nowMs,
        models: [
          {
            slug: "gpt-5.6-sol",
            default_reasoning_level: "low",
            supported_reasoning_levels: ["none", "low", "medium", "high"],
          },
        ],
      },
      updated_at_ms: nowMs,
    };
    await Promise.all([kv.set(CODEX_AUTH_POOL_KV_KEY, authPool), kv.set(RUNTIME_CONFIG_V2_KEY, runtimeConfig)]);
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    resetRuntimeConfigCacheForTest();
    resetProviderHealthThrottleForTest();
    let upstreamDispatches = 0;
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      if (request.url === CODEX_REFRESH_URL) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: accessToken }), { status: 200 }));
      }
      if (request.url === CODEX_RESPONSES_URL) {
        upstreamDispatches += 1;
        return Promise.resolve(
          new Response(RAW_UPSTREAM_BODY, {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      if (request.url.includes("openai.com")) {
        return Promise.resolve(new Response(JSON.stringify({ error: "fixture" }), { status: 400 }));
      }
      throw new Error(`Unexpected handler test fetch: ${request.url}`);
    };
    try {
      await seedAuthenticatedKey(kv, token);
      const response = await handler(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: CAPTURE_BODY,
        })
      );
      assert.equal(response.status, 500);
      assert.equal(upstreamDispatches, 1, "one real Codex dispatch must drive the handler failure");
      const responseText = await response.text();
      assert.equal(responseText.includes(MARKER), false, "failure response leaks request plaintext");

      const page = await handler(
        new Request(exportUrl({ after_ms: "0", before_ms: String(Date.now() + 2_000) }), {
          headers: { Authorization: `Bearer ${SUPER_ADMIN_TOKEN}` },
        })
      );
      assert.equal(page.status, 200);
      const exported = (await page.json()) as { data: ExportedSentinelReplayCapture[]; cursor: string | null };
      assert.equal(exported.data.length, 1);
      const capture = exported.data[0];
      const plaintext = await decryptExportedSentinelReplay(capture, keyBytes);
      assert.equal(plaintext.version, 3);
      assert.equal(plaintext.endpoint, "/v1/responses");
      assert.equal(plaintext.method, "POST");
      assert.deepEqual([...plaintext.body], [...CAPTURE_BODY]);
      assert.equal(new TextDecoder().decode(plaintext.body), new TextDecoder().decode(CAPTURE_BODY));
      assert.equal(plaintext.observation.status, 500);
      assert.equal(plaintext.upstream.attempts.length, 1);
      const attempt = plaintext.upstream.attempts[0];
      assert.equal(attempt.provider, "chatgpt_codex");
      assert.equal(attempt.status, 500);
      assert.equal(attempt.content_type, "application/json");
      assert.equal(attempt.terminal, "eof");
      assert.deepEqual(
        attempt.chunks_base64.map((chunk) => new TextDecoder().decode(base64UrlDecode(chunk))).join(""),
        RAW_UPSTREAM_BODY,
        "the decrypted private plaintext must carry the exact raw upstream bytes"
      );
      assert.equal(JSON.stringify(exported).includes("account-handler-fixture"), false);
      assert.equal(JSON.stringify(exported).includes(RAW_UPSTREAM_BODY), false, "export never carries plaintext");
    } finally {
      Deno.env.delete("SENTINEL_REPLAY_KEY");
      adminTokens.delete(SUPER_ADMIN_TOKEN);
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      resetCodexAuthCacheForTest();
      resetCodexAccountRoutingForTest();
      resetRuntimeConfigCacheForTest();
      resetProviderHealthThrottleForTest();
      kv.close();
      setKvForTest(null);
    }
  },
});

Deno.test("recorded upstream replay preserves exact chunk order and boundaries at EOF", async () => {
  const originalFetch = globalThis.fetch;
  const inputTrace = replayTrace([replayAttempt("metered", 200, "application/json", "eof", ["abc", "def", "ghi"])]);
  const inputBefore = JSON.stringify(inputTrace);
  const replay = createRecordedUpstreamReplay(inputTrace, REPLAY_ROUTES);
  const response = await replay.fetch(REPLAY_ROUTES.metered);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  const reader = response.body?.getReader();
  assert.ok(reader, "the recorded replay must expose a body stream");
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  assert.deepEqual(chunks, ["abc", "def", "ghi"], "each original chunk must be a separate exact boundary");
  replay.assertComplete();
  assert.deepEqual(replay.snapshot(), { attemptsDispatched: 1, attemptsCompleted: 1, chunksConsumed: 3, chunksTotal: 3, failed: false });
  assert.equal(JSON.stringify(inputTrace), inputBefore, "the input trace must stay unchanged");
  assert.equal(globalThis.fetch, originalFetch, "the helper must never replace or invoke global fetch");
});

Deno.test("recorded upstream read_error delivers the prefix then errors on the next pull", async () => {
  const replay = createRecordedUpstreamReplay(replayTrace([replayAttempt("surplus", 200, "text/event-stream", "read_error", ["x"])]), REPLAY_ROUTES);
  const response = await replay.fetch(REPLAY_ROUTES.surplus);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body?.getReader();
  assert.ok(reader, "the recorded replay must expose a body stream");
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(new TextDecoder().decode(first.value), "x");
  await assert.rejects(reader.read(), (error: unknown) => error instanceof TypeError);
  replay.assertComplete();
  assert.deepEqual(replay.snapshot(), { attemptsDispatched: 1, attemptsCompleted: 1, chunksConsumed: 1, chunksTotal: 1, failed: false });
});

Deno.test("recorded upstream fetch_error rejects with no headers or chunks and completes the attempt", async () => {
  const replay = createRecordedUpstreamReplay(replayTrace([replayAttempt("cerebras", null, null, "fetch_error")]), REPLAY_ROUTES);
  await assert.rejects(replay.fetch(REPLAY_ROUTES.cerebras), (error: unknown) => error instanceof TypeError);
  replay.assertComplete();
  assert.deepEqual(replay.snapshot(), { attemptsDispatched: 1, attemptsCompleted: 1, chunksConsumed: 0, chunksTotal: 0, failed: false });
});

Deno.test("recorded upstream cancelled completes only when the consumer cancels after the full prefix", async () => {
  const replay = createRecordedUpstreamReplay(replayTrace([replayAttempt("surplus", 200, "text/event-stream", "cancelled", ["data:", "x\n"])]), REPLAY_ROUTES);
  const response = await replay.fetch(REPLAY_ROUTES.surplus);
  const reader = response.body?.getReader();
  assert.ok(reader, "the recorded replay must expose a body stream");
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data:");
  assert.equal(new TextDecoder().decode((await reader.read()).value), "x\n");
  assert.deepEqual(replay.snapshot(), { attemptsDispatched: 1, attemptsCompleted: 0, chunksConsumed: 2, chunksTotal: 2, failed: false });
  await reader.cancel();
  replay.assertComplete();
  assert.deepEqual(replay.snapshot(), { attemptsDispatched: 1, attemptsCompleted: 1, chunksConsumed: 2, chunksTotal: 2, failed: false });
});

Deno.test("recorded upstream cancelled prefix rejects when read beyond it, never inventing EOF", async () => {
  const replay = createRecordedUpstreamReplay(replayTrace([replayAttempt("surplus", 200, "text/event-stream", "cancelled", ["data:"])]), REPLAY_ROUTES);
  const response = await replay.fetch(REPLAY_ROUTES.surplus);
  const reader = response.body?.getReader();
  assert.ok(reader, "the recorded replay must expose a body stream");
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data:");
  await assert.rejects(reader.read(), (error: unknown) => error instanceof TypeError);
  assert.throws(() => {
    replay.assertComplete();
  }, /replay failed/);
  assert.deepEqual(replay.snapshot(), { attemptsDispatched: 1, attemptsCompleted: 0, chunksConsumed: 1, chunksTotal: 1, failed: true });
  await assert.rejects(replay.fetch(REPLAY_ROUTES.surplus), (error: unknown) => error instanceof TypeError);
});

Deno.test("recorded upstream cancelled prefix refuses early consumer cancellation", async () => {
  const replay = createRecordedUpstreamReplay(replayTrace([replayAttempt("surplus", 200, "text/event-stream", "cancelled", ["data:", "x\n"])]), REPLAY_ROUTES);
  const response = await replay.fetch(REPLAY_ROUTES.surplus);
  const reader = response.body?.getReader();
  assert.ok(reader, "the recorded replay must expose a body stream");
  await reader.read();
  await reader.cancel();
  assert.throws(() => {
    replay.assertComplete();
  }, /replay failed/);
  assert.deepEqual(replay.snapshot(), { attemptsDispatched: 1, attemptsCompleted: 0, chunksConsumed: 1, chunksTotal: 2, failed: true });
});

Deno.test("recorded upstream enforces exact ordered provider routes and permanent failure", async () => {
  // Two attempts, each recording exactly one chunk: every total below is two.
  const twoAttempts = replayTrace([
    replayAttempt("chatgpt_codex", 200, "application/json", "eof", ["{}"]),
    replayAttempt("surplus", 200, "text/event-stream", "eof", ["{}"]),
  ]);
  // Unexpected URL entirely outside the route map.
  const unexpected = createRecordedUpstreamReplay(twoAttempts, REPLAY_ROUTES);
  await assert.rejects(unexpected.fetch("https://unmatched.example/nope"), TypeError);
  assert.throws(() => {
    unexpected.assertComplete();
  }, /replay failed/);
  assert.deepEqual(unexpected.snapshot(), { attemptsDispatched: 0, attemptsCompleted: 0, chunksConsumed: 0, chunksTotal: 2, failed: true });
  // Wrong provider route while codex is the next recorded attempt.
  const wrongProvider = createRecordedUpstreamReplay(twoAttempts, REPLAY_ROUTES);
  await assert.rejects(wrongProvider.fetch(REPLAY_ROUTES.surplus), TypeError);
  assert.deepEqual(wrongProvider.snapshot(), { attemptsDispatched: 0, attemptsCompleted: 0, chunksConsumed: 0, chunksTotal: 2, failed: true });
  // Order mismatch: the second codex call cannot satisfy the surplus attempt.
  const wrongOrder = createRecordedUpstreamReplay(twoAttempts, REPLAY_ROUTES);
  const first = await wrongOrder.fetch(REPLAY_ROUTES.chatgpt_codex);
  const firstReader = first.body?.getReader();
  assert.ok(firstReader, "the recorded replay must expose a body stream");
  await firstReader.read();
  await firstReader.read();
  await assert.rejects(wrongOrder.fetch(REPLAY_ROUTES.chatgpt_codex), TypeError);
  assert.deepEqual(wrongOrder.snapshot(), { attemptsDispatched: 1, attemptsCompleted: 1, chunksConsumed: 1, chunksTotal: 2, failed: true });
  // Dispatched but unconsumed bodies are not completion.
  const unconsumed = createRecordedUpstreamReplay(twoAttempts, REPLAY_ROUTES);
  await unconsumed.fetch(REPLAY_ROUTES.chatgpt_codex);
  await unconsumed.fetch(REPLAY_ROUTES.surplus);
  assert.deepEqual(unconsumed.snapshot(), { attemptsDispatched: 2, attemptsCompleted: 0, chunksConsumed: 0, chunksTotal: 2, failed: false });
  assert.throws(() => {
    unconsumed.assertComplete();
  }, /replay is incomplete/);
  // Extra dispatch after full completion is a permanent failure.
  const extra = createRecordedUpstreamReplay(twoAttempts, REPLAY_ROUTES);
  await (await extra.fetch(REPLAY_ROUTES.chatgpt_codex)).text();
  await (await extra.fetch(REPLAY_ROUTES.surplus)).text();
  extra.assertComplete();
  await assert.rejects(extra.fetch(REPLAY_ROUTES.chatgpt_codex), TypeError);
  assert.throws(() => {
    extra.assertComplete();
  }, /replay failed/);
  assert.deepEqual(extra.snapshot(), { attemptsDispatched: 2, attemptsCompleted: 2, chunksConsumed: 2, chunksTotal: 2, failed: true });
});

Deno.test("recorded upstream refuses unavailable or non-reproducible replay evidence at creation", () => {
  const usable = replayAttempt("metered", 200, "application/json", "eof", ["{}"]);
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([]), REPLAY_ROUTES), /trace has no attempts/);
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([usable], { attempts_truncated: true }), REPLAY_ROUTES), /trace is truncated/);
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([usable], { bytes_truncated: true }), REPLAY_ROUTES), /trace is truncated/);
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([usable], { chunks_truncated: true }), REPLAY_ROUTES), /trace is truncated/);
  assert.throws(
    () => createRecordedUpstreamReplay(replayTrace([replayAttempt("metered", 200, "application/json", "pending")]), REPLAY_ROUTES),
    /attempt is pending/
  );
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([replayAttempt("metered", null, null, "pending")]), REPLAY_ROUTES), /attempt is pending/);
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([replayAttempt("metered", 200, "other", "eof", ["{}"])]), REPLAY_ROUTES), /MIME/);
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([replayAttempt("metered", 101, "text/event-stream", "eof")]), REPLAY_ROUTES), /informational/);
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([replayAttempt("metered", 204, "application/json", "eof", ["{}"])]), REPLAY_ROUTES), /bodyless/);
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([replayAttempt("metered", 204, "application/json", "read_error")]), REPLAY_ROUTES), /bodyless/);
  const ambiguous = { ...REPLAY_ROUTES, surplus: REPLAY_ROUTES.chatgpt_codex };
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([usable]), ambiguous), /not unique/);
  const insecure = { ...REPLAY_ROUTES, metered: "http://replay.fixture.example/metered" };
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([usable]), insecure), /exact HTTPS endpoint/);
  const credential = { ...REPLAY_ROUTES, surplus: "https://user:pass@replay.fixture.example/surplus" };
  assert.throws(() => createRecordedUpstreamReplay(replayTrace([usable]), credential), /exact HTTPS endpoint/);
});

Deno.test("recorded upstream bodyless 204/205/304 replay as null body completed at dispatch", async () => {
  for (const status of [204, 205, 304] as const) {
    const replay = createRecordedUpstreamReplay(replayTrace([replayAttempt("metered", status, "other", "eof")]), REPLAY_ROUTES);
    const response = await replay.fetch(REPLAY_ROUTES.metered);
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    replay.assertComplete();
    assert.deepEqual(replay.snapshot(), {
      attemptsDispatched: 1,
      attemptsCompleted: 1,
      // The bodyless fixture records no chunks: nothing is pulled or stored.
      chunksConsumed: 0,
      chunksTotal: 0,
      failed: false,
    });
  }
});

Deno.test({
  name: "real handler replays the decrypted recorded Codex raw failure through the trusted replay transport",
  ignore: !kvAvailable,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const kv = await Deno.openKv(":memory:");
    setKvForTest(kv);
    const adminTokens = config.adminTokens as Set<string>;
    adminTokens.add(SUPER_ADMIN_TOKEN);
    const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
    const priorReplayKey = Deno.env.get("SENTINEL_REPLAY_KEY");
    Deno.env.set("SENTINEL_REPLAY_KEY", base64UrlEncode(keyBytes));
    const token = `u_${encodeHex(crypto.getRandomValues(new Uint8Array(32)))}`;
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const nowMs = 1_700_000_000_000;
    Date.now = () => nowMs;
    const accessToken = `${base64Url({ alg: "none" })}.${base64Url({ exp: (nowMs + 60 * 60_000) / 1_000 })}.handler-fixture`;
    const authState: CodexAuthState = {
      access_token: accessToken,
      refresh_token: "refresh-handler-fixture",
      account_id: "account-handler-fixture",
      updated_at_ms: nowMs,
    };
    const authPool: CodexAuthPoolState = { accounts: [authState], updated_at_ms: nowMs };
    const runtimeConfig = {
      version: 2,
      default_model: "gpt-5.6-sol",
      default_reasoning_effort: "low",
      codex_models: {
        source: "chatgpt_codex",
        client_version: "0.100.0",
        updated_at_ms: nowMs,
        models: [
          {
            slug: "gpt-5.6-sol",
            default_reasoning_level: "low",
            supported_reasoning_levels: ["none", "low", "medium", "high"],
          },
        ],
      },
      updated_at_ms: nowMs,
    };
    await Promise.all([kv.set(CODEX_AUTH_POOL_KV_KEY, authPool), kv.set(RUNTIME_CONFIG_V2_KEY, runtimeConfig)]);
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    resetRuntimeConfigCacheForTest();
    resetProviderHealthThrottleForTest();
    let rawDispatches = 0;
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      if (request.url === CODEX_REFRESH_URL) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: accessToken }), { status: 200 }));
      }
      if (request.url === CODEX_RESPONSES_URL) {
        rawDispatches += 1;
        return Promise.resolve(
          new Response(RAW_UPSTREAM_BODY, {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      if (request.url.includes("openai.com")) {
        return Promise.resolve(new Response(JSON.stringify({ error: "fixture" }), { status: 400 }));
      }
      throw new Error(`Unexpected handler test fetch: ${request.url}`);
    };
    try {
      await seedAuthenticatedKey(kv, token);
      const gatewayRequest = (): Request =>
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: CAPTURE_BODY,
        });
      const originalResponse = await handler(gatewayRequest());
      assert.equal(originalResponse.status, 500);
      assert.equal(rawDispatches, 1, "one real Codex dispatch must drive the original failure");
      const originalText = await originalResponse.text();
      assert.equal(originalText.includes(MARKER), false, "failure response leaks request plaintext");

      const page = await handler(
        new Request(exportUrl({ after_ms: "0", before_ms: String(Date.now() + 2_000) }), {
          headers: { Authorization: `Bearer ${SUPER_ADMIN_TOKEN}` },
        })
      );
      assert.equal(page.status, 200);
      const exported = (await page.json()) as { data: ExportedSentinelReplayCapture[]; cursor: string | null };
      assert.equal(exported.data.length, 1);
      const capture = exported.data[0];
      const plaintext = await decryptExportedSentinelReplay(capture, keyBytes);
      assert.equal(plaintext.endpoint, "/v1/responses");
      assert.equal(plaintext.method, "POST");
      assert.deepEqual([...plaintext.body], [...CAPTURE_BODY]);
      const replay = createRecordedUpstreamReplay(plaintext.upstream, REPLAY_ROUTES);
      const upstreamBefore = JSON.stringify(plaintext.upstream);

      resetCodexAuthCacheForTest();
      resetCodexAccountRoutingForTest();
      resetRuntimeConfigCacheForTest();
      resetProviderHealthThrottleForTest();
      let replayedDispatches = 0;
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : new URL(String(input)).href;
        if (url === CODEX_REFRESH_URL) {
          return Promise.resolve(new Response(JSON.stringify({ access_token: accessToken }), { status: 200 }));
        }
        replayedDispatches += 1;
        return replay.fetch(input, init);
      };
      const replayedResponse = await handler(
        new Request(`https://ai.ubq.fi${plaintext.endpoint}`, {
          method: plaintext.method,
          headers: {
            ...plaintext.compatibility_headers,
            Authorization: `Bearer ${token}`,
            ...(plaintext.content_type ? { "Content-Type": plaintext.content_type } : {}),
          },
          body: plaintext.body,
        })
      );
      assert.equal(replayedResponse.status, originalResponse.status);
      assert.equal(
        replayedResponse.headers.get("x-uos-upstream"),
        originalResponse.headers.get("x-uos-upstream"),
        "the replayed failure must be attributed to the same upstream provider"
      );
      const replayedText = await replayedResponse.text();
      assert.equal(replayedText.includes(MARKER), false, "replayed failure response leaks request plaintext");
      assert.deepEqual(
        JSON.parse(replayedText) as unknown,
        JSON.parse(originalText) as unknown,
        "the real handler must reconstruct the exact original raw-failure semantics"
      );
      assert.equal(replayedDispatches, 1, "exactly one replayed upstream attempt must dispatch");
      replay.assertComplete();
      assert.deepEqual(replay.snapshot(), {
        attemptsDispatched: 1,
        attemptsCompleted: 1,
        // The recorded 500 JSON body is delivered as one chunk and replayed to
        // its recorded EOF, so one chunk is pulled out of one stored chunk.
        chunksConsumed: 1,
        chunksTotal: 1,
        failed: false,
      });
      assert.equal(JSON.stringify(plaintext.upstream), upstreamBefore, "decrypted input trace must stay unchanged");

      const rePage = await handler(
        new Request(exportUrl({ after_ms: "0", before_ms: String(Date.now() + 2_000) }), {
          headers: { Authorization: `Bearer ${SUPER_ADMIN_TOKEN}` },
        })
      );
      const reExported = (await rePage.json()) as { data: ExportedSentinelReplayCapture[]; cursor: string | null };
      assert.deepEqual(reExported.data[0], exported.data[0], "identical replayed raw evidence must deduplicate and leave the original capture unchanged");
    } finally {
      if (priorReplayKey === undefined) Deno.env.delete("SENTINEL_REPLAY_KEY");
      else Deno.env.set("SENTINEL_REPLAY_KEY", priorReplayKey);
      adminTokens.delete(SUPER_ADMIN_TOKEN);
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      resetCodexAuthCacheForTest();
      resetCodexAccountRoutingForTest();
      resetRuntimeConfigCacheForTest();
      resetProviderHealthThrottleForTest();
      kv.close();
      setKvForTest(null);
    }
  },
});

/**
 * Historical source identities recorded by the MASTER-PLAN §6/§9.1
 * before/after cells for this fixture. The original Surplus revision passed
 * the raw upstream stream through unchanged (the unterminated suffix event
 * delivered verbatim to the client); the fix normalizes the stream and
 * terminates it at response.completed. The blob SHAs pin src/surplus.ts at
 * each revision and are verified against the Git object store whenever the
 * runtime grants read/run/write permissions.
 */
const HISTORICAL_UNDERMINATED_SHA = "0d795e28e42be63bbd7f0d4ce44d8ea0f6ab9d4a" as const;
const HISTORICAL_FIXED_SHA = "7cac5b68d09efe2a053e8ac658288a15aeac9af8" as const;
const HISTORICAL_UNDERMINATED_SURPLUS_BLOB = "5c6196f175c7cb7bc08658cc2e2d98093ce21d33" as const;
const HISTORICAL_FIXED_SURPLUS_BLOB = "0ecff3477d46cbec28e0aad22259a5dfe7012c93" as const;
/** SHA-256 (hex) of the recorded raw upstream bytes carried by the fixture. */
const FIXTURE_RAW_UPSTREAM_SHA256 = "d81a61c2ede75351b9d9e51bb3157dbe51f4baec92c67f6ffcfa5a910b771bad" as const;
/** SHA-256 (hex) of the repaired client stream produced by the current source. */
const FIXTURE_REPAIRED_STREAM_SHA256 = "e4b23d2ea5338058f67a28fb6b02f526e38166e7c50715dd23bcc23333c0145a" as const;
/** SHA-256 (hex) of the committed fixture file bytes. */
const FIXTURE_FILE_SHA256 = "33938442d369c52213bdde02ea5e51b9848050400302f5e9dde4fcf6b84cacaf" as const;

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

const isPermissionBlocked = (error: unknown): boolean =>
  error instanceof Deno.errors.PermissionDenied ||
  (error instanceof Error && error.name === "PermissionDenied") ||
  (error instanceof Error && /Requires (read|run|write) access/.test(error.message));

/**
 * The primary stream check shared by every run of the framing fixture: the
 * client stream must end on a blank-line terminator, every frame must be
 * exactly one event+data pair, the repaired terminal event sequence must be
 * observed, and the recorded pre-terminal delta must be forwarded exactly
 * once. The framing assertion runs first so a regression to the original
 * passthrough is reported for the intended reason (the unterminated suffix)
 * rather than a later semantic mismatch.
 */
const assertClientStreamSemantics = (text: string): { event: string; value: Record<string, unknown> }[] => {
  assert.equal(text.endsWith("\n\n"), true, "every client frame must end on its blank-line terminator");
  const frames = text.split("\n\n").filter((frame) => frame.length > 0);
  const parseFrame = (frame: string): { event: string; value: Record<string, unknown> } => {
    const lines = frame.split("\n");
    assert.equal(lines.length, 2, `client frame must be exactly one event+data pair: ${JSON.stringify(frame)}`);
    assert.equal(lines[0].startsWith("event: "), true);
    assert.equal(lines[1].startsWith("data: "), true);
    return {
      event: lines[0].slice("event: ".length),
      value: JSON.parse(lines[1].slice("data: ".length)) as Record<string, unknown>,
    };
  };
  const events = frames.map(parseFrame);
  assert.deepEqual(
    events.map(({ event }) => event),
    ["response.created", "response.output_text.delta", "response.output_text.done", "response.output_item.done", "response.completed"],
    "the client stream must terminate at response.completed with no post-terminal suffix event"
  );
  assert.equal(
    events.filter(({ event }) => event === "response.output_text.delta").length,
    1,
    "exactly one pre-terminal text delta must be forwarded, never the unterminated suffix delta"
  );
  assert.equal((events[1].value as { delta?: unknown }).delta, "fixture text");
  assert.equal((events[2].value as { text?: unknown }).text, "fixture text", "the synthesized output_text.done must carry the exact fixture text");
  assert.equal((events[3].value.item as { type?: unknown }).type, "message", "exactly one output_item.done message must be forwarded");
  assert.equal((events[4].value.response as { status?: unknown }).status, "completed", "response.completed must be the terminal client event");
  return events;
};

/**
 * Disposable child harness: imports the historical src/surplus.ts that sits
 * next to it (never the current source) and replays the recorded upstream
 * through the historical fetch path. Global fetch is replaced by a throwing
 * stub and the child is started without net permission, so any live network
 * use fails the child. The fetcher accepts only the exact historical
 * Responses endpoint built from the historical module's own SURPLUS_BASE_URL
 * constant, binding endpoint identity to the exercised revision.
 */
const HISTORICAL_SOURCE_HARNESS = [
  'import { fetchSurplusResponses, SURPLUS_BASE_URL } from "./src/surplus.ts";',
  "",
  'const root = new URL(".", import.meta.url);',
  'const upstreamRaw = await Deno.readFile(new URL("./upstream.raw", root));',
  'const request = JSON.parse(await Deno.readTextFile(new URL("./request.json", root))) as Record<string, unknown>;',
  'const expectedEndpoint = SURPLUS_BASE_URL + "/v1/responses";',
  "",
  "let liveFetchCalls = 0;",
  "globalThis.fetch = ((..._args: unknown[]) => {",
  "  liveFetchCalls += 1;",
  '  throw new Error("live network must not be used in the historical source exercise");',
  "}) as typeof fetch;",
  "",
  "const result = await fetchSurplusResponses(request, {",
  '  apiKey: "test-only-fixture-key",',
  "  fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {",
  "    const url = input instanceof Request ? input.url : new URL(String(input)).href;",
  '    if (url !== expectedEndpoint) return Promise.reject(new TypeError("unexpected endpoint " + url));',
  "    return Promise.resolve(",
  '      new Response(upstreamRaw, { status: 200, headers: { "Content-Type": "text/event-stream" } }),',
  "    );",
  "  },",
  "});",
  'if (liveFetchCalls !== 0) throw new Error("live network fetch was invoked");',
  "const clientText = await result.response.text();",
  "await Deno.stdout.write(new TextEncoder().encode(clientText));",
  "",
].join("\n");

/**
 * Reproduces both recorded historical revisions from disposable exact source
 * archives (git archive of the exact src tree at each SHA) in a temporary
 * directory under the checkout, runs a child Deno process that imports the
 * historical src/surplus.ts and replays the recorded upstream through the
 * historical fetch path, and returns the exact client-visible stream bytes
 * each revision produced together with the verified source identities.
 *
 * The ordinary sentinel:test-local permission set grants neither subprocess
 * nor write access; in that environment this returns null and the caller
 * keeps the fixture-level before/after cells only, without claiming
 * historical-source proof. Every other failure is fail-closed: an exact
 * error naming the revision, never a causal claim from unavailable sources.
 */
const exerciseHistoricalFramingSources = async (options: {
  requestBody: string;
  rawUpstream: Uint8Array<ArrayBuffer>;
}): Promise<null | {
  originalClientText: string;
  fixedClientText: string;
  fixtureFileSha256: string;
  originalBlobSha: string;
  fixedBlobSha: string;
  orderingAncestor: boolean;
}> => {
  let fixtureBytes: Uint8Array<ArrayBuffer>;
  try {
    fixtureBytes = await Deno.readFile(new URL("./fixtures/sentinel-historical-framing.json", import.meta.url));
  } catch (error) {
    if (isPermissionBlocked(error)) return null;
    throw new Error(`historical framing regression cannot read the committed fixture: ${String(error)}`, {
      cause: error,
    });
  }

  const readBlob = async (sha: string): Promise<string> => {
    const result = await new Deno.Command("git", {
      args: ["rev-parse", `${sha}:src/surplus.ts`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (result.code !== 0) {
      throw new Error(
        `historical framing regression cannot prove the causal boundary: Git object ${sha}:src/surplus.ts is not available in this checkout (${new TextDecoder()
          .decode(result.stderr)
          .trim()})`
      );
    }
    return new TextDecoder().decode(result.stdout).trim();
  };
  const originalBlobSha = await readBlob(HISTORICAL_UNDERMINATED_SHA);
  const fixedBlobSha = await readBlob(HISTORICAL_FIXED_SHA);
  const ordering = await new Deno.Command("git", {
    args: ["merge-base", "--is-ancestor", HISTORICAL_UNDERMINATED_SHA, HISTORICAL_FIXED_SHA],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (ordering.code !== 0) {
    throw new Error(
      `historical framing regression cannot prove the causal boundary: ${HISTORICAL_UNDERMINATED_SHA} is not an ancestor of ${HISTORICAL_FIXED_SHA} in this checkout (${new TextDecoder()
        .decode(ordering.stderr)
        .trim()})`
    );
  }

  const tempDir = await Deno.makeTempDir({ dir: Deno.cwd(), prefix: "m06-historical-framing-" });
  try {
    const runHistorical = async (sha: string): Promise<string> => {
      const archiveDir = `${tempDir}/${sha.slice(0, 8)}`;
      const treeDir = `${archiveDir}/tree`;
      await Deno.mkdir(treeDir, { recursive: true });
      const archive = await new Deno.Command("git", {
        args: ["archive", "--format=tar", sha, "src"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (archive.code !== 0) {
        throw new Error(`historical framing regression cannot prove the ${sha} cell: git archive failed (${new TextDecoder().decode(archive.stderr).trim()})`);
      }
      const archivePath = `${archiveDir}/src.tar`;
      await Deno.writeFile(archivePath, archive.stdout);
      const extracted = await new Deno.Command("tar", {
        args: ["-xf", archivePath, "-C", treeDir],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (extracted.code !== 0) {
        throw new Error(
          `historical framing regression cannot prove the ${sha} cell: source archive extraction failed (${new TextDecoder().decode(extracted.stderr).trim()})`
        );
      }
      await Deno.writeTextFile(`${treeDir}/harness.ts`, HISTORICAL_SOURCE_HARNESS);
      await Deno.writeTextFile(`${treeDir}/request.json`, options.requestBody);
      await Deno.writeFile(`${treeDir}/upstream.raw`, options.rawUpstream);
      const child = await new Deno.Command(Deno.execPath(), {
        args: ["run", "--no-config", "--no-prompt", "--allow-read=.", "harness.ts"],
        cwd: treeDir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (child.code !== 0) {
        throw new Error(
          `historical framing regression cannot prove the ${sha} cell: harness exited ${child.code} (${new TextDecoder().decode(child.stderr).trim()})`
        );
      }
      return new TextDecoder().decode(child.stdout);
    };
    const originalClientText = await runHistorical(HISTORICAL_UNDERMINATED_SHA);
    const fixedClientText = await runHistorical(HISTORICAL_FIXED_SHA);
    return {
      originalClientText,
      fixedClientText,
      fixtureFileSha256: await sha256Hex(fixtureBytes),
      originalBlobSha,
      fixedBlobSha,
      orderingAncestor: true,
    };
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
};

/**
 * Provenance: this fixture was generated by the positive sanitizer from a
 * local authenticated synthetic capture. Historical source
 * 0d795e28e42be63bbd7f0d4ce44d8ea0f6ab9d4a fails and historical
 * 7cac5b68d09efe2a053e8ac658288a15aeac9af8 passes the primary four-cell
 * check. It is not a production incident, but the causal before/after
 * boundary is exercised below from the exact historical sources whenever the
 * runtime can run Git and child processes.
 */
Deno.test("historical framing fixture replays through the real Surplus fetch without the unterminated suffix", async () => {
  const framingFixture = sentinelHistoricalFraming as unknown as Readonly<{
    version: number;
    request: { endpoint: string; method: string; body: string };
    upstream: SentinelUpstreamTrace;
  }>;
  // Bind the committed public fixture identity: fixture version 1, one POST to
  // the Responses endpoint, an untruncated recorded prefix, and the recorded
  // terminal eof as captured. Replay-side completion is asserted separately
  // below and never assumes the client read to transport EOF.
  assert.equal(framingFixture.version, 1);
  assert.equal(framingFixture.request.endpoint, "/v1/responses");
  assert.equal(framingFixture.request.method, "POST");
  assert.equal(framingFixture.upstream.attempts_truncated, false);
  assert.equal(framingFixture.upstream.bytes_truncated, false);
  assert.equal(framingFixture.upstream.chunks_truncated, false);
  assert.equal(framingFixture.upstream.attempts[0].terminal, "eof");
  assert.equal(framingFixture.upstream.attempts.length, 1, "the fixture must carry exactly one recorded attempt");
  assert.equal(framingFixture.upstream.attempts[0].provider, "surplus");
  assert.equal(framingFixture.upstream.attempts[0].status, 200);

  // The recorded upstream is sparse: created, one text delta, completed, then
  // a parseable but unterminated SSE suffix event (no blank-line terminator).
  const rawText = decodeChunks(framingFixture.upstream);
  assert.equal(rawText.includes("response.completed"), true);
  assert.equal(rawText.endsWith("\n\n"), false, "the recorded suffix event must lack its blank-line terminator");
  // The real inspector classifies the raw stream as invalid_sse_framing: a
  // terminal event was observed, so nothing is invented, but the unterminated
  // suffix makes the framing invalid.
  const rawObservation = inspectSentinelSse(new TextEncoder().encode(rawText));
  // The observed terminal event's own bytes are retained (bounded) so the
  // client-visible outcome survives with the capture; the rest of the shape is
  // unchanged.
  const { terminal_body_base64: observedTerminalBody, ...rawShape } = rawObservation;
  assert.equal(typeof observedTerminalBody, "string");
  assert.equal(
    Buffer.from(observedTerminalBody ?? "", "base64")
      .toString("utf8")
      .includes("response.completed"),
    true
  );
  assert.deepEqual(rawShape, {
    stream: true,
    completed: true,
    terminal_type: "response.completed",
    failure_kind: "invalid_sse_framing",
    framing_valid: false,
    error_code: null,
    error_param: null,
    terminal_body_truncated: false,
  });
  // The derived client failure observation must remain persistable for replay
  // capture even though the upstream terminal itself reported success.
  const upstreamObservation: SentinelFailureObservation = {
    status: 200,
    stream: true,
    completed: true,
    terminal_type: "response.completed",
    failure_kind: null,
    synthetic_terminal_type: null,
    provider_route: "surplus",
  };
  const clientObservation = resolveSentinelClientFailureObservation(upstreamObservation, rawObservation);
  assert.equal(clientObservation.framing_valid, false);
  assert.equal(clientObservation.failure_kind, "invalid_sse_framing");
  assert.equal(
    shouldPersistSentinelReplay(upstreamObservation, clientObservation),
    true,
    "the actual derived framing observation must be permitted for replay persistence"
  );

  const replay = createRecordedUpstreamReplay(framingFixture.upstream, REPLAY_ROUTES);
  const originalFetch = globalThis.fetch;
  const result = await fetchSurplusResponses(JSON.parse(framingFixture.request.body) as Record<string, unknown>, {
    apiKey: "test-only-fixture-key",
    fetcher: replay.fetch,
  });
  assert.equal(result.response.status, 200);
  assert.equal(globalThis.fetch, originalFetch, "the regression must never fall through to a real network");
  const normalized = await result.response.text();
  assertClientStreamSemantics(normalized);
  // The responses parser cancels the raw source at the terminal event, so the
  // recorded transport never reaches its stored EOF: the honest attempt
  // outcome is dispatched-but-not-completed. No assertComplete claim and no
  // invented EOF here.
  assert.deepEqual(replay.snapshot(), {
    attemptsDispatched: 1,
    attemptsCompleted: 0,
    // The fixture stores four chunks; the parser cancels after the terminal
    // event completes inside the fourth, so all four are pulled but the stored
    // EOF is never reached and no completion is invented.
    chunksConsumed: 4,
    chunksTotal: 4,
    failed: false,
  });

  // Fixture-level causal cells, always verified without any subprocess: the
  // recorded raw upstream bytes keep their exact committed identity, they
  // fail the primary check specifically for the unterminated framing, and
  // they never contain the repaired done events. The repaired client stream
  // digest is the identity this permanent regression is pinned to.
  assert.equal(
    await sha256Hex(new TextEncoder().encode(rawText)),
    FIXTURE_RAW_UPSTREAM_SHA256,
    "the recorded raw upstream bytes must keep their exact committed identity"
  );
  assert.equal(
    await sha256Hex(new TextEncoder().encode(normalized)),
    FIXTURE_REPAIRED_STREAM_SHA256,
    "the repaired client stream must keep its exact committed identity"
  );
  assert.throws(
    () => assertClientStreamSemantics(rawText),
    (error: unknown) => error instanceof Error && error.message.includes("blank-line terminator"),
    "the recorded raw upstream must fail the primary check specifically for the unterminated framing"
  );
  assert.equal(rawText.includes("event: response.output_text.done"), false, "the recorded raw upstream never synthesizes the repaired done events");

  // Causal before/after boundary: exercise the exact recorded historical
  // sources from disposable exact source archives. The original revision
  // must produce the verbatim unterminated stream (failing the primary
  // check for the intended reason), and the fixed revision must reproduce
  // today's repaired client stream byte-for-byte.
  const historical = await exerciseHistoricalFramingSources({
    requestBody: framingFixture.request.body,
    rawUpstream: new TextEncoder().encode(rawText),
  });
  if (historical !== null) {
    assert.equal(historical.fixtureFileSha256, FIXTURE_FILE_SHA256, "the committed fixture file must keep its exact byte identity");
    assert.equal(
      historical.originalBlobSha,
      HISTORICAL_UNDERMINATED_SURPLUS_BLOB,
      "src/surplus.ts at the original revision must match the recorded source blob"
    );
    assert.equal(historical.fixedBlobSha, HISTORICAL_FIXED_SURPLUS_BLOB, "src/surplus.ts at the fixed revision must match the recorded source blob");
    assert.equal(historical.orderingAncestor, true, "the original revision must be an ancestor of the fixed revision");
    assert.equal(historical.originalClientText, rawText, "the original revision must deliver the recorded raw upstream bytes verbatim");
    assert.throws(
      () => assertClientStreamSemantics(historical.originalClientText),
      (error: unknown) => error instanceof Error && error.message.includes("blank-line terminator"),
      "the original revision must fail the primary check for the unterminated framing"
    );
    assert.equal(historical.fixedClientText, normalized, "the fixed revision must reproduce the current repaired client stream byte-for-byte");
    assertClientStreamSemantics(historical.fixedClientText);
  }
});

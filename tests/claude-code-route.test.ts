import type { Kv, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { attemptClaudeCodeSubscription } from "../src/paid-fallback/claude-code-route.ts";
import { resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";
import { resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import { setKvForTest } from "../src/kv.ts";
import { CLAUDE_CODE_QUOTA_KV_KEY, loadClaudeCodeQuotaState } from "../src/provider/claude-code-quota.ts";

type JsonRecord = Record<string, unknown>;

const keyOf = (key: KvKey): string => JSON.stringify(key);

class RouteKv {
  readonly values = new Map<string, unknown>();

  get<T>(key: KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({
      key,
      value: (stored ?? null) as T | null,
      versionstamp: stored === undefined ? null : "00000000000000000001",
    } as KvEntryMaybe<T>);
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    this.values.set(keyOf(key), value);
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" } as KvCommitResult);
  }
}

const sse = (events: JsonRecord[]): string => events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const model = "claude-opus-5-5";
const successEvents = (): JsonRecord[] => [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
];

const captured: { url: string; headers: Headers; body: JsonRecord }[] = [];
const jsonBody = (init?: RequestInit): JsonRecord => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as JsonRecord;

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  captured.push({ url: requestUrl(input), headers: new Headers(init?.headers), body: jsonBody(init) });
  return Promise.resolve(new Response(sse(successEvents()), { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_1" } }));
};

const usageContext = { keyId: "owner-key", kernelRepo: null, kernelOrg: null } as const;
const env = { CLAUDE_CODE_OAUTH_TOKEN: "test-token", CLAUDE_CODE_ALLOWED_KEY_IDS: "owner-key" } as const;
const envLookup =
  (values: Readonly<Record<string, string>>) =>
  (name: string): string | null =>
    values[name] ?? null;

const withRouteKv = async (run: (kv: RouteKv) => Promise<void>): Promise<void> => {
  const kv = new RouteKv();
  resetProviderSelectionCacheForTest();
  resetProviderHealthThrottleForTest();
  setKvForTest(kv as unknown as Kv);
  try {
    await run(kv);
  } finally {
    setKvForTest(null);
  }
};

test("an eligible owner request is served by the subscription with the documented headers and defaults", async () => {
  await withRouteKv(async () => {
    captured.length = 0;
    const routed = await attemptClaudeCodeSubscription(
      { model, input: "hello", stream: true, instructions: "be brief" },
      { model, usageContext, env: envLookup(env), fetcher }
    );
    assert(routed, "the subscription route must serve this request");
    assert.equal(routed.provider, "claude_code");
    assert.equal(routed.paidFallback, null);
    assert.equal(routed.gatewayResponse, false);
    assert.equal(captured.length, 1);
    const request = captured[0];
    assert.equal(request.url, "https://api.anthropic.com/v1/messages");
    assert.equal(request.headers.get("authorization"), "Bearer test-token");
    assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(request.headers.get("anthropic-beta"), "oauth-2025-04-20");
    assert.equal(request.headers.get("x-api-key"), null);
    assert.equal(request.body.model, model);
    assert.equal(request.body.max_tokens, 32_000);
    assert.equal(request.body.stream, true);
    const delivered = await routed.response.text();
    assert(delivered.includes("response.completed"), "the delivered body is the translated Responses stream");
  });
});

test("an ineligible request never reaches the subscription transport", async () => {
  await withRouteKv(async () => {
    captured.length = 0;
    const noToken = await attemptClaudeCodeSubscription({ model, input: "hello" }, { model, usageContext, env: envLookup({}), fetcher });
    assert.equal(noToken, null);
    const wrongPrincipal = await attemptClaudeCodeSubscription(
      { model, input: "hello" },
      { model, usageContext: { ...usageContext, keyId: "someone-else" }, env: envLookup(env), fetcher }
    );
    assert.equal(wrongPrincipal, null);
    const nonClaudeModel = await attemptClaudeCodeSubscription(
      { model: "gpt-5.6-sol", input: "hello" },
      { model: "gpt-5.6-sol", usageContext, env: envLookup(env), fetcher }
    );
    assert.equal(nonClaudeModel, null);
    assert.equal(captured.length, 0, "no transport for an ineligible request");
  });
});

test("a durable subscription rejection falls through and blocks the tier until the reset margin", async () => {
  await withRouteKv(async (kv) => {
    captured.length = 0;
    const nowSeconds = Math.trunc(Date.now() / 1_000);
    const rejection = (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limit reached" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "anthropic-ratelimit-unified-5h-status": "limited",
            "anthropic-ratelimit-unified-5h-utilization": "1",
            "anthropic-ratelimit-unified-5h-reset": String(nowSeconds + 3_600),
          },
        })
      );
    const rejected = await attemptClaudeCodeSubscription({ model, input: "hello" }, { model, usageContext, env: envLookup(env), fetcher: rejection });
    assert.equal(rejected, null, "a rejected subscription never serves the request itself");
    assert.equal(captured.length, 0);
    const quota = await loadClaudeCodeQuotaState(kv as unknown as Kv);
    assert(quota, "the durable window block is persisted");
    assert.equal(quota.block_window, "5h");
    assert(quota.blocked_until_ms !== null && quota.blocked_until_ms > Date.now() + 3_600_000, "the reset margin is added to the upstream reset");
    assert(kv.values.has(keyOf([...CLAUDE_CODE_QUOTA_KV_KEY])));

    const second = await attemptClaudeCodeSubscription({ model, input: "hello" }, { model, usageContext, env: envLookup(env), fetcher });
    assert.equal(second, null);
    assert.equal(captured.length, 0, "a blocked tier is skipped without touching the transport");
  });
});

test("a local request-build failure falls through without recording an upstream health event", async () => {
  await withRouteKv(async (kv) => {
    captured.length = 0;
    const rejected = await attemptClaudeCodeSubscription(
      // `previous_response_id` has no lossless native Messages representation,
      // so the request fails locally before any transport exists.
      { model, input: "hello", previous_response_id: "resp_123" },
      { model, usageContext, env: envLookup(env), fetcher }
    );
    assert.equal(rejected, null);
    assert.equal(captured.length, 0, "the transport must not run for a local build failure");
    assert.deepEqual(
      [...kv.values.keys()].filter((key) => key.includes("provider_health")),
      [],
      "no upstream health event may be recorded when nothing reached the upstream"
    );
  });
});

test("a transient rate limit falls through with a short cooldown and no durable block", async () => {
  await withRouteKv(async (kv) => {
    const transient = (): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        })
      );
    const rejected = await attemptClaudeCodeSubscription({ model, input: "hello" }, { model, usageContext, env: envLookup(env), fetcher: transient });
    assert.equal(rejected, null);
    const quota = await loadClaudeCodeQuotaState(kv as unknown as Kv);
    assert(quota, "the transient outcome is still recorded");
    assert.equal(quota.blocked_until_ms, null, "a generic 429 never becomes durable exhaustion");
    assert(quota.cooldown_until_ms !== null && quota.cooldown_until_ms > Date.now());
  });
});

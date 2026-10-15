import assert from "node:assert/strict";
import { attemptClaudeCodeSubscription } from "../src/paid-fallback/claude-code-route.ts";
import { resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";
import { resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import { setKvForTest } from "../src/kv.ts";
import { CLAUDE_CODE_QUOTA_KV_KEY, clearClaudeCodeQuotaGuards, loadClaudeCodeQuotaState } from "../src/provider/claude-code-quota.ts";
import { resetClaudeCodeCredentialCacheForTest, resolveClaudeCodeWorkspace } from "../src/provider/claude-code-credentials.ts";

type JsonRecord = Record<string, unknown>;

const keyOf = (key: Deno.KvKey): string => JSON.stringify(key);

class RouteKv {
  readonly values = new Map<string, unknown>();

  get<T>(key: Deno.KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<Deno.KvEntryMaybe<T>> {
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({
      key,
      value: (stored ?? null) as T | null,
      versionstamp: stored === undefined ? null : "00000000000000000001",
    } as Deno.KvEntryMaybe<T>);
  }

  set(key: Deno.KvKey, value: unknown): Promise<Deno.KvCommitResult> {
    this.values.set(keyOf(key), value);
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" } as Deno.KvCommitResult);
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
  resetClaudeCodeCredentialCacheForTest();
  setKvForTest(kv as unknown as Deno.Kv);
  try {
    await run(kv);
  } finally {
    setKvForTest(null);
  }
};

Deno.test("an eligible owner request is served by the subscription with the documented headers and defaults", async () => {
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

Deno.test("an ineligible request never reaches the subscription transport", async () => {
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

Deno.test("a durable subscription rejection falls through and blocks the tier until the reset margin", async () => {
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
    const quota = await loadClaudeCodeQuotaState(kv as unknown as Deno.Kv);
    assert(quota, "the durable window block is persisted");
    assert.equal(quota.block_window, "5h");
    assert(quota.blocked_until_ms !== null && quota.blocked_until_ms > Date.now() + 3_600_000, "the reset margin is added to the upstream reset");
    assert(kv.values.has(keyOf([...CLAUDE_CODE_QUOTA_KV_KEY])));

    const second = await attemptClaudeCodeSubscription({ model, input: "hello" }, { model, usageContext, env: envLookup(env), fetcher });
    assert.equal(second, null);
    assert.equal(captured.length, 0, "a blocked tier is skipped without touching the transport");
  });
});

Deno.test("a local request-build failure falls through without recording an upstream health event", async () => {
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

Deno.test("a transient rate limit falls through with a short cooldown and no durable block", async () => {
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
    const quota = await loadClaudeCodeQuotaState(kv as unknown as Deno.Kv);
    assert(quota, "the transient outcome is still recorded");
    assert.equal(quota.blocked_until_ms, null, "a generic 429 never becomes durable exhaustion");
    assert(quota.cooldown_until_ms !== null && quota.cooldown_until_ms > Date.now());
  });
});

const workspacesBody = (id = "wrkspc_01ErorW3iFLRvQy55cpNWtEt", name = "Default"): string =>
  JSON.stringify({
    data: [
      { id, type: "workspace", name, created_at: "2026-02-02T22:25:14.167463Z", archived_at: null },
      { id: "wrkspc_01FBEp5VyCHs7ghEnJqk6giF", type: "workspace", name: "Claude Code", created_at: "2025-03-22T10:01:42Z", archived_at: null },
    ],
    has_more: false,
  });

Deno.test("a CLAUDE_API_KEY credential travels as x-api-key without the OAuth beta or a Bearer header", async () => {
  await withRouteKv(async () => {
    captured.length = 0;
    const apiKeyEnv = { CLAUDE_API_KEY: "sk-ant-usr-1A6exampleBwAA", CLAUDE_CODE_ALLOWED_KEY_IDS: "owner-key" };
    const routed = await attemptClaudeCodeSubscription({ model, input: "hello", stream: false }, { model, usageContext, env: envLookup(apiKeyEnv), fetcher });
    assert(routed, "the subscription route must serve this request");
    assert.equal(captured.length, 1);
    const request = captured[0];
    assert.equal(request.headers.get("x-api-key"), "sk-ant-usr-1A6exampleBwAA");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("anthropic-beta"), null);
    assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(request.headers.get("anthropic-workspace-id"), null, "no workspace header until one is known or required");
  });
});

Deno.test("an organization-scoped key discovers the workspace once and the retry carries the header", async () => {
  await withRouteKv(async (kv) => {
    captured.length = 0;
    const apiKeyEnv = { CLAUDE_API_KEY: "sk-ant-usr-1A6exampleBwAA", CLAUDE_CODE_ALLOWED_KEY_IDS: "owner-key" };
    const discovery: { count: number } = { count: 0 };
    const requireWorkspaceFetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      captured.push({ url, headers: new Headers(init?.headers), body: jsonBody(init) });
      if (url.endsWith("/v1/organizations/workspaces")) {
        discovery.count += 1;
        return Promise.resolve(new Response(workspacesBody(), { status: 200, headers: { "content-type": "application/json" } }));
      }
      const workspaceId = new Headers(init?.headers).get("anthropic-workspace-id");
      if (!workspaceId) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message:
                  "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.resolve(new Response(sse(successEvents()), { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_ws" } }));
    };

    const routed = await attemptClaudeCodeSubscription(
      { model, input: "hello", stream: true },
      { model, usageContext, env: envLookup(apiKeyEnv), fetcher: requireWorkspaceFetcher }
    );
    assert(routed, "the discovered workspace must let the retry serve the request");
    assert.equal(discovery.count, 1, "discovery runs once for the deployment");
    const messages = captured.filter((entry) => entry.url.endsWith("/v1/messages"));
    assert.equal(messages.length, 2, "the first rejection is retried exactly once");
    assert.equal(messages[0].headers.get("anthropic-workspace-id"), null);
    assert.equal(messages[1].headers.get("anthropic-workspace-id"), "wrkspc_01ErorW3iFLRvQy55cpNWtEt");
    const stored = await resolveClaudeCodeWorkspace(kv as unknown as Deno.Kv);
    assert.equal(stored?.id, "wrkspc_01ErorW3iFLRvQy55cpNWtEt");
    assert.equal(stored?.source, "discovered");

    captured.length = 0;
    const second = await attemptClaudeCodeSubscription(
      { model, input: "again", stream: true },
      { model, usageContext, env: envLookup(apiKeyEnv), fetcher: requireWorkspaceFetcher }
    );
    assert(second, "the cached workspace serves the next request");
    assert.equal(discovery.count, 1, "the workspace lookup is cached in KV");
    assert.equal(captured.filter((entry) => entry.url.endsWith("/v1/messages")).length, 1);
    assert.equal(captured[0].headers.get("anthropic-workspace-id"), "wrkspc_01ErorW3iFLRvQy55cpNWtEt");
  });
});

Deno.test("the workspace discovery retry keeps the single-use dispatch reservation to one claim", async () => {
  await withRouteKv(async () => {
    captured.length = 0;
    const apiKeyEnv = { CLAUDE_API_KEY: "sk-ant-usr-1A6exampleBwAA", CLAUDE_CODE_ALLOWED_KEY_IDS: "owner-key" };
    let reservations = 0;
    const requireWorkspaceFetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      captured.push({ url, headers: new Headers(init?.headers), body: jsonBody(init) });
      if (url.endsWith("/v1/organizations/workspaces")) {
        return Promise.resolve(new Response(workspacesBody(), { status: 200, headers: { "content-type": "application/json" } }));
      }
      const workspaceId = new Headers(init?.headers).get("anthropic-workspace-id");
      if (!workspaceId) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message:
                  "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.resolve(new Response(sse(successEvents()), { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_ws" } }));
    };
    const routed = await attemptClaudeCodeSubscription(
      { model, input: "hello", stream: true },
      {
        model,
        env: envLookup(apiKeyEnv),
        fetcher: requireWorkspaceFetcher,
        usageContext: {
          ...usageContext,
          beforeProviderDispatch: () => {
            reservations += 1;
            return Promise.resolve(undefined);
          },
        },
      }
    );
    assert(routed, "the retry must serve the request");
    assert.equal(reservations, 1, "the retry reuses the request's single pre-transport reservation");
    assert.equal(captured.filter((entry) => entry.url.endsWith("/v1/messages")).length, 2, "two transports ran for the discovery retry");
  });
});

Deno.test("a billing rejection becomes an operator-visible configuration state and skips the transport until cleared", async () => {
  await withRouteKv(async (kv) => {
    captured.length = 0;
    const apiKeyEnv = { CLAUDE_API_KEY: "sk-ant-usr-1A6exampleBwAA", CLAUDE_CODE_ALLOWED_KEY_IDS: "owner-key" };
    const billingFetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      captured.push({ url: requestUrl(input), headers: new Headers(init?.headers), body: jsonBody(init) });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
      );
    };
    const rejected = await attemptClaudeCodeSubscription(
      { model, input: "hello" },
      { model, usageContext, env: envLookup(apiKeyEnv), fetcher: billingFetcher }
    );
    assert.equal(rejected, null, "a billing rejection never serves the request itself");
    const quota = await loadClaudeCodeQuotaState(kv as unknown as Deno.Kv);
    assert.equal(quota?.last_error?.kind, "billing_blocked");
    assert(quota?.last_error?.message?.includes("credit balance"));
    assert(quota?.blocked_until_ms === null, "a billing rejection is not quota exhaustion");
    assert(quota !== null && quota.cooldown_until_ms !== null && quota.cooldown_until_ms > Date.now());

    const callsAfterFirst = captured.length;
    const second = await attemptClaudeCodeSubscription({ model, input: "hello" }, { model, usageContext, env: envLookup(apiKeyEnv), fetcher: billingFetcher });
    assert.equal(second, null);
    assert.equal(captured.length, callsAfterFirst, "the configuration cooldown keeps the tier from hammering the upstream");

    await clearClaudeCodeQuotaGuards(kv as unknown as Deno.Kv);
    const afterClear = await attemptClaudeCodeSubscription(
      { model, input: "hello" },
      { model, usageContext, env: envLookup(apiKeyEnv), fetcher: billingFetcher }
    );
    assert.equal(afterClear, null, "the rejection still cannot serve, but the tier was retried");
    assert.equal(captured.length, callsAfterFirst + 1, "clearing the guards retries the tier immediately");
  });
});

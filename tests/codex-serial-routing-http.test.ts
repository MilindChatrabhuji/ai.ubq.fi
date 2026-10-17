import { test } from "bun:test";
import { serveHttp, type HttpServer, type NetAddr } from "#http";
import { openKv } from "#kv";
import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  type CodexAccountRoutingState,
  codexCredentialVersion,
  type CodexRoutingSlot,
  parseCodexActiveAccountSelection,
} from "../src/codex/account-routing.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, CodexAuthState } from "../src/types.ts";
import { sha256Base64Url, sha256Hex } from "../src/utils.ts";

// This is local HTTP proof against controlled mock subscription upstreams and a
// disposable in-memory KV. It never reads production data, the reset provider,
// or a paid provider.

const CODEX_AUTH_POOL_KV_KEY = ["ubq_ai", "codex_auth"] as const;
const MODEL = "gpt-5.6-sol";
const ACCOUNT_A = "serial-routing-http-account-a";
const ACCOUNT_B = "serial-routing-http-account-b";
const KEY_ONE = "serial-routing-http-key-one";
const KEY_TWO = "serial-routing-http-key-two";

const fetchInputUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const contentText = (items: unknown): string => {
  if (!Array.isArray(items)) return "";
  return items
    .flatMap((item) => {
      if (!item || typeof item !== "object" || !Array.isArray((item as { content?: unknown }).content)) return [];
      return (item as { content: { text?: unknown }[] }).content.map((content) => (typeof content.text === "string" ? content.text : ""));
    })
    .join("");
};

const outputText = (payload: Record<string, unknown>): string => contentText(payload.output);

/** The upstream body may carry `input` as a string or as normalized items. */
const inputText = (value: unknown): string => (typeof value === "string" ? value : contentText(value));

type UpstreamCall = Readonly<{
  accountId: string | null;
  sessionId: string | null;
  conversationId: string | null;
  promptCacheKey: string | null;
  status: number;
  sentinel: string;
}>;

type GatewayCall = Readonly<{ status: number; completed: boolean; text: string }>;

const codexAccount = (accountId: string, updatedAtMs: number): CodexAuthState => ({
  account_id: accountId,
  access_token: `${accountId}-access-token`,
  refresh_token: `${accountId}-refresh-token`,
  updated_at_ms: updatedAtMs,
});

const routingAccountIdHash = async (accountId: string): Promise<string> => await sha256Hex(`uos_ai\u0000codex_routing_account\u0000${accountId}`);

/**
 * A durable routing row with no circuit. Account A carries a much higher used
 * percentage than B, so the retired headroom ranking would have started with B.
 */
const routingSlot = async (auth: CodexAuthState, usedPercent: number): Promise<CodexRoutingSlot> => ({
  account_id_hash: await routingAccountIdHash(auth.account_id),
  credential_version: await codexCredentialVersion(auth),
  quota_blocked_until_ms: null,
  quota_block_source: null,
  quota_blocked_classes: [],
  quota_blocks_by_class: {},
  invalid_credential_version: null,
  primary_used_percent: usedPercent,
  secondary_used_percent: null,
  quota_signal_observed_at_ms: null,
  capacity_observed_at_ms: null,
  upstream_timeout_blocked_until_ms: null,
  observed_reset_at_ms: null,
  observed_reset_at_is_stable: false,
  banked_reset_generation_ambiguous: false,
  banked_reset_recovery_probe_pending: false,
  generation: 0,
  probe_lease: null,
});

test("serial Codex routing keeps one active account across cache keys, idle time, exhaustion, and recovery over real loopback HTTP", async () => {
  const kv = await openKv(":memory:");
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  const upstreamCalls: UpstreamCall[] = [];
  let exhaustAccountA = false;
  let providerBaseUrl = "";
  let providerServer: HttpServer | null = null;
  let gatewayServer: HttpServer | null = null;
  let originalDeployFlag: boolean | null = null;

  try {
    const { setKvForTest } = await import("../src/kv.ts");
    const { resetCodexAccountRoutingForTest } = await import("../src/codex/account-routing.ts");
    const { resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
    const { config } = await import("../src/config.ts");
    const { default: handler } = await import("../src/handler/index.ts");
    const { createServeHandler } = await import("../src/handler/serve-handler.ts");

    setKvForTest(kv);
    resetCodexAccountRoutingForTest();
    resetCodexAuthCacheForTest();
    console.info = () => {};
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

    const now = Date.now();
    const accountA = codexAccount(ACCOUNT_A, now);
    const accountB = codexAccount(ACCOUNT_B, now);
    await kv.set(CODEX_AUTH_POOL_KV_KEY, { accounts: [accountA, accountB], updated_at_ms: now });
    const routingState: CodexAccountRoutingState = {
      v: 2,
      updated_at_ms: now,
      banked_reset_legacy_identity_unresolved: false,
      slots: [await routingSlot(accountA, 90), await routingSlot(accountB, 10)],
    };
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, routingState);

    const token = `u_${"b".repeat(64)}`;
    const tokenHash = await sha256Base64Url(token);
    const commonPolicy = {
      expires_at_ms: -1,
      revoked_at_ms: null,
      usage_limit_requests: -1,
      usage_requests: 0,
      usage_reset_at_ms: now + 60 * 60_000,
      window_ms: 60 * 60_000,
      usage_quota_version: 3,
      paid_fallback_enabled: false,
      paid_fallback_limit_microcredits: 0,
      paid_fallback_spent_microcredits: 0,
      paid_fallback_reserved_microcredits: 0,
      paid_fallback_reservation_request_id: null,
    } satisfies Omit<ApiKeyHashRecord, "id">;
    const keyRecord: ApiKeyRecord = {
      id: "serial-routing-http-key",
      name: "Serial routing HTTP key",
      prefix: token.slice(0, 10),
      hash: tokenHash,
      created_at_ms: now,
      ...commonPolicy,
      paid_fallback_model_ids: [],
      paid_fallback_quota_per_credit: 0,
      paid_fallback_max_exposure_microcredits: {},
      paid_fallback_pricing_checked_at_ms: now,
    };
    await kv.set(["ubq_ai", "api_keys", "id", keyRecord.id], keyRecord);
    await kv.set(["ubq_ai", "api_keys", "hash", tokenHash], { id: keyRecord.id, ...commonPolicy } satisfies ApiKeyHashRecord);

    const catalog = {
      source: "codex_cli",
      client_version: "0.145.0",
      updated_at_ms: now,
      models: [
        {
          slug: MODEL,
          context_window: 272_000,
          max_context_window: 1_000_000,
          auto_compact_token_limit: null,
          default_reasoning_level: "low",
          supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
          reasoning_effort_wire_map: { ultra: "max" },
        },
      ],
    };
    await kv.set(["ubq_ai", "codex_models"], catalog);
    await kv.set(["uos_ai", "runtime_config", "v2"], {
      version: 2,
      default_model: MODEL,
      default_reasoning_effort: "low",
      codex_models: catalog,
      updated_at_ms: now,
    });

    providerServer = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/codex/responses") return new Response("not found", { status: 404 });
      const body = (await request.json()) as Record<string, unknown>;
      const accountId = request.headers.get("chatgpt-account-id");
      const sentinel = inputText(body.input);
      const exhausting = exhaustAccountA && accountId === ACCOUNT_A;
      upstreamCalls.push({
        accountId,
        sessionId: request.headers.get("session-id"),
        conversationId: request.headers.get("conversation_id"),
        promptCacheKey: typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : null,
        status: exhausting ? 429 : 200,
        sentinel,
      });
      if (exhausting) {
        return Response.json(
          { error: { message: "Codex subscription quota exhausted", type: "usage_limit_reached" } },
          { status: 429, headers: { "Retry-After": new Date(Date.now() + 90_000).toUTCString() } }
        );
      }
      const responseId = `resp_serial_routing_http_${upstreamCalls.length}`;
      const completed = {
        id: responseId,
        object: "response",
        created_at: Math.trunc(Date.now() / 1_000),
        status: "completed",
        model: MODEL,
        output: [
          {
            type: "message",
            id: `msg_${responseId}`,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: sentinel, annotations: [] }],
          },
        ],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      };
      const sse = [
        `data: ${JSON.stringify({ type: "response.created", response: { id: responseId } })}\n\n`,
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: sentinel })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`,
      ].join("");
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    });
    await providerServer.ready;
    providerBaseUrl = `http://127.0.0.1:${(providerServer.addr as NetAddr).port}`;

    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const sourceUrl = fetchInputUrl(input);
        if (sourceUrl === `${config.codexBaseUrl}/responses`) return originalFetch(`${providerBaseUrl}/codex/responses`, init);
        if (sourceUrl.startsWith("https://auth.openai.com/")) {
          return Promise.resolve(Response.json({ error: "unexpected_token_refresh" }, { status: 500 }));
        }
        const destination = new URL(sourceUrl);
        if (destination.hostname !== "127.0.0.1") return Promise.reject(new Error("Unmapped external URL refused by loopback HTTP fixture"));
        return originalFetch(input, init);
      },
      { preconnect: originalFetch.preconnect }
    );

    originalDeployFlag = config.isDeploy;
    (config as { isDeploy: boolean }).isDeploy = true;
    gatewayServer = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, createServeHandler(handler));
    await gatewayServer.ready;
    const gatewayPort = (gatewayServer.addr as NetAddr).port;
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}/v1/responses`;

    let requestIndex = 0;
    const callGateway = async (promptCacheKey: string | null): Promise<GatewayCall> => {
      const body: Record<string, unknown> = {
        model: MODEL,
        input: `serial-routing-http-${requestIndex++}`,
        stream: false,
        reasoning: { effort: "low" },
      };
      if (promptCacheKey !== null) body.prompt_cache_key = promptCacheKey;
      const response = await fetch(gatewayUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      return {
        status: response.status,
        completed: payload.status === "completed",
        text: outputText(payload),
      };
    };
    const lastUpstream = (): UpstreamCall | undefined => upstreamCalls.at(-1);
    const expectServedBy = (accountId: string): void => {
      assert.equal(lastUpstream()?.accountId, accountId, JSON.stringify(upstreamCalls));
      assert.equal(lastUpstream()?.status, 200, JSON.stringify(upstreamCalls));
    };
    const callChatGateway = async (): Promise<number> => {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: `serial-routing-http-chat-${requestIndex++}` }],
          stream: false,
        }),
      });
      await response.arrayBuffer();
      return response.status;
    };

    // Account A starts despite B having more remaining capacity, and it stays
    // selected for a repeated key, a different key, and no key at all.
    const first = await callGateway(KEY_ONE);
    assert.equal(first.status, 200, JSON.stringify(upstreamCalls));
    assert.equal(first.completed, true);
    assert.equal(first.text, "serial-routing-http-0");
    expectServedBy(ACCOUNT_A);
    assert.equal(lastUpstream()?.sentinel, "serial-routing-http-0");
    const firstSessionId = lastUpstream()?.sessionId ?? null;
    assert.ok(firstSessionId, "a repeated explicit prompt_cache_key must capture a native session identity");

    const repeated = await callGateway(KEY_ONE);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.text, "serial-routing-http-1");
    expectServedBy(ACCOUNT_A);
    assert.equal(lastUpstream()?.sessionId, firstSessionId);
    assert.equal(lastUpstream()?.conversationId, lastUpstream()?.sessionId);
    assert.equal(lastUpstream()?.promptCacheKey, KEY_ONE);

    const differentKey = await callGateway(KEY_TWO);
    assert.equal(differentKey.status, 200);
    expectServedBy(ACCOUNT_A);
    assert.notEqual(lastUpstream()?.sessionId, firstSessionId);

    const keyless = await callGateway(null);
    assert.equal(keyless.status, 200);
    expectServedBy(ACCOUNT_A);
    assert.equal(lastUpstream()?.sessionId, null);

    // The Chat Completions path shares the one durable active selection.
    assert.equal(await callChatGateway(), 200);
    expectServedBy(ACCOUNT_A);

    // A simulated six-minute idle period with retained KV, cleared module
    // caches, and a fresh strong selector must not expire or rebalance the
    // durable active account, and the keyed native identity is unchanged.
    Date.now = () => now + 6 * 60_000;
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    const afterIdle = await callGateway(KEY_ONE);
    Date.now = originalNow;
    assert.equal(afterIdle.status, 200);
    expectServedBy(ACCOUNT_A);
    assert.equal(lastUpstream()?.sessionId, firstSessionId);

    // Authoritative exhaustion of A advances the shared active account to B,
    // and the same request is served by B with a normal terminal completion.
    exhaustAccountA = true;
    const exhausted = await callGateway(KEY_TWO);
    assert.equal(exhausted.status, 200, JSON.stringify(upstreamCalls));
    assert.equal(exhausted.completed, true);
    assert.equal(exhausted.text, `serial-routing-http-${requestIndex - 1}`);
    expectServedBy(ACCOUNT_B);
    assert.equal(
      upstreamCalls.some((call) => call.accountId === ACCOUNT_A && call.status === 429),
      true,
      JSON.stringify(upstreamCalls)
    );

    // A's quota window has elapsed, but its recovery cannot steal the active
    // account back from B.
    exhaustAccountA = false;
    Date.now = () => now + 120_000;
    const afterRecovery = await callGateway(KEY_ONE);
    Date.now = originalNow;
    assert.equal(afterRecovery.status, 200, JSON.stringify(upstreamCalls));
    expectServedBy(ACCOUNT_B);
    assert.equal(
      warnings.some((warning) => warning.includes("quota_accounting_failed")),
      false,
      warnings.join("\n")
    );

    // Narrowing the operator selection to B re-admits B at its durable
    // full-pool slot (1), not its narrowed index (0): the committed active
    // row and the final pre-transport fence must resolve the same account.
    const authPoolEntry = await kv.get(CODEX_AUTH_POOL_KV_KEY);
    await kv.set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, {
      v: 1,
      account_id_hash: await routingAccountIdHash(ACCOUNT_A),
      credential_version: await codexCredentialVersion(accountA),
      pool_versionstamp: authPoolEntry.versionstamp,
      slot: 0,
      routing_generation: 0,
      generation: 1,
      transition_reason: null,
      updated_at_ms: Date.now(),
    });
    const { codexSubscriptionHash, codexSubscriptionSelectionId, PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } =
      await import("../src/provider/selection.ts");
    await kv.set(PROVIDER_SELECTION_KV_KEY, {
      provider_ids: [codexSubscriptionSelectionId(await codexSubscriptionHash(ACCOUNT_B))],
      updated_at_ms: Date.now(),
    });
    resetProviderSelectionCacheForTest();
    const narrowed = await callGateway(KEY_TWO);
    assert.equal(narrowed.status, 200, JSON.stringify(upstreamCalls));
    assert.equal(narrowed.completed, true);
    assert.equal(narrowed.text, `serial-routing-http-${requestIndex - 1}`);
    expectServedBy(ACCOUNT_B);
    const narrowedActive = parseCodexActiveAccountSelection((await kv.get(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)).value);
    assert.ok(narrowedActive, "the narrowed admission must commit an active row");
    assert.equal(narrowedActive.slot, 1, "narrowing must keep B's durable full-pool slot");
    assert.equal(narrowedActive.account_id_hash, await routingAccountIdHash(ACCOUNT_B));

    // The committed active row keeps serving the narrowed cohort.
    const narrowedAgain = await callGateway(KEY_TWO);
    assert.equal(narrowedAgain.status, 200, JSON.stringify(upstreamCalls));
    expectServedBy(ACCOUNT_B);
  } finally {
    Date.now = originalNow;
    if (gatewayServer) await gatewayServer.shutdown();
    if (providerServer) await providerServer.shutdown();
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    console.warn = originalWarn;
    const { setKvForTest } = await import("../src/kv.ts");
    const { resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
    const configModule = await import("../src/config.ts");
    if (originalDeployFlag !== null) (configModule.config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
    const { resetProviderSelectionCacheForTest } = await import("../src/provider/selection.ts");
    resetProviderSelectionCacheForTest();
    kv.close();
  }
}, 300_000);

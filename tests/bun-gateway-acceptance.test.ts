import assert from "node:assert/strict";
import { test } from "bun:test";
import { serveHttp, type HttpServer } from "#http";
import { openKv, type Kv } from "#kv";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiKeyHashRecord, ApiKeyRecord, ApiKeyUsageWindowV3 } from "../src/types.ts";
import { apiKeyPolicyFromHashRecord, apiKeyUsageV3WindowKey } from "../src/api-key-policy.ts";
import { sha256Base64Url } from "../src/utils.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODEL = "gpt-5.6-sol";
const ACCOUNT = "bun-gateway-restart-synthetic-account";
const TOKEN = `u_${"f".repeat(64)}`;
const PROTECTED_ENV = [
  "UOS_AI_TOKEN",
  "DENO_DEPLOY_TOKEN",
  "CODEX_AUTH_JSON_B64",
  "DEEPSEEK_API_KEY",
  "SURPLUS_API_KEY",
  "METERED_API_KEY",
  "OPENROUTER_API_KEY",
];

const seedGateway = async (kv: Kv): Promise<ApiKeyHashRecord> => {
  const now = Date.now();
  const hash = await sha256Base64Url(TOKEN);
  const record: ApiKeyHashRecord = {
    id: "bun-gateway-restart-key",
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 2,
    usage_requests: 0,
    usage_reset_at_ms: now + 3_600_000,
    window_ms: 3_600_000,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  const key: ApiKeyRecord = {
    ...record,
    name: "Synthetic restart acceptance",
    prefix: TOKEN.slice(0, 10),
    hash,
    created_at_ms: now,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: now,
  };
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
  await kv.set(["ubq_ai", "api_keys", "id", record.id], key);
  await kv.set(["ubq_ai", "api_keys", "hash", hash], record);
  await kv.set(["ubq_ai", "codex_auth"], {
    accounts: [{ account_id: ACCOUNT, access_token: "synthetic-restart-access", refresh_token: "synthetic-restart-refresh", updated_at_ms: now }],
    updated_at_ms: now,
  });
  await kv.set(["ubq_ai", "codex_models"], catalog);
  await kv.set(["uos_ai", "runtime_config", "v2"], {
    version: 2,
    default_model: MODEL,
    default_reasoning_effort: "low",
    codex_models: catalog,
    updated_at_ms: now,
  });
  return record;
};

/** The application runs in an actual separate Bun process, with no dotenv or inherited credentials. */
const gatewaySource = (databasePath: string, upstreamOrigin: string): string => `
import { openKv } from "#kv";
import { serveHttp, type HttpServer } from "#http";
import { initializeKv } from "./src/kv.ts";
import { config } from "./src/config.ts";
const protectedNames = ${JSON.stringify(PROTECTED_ENV)};
if (protectedNames.some((name) => process.env[name] !== undefined)) throw new Error("Unexpected inherited credential");
const kv = await openKv(${JSON.stringify(databasePath)});
initializeKv(kv);
config.isDeploy = true;
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.href.startsWith(config.codexBaseUrl + "/")) {
    const path = url.href.slice(config.codexBaseUrl.length);
    return originalFetch(${JSON.stringify(upstreamOrigin)} + "/codex" + path, init);
  }
  if (url.hostname === "127.0.0.1") return originalFetch(input, init);
  return Promise.reject(new Error("External network forbidden in synthetic gateway acceptance"));
}, { preconnect: originalFetch.preconnect });
const { application, shutdownOptionalTelemetry } = await import("./serve.ts");
const server = serveHttp({ hostname: "127.0.0.1", port: 0, upgrade: application.upgrade }, application.fetch);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void (async () => { await server.shutdown(); await shutdownOptionalTelemetry(); kv.close(); process.exit(0); })().catch(() => process.exit(1));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const address = await server.ready;
console.log(JSON.stringify({ acceptanceReady: true, port: address.port, protectedEnvAbsent: true }));
await server.finished;
`;

type GatewayProcess = Readonly<{ origin: string; stop: () => Promise<void> }>;

const startGateway = async (databasePath: string, upstreamOrigin: string): Promise<GatewayProcess> => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", gatewaySource(databasePath, upstreamOrigin)], {
    cwd: ROOT,
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const ready = Promise.withResolvers<number>();
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  const output = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("{")) continue;
          const event = JSON.parse(line) as { acceptanceReady?: boolean; port?: number; protectedEnvAbsent?: boolean };
          if (event.acceptanceReady && typeof event.port === "number") {
            assert.equal(event.protectedEnvAbsent, true);
            ready.resolve(event.port);
          }
        }
      }
      ready.reject(new Error(`Bun gateway exited before readiness: ${await stderr}`));
    } catch (error) {
      ready.reject(error);
    } finally {
      reader.releaseLock();
    }
  })();
  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      const kill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5_000);
      try {
        const code = await child.exited;
        await output;
        assert.equal(code, 0, await stderr);
      } finally {
        clearTimeout(kill);
        await reader.cancel().catch(() => {});
        await output;
      }
    })();
    return stopPromise;
  };
  const timeout = setTimeout(() => {
    ready.reject(new Error("Bun gateway readiness timed out"));
  }, 10_000);
  try {
    return { origin: `http://127.0.0.1:${await ready.promise}`, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const requestCompletion = (origin: string): Promise<Response> =>
  fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ input: "Reply with restart proof.", stream: false }),
  });

test("Bun gateway preserves real catalog, auth and quota across an isolated process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uos-bun-gateway-"));
  const databasePath = join(directory, "gateway.sqlite3");
  let upstream: HttpServer | null = null;
  let gateway: GatewayProcess | null = null;
  try {
    const seed = await openKv(databasePath);
    let keyRecord: ApiKeyHashRecord;
    try {
      keyRecord = await seedGateway(seed);
    } finally {
      seed.close();
    }
    const upstreamCalls: Headers[] = [];
    upstream = serveHttp({ hostname: "127.0.0.1", port: 0 }, async (request) => {
      if (new URL(request.url).pathname !== "/codex/responses") return new Response("Fixture endpoint unavailable", { status: 404 });
      upstreamCalls.push(new Headers(request.headers));
      await request.arrayBuffer();
      const completed = {
        id: `resp_bun_restart_${upstreamCalls.length}`,
        object: "response",
        created_at: 1,
        status: "completed",
        model: MODEL,
        output: [
          {
            type: "message",
            id: `msg_bun_restart_${upstreamCalls.length}`,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "restart proof", annotations: [] }],
          },
        ],
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      };
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const upstreamAddress = await upstream.ready;
    const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;
    gateway = await startGateway(databasePath, upstreamOrigin);
    const unauthorized = await fetch(`${gateway.origin}/v1/models`, { headers: { authorization: "Bearer synthetic-invalid" } });
    assert.equal(unauthorized.status, 401);
    await unauthorized.arrayBuffer();
    const catalog = await fetch(`${gateway.origin}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(catalog.status, 200);
    const models = (await catalog.json()) as { data?: { id: string }[] };
    assert.ok(models.data?.some((model) => model.id === MODEL));
    const style = await fetch(`${gateway.origin}/style.css`);
    assert.equal(style.status, 200);
    assert.equal(await style.text(), await Bun.file(join(ROOT, "static/style.css")).text());
    const first = await requestCompletion(gateway.origin);
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { status: string }).status, "completed");
    await gateway.stop();
    gateway = null;

    gateway = await startGateway(databasePath, upstreamOrigin);
    const second = await requestCompletion(gateway.origin);
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { status: string }).status, "completed");
    const refused = await requestCompletion(gateway.origin);
    assert.equal(refused.status, 429);
    await refused.arrayBuffer();
    assert.equal(upstreamCalls.length, 2, "quota refusal must not dispatch a third upstream request");
    assert.ok(upstreamCalls.every((headers) => headers.get("chatgpt-account-id") === ACCOUNT));
    await gateway.stop();
    gateway = null;

    const persisted = await openKv(databasePath);
    try {
      const policy = apiKeyPolicyFromHashRecord(await sha256Base64Url(TOKEN), keyRecord, Date.now());
      assert.ok(policy);
      const window = await persisted.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(policy));
      assert.equal(window.value?.committed_requests, 2);
      assert.equal(window.value.reserved_requests, 0);
    } finally {
      persisted.close();
    }
  } finally {
    try {
      await gateway?.stop();
    } finally {
      await upstream?.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 30_000);

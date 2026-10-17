import { test } from "bun:test";
import { serveHttp, loadWebSocketModule, type NetAddr, type ServeUpgradeHandler } from "#http";
import { type Kv } from "#kv";
import { runSequence } from "./helpers/sequence.ts";
import assert from "node:assert/strict";
import type { WebSocket as UpstreamClient } from "ws";
import { CountingKv } from "./helpers/counting-kv.ts";
import { CODEX_REFRESH_TOKEN_URL } from "../src/codex/auth.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, CodexAuthState } from "../src/types.ts";
import { sha256Base64Url } from "../src/utils.ts";
import { LIVE_SIDEBAND_MAX_BUFFERED_BYTES, LIVE_SIDEBAND_MAX_PAYLOAD_BYTES } from "../src/live/upstream.ts";

// Hermetic loopback proof for the `GET /v1/live/<call_id>` sideband: the real
// production handler, a disposable in-memory KV, a seeded Codex auth pool, and
// one task-owned loopback WebSocket upstream standing in for the realtime API.
// No production data and no real upstream is touched.

const ACCOUNT_A = "live-sideband-http-account-a";
const GONE_ACCOUNT = "live-sideband-http-account-gone";
const KEY_ID = "live-sideband-http-key";
const KEY_ID_B = "live-sideband-http-key-b";
/** The principal the fixture's first API key resolves to; the mapping records it. */
const PRINCIPAL = `api-key:${KEY_ID}`;
const CALL_ID = "rtc_live_sideband_http";
const LEGACY_CALL_ID = "rtc_live_sideband_legacy";
const GONE_ACCOUNT_CALL_ID = "rtc_live_sideband_gone_account";
const UNKNOWN_CALL_ID = "rtc_live_sideband_unknown";
const CLIENT_FRAME = JSON.stringify({ type: "input_audio.append", audio: "AAAA" });
const UPSTREAM_FRAME = JSON.stringify({ type: "output_audio.delta", audio: "BBBB" });

const codexAccount = (accountId: string, nowMs: number): CodexAuthState => ({
  account_id: accountId,
  access_token: `${accountId}-access-token`,
  refresh_token: `${accountId}-refresh-token`,
  updated_at_ms: nowMs,
});

const encodeBase64Url = (value: unknown): string =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/={1,2}$/u, "");

/** A decodable JWT-shaped token; only `exp` matters to the refresh decision. */
const jwtLike = (payload: unknown): string => `${encodeBase64Url({ alg: "none" })}.${encodeBase64Url(payload)}.signature`;

/** A credential whose JWT expiry is already past, so the coordinated path must refresh it. */
const expiredCodexAccount = (accountId: string): CodexAuthState => ({
  account_id: accountId,
  access_token: jwtLike({ exp: Math.floor((Date.now() - 60_000) / 1_000) }),
  refresh_token: `${accountId}-refresh-token`,
  updated_at_ms: Date.now(),
});

/** The synthetic credential pair each controlled refresh answer carries a unique index in. */
const REFRESH_ACCESS_TOKEN = "live-sideband-refreshed-access-token";
const REFRESH_REFRESH_TOKEN = "live-sideband-refreshed-refresh-token";

type RefreshCall = Readonly<{ url: string; refreshToken: string | null; index: number }>;

type RefreshResponder = (call: RefreshCall) => Response;

type SidebandFixtureOptions = Readonly<{
  accounts?: readonly CodexAuthState[];
  delayUpstreamOpen?: boolean;
  upstreamBufferedBytes?: number;
  upstreamRejectionStatus?: 404 | 410;
  retireDeleteFailures?: number;
}>;

const seedApiKey = async (kv: CountingKv, keyId: string, name: string, token: string, nowMs: number): Promise<void> => {
  const tokenHash = await sha256Base64Url(token);
  const commonPolicy = {
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: -1,
    usage_requests: 0,
    usage_reset_at_ms: nowMs + 60 * 60_000,
    window_ms: 60 * 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  } satisfies Omit<ApiKeyHashRecord, "id">;
  const keyRecord: ApiKeyRecord = {
    id: keyId,
    name,
    prefix: token.slice(0, 10),
    hash: tokenHash,
    created_at_ms: nowMs,
    ...commonPolicy,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: nowMs,
  };
  await kv.set(["ubq_ai", "api_keys", "id", keyRecord.id], keyRecord);
  await kv.set(["ubq_ai", "api_keys", "hash", tokenHash], { id: keyRecord.id, ...commonPolicy } satisfies ApiKeyHashRecord);
};

type UpstreamSideband = {
  path: string;
  headers: Headers;
  socket: UpstreamClient;
  messages: string[];
  closed: { code: number; reason: string } | null;
};

type SidebandFixture = {
  readonly kv: CountingKv;
  readonly token: string;
  readonly tokenB: string;
  readonly gatewayWsBaseUrl: string;
  readonly upstreamSidebands: UpstreamSideband[];
  readonly refreshCalls: RefreshCall[];
  waitForUpstreamHandshake: () => Promise<void>;
  waitForClientFrames: (expected: number) => Promise<void>;
  releaseUpstreamHandshake: () => void;
  waitForUpstreamSideband: (index?: number) => Promise<UpstreamSideband>;
  setRefreshResponder: (responder: RefreshResponder) => void;
  setAuthPool: (accounts: readonly CodexAuthState[]) => Promise<void>;
  close: () => Promise<void>;
};

const startSidebandFixture = async (options: SidebandFixtureOptions = {}): Promise<SidebandFixture> => {
  const { setKvForTest } = await import("../src/kv.ts");
  const { resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
  const { resetCodexAccountRoutingForTest } = await import("../src/codex/account-routing.ts");
  const { default: handler } = await import("../src/handler/index.ts");
  const { createServeHandler } = await import("../src/handler/serve-handler.ts");
  const { setLiveUpstreamBasesForTest } = await import("../src/live/upstream.ts");
  const { config } = await import("../src/config.ts");

  const kv = new CountingKv();
  let retireDeleteFailures = options.retireDeleteFailures ?? 0;
  const deleteKv = kv.delete.bind(kv);
  kv.delete = (key) => {
    if (retireDeleteFailures > 0) {
      retireDeleteFailures -= 1;
      return Promise.reject(new Error("fixture retirement delete failure"));
    }
    return deleteKv(key);
  };
  const upstreamSidebands: UpstreamSideband[] = [];
  const openSidebands: UpstreamClient[] = [];
  const refreshCalls: RefreshCall[] = [];
  const serverAbort = new AbortController();
  const upstreamHandshake = Promise.withResolvers<undefined>();
  let upstreamHandshakeStarted = false;
  let clientFrameCount = 0;
  let closing = false;
  if (!options.delayUpstreamOpen) upstreamHandshake.resolve(undefined);
  let activeRefreshResponder: RefreshResponder = (call) =>
    Response.json({ access_token: `${REFRESH_ACCESS_TOKEN}-${call.index}`, refresh_token: `${REFRESH_REFRESH_TOKEN}-${call.index}` });
  const originalDeployFlag = config.isDeploy;
  const originalInfo = console.info;
  const originalWarn = console.warn;

  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  console.info = () => {};
  console.warn = () => {};
  // A loopback caller would otherwise receive the passwordless local principal
  // instead of an API key decision, which would hide the 401 arm.
  (config as { isDeploy: boolean }).isDeploy = true;

  const now = Date.now();
  const accounts = options.accounts ?? [codexAccount(ACCOUNT_A, now)];
  await kv.set(["ubq_ai", "codex_auth"], { accounts, updated_at_ms: now });
  await kv.set(
    ["uos_ai", "codex_live_calls", "v1", CALL_ID],
    { account_id: ACCOUNT_A, principal_id: PRINCIPAL, created_at_ms: now },
    { expireIn: 60 * 60_000 }
  );
  // A record written before principal binding: no `principal_id`, so no join
  // can ever be authorized against it.
  await kv.set(["uos_ai", "codex_live_calls", "v1", LEGACY_CALL_ID], { account_id: ACCOUNT_A, created_at_ms: now }, { expireIn: 60 * 60_000 });
  // A mapping whose account left the pool: the join must fail closed.
  await kv.set(
    ["uos_ai", "codex_live_calls", "v1", GONE_ACCOUNT_CALL_ID],
    { account_id: GONE_ACCOUNT, principal_id: PRINCIPAL, created_at_ms: now },
    { expireIn: 60 * 60_000 }
  );
  const token = `u_${"d".repeat(64)}`;
  const tokenB = `u_${"e".repeat(64)}`;
  await seedApiKey(kv, KEY_ID, "Live sideband HTTP key", token, now);
  await seedApiKey(kv, KEY_ID_B, "Live sideband HTTP key B", tokenB, now);

  // The refresh URL is a module constant, so the fixture redirects that exact
  // URL to a real loopback endpoint; no production refresh code or upstream
  // auth server is involved.
  const refreshServer = serveHttp({ hostname: "127.0.0.1", port: 0, signal: serverAbort.signal, onListen: () => {} }, async (request) => {
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    const call: RefreshCall = {
      url: request.url,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      index: refreshCalls.length + 1,
    };
    refreshCalls.push(call);
    return activeRefreshResponder(call);
  });
  await refreshServer.ready;
  const refreshEndpointUrl = `http://127.0.0.1:${(refreshServer.addr as NetAddr).port}/oauth/token`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      let target: string;
      if (typeof input === "string") target = input;
      else if (input instanceof URL) target = input.href;
      else target = input.url;
      if (target === CODEX_REFRESH_TOKEN_URL) return originalFetch(refreshEndpointUrl, init);
      if (new URL(target).hostname !== "127.0.0.1") return Promise.reject(new Error("Unmapped external URL refused by loopback HTTP fixture"));
      return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect }
  );

  const upstreamUpgrade: ServeUpgradeHandler = async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== `/v1/live/${CALL_ID}`) return new Response("not found", { status: 404 });
    if (options.upstreamRejectionStatus !== undefined) return new Response("upstream call is gone", { status: options.upstreamRejectionStatus });
    upstreamHandshakeStarted = true;
    await upstreamHandshake.promise;
    if (closing || request.signal.aborted) return new Response(null, { status: 503 });
    return {
      maxPayloadBytes: LIVE_SIDEBAND_MAX_PAYLOAD_BYTES,
      accept(socket) {
        const record: UpstreamSideband = { path: url.pathname, headers: new Headers(request.headers), socket, messages: [], closed: null };
        openSidebands.push(socket);
        socket.onmessage = (event) => {
          if (typeof event.data === "string") record.messages.push(event.data);
        };
        socket.onclose = (event) => {
          record.closed = { code: event.code, reason: event.reason };
        };
        upstreamSidebands.push(record);
      },
    };
  };
  const upstreamServer = serveHttp(
    { hostname: "127.0.0.1", port: 0, signal: serverAbort.signal, upgrade: upstreamUpgrade },
    () => new Response("WebSocket upgrade required", { status: 426 })
  );
  await upstreamServer.ready;
  const upstreamWsBaseUrl = `ws://127.0.0.1:${(upstreamServer.addr as NetAddr).port}/v1/live`;
  setLiveUpstreamBasesForTest({
    callsBaseUrl: null,
    sidebandBaseUrl: upstreamWsBaseUrl,
  });

  // Keep real loopback sockets and sends while supplying a deterministic
  // pending-byte observation for the gateway's upstream socket only.
  const CLIENT_CONSTRUCTOR = options.upstreamBufferedBytes === undefined ? null : await loadClientConstructor();
  const originalBufferedAmount = CLIENT_CONSTRUCTOR ? Object.getOwnPropertyDescriptor(CLIENT_CONSTRUCTOR.prototype, "bufferedAmount") : undefined;
  if (CLIENT_CONSTRUCTOR && options.upstreamBufferedBytes !== undefined) {
    Object.defineProperty(CLIENT_CONSTRUCTOR.prototype, "bufferedAmount", {
      configurable: true,
      get(this: UpstreamClient): number {
        if (this.url === `${upstreamWsBaseUrl}/${CALL_ID}`) return options.upstreamBufferedBytes ?? 0;
        return originalBufferedAmount?.get?.call(this) as number;
      },
    });
  }

  const { createServeUpgradeHandler } = await import("../src/handler/serve-handler.ts");
  const realUpgrade = createServeUpgradeHandler();
  const gatewayUpgrade: ServeUpgradeHandler = async (request, info) => {
    const upgrade = await realUpgrade(request, info);
    if (upgrade instanceof Response) return upgrade;
    return {
      ...upgrade,
      accept(socket) {
        socket.on("message", () => {
          clientFrameCount += 1;
        });
        upgrade.accept(socket);
      },
    };
  };
  const gatewayServer = serveHttp({ hostname: "127.0.0.1", port: 0, signal: serverAbort.signal, upgrade: gatewayUpgrade }, createServeHandler(handler));
  await gatewayServer.ready;

  return {
    kv,
    token,
    tokenB,
    gatewayWsBaseUrl: `ws://127.0.0.1:${(gatewayServer.addr as NetAddr).port}/v1/live`,
    upstreamSidebands,
    refreshCalls,
    waitForUpstreamHandshake: async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (upstreamHandshakeStarted) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("the gateway never started the upstream handshake");
    },
    releaseUpstreamHandshake: () => {
      upstreamHandshake.resolve(undefined);
    },
    waitForClientFrames: async (expected) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (clientFrameCount >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("the gateway never received the expected client frames");
    },
    waitForUpstreamSideband: async (index = 0) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const sideband = upstreamSidebands.at(index);
        if (sideband !== undefined && sideband.socket.readyState !== 0) return sideband;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("the gateway never dialed the upstream sideband");
    },
    setRefreshResponder: (next) => {
      activeRefreshResponder = next;
    },
    setAuthPool: async (nextAccounts) => {
      await kv.set(["ubq_ai", "codex_auth"], { accounts: nextAccounts, updated_at_ms: Date.now() });
    },
    close: async () => {
      closing = true;
      upstreamHandshake.resolve(undefined);
      for (const socket of openSidebands) socket.terminate();
      serverAbort.abort();
      try {
        await Promise.all([gatewayServer.shutdown(), upstreamServer.shutdown(), refreshServer.shutdown()]);
      } finally {
        console.info = originalInfo;
        console.warn = originalWarn;
        (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
        globalThis.fetch = originalFetch;
        setLiveUpstreamBasesForTest({ callsBaseUrl: null, sidebandBaseUrl: null });
        setKvForTest(null);
        resetCodexAuthCacheForTest();
        resetCodexAccountRoutingForTest();
        kv.close();
        if (CLIENT_CONSTRUCTOR && originalBufferedAmount) Object.defineProperty(CLIENT_CONSTRUCTOR.prototype, "bufferedAmount", originalBufferedAmount);
      }
    },
  };
};

/** A non-101 handshake is surfaced as its HTTP status rather than a socket error. */
class SidebandHandshakeError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`sideband handshake answered ${status}`);
    this.name = "SidebandHandshakeError";
    this.status = status;
  }
}

const loadClientConstructor = async (): Promise<typeof UpstreamClient> => {
  const module: unknown = await loadWebSocketModule();
  const candidate = (module as { default?: unknown }).default;
  assert.equal(typeof candidate, "function");
  return candidate as typeof UpstreamClient;
};

const connectSideband = async (url: string, headers: Record<string, string> = {}): Promise<UpstreamClient> => {
  const CLIENT_CONSTRUCTOR = await loadClientConstructor();
  return await new Promise<UpstreamClient>((resolve, reject) => {
    const socket = new CLIENT_CONSTRUCTOR(url, { headers, perMessageDeflate: false });
    socket.on("open", () => {
      resolve(socket);
    });
    socket.on("unexpected-response", (_request, response) => {
      reject(new SidebandHandshakeError(response.statusCode ?? 0));
      response.resume();
      socket.terminate();
    });
    socket.on("error", (error: Error) => {
      reject(error);
    });
  });
};

const nextFrame = (socket: UpstreamClient, timeoutMs = 5_000): Promise<string> => {
  const awaiting = new Promise<string>((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      socket.removeListener("message", message);
      socket.removeListener("close", closed);
    };
    const message = (data: unknown) => {
      clean();
      resolve(String(data));
    };
    const closed = () => {
      clean();
      reject(new Error("sideband closed before delivering a frame"));
    };
    const timer = setTimeout(() => {
      clean();
      reject(new Error("timed out waiting for a sideband frame"));
    }, timeoutMs);
    socket.once("message", message);
    socket.once("close", closed);
  });
  // Cleanup can close a socket after an earlier assertion already failed.
  void awaiting.catch(() => {});
  return awaiting;
};

const nextClose = (socket: UpstreamClient, timeoutMs = 5_000): Promise<{ code: number; reason: string }> =>
  new Promise((resolve, reject) => {
    const closed = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason) });
    };
    const timer = setTimeout(() => {
      socket.removeListener("close", closed);
      reject(new Error("timed out waiting for a sideband close"));
    }, timeoutMs);
    socket.once("close", closed);
  });

/**
 * A raw sideband client hosted in a Worker. The worker owns its own event loop,
 * so it puts its first frame on the wire the moment it observes the gateway's
 * 101 - while the gateway itself is still loading the upstream WebSocket client.
 * Frames, the handshake, and client-side masking are all real bytes on loopback.
 */
const rawSidebandWorkerSource = (url: string, headers: Readonly<Record<string, string>>, frames: readonly string[]): string => `
const target = new URL(${JSON.stringify(url)});
const headers = ${JSON.stringify(headers)};
const frames = ${JSON.stringify(frames)};
const maskedTextFrame = (text, seed) => {
  const payload = new TextEncoder().encode(text);
  const mask = new Uint8Array([(seed >>> 24) & 0xff, (seed >>> 16) & 0xff, (seed >>> 8) & 0xff, seed & 0xff]);
  const frame = new Uint8Array(2 + 4 + payload.byteLength);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.byteLength;
  frame.set(mask, 2);
  for (let index = 0; index < payload.byteLength; index += 1) frame[6 + index] = payload[index] ^ mask[index % 4];
  return frame;
};
const requestHead = [
  "GET " + target.pathname + " HTTP/1.1",
  "Host: " + target.host,
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Key: " + btoa("0123456789abcdef"),
  "Sec-WebSocket-Version: 13",
  ...Object.entries(headers).map(([name, value]) => name + ": " + value),
].join("\\r\\n");
const { createConnection } = await import("node:net");
const conn = createConnection({ host: target.hostname, port: Number(target.port) });
conn.on("error", (error) => self.postMessage({ event: "error", message: error.message }));
await new Promise((resolve, reject) => { conn.once("connect", resolve); conn.once("error", reject); });
const decoder = new TextDecoder();
let response = "";
let upgraded = false;
conn.on("data", (bytes) => {
  if (upgraded) return;
  response += decoder.decode(bytes, { stream: true });
  if (!response.includes("\\r\\n\\r\\n")) return;
  upgraded = true;
  self.postMessage({ event: "upgraded", status: response.split("\\r\\n")[0] });
  const framed = frames.map((frame, index) => maskedTextFrame(frame, 0x9a2b7c4d + index));
  const wire = new Uint8Array(framed.reduce((total, frame) => total + frame.byteLength, 0));
  let offset = 0;
  for (const frame of framed) { wire.set(frame, offset); offset += frame.byteLength; }
  conn.write(wire, () => self.postMessage({ event: "sent" }));
});
conn.write(new TextEncoder().encode(requestHead + "\\r\\n\\r\\n"));
self.onmessage = () => conn.destroy();
`;

type RawSidebandClient = Readonly<{ worker: Worker; waitForEvent: (event: string) => Promise<Record<string, unknown>> }>;

const startRawSidebandClient = (url: string, headers: Readonly<Record<string, string>>, frames: readonly string[]): RawSidebandClient => {
  const events: Record<string, unknown>[] = [];
  const worker = new Worker(`data:text/javascript,${encodeURIComponent(rawSidebandWorkerSource(url, headers, frames))}`, { type: "module" });
  worker.onmessage = (event) => {
    events.push(event.data as Record<string, unknown>);
  };
  return {
    worker,
    waitForEvent: async (event) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const failed = events.find((candidate) => candidate.event === "error");
        if (failed) throw new Error(String(failed.message));
        const found = events.find((candidate) => candidate.event === event);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`the raw sideband client never reported ${event}`);
    },
  };
};

/** Bounded polling on the upstream fixture; no arbitrary sleep. */
const waitForUpstreamFrames = async (sideband: UpstreamSideband, expected: number): Promise<string[]> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (sideband.messages.length >= expected) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return sideband.messages;
};

const expectHandshakeStatus = async (url: string, headers: Record<string, string>, status: number): Promise<void> => {
  try {
    const socket = await connectSideband(url, headers);
    socket.close();
    assert.fail(`expected the sideband to answer ${status}`);
  } catch (error) {
    assert.ok(error instanceof SidebandHandshakeError, String(error));
    assert.equal(error.status, status);
  }
};

test("GET /v1/live/<call_id> keeps the frames a client sends immediately after the 101, in order", async () => {
  const fixture = await startSidebandFixture();
  const frames = [1, 2, 3].map((seq) => JSON.stringify({ type: "input_audio.append", seq }));
  const client = startRawSidebandClient(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` }, frames);
  try {
    const upgraded = await client.waitForEvent("upgraded");
    assert.match(String(upgraded.status), /^HTTP\/1\.1 101 /u);
    await client.waitForEvent("sent");
    const upstream = await fixture.waitForUpstreamSideband();
    const received = await waitForUpstreamFrames(upstream, frames.length);
    assert.deepEqual(received, frames, "the upstream sideband is missing frames the client sent after the 101");
  } finally {
    client.worker.postMessage("close");
    client.worker.terminate();
    await fixture.close();
  }
}, 300_000);

test("GET /v1/live/<call_id> flushes a delayed-open queue at the UTF-8 payload byte boundary and keeps relaying", async () => {
  const fixture = await startSidebandFixture({ delayUpstreamOpen: true });
  let client: UpstreamClient | null = null;
  try {
    client = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    await fixture.waitForUpstreamHandshake();
    const frame = "é".repeat(LIVE_SIDEBAND_MAX_PAYLOAD_BYTES / 2);
    client.send(frame);
    client.send(CLIENT_FRAME);
    await fixture.waitForClientFrames(2);
    assert.equal(fixture.upstreamSidebands.length, 0, "the upstream is still waiting to upgrade");
    fixture.releaseUpstreamHandshake();
    const upstream = await fixture.waitForUpstreamSideband();
    assert.deepEqual(await waitForUpstreamFrames(upstream, 2), [frame, CLIENT_FRAME]);
    client.send(CLIENT_FRAME);
    assert.deepEqual(await waitForUpstreamFrames(upstream, 3), [frame, CLIENT_FRAME, CLIENT_FRAME]);
    const reply = nextFrame(client);
    upstream.socket.send(UPSTREAM_FRAME);
    assert.equal(await reply, UPSTREAM_FRAME);
  } finally {
    client?.terminate();
    await fixture.close();
  }
}, 300_000);

test(
  "GET /v1/live/<call_id> rejects oversized UTF-8 and binary client frames before the delayed upstream opens",
  async () =>
    runSequence(async (step) => {
      for (const [name, frame] of [
        ["UTF-8", "é".repeat(LIVE_SIDEBAND_MAX_PAYLOAD_BYTES / 2 + 1)],
        ["binary", new Uint8Array(LIVE_SIDEBAND_MAX_PAYLOAD_BYTES + 1)],
      ] as const) {
        await step(name, async () => {
          const fixture = await startSidebandFixture({ delayUpstreamOpen: true });
          let client: UpstreamClient | null = null;
          try {
            client = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
            await fixture.waitForUpstreamHandshake();
            const closed = nextClose(client);
            client.send(frame);
            assert.deepEqual(await closed, { code: 1011, reason: "realtime sideband frame exceeds payload limit" });
            assert.equal(fixture.upstreamSidebands.length, 0, "the oversized frame never reaches an upgraded upstream");
          } finally {
            client?.terminate();
            await fixture.close();
          }
        });
      }
    }),
  300_000
);

test("GET /v1/live/<call_id> caps a delayed-open queue by bytes below the frame-count limit", async () => {
  const fixture = await startSidebandFixture({ delayUpstreamOpen: true });
  let client: UpstreamClient | null = null;
  try {
    client = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    await fixture.waitForUpstreamHandshake();
    const closed = nextClose(client);
    const frame = "€".repeat(1_048_576);
    for (let index = 0; index < 3; index += 1) client.send(frame);
    assert.deepEqual(await closed, { code: 1011, reason: "realtime sideband frame queue overflow" });
    assert.equal(fixture.upstreamSidebands.length, 0, "the 9 MiB queue is refused while the upstream handshake is pending");
  } finally {
    client?.terminate();
    await fixture.close();
  }
}, 300_000);

test(
  "GET /v1/live/<call_id> checks pending bytes plus the next frame during queued flush and direct send",
  async () =>
    runSequence(async (step) => {
      const pendingBytes = LIVE_SIDEBAND_MAX_BUFFERED_BYTES - new TextEncoder().encode(CLIENT_FRAME).byteLength + 1;
      for (const delayUpstreamOpen of [true, false]) {
        await step(delayUpstreamOpen ? "queued flush" : "direct send", async () => {
          const fixture = await startSidebandFixture({ delayUpstreamOpen, upstreamBufferedBytes: pendingBytes });
          let client: UpstreamClient | null = null;
          try {
            client = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
            await fixture.waitForUpstreamHandshake();
            if (!delayUpstreamOpen) {
              const upstream = await fixture.waitForUpstreamSideband();
              const ready = nextFrame(client);
              upstream.socket.send(UPSTREAM_FRAME);
              assert.equal(await ready, UPSTREAM_FRAME, "the upstream relay is open before the direct client send");
            }
            const closed = nextClose(client);
            client.send(CLIENT_FRAME);
            await fixture.waitForClientFrames(1);
            fixture.releaseUpstreamHandshake();
            assert.deepEqual(await closed, { code: 1011, reason: "realtime upstream is not draining frames" });
            const upstream = await fixture.waitForUpstreamSideband();
            assert.deepEqual(upstream.messages, [], "the frame that would exceed the pending-byte bound was never sent");
          } finally {
            client?.terminate();
            await fixture.close();
          }
        });
      }
    }),
  300_000
);

test("GET /v1/live/<call_id> bridges the sideband to the mapped account's upstream and relays frames both ways", async () => {
  const fixture = await startSidebandFixture();
  let client: UpstreamClient | null = null;
  try {
    client = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    const upstream = await fixture.waitForUpstreamSideband();
    assert.equal(upstream.path, `/v1/live/${CALL_ID}`);
    assert.equal(upstream.headers.get("authorization"), `Bearer ${ACCOUNT_A}-access-token`);
    assert.equal(upstream.headers.get("chatgpt-account-id"), ACCOUNT_A);
    assert.equal(upstream.headers.get("originator"), "codex_cli_rs");
    assert.equal(upstream.headers.get("openai-alpha"), "quicksilver=v2");
    assert.match(upstream.headers.get("user-agent") ?? "", /^codex_cli_rs\//u);

    // The client's frame reaches upstream, and the upstream's frame reaches back.
    const upstreamFrame = nextFrame(client);
    const receivedUpstream = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("upstream never received the client frame"));
      }, 5_000);
      upstream.socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        clearTimeout(timer);
        upstream.messages.push(event.data);
        resolve();
      };
    });
    client.send(CLIENT_FRAME);
    await receivedUpstream;
    assert.deepEqual(upstream.messages, [CLIENT_FRAME]);

    upstream.socket.send(UPSTREAM_FRAME);
    assert.equal(await upstreamFrame, UPSTREAM_FRAME);

    // A clean client close propagates to the upstream as a normal close, and
    // the gateway completes the close handshake back to the client. Both
    // listeners are armed before the close frame is sent.
    const downstreamClosed = nextClose(client);
    const upstreamClosed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("upstream never observed the close"));
      }, 5_000);
      upstream.socket.onclose = (event) => {
        clearTimeout(timer);
        resolve({ code: event.code, reason: event.reason });
      };
    });
    client.close(1000, "session complete");
    assert.equal((await downstreamClosed).code, 1000);
    assert.equal((await upstreamClosed).code, 1000);
  } finally {
    try {
      client?.terminate();
    } catch {
      // Already closed.
    }
    await fixture.close();
  }
}, 300_000);

test("GET /v1/live/<call_id> rejects an unauthenticated upgrade without dialing upstream", async () => {
  const fixture = await startSidebandFixture();
  try {
    await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, {}, 401);
    assert.equal(fixture.upstreamSidebands.length, 0);
  } finally {
    await fixture.close();
  }
}, 300_000);

test("GET /v1/live/<call_id> answers 404 for an unknown call id without dialing upstream", async () => {
  const fixture = await startSidebandFixture();
  try {
    await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${UNKNOWN_CALL_ID}`, { authorization: `Bearer ${fixture.token}` }, 404);
    assert.equal(fixture.upstreamSidebands.length, 0);
  } finally {
    await fixture.close();
  }
}, 300_000);

test("GET /v1/live/<call_id> retires a terminal upstream mapping before closing and allowing reconnect", async () => {
  const fixture = await startSidebandFixture({ delayUpstreamOpen: true, upstreamRejectionStatus: 404, retireDeleteFailures: 1 });
  let client: UpstreamClient | null = null;
  try {
    client = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    await fixture.waitForUpstreamHandshake();
    const { setKvForTest } = await import("../src/kv.ts");
    let kvUnavailable = true;
    setKvForTest(null, async () => {
      if (kvUnavailable) {
        kvUnavailable = false;
        return null;
      }
      return fixture.kv as unknown as Kv;
    });
    fixture.releaseUpstreamHandshake();
    const closed = await nextClose(client);
    assert.deepEqual(closed, { code: 1011, reason: "realtime upstream rejected the sideband" });
    assert.equal(fixture.kv.entries.get(JSON.stringify(["uos_ai", "codex_live_calls", "v1", CALL_ID]))?.value ?? null, null);
    await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` }, 404);
    assert.equal(fixture.upstreamSidebands.length, 0, "a retired mapping never dials the ended upstream call again");
  } finally {
    client?.terminate();
    await fixture.close();
  }
}, 300_000);

test("GET /v1/live/<call_id> answers 403 for a different valid principal without dialing upstream", async () => {
  const fixture = await startSidebandFixture();
  try {
    await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.tokenB}` }, 403);
    assert.equal(fixture.upstreamSidebands.length, 0, "an unauthorized principal never reaches the upstream");
  } finally {
    await fixture.close();
  }
}, 300_000);

test("GET /v1/live/<call_id> fails closed for a mapping with no recorded principal", async () => {
  const fixture = await startSidebandFixture();
  try {
    await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${LEGACY_CALL_ID}`, { authorization: `Bearer ${fixture.token}` }, 403);
    assert.equal(fixture.upstreamSidebands.length, 0, "a legacy mapping is never joined on an unproven principal");
  } finally {
    await fixture.close();
  }
}, 300_000);

test("GET /v1/live/<call_id> lets the creating principal reconnect on the same upstream account", async () => {
  const fixture = await startSidebandFixture();
  try {
    const first = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    const firstUpstream = await fixture.waitForUpstreamSideband(0);
    assert.equal(firstUpstream.headers.get("authorization"), `Bearer ${ACCOUNT_A}-access-token`);
    assert.equal(firstUpstream.headers.get("chatgpt-account-id"), ACCOUNT_A);

    const firstClosed = nextClose(first);
    first.close(1000, "reconnect");
    await firstClosed;

    const second = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    try {
      const secondUpstream = await fixture.waitForUpstreamSideband(1);
      assert.equal(secondUpstream.path, `/v1/live/${CALL_ID}`);
      assert.equal(secondUpstream.headers.get("authorization"), `Bearer ${ACCOUNT_A}-access-token`, "the reconnect maps the same upstream account");
      assert.equal(secondUpstream.headers.get("chatgpt-account-id"), ACCOUNT_A);
    } finally {
      second.terminate();
    }
  } finally {
    await fixture.close();
  }
}, 300_000);

test("GET /v1/live/<call_id> refreshes the mapped account's expired token before dialing upstream", async () => {
  const fixture = await startSidebandFixture({ accounts: [expiredCodexAccount(ACCOUNT_A)] });
  let client: UpstreamClient | null = null;
  try {
    client = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    const upstream = await fixture.waitForUpstreamSideband();
    assert.equal(
      upstream.headers.get("authorization"),
      `Bearer ${REFRESH_ACCESS_TOKEN}-1`,
      "the handshake carries the refreshed credential instead of the expired cached bearer"
    );
    assert.equal(upstream.headers.get("chatgpt-account-id"), ACCOUNT_A);
    assert.equal(fixture.refreshCalls.length, 1, "the expired mapped account is refreshed exactly once");
    assert.equal(fixture.refreshCalls[0]?.refreshToken, `${ACCOUNT_A}-refresh-token`, "the refresh re-read the mapped account by identity");

    const storedPool = fixture.kv.entries.get(JSON.stringify(["ubq_ai", "codex_auth"]))?.value as { accounts?: CodexAuthState[] } | undefined;
    const refreshed = storedPool?.accounts?.find((account) => account.account_id === ACCOUNT_A);
    assert.equal(refreshed?.access_token, `${REFRESH_ACCESS_TOKEN}-1`, "the rotated credential is persisted under the same account identity");
    assert.equal(refreshed.refresh_token, `${REFRESH_REFRESH_TOKEN}-1`);

    const mapping = fixture.kv.entries.get(JSON.stringify(["uos_ai", "codex_live_calls", "v1", CALL_ID]))?.value;
    assert.equal((mapping as { account_id?: unknown } | undefined)?.account_id, ACCOUNT_A, "the call keeps its mapped account identity");
    assert.equal((mapping as { principal_id?: unknown } | undefined)?.principal_id, PRINCIPAL, "the creator-principal binding is preserved");
  } finally {
    client?.terminate();
    await fixture.close();
  }
}, 300_000);

test("GET /v1/live/<call_id> refreshes again on reconnect when the mapped credential expired again", async () => {
  const fixture = await startSidebandFixture({ accounts: [expiredCodexAccount(ACCOUNT_A)] });
  try {
    const first = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    const firstUpstream = await fixture.waitForUpstreamSideband(0);
    assert.equal(firstUpstream.headers.get("authorization"), `Bearer ${REFRESH_ACCESS_TOKEN}-1`);

    const firstClosed = nextClose(first);
    first.close(1000, "reconnect");
    await firstClosed;
    assert.equal(fixture.refreshCalls.length, 1);

    // The credential expires again before the sideband reconnects, so the
    // reconnect must run the coordinated path rather than reuse the previous
    // in-memory bearer.
    await fixture.setAuthPool([expiredCodexAccount(ACCOUNT_A)]);

    const second = await connectSideband(`${fixture.gatewayWsBaseUrl}/${CALL_ID}`, { authorization: `Bearer ${fixture.token}` });
    try {
      const secondUpstream = await fixture.waitForUpstreamSideband(1);
      assert.equal(secondUpstream.headers.get("chatgpt-account-id"), ACCOUNT_A);
      assert.equal(secondUpstream.headers.get("authorization"), `Bearer ${REFRESH_ACCESS_TOKEN}-2`, "the reconnect dispatches a newly refreshed credential");
      assert.equal(fixture.refreshCalls.length, 2, "the reconnect refreshed the expired mapped account again");
      assert.equal(fixture.refreshCalls[1]?.refreshToken, `${ACCOUNT_A}-refresh-token`);
    } finally {
      second.terminate();
    }
  } finally {
    await fixture.close();
  }
}, 300_000);

test("GET /v1/live/<call_id> answers 404 when the mapped account is no longer configured", async () => {
  const fixture = await startSidebandFixture();
  try {
    await expectHandshakeStatus(`${fixture.gatewayWsBaseUrl}/${GONE_ACCOUNT_CALL_ID}`, { authorization: `Bearer ${fixture.token}` }, 404);
    assert.equal(fixture.upstreamSidebands.length, 0, "a disappeared mapped account never reaches the upstream");
    assert.equal(fixture.refreshCalls.length, 0);
  } finally {
    await fixture.close();
  }
}, 300_000);

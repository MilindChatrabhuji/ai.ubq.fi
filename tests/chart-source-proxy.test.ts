import { test } from "bun:test";
import type { NetAddr } from "#http";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { type CapacityPushState, type ChartSourceProxyDeps, proxyAdminChartSource } from "../src/admin/chart-source-proxy.ts";
import { configureAdminAuthForListener, configureMacLocalAdminAuthBypassForListener } from "../src/auth/local-admin.ts";
import { MAX_REMOTE_CAPACITY_OBSERVATIONS } from "../src/provider/capacity-analytics.ts";
import { createFetchMock } from "./helpers/fetch-mock.ts";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const capacityPayload = (label: string, usedPercent: number, sampledAtMs: number) => ({
  snapshot_at_ms: sampledAtMs,
  stale_after_ms: 30_000,
  sources: [{ source: "codex", label, slot: 1, state: "available", windows: { primary: { used_percent: usedPercent } } }],
  history: [{ sampled_at_ms: sampledAtMs, sources: [{ source: "codex", slot: 1, state: "available", windows: { primary: { used_percent: usedPercent } } }] }],
  reset_events: [{ event_id: `${label}-reset` }],
  rate_limit_reset_events: [{ event_id: `${label}-rate-reset` }],
  downtime_events: [{ event_id: `${label}-downtime` }],
  prompt_cache: { status: "ready", bucket_ms: 60_000, buckets: [{ bucket_start_at_ms: sampledAtMs, cached_share: usedPercent / 100 }] },
  ledger_growth: { estimated_bytes: usedPercent },
});

const BUCKET_MS = 15 * 60_000;
const sample = (index: number) => ({ bucket_start_at_ms: index * BUCKET_MS, sampled_at_ms: index * BUCKET_MS + 1_000, sources: [] });
const localWithHistory = (history: readonly unknown[]) => ({ ...capacityPayload("local", 7, 1_000), history });
const REMOTE_PAYLOAD = capacityPayload("remote", 0, 2_000);

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

type RecordedCall = { method: string; url: string; authorization: string | null; userAgent: string | null; body: unknown };
type Responder = (call: RecordedCall) => Promise<Response>;

const acknowledgePush: Responder = (call) => {
  if (call.method !== "POST") return Promise.resolve(jsonResponse(REMOTE_PAYLOAD));
  const body = call.body as { host: string; history: unknown[] };
  return Promise.resolve(jsonResponse({ accepted: body.history.length, host: body.host }));
};

const recordingFetch = (calls: RecordedCall[], respond: Responder = acknowledgePush): typeof fetch =>
  createFetchMock((input, init) => {
    const headers = new Headers(init?.headers);
    const call: RecordedCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: requestUrl(input),
      authorization: headers.get("Authorization"),
      userAgent: headers.get("User-Agent"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return respond(call);
  });

const freshPushState = (): CapacityPushState => ({ acknowledgedSampledAtMs: null, inFlight: null });

const deps = (overrides: Partial<ChartSourceProxyDeps>): ChartSourceProxyDeps => ({
  isLoopbackAdmin: () => true,
  token: "test-token",
  remoteOrigin: "https://vps.example",
  ...overrides,
});

/** The Mac companion service: the only process allowed to push its samples. */
const macDeps = (overrides: Partial<ChartSourceProxyDeps>): ChartSourceProxyDeps => deps({ isMacCompanionService: () => true, hostId: "mac", ...overrides });

const CAPACITY_URL = "http://localhost:7999/admin/providers/capacity";

/** One Analytics poll from the Mac, waiting for its background push to settle. */
const poll = async (history: readonly unknown[], state: CapacityPushState, calls: RecordedCall[], respond?: Responder): Promise<Response> => {
  const response = await proxyAdminChartSource(
    new Request(CAPACITY_URL),
    jsonResponse(localWithHistory(history)),
    macDeps({ pushState: state, fetch: recordingFetch(calls, respond) })
  );
  await state.inFlight;
  return response;
};

const pushedSamples = (calls: readonly RecordedCall[]): number[][] =>
  calls
    .filter((call) => call.method === "POST")
    .map((call) => (call.body as { history: { sampled_at_ms: number }[] }).history.map((point) => point.sampled_at_ms));

test("chart proxy leaves non-loopback admin responses local", async () => {
  let calls = 0;
  const local = jsonResponse(capacityPayload("local", 7, 1_000));
  const response = await proxyAdminChartSource(
    new Request("https://ai.ubq.fi/admin/providers/capacity"),
    local,
    deps({
      isLoopbackAdmin: () => false,
      fetch: createFetchMock(() => {
        calls += 1;
        return Promise.resolve(jsonResponse(capacityPayload("remote", 0, 2_000)));
      }),
    })
  );
  assert.equal(response, local);
  assert.equal(calls, 0);
});

test("the Mac service pushes its samples oldest first beside the canonical chart read", async () => {
  const state = freshPushState();
  const calls: RecordedCall[] = [];
  const localPayload = localWithHistory([sample(2), sample(1)]);
  const request = new Request(`${CAPACITY_URL}?refresh=live`, { headers: { Authorization: "Bearer browser-token" } });
  const response = await proxyAdminChartSource(request, jsonResponse(localPayload), macDeps({ pushState: state, fetch: recordingFetch(calls) }));
  await state.inFlight;
  const body = (await response.json()) as typeof localPayload;
  // The loopback query string is never forwarded: `?refresh=live` would force an upstream probe on the VPS.
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ["POST https://vps.example/admin/providers/capacity/observations", "GET https://vps.example/admin/providers/capacity"]
  );
  assert.deepEqual(
    calls.map((call) => call.authorization),
    ["Bearer test-token", "Bearer test-token"]
  );
  assert.match(calls[0]?.userAgent ?? "", /Mozilla/);
  assert.deepEqual(calls[0]?.body, { host: "mac", history: [sample(1), sample(2)] });
  assert.equal(state.acknowledgedSampledAtMs, sample(2).sampled_at_ms);
  assert.deepEqual(body.sources, localPayload.sources);
  assert.equal(body.snapshot_at_ms, localPayload.snapshot_at_ms);
  assert.deepEqual(body.history, REMOTE_PAYLOAD.history);
  assert.deepEqual(body.reset_events, REMOTE_PAYLOAD.reset_events);
  assert.deepEqual(body.rate_limit_reset_events, REMOTE_PAYLOAD.rate_limit_reset_events);
  assert.deepEqual(body.downtime_events, REMOTE_PAYLOAD.downtime_events);
  assert.deepEqual(body.prompt_cache, REMOTE_PAYLOAD.prompt_cache);
  assert.deepEqual(body.ledger_growth, REMOTE_PAYLOAD.ledger_growth);
});

test("the chart read never waits for the push, and only one push runs at a time", async () => {
  const state = freshPushState();
  const calls: RecordedCall[] = [];
  let releasePush: (response: Response) => void = () => {};
  const pendingPush = new Promise<Response>((resolve) => {
    releasePush = resolve;
  });
  const respond: Responder = (call) => (call.method === "POST" ? pendingPush : Promise.resolve(jsonResponse(REMOTE_PAYLOAD)));
  const read = () =>
    proxyAdminChartSource(
      new Request(CAPACITY_URL),
      jsonResponse(localWithHistory([sample(1)])),
      macDeps({ pushState: state, fetch: recordingFetch(calls, respond) })
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, 2_000);
  });
  try {
    const first = await Promise.race([read(), timeout]);
    assert.notEqual(first, "timeout");
    const second = await Promise.race([read(), timeout]);
    assert.notEqual(second, "timeout");
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "GET", "GET"]
  );
  assert.equal(state.acknowledgedSampledAtMs, null);
  releasePush(jsonResponse({ accepted: 1, host: "mac" }));
  await state.inFlight;
  assert.equal(state.acknowledgedSampledAtMs, sample(1).sampled_at_ms);
});

test("each sample is pushed once instead of the whole week on every poll", async () => {
  const state = freshPushState();
  const calls: RecordedCall[] = [];
  await poll([sample(1), sample(2)], state, calls);
  await poll([sample(1), sample(2)], state, calls);
  await poll([sample(1), sample(2), sample(3)], state, calls);
  assert.deepEqual(pushedSamples(calls), [[sample(1).sampled_at_ms, sample(2).sampled_at_ms], [sample(3).sampled_at_ms]]);
  assert.equal(calls.filter((call) => call.method === "GET").length, 3);
});

test("a failed or unacknowledged push is retried with the same samples", async () => {
  const state = freshPushState();
  const calls: RecordedCall[] = [];
  const pushReplies = [new Response("push unavailable", { status: 503 }), jsonResponse({ ok: true }), jsonResponse({ accepted: 1, host: "mac" })];
  const respond: Responder = (call) =>
    call.method === "POST" ? Promise.resolve(pushReplies.shift() ?? jsonResponse({})) : Promise.resolve(jsonResponse(REMOTE_PAYLOAD));
  for (let attempt = 0; attempt < 4; attempt += 1) await poll([sample(1)], state, calls, respond);
  assert.deepEqual(pushedSamples(calls), [[sample(1).sampled_at_ms], [sample(1).sampled_at_ms], [sample(1).sampled_at_ms]]);
});

test("a batch the VPS refuses as invalid is skipped instead of blocking later samples", async () => {
  for (const status of [400, 413]) {
    const state = freshPushState();
    const calls: RecordedCall[] = [];
    let refused = false;
    const respond: Responder = (call) => {
      if (call.method === "POST" && !refused) {
        refused = true;
        return Promise.resolve(jsonResponse({ error: { message: "Invalid capacity observations" } }, status));
      }
      return acknowledgePush(call);
    };
    await poll([sample(1)], state, calls, respond);
    await poll([sample(1), sample(2)], state, calls, respond);
    assert.deepEqual(pushedSamples(calls), [[sample(1).sampled_at_ms], [sample(2).sampled_at_ms]], `status ${status}`);
  }
});

test("a long history is pushed oldest first, one ingest batch per poll", async () => {
  const state = freshPushState();
  const calls: RecordedCall[] = [];
  const history = Array.from({ length: MAX_REMOTE_CAPACITY_OBSERVATIONS + 5 }, (_, index) => sample(index)).reverse();
  await poll(history, state, calls);
  await poll(history, state, calls);
  await poll(history, state, calls);
  const pushes = pushedSamples(calls);
  assert.deepEqual(
    pushes.map((push) => push.length),
    [MAX_REMOTE_CAPACITY_OBSERVATIONS, 5]
  );
  assert.equal(pushes[0]?.[0], sample(0).sampled_at_ms);
  assert.equal(pushes[1]?.[0], sample(MAX_REMOTE_CAPACITY_OBSERVATIONS).sampled_at_ms);
});

test("only the Mac companion service pushes; a development server with the same token only reads", async () => {
  const loopback: NetAddr = { transport: "tcp", hostname: "127.0.0.1", port: 8000 };
  const read = async (calls: RecordedCall[], state: CapacityPushState): Promise<void> => {
    await proxyAdminChartSource(
      new Request(CAPACITY_URL),
      jsonResponse(localWithHistory([sample(1)])),
      deps({ hostId: "mac", pushState: state, fetch: recordingFetch(calls) })
    );
    await state.inFlight;
  };
  try {
    // `bun run dev` / `dev:local`: the generic loopback bypass.
    configureAdminAuthForListener({ disableAdminAuth: true }, loopback);
    const devCalls: RecordedCall[] = [];
    await read(devCalls, freshPushState());
    assert.deepEqual(
      devCalls.map((call) => call.method),
      ["GET"]
    );
    // scripts/serve-mac.ts: the Mac companion's LAN listener.
    configureMacLocalAdminAuthBypassForListener({ transport: "tcp", hostname: "0.0.0.0", port: 7999 });
    const macCalls: RecordedCall[] = [];
    await read(macCalls, freshPushState());
    assert.deepEqual(
      macCalls.map((call) => call.method),
      ["POST", "GET"]
    );
    // A later development listener in the same process clears the signal again.
    configureAdminAuthForListener({ disableAdminAuth: true }, loopback);
    const laterCalls: RecordedCall[] = [];
    await read(laterCalls, freshPushState());
    assert.deepEqual(
      laterCalls.map((call) => call.method),
      ["GET"]
    );
  } finally {
    configureAdminAuthForListener({ disableAdminAuth: false }, loopback);
  }
});

test("the push sends the configured host id and stops on an invalid one", async () => {
  const previous = process.env.UOS_CAPACITY_OBSERVATION_HOST_ID;
  try {
    for (const [configured, expected] of [
      [undefined, "mac"],
      ["", "mac"],
      ["mac-studio", "mac-studio"],
      [" mac-mini ", "mac-mini"],
      ["Mac Mini", null],
    ] as const) {
      if (configured === undefined) delete process.env.UOS_CAPACITY_OBSERVATION_HOST_ID;
      else process.env.UOS_CAPACITY_OBSERVATION_HOST_ID = configured;
      const state = freshPushState();
      const calls: RecordedCall[] = [];
      await proxyAdminChartSource(
        new Request(CAPACITY_URL),
        jsonResponse(localWithHistory([sample(1)])),
        deps({ isMacCompanionService: () => true, pushState: state, fetch: recordingFetch(calls) })
      );
      await state.inFlight;
      assert.deepEqual(
        calls.filter((call) => call.method === "POST").map((call) => (call.body as { host: string }).host),
        expected === null ? [] : [expected],
        `configured ${JSON.stringify(configured)}`
      );
    }
  } finally {
    if (previous === undefined) delete process.env.UOS_CAPACITY_OBSERVATION_HOST_ID;
    else process.env.UOS_CAPACITY_OBSERVATION_HOST_ID = previous;
  }
});

test("chart proxy serves only the canonical five-xx buckets and keeps the local error rows", async () => {
  const localOverlay = {
    object: "list",
    data: [{ status: 500, id: "local-latest" }],
    five_xx_buckets: [{ bucket_start_at_ms: 1_000, count: 1 }],
    retention: { status: "local" },
  };
  const remoteOverlay = {
    object: "list",
    data: [{ status: 502, id: "vps-latest" }],
    five_xx_buckets: [{ bucket_start_at_ms: 2_000, count: 9 }],
    retention: { status: "vps" },
  };
  const seen: { method: string; url: string }[] = [];
  const response = await proxyAdminChartSource(
    new Request("http://localhost:7999/admin/errors?limit=1&refresh=live"),
    jsonResponse(localOverlay),
    deps({
      fetch: createFetchMock((input, init) => {
        seen.push({ method: (init?.method ?? "GET").toUpperCase(), url: requestUrl(input) });
        return Promise.resolve(jsonResponse(remoteOverlay));
      }),
    })
  );
  assert.deepEqual(seen, [{ method: "GET", url: "https://vps.example/admin/errors?limit=1" }]);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { ...localOverlay, five_xx_buckets: remoteOverlay.five_xx_buckets });
});

test("chart proxy re-encodes a compressed five-xx overlay instead of forwarding its transfer headers", async () => {
  const overlay = { object: "list", data: [{ status: 502, message: "upstream ".repeat(60) }], five_xx_buckets: [{ bucket_start_at_ms: 2_000, count: 9 }] };
  const localOverlay = { object: "list", data: [], five_xx_buckets: [] };
  const compressed = gzipSync(JSON.stringify(overlay));
  const acceptEncodings: (string | null)[] = [];
  // Cloudflare compresses JSON for the Accept-Encoding that Bun fetch always sends.
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      acceptEncodings.push(request.headers.get("Accept-Encoding"));
      return new Response(compressed, {
        headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": String(compressed.byteLength) },
      });
    },
  });
  try {
    const response = await proxyAdminChartSource(
      new Request("http://localhost:7999/admin/errors?limit=1"),
      jsonResponse(localOverlay),
      deps({ remoteOrigin: `http://127.0.0.1:${upstream.port}` })
    );
    assert.equal(acceptEncodings.length, 1);
    assert.match(acceptEncodings[0] ?? "", /gzip/);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Encoding"), null);
    assert.notEqual(response.headers.get("Content-Length"), String(compressed.byteLength));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const text = await response.text();
    const declaredLength = response.headers.get("Content-Length");
    if (declaredLength !== null) assert.equal(Number(declaredLength), new TextEncoder().encode(text).byteLength);
    assert.deepEqual(JSON.parse(text), { ...localOverlay, five_xx_buckets: overlay.five_xx_buckets });
  } finally {
    await upstream.stop(true);
  }
});

test("chart proxy drops stale decoded-body transfer headers from the five-xx overlay", async () => {
  const overlay = { object: "list", data: [], five_xx_buckets: [{ bucket_start_at_ms: 2_000, count: 9 }] };
  // Bun fetch hands back the decoded body but keeps the upstream encoding headers.
  const decodedWithStaleHeaders = new Response(JSON.stringify(overlay), {
    headers: { "Content-Type": "application/json", "Content-Encoding": "br", "Content-Length": "17" },
  });
  const response = await proxyAdminChartSource(
    new Request("http://localhost:7999/admin/errors?limit=1"),
    jsonResponse({ object: "list", data: [], five_xx_buckets: [] }),
    deps({ fetch: createFetchMock(() => Promise.resolve(decodedWithStaleHeaders)) })
  );
  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.notEqual(response.headers.get("Content-Length"), "17");
  assert.deepEqual(await response.json(), overlay);
});

test("chart proxy keeps the local five-xx overlay when the remote body is unusable", async () => {
  for (const remote of [
    new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }),
    jsonResponse({ object: "list", data: [] }),
    jsonResponse({ object: "list", data: [], five_xx_buckets: "9" }),
  ]) {
    const local = jsonResponse({ object: "list", data: [], five_xx_buckets: [{ bucket_start_at_ms: 1_000, count: 1 }] });
    const response = await proxyAdminChartSource(
      new Request("http://localhost:7999/admin/errors?limit=1"),
      local,
      deps({ fetch: createFetchMock(() => Promise.resolve(remote)) })
    );
    assert.equal(response, local);
  }
});

test("chart proxy releases the body of a failed remote read", async () => {
  let cancelled = 0;
  const local = jsonResponse({ object: "list", data: [], five_xx_buckets: [] });
  const response = await proxyAdminChartSource(
    new Request("http://localhost:7999/admin/errors?limit=1"),
    local,
    deps({
      fetch: createFetchMock(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull: (controller) => {
                controller.enqueue(new TextEncoder().encode("upstream unavailable "));
              },
              cancel: () => {
                cancelled += 1;
              },
            }),
            { status: 503 }
          )
        )
      ),
    })
  );
  assert.equal(response, local);
  assert.equal(cancelled, 1);
});

test("chart proxy leaves the fuller errors view local", async () => {
  let calls = 0;
  const local = jsonResponse({ object: "list", data: [], five_xx_buckets: [] });
  const response = await proxyAdminChartSource(
    new Request("http://localhost:7999/admin/errors?limit=200"),
    local,
    deps({
      fetch: createFetchMock(() => {
        calls += 1;
        return Promise.resolve(jsonResponse({}));
      }),
    })
  );
  assert.equal(response, local);
  assert.equal(calls, 0);
});

test("chart proxy falls back to local on a missing token or failed remote read", async () => {
  const local = jsonResponse(capacityPayload("local", 7, 1_000));
  const missingToken = await proxyAdminChartSource(new Request(CAPACITY_URL), local, deps({ token: null }));
  assert.equal(missingToken, local);
  const failed = await proxyAdminChartSource(
    new Request(CAPACITY_URL),
    local,
    deps({ fetch: createFetchMock(() => Promise.resolve(new Response("upstream unavailable", { status: 503 }))) })
  );
  assert.equal(failed, local);
});

test("chart proxy still serves the canonical chart when only the push fails", async () => {
  const state = freshPushState();
  const calls: RecordedCall[] = [];
  const localPayload = localWithHistory([sample(1)]);
  const response = await poll([sample(1)], state, calls, (call) =>
    Promise.resolve(call.method === "POST" ? new Response("push unavailable", { status: 503 }) : jsonResponse(REMOTE_PAYLOAD))
  );
  const body = (await response.json()) as typeof localPayload;
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "GET"]
  );
  assert.equal(state.acknowledgedSampledAtMs, null);
  assert.deepEqual(body.sources, localPayload.sources);
  assert.deepEqual(body.history, REMOTE_PAYLOAD.history);
});

test("chart proxy reads the admin token from the Bun process environment", async () => {
  const previous = process.env.DENO_DEPLOY_TOKEN;
  try {
    for (const [configured, expected] of [
      ["env-token", "Bearer env-token"],
      [" first-token,\nsecond-token ", "Bearer first-token"],
    ] as const) {
      process.env.DENO_DEPLOY_TOKEN = configured;
      const authorizations: (string | null)[] = [];
      const response = await proxyAdminChartSource(
        new Request("http://localhost:7999/admin/errors?limit=1"),
        jsonResponse({ object: "list", data: [], five_xx_buckets: [] }),
        deps({
          token: undefined,
          fetch: createFetchMock((_input, init) => {
            authorizations.push(new Headers(init?.headers).get("Authorization"));
            return Promise.resolve(jsonResponse({ object: "list", data: [], five_xx_buckets: [{ bucket_start_at_ms: 2_000, count: 9 }] }));
          }),
        })
      );
      assert.deepEqual(authorizations, [expected]);
      assert.deepEqual(((await response.json()) as { five_xx_buckets: unknown }).five_xx_buckets, [{ bucket_start_at_ms: 2_000, count: 9 }]);
    }
  } finally {
    if (previous === undefined) delete process.env.DENO_DEPLOY_TOKEN;
    else process.env.DENO_DEPLOY_TOKEN = previous;
  }
});

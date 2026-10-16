import { test } from "bun:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { type ChartSourceProxyDeps, proxyAdminChartSource } from "../src/admin/chart-source-proxy.ts";
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

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const deps = (overrides: Partial<ChartSourceProxyDeps>): ChartSourceProxyDeps => ({
  isLoopbackAdmin: () => true,
  token: "test-token",
  remoteOrigin: "https://vps.example",
  ...overrides,
});

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

test("chart proxy pushes the local history before reading the canonical chart", async () => {
  const localPayload = capacityPayload("local", 7, 1_000);
  const remotePayload = capacityPayload("remote", 0, 2_000);
  const calls: { method: string; url: string; authorization: string | null; userAgent: string | null; body: string | null }[] = [];
  const request = new Request("http://localhost:7999/admin/providers/capacity", {
    headers: { Authorization: "Bearer browser-token" },
  });
  const response = await proxyAdminChartSource(
    request,
    jsonResponse(localPayload),
    deps({
      fetch: createFetchMock((input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          method: (init?.method ?? "GET").toUpperCase(),
          url: requestUrl(input),
          authorization: headers.get("Authorization"),
          userAgent: headers.get("User-Agent"),
          body: typeof init?.body === "string" ? init.body : null,
        });
        if (init?.method === "POST") return Promise.resolve(jsonResponse({ accepted: 1, host: "mac" }));
        return Promise.resolve(jsonResponse(remotePayload));
      }),
    })
  );
  const body = (await response.json()) as typeof localPayload;
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ["POST https://vps.example/admin/providers/capacity/observations", "GET https://vps.example/admin/providers/capacity"]
  );
  assert.deepEqual(calls[0]?.authorization, "Bearer test-token");
  assert.deepEqual(calls[1]?.authorization, "Bearer test-token");
  assert.match(calls[0]?.userAgent ?? "", /Mozilla/);
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "null"), { host: "mac", history: localPayload.history });
  assert.deepEqual(body.sources, localPayload.sources);
  assert.equal(body.snapshot_at_ms, localPayload.snapshot_at_ms);
  assert.deepEqual(body.history, remotePayload.history);
  assert.deepEqual(body.reset_events, remotePayload.reset_events);
  assert.deepEqual(body.rate_limit_reset_events, remotePayload.rate_limit_reset_events);
  assert.deepEqual(body.downtime_events, remotePayload.downtime_events);
  assert.deepEqual(body.prompt_cache, remotePayload.prompt_cache);
  assert.deepEqual(body.ledger_growth, remotePayload.ledger_growth);
});

test("chart proxy serves the canonical five-xx overlay for the chart only", async () => {
  const overlay = { object: "list", data: [], five_xx_buckets: [{ bucket_start_at_ms: 2_000, count: 9 }] };
  const seen: { method: string; url: string }[] = [];
  const response = await proxyAdminChartSource(
    new Request("http://localhost:7999/admin/errors?limit=1"),
    jsonResponse({ object: "list", data: [], five_xx_buckets: [{ bucket_start_at_ms: 1_000, count: 1 }] }),
    deps({
      fetch: createFetchMock((input, init) => {
        seen.push({ method: (init?.method ?? "GET").toUpperCase(), url: requestUrl(input) });
        return Promise.resolve(jsonResponse(overlay));
      }),
    })
  );
  assert.deepEqual(seen, [{ method: "GET", url: "https://vps.example/admin/errors?limit=1" }]);
  assert.deepEqual(await response.json(), overlay);
});

test("chart proxy re-encodes a compressed five-xx overlay instead of forwarding its transfer headers", async () => {
  const overlay = { object: "list", data: [{ status: 502, message: "upstream ".repeat(60) }], five_xx_buckets: [{ bucket_start_at_ms: 2_000, count: 9 }] };
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
      jsonResponse({ object: "list", data: [], five_xx_buckets: [] }),
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
    assert.deepEqual(JSON.parse(text), overlay);
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
  const missingToken = await proxyAdminChartSource(new Request("http://localhost:7999/admin/providers/capacity"), local, deps({ token: null }));
  assert.equal(missingToken, local);
  const failed = await proxyAdminChartSource(
    new Request("http://localhost:7999/admin/providers/capacity"),
    local,
    deps({ fetch: createFetchMock(() => Promise.resolve(new Response("upstream unavailable", { status: 503 }))) })
  );
  assert.equal(failed, local);
});

test("chart proxy still serves the union when only the push fails", async () => {
  const localPayload = capacityPayload("local", 7, 1_000);
  const remotePayload = capacityPayload("remote", 0, 2_000);
  const methods: string[] = [];
  const response = await proxyAdminChartSource(
    new Request("http://localhost:7999/admin/providers/capacity"),
    jsonResponse(localPayload),
    deps({
      fetch: createFetchMock((_input, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        methods.push(method);
        if (method === "POST") return Promise.resolve(new Response("push unavailable", { status: 503 }));
        return Promise.resolve(jsonResponse(remotePayload));
      }),
    })
  );
  const body = (await response.json()) as typeof localPayload;
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.deepEqual(body.sources, localPayload.sources);
  assert.deepEqual(body.history, remotePayload.history);
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

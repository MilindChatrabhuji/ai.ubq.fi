import { test } from "bun:test";
import type { NetAddr } from "#http";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { authenticateAdmin, authenticateClient, handleV1Auth } from "../src/auth/index.ts";
import { config } from "../src/config.ts";
import {
  configureAdminAuthForListener,
  configureAdminAuthPeerForRequest,
  configureMacLocalAdminAuthBypassForListener,
  isAdminAuthDisabledForRequest,
  isLoopbackHostname,
  parseServeRuntimeOptions,
  type ServeRuntimeOptions,
  shouldDisableAdminAuthForListener,
} from "../src/auth/local-admin.ts";

const tcpAddress = (hostname: string): NetAddr => ({
  transport: "tcp",
  hostname,
  port: 8000,
});

const enabledOptions: ServeRuntimeOptions = Object.freeze({ disableAdminAuth: true });
const disabledOptions: ServeRuntimeOptions = Object.freeze({ disableAdminAuth: false });

test("serve runtime options keep admin auth enabled by default", () => {
  assert.deepEqual(parseServeRuntimeOptions([], { isDeploy: false }), { disableAdminAuth: false });
  assert.equal(Object.isFrozen(parseServeRuntimeOptions([], { isDeploy: false })), true);
});

test("serve runtime options accept only one exact disable-admin-auth flag", () => {
  assert.deepEqual(parseServeRuntimeOptions(["--disable-admin-auth"], { isDeploy: false }), {
    disableAdminAuth: true,
  });
  assert.throws(() => parseServeRuntimeOptions(["--disable-admin-auth", "--disable-admin-auth"], { isDeploy: false }), /may only be specified once/);
  assert.throws(() => parseServeRuntimeOptions(["--disable-admin-auth=true"], { isDeploy: false }), /Unknown server argument/);
  assert.throws(() => parseServeRuntimeOptions(["--disable-auth"], { isDeploy: false }), /Unknown server argument/);
});

test("disable-admin-auth is rejected in Deno Deploy", () => {
  assert.throws(() => parseServeRuntimeOptions(["--disable-admin-auth"], { isDeploy: true }), /unavailable in Deno Deploy/);
});

test("loopback detection accepts local TCP hostnames only", () => {
  for (const hostname of ["localhost", "LOCALHOST", "127.0.0.1", "127.42.9.3", "::1", "[::1]"]) {
    assert.equal(isLoopbackHostname(hostname), true, hostname);
  }
  // RFC 5737 documentation addresses stand in for non-loopback peers.
  for (const hostname of ["0.0.0.0", "::", "192.0.2.10", "198.51.100.1", "ai.ubq.fi", "127.0.0.1.example"]) {
    assert.equal(isLoopbackHostname(hostname), false, hostname);
  }
});

test("admin auth can only be disabled on a loopback TCP listener", () => {
  assert.equal(shouldDisableAdminAuthForListener(disabledOptions, tcpAddress("0.0.0.0")), false);
  assert.equal(shouldDisableAdminAuthForListener(enabledOptions, tcpAddress("127.0.0.1")), true);
  assert.equal(shouldDisableAdminAuthForListener(enabledOptions, tcpAddress("::1")), true);
  assert.throws(() => shouldDisableAdminAuthForListener(enabledOptions, tcpAddress("localhost")), /requires a loopback TCP listener/);
  assert.throws(() => shouldDisableAdminAuthForListener(enabledOptions, tcpAddress("0.0.0.0")), /requires a loopback TCP listener/);
  assert.throws(
    () =>
      shouldDisableAdminAuthForListener(enabledOptions, {
        transport: "unix",
        // A socket path fixture, not a temporary file: nothing is created at it.
        path: "/run/ai-ubq-fi.sock",
      }),
    /requires a loopback TCP listener/
  );
});

test("guarded runtime bypass grants local super-admin access only to loopback peers", async () => {
  const localRequest = new Request("http://127.0.0.1/admin/api-keys");
  const remoteRequest = new Request("https://ai.ubq.fi/admin/api-keys");

  configureAdminAuthForListener(enabledOptions, tcpAddress("127.0.0.1"));
  // Fail closed until a loopback peer is observed.
  assert.equal(isAdminAuthDisabledForRequest(localRequest), false);
  const localAuthNoPeer = await authenticateAdmin(localRequest);
  assert.equal(localAuthNoPeer.ok, false);

  // A forwarded or port-forwarded request has a non-loopback peer and must
  // never receive the bypass, regardless of its (client-controlled) URL host.
  configureAdminAuthPeerForRequest(tcpAddress("192.0.2.10"));
  assert.equal(isAdminAuthDisabledForRequest(localRequest), false);
  const localAuthForwarded = await authenticateAdmin(localRequest);
  assert.equal(localAuthForwarded.ok, false);

  // A unix-socket peer never qualifies.
  configureAdminAuthPeerForRequest({ transport: "unix", path: "/run/ai-ubq-fi.sock" });
  assert.equal(isAdminAuthDisabledForRequest(localRequest), false);

  configureAdminAuthPeerForRequest(tcpAddress("127.0.0.1"));
  try {
    assert.equal(isAdminAuthDisabledForRequest(localRequest), true);
    assert.equal(isAdminAuthDisabledForRequest(remoteRequest), false);

    const crossOriginHeaders: HeadersInit[] = [
      { origin: "https://attacker.example" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const headers of crossOriginHeaders) {
      const crossOrigin = new Request(localRequest, { headers });
      assert.equal(isAdminAuthDisabledForRequest(crossOrigin), false);
      assert.equal((await authenticateAdmin(crossOrigin)).ok, false);
    }
    assert.equal(
      isAdminAuthDisabledForRequest(
        new Request(localRequest, {
          headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin" },
        })
      ),
      true
    );

    const localAuth = await authenticateAdmin(localRequest);
    assert.equal(localAuth.ok, true);
    {
      assert.equal(localAuth.method.kind, "disabled");
      assert.equal(localAuth.is_super_admin, true);
    }

    // Explicit listener bypass also covers clients outside the legacy dev-host list.
    const loopbackClient = await authenticateClient(new Request("http://127.42.9.3/v1/models"));
    assert.equal(loopbackClient.ok, true);
    {
      assert.equal(loopbackClient.method.kind, "disabled");
    }

    const remoteAuth = await authenticateAdmin(remoteRequest);
    assert.equal(remoteAuth.ok, false);
    {
      assert.equal(remoteAuth.response.status, 401);
    }

    const whoami = await handleV1Auth(new Request("http://127.0.0.1/uos/auth"));
    assert.equal(whoami.status, 200);
    const body = await whoami.json();
    assert.equal(body.auth.is_admin, true);
    assert.equal(body.auth.is_super_admin, true);
    assert.equal(body.auth.method.kind, "disabled");
  } finally {
    configureAdminAuthForListener(disabledOptions, tcpAddress("127.0.0.1"));
  }

  assert.equal(isAdminAuthDisabledForRequest(localRequest), false);
  const defaultAuth = await authenticateAdmin(localRequest);
  assert.equal(defaultAuth.ok, false);
  {
    assert.equal(defaultAuth.response.status, 401);
  }

  const defaultWhoami = await handleV1Auth(new Request("http://127.0.0.1/uos/auth"));
  assert.equal(defaultWhoami.status, 200);
  const defaultWhoamiBody = await defaultWhoami.json();
  assert.equal(defaultWhoamiBody.auth.is_admin, false);
  assert.equal(defaultWhoamiBody.auth.is_super_admin, false);

  const otherLoopbackClient = await authenticateClient(new Request("http://127.42.9.3/v1/models"));
  assert.equal(otherLoopbackClient.ok, false);
  {
    assert.equal(otherLoopbackClient.response.status, 401);
  }
});

const macListenerAddress: NetAddr = { transport: "tcp", hostname: "0.0.0.0", port: 7999 };

test("the Mac LAN listener configurator accepts the wildcard TCP listener only", () => {
  assert.equal(configureMacLocalAdminAuthBypassForListener(macListenerAddress), true);
  try {
    assert.throws(() => configureMacLocalAdminAuthBypassForListener(tcpAddress("127.0.0.1")), /requires the 0\.0\.0\.0 TCP listener/);
    assert.throws(
      () =>
        configureMacLocalAdminAuthBypassForListener({
          transport: "unix",
          // A socket path fixture, not a temporary file: nothing is created at it.
          path: "/run/ai-ubq-fi.sock",
        }),
      /requires the 0\.0\.0\.0 TCP listener/
    );
    // The Mac entry point never relaxes the generic guard: the same
    // non-loopback listener still fails for `--disable-admin-auth` callers.
    assert.throws(() => shouldDisableAdminAuthForListener(enabledOptions, macListenerAddress), /requires a loopback TCP listener/);
  } finally {
    configureAdminAuthForListener(disabledOptions, tcpAddress("127.0.0.1"));
  }
  assert.equal(isAdminAuthDisabledForRequest(new Request("http://127.0.0.1/v1/models")), false);
});

test("the Mac LAN listener bypasses authentication for loopback peers only", async () => {
  const localRequest = new Request("http://127.0.0.1/v1/models");
  const forgedLoopbackHost = new Request("http://127.0.0.1/v1/models");
  const unboundRequest = new Request("http://127.0.0.1/v1/models");

  assert.equal(configureMacLocalAdminAuthBypassForListener(macListenerAddress), true);
  try {
    // Fail closed until a loopback peer is observed for that exact request.
    assert.equal(isAdminAuthDisabledForRequest(localRequest), false);
    assert.equal((await authenticateAdmin(localRequest)).ok, false);

    configureAdminAuthPeerForRequest(tcpAddress("127.0.0.1"), localRequest);
    // A LAN peer that forges a loopback Host header keeps its own peer.
    configureAdminAuthPeerForRequest(tcpAddress("192.0.2.10"), forgedLoopbackHost);
    assert.equal(isAdminAuthDisabledForRequest(localRequest), true);
    assert.equal(isAdminAuthDisabledForRequest(forgedLoopbackHost), false);
    assert.equal(isAdminAuthDisabledForRequest(unboundRequest), false);

    const localAuth = await authenticateAdmin(localRequest);
    assert.equal(localAuth.ok, true);
    {
      assert.equal(localAuth.is_super_admin, true);
      assert.equal(localAuth.method.kind, "disabled");
    }

    const forgedAuth = await authenticateAdmin(forgedLoopbackHost);
    assert.equal(forgedAuth.ok, false);
    {
      assert.equal(forgedAuth.response.status, 401);
    }

    const unboundAuth = await authenticateAdmin(unboundRequest);
    assert.equal(unboundAuth.ok, false);
    {
      assert.equal(unboundAuth.response.status, 401);
    }
  } finally {
    configureAdminAuthForListener(disabledOptions, tcpAddress("127.0.0.1"));
  }
});

test("a concurrent LAN request cannot inherit a loopback peer", async () => {
  // Routing awaits several times before it authenticates, so the two requests
  // below really do overlap in production. A process-wide peer slot would let
  // the LAN request read the local request's loopback peer; each request keeps
  // its own peer instead. 127.42.9.3 is loopback but outside the legacy
  // dev-host list, so only the peer can decide here.
  const localRequest = new Request("http://127.42.9.3/v1/models");
  const lanRequest = new Request("http://127.42.9.3/v1/models");

  assert.equal(configureMacLocalAdminAuthBypassForListener(macListenerAddress), true);
  try {
    configureAdminAuthPeerForRequest(tcpAddress("127.0.0.1"), localRequest);
    // The LAN request arrives (and is bound to its own peer) before the local
    // request reaches its authentication check.
    configureAdminAuthPeerForRequest(tcpAddress("192.0.2.10"), lanRequest);
    await Promise.resolve();

    assert.equal(isAdminAuthDisabledForRequest(lanRequest), false);
    assert.equal((await authenticateClient(lanRequest)).ok, false);
    assert.equal(isAdminAuthDisabledForRequest(localRequest), true);
    assert.equal((await authenticateClient(localRequest)).ok, true);
  } finally {
    configureAdminAuthForListener(disabledOptions, tcpAddress("127.0.0.1"));
  }
});

// The production VPS (scripts/serve-vps.ts, DENO_TIMELINE=production) serves
// Caddy-proxied public traffic on its loopback listener, so a request addressed
// to that listener is not a local developer and must never authenticate as
// `disabled` through the hostname-only development fallback (#262).
const LOOPBACK_LISTENER_ORIGINS = ["http://127.0.0.1:7999", "http://localhost:7999", "http://[::1]:7999"];

const unauthenticatedResponsesRequest = (origin: string): Request =>
  new Request(origin + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: '{"input":"hi"}' });

const withProductionTimeline = async (enabled: boolean, run: () => Promise<void>): Promise<void> => {
  const mutable = config as { isProductionTimeline: boolean };
  const previous = mutable.isProductionTimeline;
  mutable.isProductionTimeline = enabled;
  try {
    await run();
  } finally {
    mutable.isProductionTimeline = previous;
  }
};

test("a development checkout keeps the loopback hostname client-auth bypass", async () => {
  assert.equal(config.isDeploy, false);
  await withProductionTimeline(false, async () => {
    for (const origin of LOOPBACK_LISTENER_ORIGINS) {
      const result = await authenticateClient(unauthenticatedResponsesRequest(origin));
      assert.equal(result.ok, true, origin);
      assert.equal(result.method.kind, "disabled", origin);
    }
    const whoami = await handleV1Auth(new Request("http://127.0.0.1:7999/uos/auth"));
    assert.equal(whoami.status, 200);
    assert.equal((await whoami.json()).auth.mode, "disabled");
  });
});

test("the production VPS timeline refuses unauthenticated loopback client requests", async () => {
  assert.equal(config.isDeploy, false);
  await withProductionTimeline(true, async () => {
    for (const origin of LOOPBACK_LISTENER_ORIGINS) {
      const result = await authenticateClient(unauthenticatedResponsesRequest(origin));
      assert.equal(result.ok, false, origin);
      assert.equal(result.response.status, 401, origin);
    }
    const whoami = await handleV1Auth(new Request("http://127.0.0.1:7999/uos/auth"));
    assert.equal(whoami.status, 401);
  });
});

type TimelineProbe = Readonly<{ isDeploy: boolean; isProductionTimeline: boolean; ok: boolean; method: string | null; status: number | null }>;

/** Loads config and client auth in a fresh process whose only timeline input is `DENO_TIMELINE`. */
const probeLoopbackClientAuth = async (timeline: string | null): Promise<TimelineProbe> => {
  const module = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href);
  const source = [
    `const { setKvForTest } = await import(${module("../src/kv.ts")});`,
    `const { config } = await import(${module("../src/config.ts")});`,
    `const { authenticateClient } = await import(${module("../src/auth/index.ts")});`,
    "setKvForTest(null);",
    'const result = await authenticateClient(new Request("http://127.0.0.1:7999/v1/responses", { method: "POST", body: "{}" }));',
    "console.log(JSON.stringify({ isDeploy: config.isDeploy, isProductionTimeline: config.isProductionTimeline, ok: result.ok, method: result.ok ? result.method.kind : null, status: result.ok ? null : result.response.status }));",
  ].join("\n");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  if (timeline !== null) env.DENO_TIMELINE = timeline;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", source], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as TimelineProbe;
};

test("DENO_TIMELINE=production disables the loopback hostname client-auth bypass at startup", async () => {
  assert.deepEqual(await probeLoopbackClientAuth("production"), { isDeploy: false, isProductionTimeline: true, ok: false, method: null, status: 401 });
  assert.deepEqual(await probeLoopbackClientAuth(null), { isDeploy: false, isProductionTimeline: false, ok: true, method: "disabled", status: null });
});

test("the VPS entrypoint requires the production timeline and never enables a loopback auth bypass", async () => {
  const source = await readFile(new URL("../scripts/serve-vps.ts", import.meta.url), "utf8");
  assert.match(source, /if \(process\.env\.DENO_TIMELINE !== "production"\) throw /);
  for (const enabler of [
    "configureAdminAuthForListener",
    "configureMacLocalAdminAuthBypassForListener",
    "configureAdminAuthPeerForRequest",
    "configureLoopbackServeRuntime",
    "--disable-admin-auth",
    "auth/local-admin",
  ]) {
    assert.equal(source.includes(enabler), false, enabler);
  }
});

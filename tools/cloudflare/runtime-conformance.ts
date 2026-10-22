import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { liveCases } from "./fixtures/live-conformance.ts";
import { isObject } from "./runtime-conformance-support.ts";
import { failureCaptureCase, captureSuppressionCase } from "./fixtures/capture-conformance.ts";
import { cerebrasPaymentCases, passportCases } from "./runtime-auth-conformance.ts";
import { runProviderMatrixCases, type MatrixContext, type MatrixScenario } from "./runtime-matrix/index.ts";
import { compactionFallbackCases, replayProviderCases, unicodeForwardingCases } from "./runtime-matrix/context-replay.ts";
import { testNetworkArgv } from "../../scripts/test-network.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expectedSha = process.argv[2] === "--fixture-child" ? process.argv[3] : process.argv[2];
assert(expectedSha && /^[a-f0-9]{40}$/.test(expectedSha), "Pass the exact compiled application's full source SHA.");
assert.equal(Bun.version, "1.4.0");
const require = createRequire(import.meta.url);
const workerd: unknown = require("workerd");
assert(isObject(workerd) && typeof workerd.default === "string", "The prepared native workerd binary is required.");
const workerdBinary = workerd.default;
const workerdPackage: unknown = JSON.parse(await readFile(join(root, "node_modules/workerd/package.json"), "utf8"));
assert(isObject(workerdPackage) && workerdPackage.version === "1.20261012.1", "The locked workerd version is required.");

async function outer(): Promise<void> {
  const parent = join(root, ".data/rust-runtime-conformance");
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, "run-"));
  const control = await lookup(new URL("https://developers.cloudflare.com").hostname, { family: 4 });
  await reachableControl(control.address, 443);
  const command = testNetworkArgv([
    process.execPath,
    "--no-env-file",
    "--no-install",
    fileURLToPath(import.meta.url),
    "--fixture-child",
    expectedSha,
    workspace,
    control.address,
    "443",
  ]);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: workspace, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  const child = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const stop = (): void => {
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timeout = setTimeout(stop, 90_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await Promise.all([writeFile(join(workspace, "stdout.log"), stdout), writeFile(join(workspace, "stderr.log"), stderr)]);
    assert.equal(code, 0, `Actual workerd conformance failed; evidence: ${workspace}`);
    await reachableControl(control.address, 443);
    const receipt: unknown = JSON.parse(stdout.trim());
    assert(isObject(receipt) && Array.isArray(receipt.cases) && receipt.cases.length >= 16, "A nonzero complete case floor is required.");
    await writeFile(join(workspace, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify({ evidence: workspace, ...receipt }));
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    stop();
  }
}

async function reachableControl(host: string, port: number): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const socket = connect({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectProbe(new Error("The outside-boundary TCP control is unavailable."));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe();
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timeout);
      rejectProbe(error);
    });
  });
}

async function deniedEgress(host: string, port: number): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const socket = connect({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectProbe(new Error("An egress timeout does not prove OS denial."));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      rejectProbe(new Error("The fixture OS boundary allowed external TCP."));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      const denied = ["EPERM", "EACCES", "ENETUNREACH", "EHOSTUNREACH"];
      // Seatbelt reports a refused connect on this Bun/Darwin build. The same
      // endpoint must accept native TCP both before and after the isolated run.
      if (process.platform === "darwin") denied.push("ECONNREFUSED");
      if (denied.includes(error.code ?? "")) resolveProbe();
      else rejectProbe(error);
    });
  });
}

async function fixtureConfig(workspace: string, scenario?: MatrixScenario): Promise<string> {
  const application = join(root, "rust/crates", scenario ? "gateway-worker-fixture" : "gateway-worker", "build");
  const scenarioBinding = scenario ? `, (name = "UOS_MATRIX_SCENARIO", text = ${JSON.stringify(scenario)})` : "";
  const paidBindings =
    scenario === "paid"
      ? ', (name = "SURPLUS_API_KEY", text = "fixture-matrix-surplus"), (name = "OPENLUX_API_KEY", text = "fixture-matrix-openlux-discovery"), (name = "METERED_API_KEY", text = "fixture-matrix-openlux-spend")'
      : "";
  const path = join(workspace, "runtime.capnp");
  const quoted = (value: string): string => JSON.stringify(value);
  await mkdir(join(workspace, "state"), { recursive: true });
  const config = `using Workerd = import ${quoted(join(root, "node_modules/workerd/workerd.capnp"))};
const config :Workerd.Config = (
  services = [
    (name = "internet", network = (allow = [])),
    (name = "state", disk = (path = ${quoted(join(workspace, "state"))}, writable = true)),
    (name = "assets", disk = (path = ${quoted(join(root, "static"))})),
    (name = "gateway", worker = (
      modules = [(name = "index.js", esModule = embed ${quoted(join(application, "index.js"))}), (name = "index_bg.wasm", wasm = embed ${quoted(join(application, "index_bg.wasm"))})],
      compatibilityDate = "2026-10-18", compatibilityFlags = ["enable_request_signal", "request_signal_passthrough"],
      globalOutbound = "driver",
      bindings = [(name = "AUTHORITY", durableObjectNamespace = (className = "GatewayAuthority")), (name = "ASSETS", service = "assets"), (name = "UOS_AI_TOKEN", text = "fixture-access"), (name = "DENO_DEPLOY_TOKEN", text = "fixture-admin"), (name = "LITHOSAI_API_KEY", text = "fixture-provider-secret"), (name = "DEEPSEEK_API_KEY", text = "fixture-provider-secret"), (name = "CEREBRAS_API_KEY", text = "fixture-provider-secret"), (name = "OPENROUTER_API_KEY", text = "fixture-provider-secret"), (name = "VOYAGEAI_API_KEY", text = "fixture-provider-secret"), (name = "SENTINEL_REPLAY_KEY", text = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), (name = "IMAGE_BASE_MODEL", text = "gpt-matrix-test"), (name = "UOS_AI_PASSPORT_CLIENT_ID", text = "ai"), (name = "UOS_AI_PASSPORT_AUDIENCE", text = "ai"), (name = "UOS_AI_PASSPORT_ORIGIN", text = "https://ai.ubq.fi"), (name = "UOS_AI_PASSPORT_REDIRECT_URI", text = "https://ai.ubq.fi/auth/callback")${scenarioBinding}${paidBindings}],
      durableObjectNamespaces = [(className = "GatewayAuthority", uniqueKey = "uos-rust-runtime-conformance-v1", enableSql = true)],
      durableObjectStorage = (localDisk = "state")
    )),
    (name = "driver", worker = (
      modules = [(name = "driver.mjs", esModule = embed ${quoted(join(root, "tools/cloudflare/fixtures/runtime-driver.mjs"))}), (name = "provider-matrix.mjs", esModule = embed ${quoted(join(root, "tools/cloudflare/fixtures/provider-matrix.mjs"))})],
      compatibilityDate = "2026-10-18", compatibilityFlags = ["enable_request_signal", "request_signal_passthrough"],
      bindings = [(name = "GATEWAY", service = "gateway"), (name = "AUTHORITY", durableObjectNamespace = (className = "GatewayAuthority", serviceName = "gateway")), (name = "CONTROL", durableObjectNamespace = (className = "FixtureControl"))],
      durableObjectNamespaces = [(className = "FixtureControl", uniqueKey = "uos-rust-runtime-control-v1", enableSql = true)],
      durableObjectStorage = (localDisk = "state")
    ))
  ],
  sockets = [(name = "main", http = (), service = "driver"), (name = "public", http = (), service = "gateway")]
);`;
  await writeFile(path, config);
  return path;
}

type Running = { origin: string; publicOrigin: string; stop: () => Promise<void> };
async function start(config: string, workspace: string): Promise<Running> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = reservation.port;
  const publicReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const publicPort = publicReservation.port;
  await Promise.all([reservation.stop(true), publicReservation.stop(true)]);
  const runId = Date.now();
  const output = Bun.file(join(workspace, `workerd-${runId}.stdout.log`));
  const errors = Bun.file(join(workspace, `workerd-${runId}.stderr.log`));
  const child = Bun.spawn(
    [
      workerdBinary,
      "serve",
      config,
      "--experimental",
      "--import-path",
      "/",
      "--socket-addr",
      `main=127.0.0.1:${port}`,
      "--socket-addr",
      `public=127.0.0.1:${publicPort}`,
    ],
    {
      cwd: workspace,
      stdout: output,
      stderr: errors,
    }
  );
  const origin = `http://127.0.0.1:${port}`;
  const publicOrigin = `http://127.0.0.1:${publicPort}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("workerd exited during startup.");
      try {
        const ready = await fetch(`${publicOrigin}/health`);
        if (ready.status === 200) return { origin, publicOrigin, stop };
      } catch {
        /* process startup */
      }
      await Bun.sleep(20);
    }
    throw new Error("workerd did not become ready within ten seconds.");
  } catch (error) {
    await stop();
    throw error;
  }
}

function tuple(...parts: string[]): string {
  return "tuple-v1:" + parts.map((part) => "02" + Buffer.from(part).toString("hex").replaceAll("00", "00ff") + "00").join("");
}
async function objectBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert(isObject(body));
  return body;
}

async function assertUpstreamCancelled(events: () => Promise<unknown[]>, marker: string): Promise<void> {
  const deadline = Date.now() + 2000;
  let cancelled: boolean;
  do {
    cancelled = (await events()).some(
      (event: unknown) => isObject(event) && event.kind === "upstream_cancelled" && typeof event.prompt === "string" && event.prompt.includes(marker)
    );
    if (!cancelled) await Bun.sleep(10);
  } while (!cancelled && Date.now() < deadline);
  assert(cancelled, "Caller abort must reach the actual controlled upstream.");
}

async function disconnectAfterFirstChunk(url: string, body: unknown, workspace: string): Promise<string> {
  const headers = join(workspace, "cancel-client.headers");
  const output = join(workspace, "cancel-client.body");
  const argv = [
    "/usr/bin/curl",
    "--disable",
    "--silent",
    "--show-error",
    "--no-buffer",
    "--http1.1",
    "--max-time",
    "1",
    "--request",
    "POST",
    "--header",
    "content-type: application/json",
    "--header",
    "authorization: Bearer fixture-access",
    "--header",
    "x-fixture-disconnect: 1",
    "--data-binary",
    JSON.stringify(body),
    "--dump-header",
    headers,
    "--output",
    output,
    url,
  ];
  const child = Bun.spawn(argv, { cwd: workspace, stdout: "pipe", stderr: "pipe" });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  await writeFile(join(workspace, "cancel-client.stderr.log"), stderr);
  assert.equal(exit, 28, "Native client must terminate its actual socket at the declared timeout.");
  const received = await readFile(output, "utf8");
  assert(received.includes("fixture ") && !received.includes("response.completed"), "The real client must receive progressive output before disconnect.");
  const id = (await readFile(headers, "utf8"))
    .split("\n")
    .find((line) => line.toLowerCase().startsWith("x-uos-request-id:"))
    ?.slice("x-uos-request-id:".length)
    .trim();
  assert(id);
  return id;
}

type ScenarioHarness = { scope: string; restart: () => Promise<void> };

async function catalogRestartCases(context: MatrixContext & ScenarioHarness, cases: string[]): Promise<void> {
  const headers = { authorization: "Bearer fixture-access" };
  const catalogKey = tuple("ubq_ai", "codex_catalog", "0.163.0");
  const priorCatalog = await context.read(catalogKey);
  if (priorCatalog) {
    const deleted = await context.rpc({
      operation: "commit",
      checks: [{ key: catalogKey, expected_revision: priorCatalog.revision }],
      mutations: [{ operation: "delete", key: catalogKey }],
    });
    assert.equal(deleted.committed, true);
  }
  // Clear the isolate memo as well as the durable catalog so this is a real
  // cold provider-discovery pass rather than a cached catalog response.
  await context.restart();
  const warm = await fetch(context.url("/v1/models?client_version=0.163.0"), { headers });
  assert.equal(warm.status, 200);
  const warmBody = await objectBody(warm);
  let warmModels = Array.isArray(warmBody.models) ? warmBody.models : [];
  let warmEtag = warm.headers.get("etag");
  assert(warmModels.length > 0 && warmEtag);
  // A warm catalog may already be durable, so explicitly force the same admin
  // discovery path before asserting that provider observations survive restart.
  const refresh = await context.post("/admin/models/refresh", {}, "fixture-admin");
  assert.equal(refresh.status, 200, await refresh.clone().text());
  const generation = (await context.read(tuple("ubq_ai", "codex_catalog_auth_generation")))?.value;
  assert.equal(typeof generation, "string");
  const observationKey = tuple(
    "ubq_ai",
    "provider_catalog_v1",
    String(generation),
    "lithos",
    createHash("sha256").update(createHash("sha256").update("lithos\0fixture-provider-secret").digest("hex")).digest("hex")
  );
  let observation = null;
  const observationDeadline = Date.now() + 15_000;
  while (Date.now() < observationDeadline) {
    observation = await context.read(observationKey);
    if (observation) break;
    await Bun.sleep(50);
  }
  assert(observation, "provider observations must persist for a fresh process");
  // Provider discovery can change the assembled body. Use the settled catalog
  // for the stale/conditional checks, not the pre-discovery response.
  const settled = await fetch(context.url("/v1/models?client_version=0.163.0"), { headers });
  assert.equal(settled.status, 200);
  const settledBody = await objectBody(settled);
  warmModels = Array.isArray(settledBody.models) ? settledBody.models : [];
  warmEtag = settled.headers.get("etag");
  assert(warmModels.length > 0 && warmEtag);
  const freshConditional = await fetch(context.url("/v1/models?client_version=0.163.0"), {
    headers: { ...headers, "if-none-match": warmEtag },
  });
  assert.equal(freshConditional.status, 304);
  assert.equal((await freshConditional.arrayBuffer()).byteLength, 0);
  const metadata = await context.read(tuple("ubq_ai", "codex_catalog", "0.163.0"));
  assert(metadata && isObject(metadata.value));
  const metadataValue = metadata.value;
  const staleAt = Date.now() - 600_000;
  const staleRevision = `stale-${Date.now()}`;
  const committed = await context.rpc({
    operation: "commit",
    checks: [{ key: tuple("ubq_ai", "codex_catalog", "0.163.0"), expected_revision: metadata.revision }],
    mutations: [
      {
        operation: "put",
        key: tuple("ubq_ai", "codex_catalog", "0.163.0"),
        record: { ...metadata, revision: staleRevision, value: { ...metadataValue, fetched_at_ms: staleAt } },
      },
    ],
  });
  assert.equal(committed.committed, true);
  cases.push("catalog_durable_provider_observations_and_stale_metadata_seeded");

  const baseline = (await context.events()).filter((event) => isObject(event) && event.kind === "matrix_catalog" && event.provider === "codex").length;
  await context.restart();

  const started = performance.now();
  const stale = await fetch(context.url("/v1/models?client_version=0.163.0"), { headers });
  const elapsed = performance.now() - started;
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get("x-uos-cache"), "stale");
  assert.equal(stale.headers.get("etag"), warmEtag, "stale rendering must preserve the final-body ETag");
  const staleBody = await objectBody(stale);
  const staleModels = Array.isArray(staleBody.models) ? staleBody.models : [];
  assert.equal(staleModels.length, warmModels.length);
  assert(elapsed < 2_000, `retained stale catalog must answer without blocking refresh (took ${Math.round(elapsed)}ms)`);
  cases.push("fresh_workerd_retained_stale_catalog_answers_quickly_with_same_models_and_etag");

  const deadline = Date.now() + 15_000;
  let refreshed = false;
  while (Date.now() < deadline) {
    const rows = (await context.events()).filter((event) => isObject(event) && event.kind === "matrix_catalog" && event.provider === "codex").length;
    if (rows > baseline) {
      refreshed = true;
      break;
    }
    await Bun.sleep(50);
  }
  assert(refreshed, "the stale response must schedule the normal background refresh");
  cases.push("fresh_catalog_conditional_304_semantics");
  cases.push("stale_while_revalidate_refresh_occurs");
}

async function staticRouteCases(url: (path: string) => string, cases: string[]): Promise<void> {
  const sourceStatic = await readFile(join(root, "src/static.ts"), "utf8");
  for (const match of sourceStatic.matchAll(/textAsset\(\[([^\]]+)\], "([^"]+)", "([^"]+)"(, "html")?/g)) {
    const routes: unknown = JSON.parse(`[${match[1]}]`);
    assert(Array.isArray(routes));
    const expected = await readFile(join(root, "static", match[2]));
    for (const route of routes) {
      assert.equal(typeof route, "string");
      const served = await fetch(url(String(route)));
      assert.equal(served.status, 200, String(route));
      assert.equal(served.headers.get("content-type"), match[3]);
      assert.equal(served.headers.get("cache-control"), route === "/admin" || String(route).startsWith("/admin/") ? "no-store" : "public, max-age=300");
      assert.equal(served.headers.get("x-content-type-options"), "nosniff");
      if (match[4]) {
        assert(served.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
        assert.equal(served.headers.get("referrer-policy"), "no-referrer");
      }
      assert.deepEqual(new Uint8Array(await served.arrayBuffer()), new Uint8Array(expected));
      const head = await fetch(url(String(route)), { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-type"), match[3]);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
  }
  cases.push("source_static_route_bytes_head_and_security_parity");
  for (const [accept, status, contentType] of [
    ["text/markdown", 200, "text/markdown; charset=utf-8"],
    ["application/json", 200, "application/json"],
    ["text/html;q=0, */*;q=1", 200, "text/html; charset=utf-8"],
    ["image/png", 406, "application/json"],
  ] as const) {
    const served = await fetch(url("/"), { headers: { Accept: accept } });
    assert.equal(served.status, status);
    assert(
      served.headers.get("content-type")?.startsWith(contentType),
      JSON.stringify({ accept, expected: contentType, actual: served.headers.get("content-type") })
    );
    assert.equal(served.headers.get("vary"), "Accept, Accept-Encoding");
    await served.arrayBuffer();
  }
  cases.push("source_root_media_negotiation");
  for (const path of ["/health///", "/docs///"]) {
    const normalized = await fetch(url(path));
    assert.equal(normalized.status, 200);
    await normalized.arrayBuffer();
  }
  cases.push("source_trailing_slash_normalization_for_health_and_assets");
}

async function agentMessageCases(url: (path: string) => string, cases: string[]): Promise<void> {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = pair.publicKey.export({ type: "spki", format: "pem" });
  const created = await fetch(url("/admin/kernel-pubkeys"), {
    method: "POST",
    headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" },
    body: JSON.stringify({ app_id: 91, pem, owner: "runtime fixture" }),
  });
  assert.equal(created.status, 200);
  await created.arrayBuffer();
  const token = "ghs_fixture_kernel_access";
  const headers = (stateId: string): HeadersInit => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      owner: "fixture-owner",
      repo: "fixture-repo",
      state_id: stateId,
      auth_token_sha256: createHash("sha256").update(token).digest("base64url"),
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 300,
    };
    const data = `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const jwt = `${data}.${sign("RSA-SHA256", Buffer.from(data), pair.privateKey).toString("base64url")}`;
    return {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-owner": claims.owner,
      "x-github-repo": claims.repo,
      "x-ubiquity-kernel-token": jwt,
    };
  };
  const message = await fetch(url("/uos/agent-messages"), {
    method: "POST",
    headers: headers("fixture-state"),
    body: JSON.stringify({ agent_id: "fixture-agent", channel: "fixture-channel", body: "source scoped message", metadata: { value: 1 } }),
  });
  assert.equal(message.status, 200);
  const saved = await objectBody(message);
  assert(isObject(saved.message));
  const list = await fetch(url("/uos/agent-messages?channel=fixture-channel&limit=1"), { headers: headers("fixture-state") });
  const listed = await objectBody(list);
  assert(Array.isArray(listed.messages) && listed.messages.length === 1 && isObject(listed.messages[0]));
  assert.equal(listed.messages[0].id, saved.message.id);
  const other = await objectBody(await fetch(url("/uos/agent-messages"), { headers: headers("other-state") }));
  assert.deepEqual(other.messages, []);
  const invalid = await fetch(url("/uos/agent-messages"), {
    method: "POST",
    headers: headers("fixture-state"),
    body: JSON.stringify({ agent_id: "fixture-agent", body: "💻".repeat(4001) }),
  });
  assert.equal(invalid.status, 400);
  await invalid.arrayBuffer();
  cases.push("actual_kernel_rs256_github_auth_and_message_scope");
}

async function refusalCases(
  post: (path: string, body: unknown) => Promise<Response>,
  lifecycle: (id: string) => Promise<Record<string, unknown>>,
  cases: string[]
): Promise<void> {
  const refusal = await post("/v1/responses", { model: "deepseek-flash", input: "fixture:refusal-progressive" });
  assert.equal(refusal.status, 418, refusal.status === 418 ? undefined : await refusal.text());
  assert.equal(refusal.headers.get("content-type"), "application/octet-stream");
  assert.equal(refusal.headers.get("x-fixture-refusal"), "raw");
  assert.equal(refusal.headers.get("x-uos-provider-request-id"), "fixture-refusal-id");
  assert.deepEqual(refusal.headers.getSetCookie(), ["first=1; Secure; HttpOnly", "second=2; Secure; HttpOnly"]);
  assert(refusal.body);
  const refusalReader = refusal.body.getReader();
  const refusalFirst = await refusalReader.read();
  assert.deepEqual(refusalFirst.value, new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0x00, 0x41]));
  const refusalBytes = Array.from(refusalFirst.value);
  for (;;) {
    const part = await refusalReader.read();
    if (part.done) break;
    refusalBytes.push(...part.value);
  }
  assert.deepEqual(refusalBytes, [0xef, 0xbb, 0xbf, 0xff, 0x00, 0x41, 0x42, 0xfe, 0x43]);
  const refusalId = refusal.headers.get("x-uos-request-id");
  assert(refusalId);
  const refusalState = await lifecycle(refusalId);
  assert.equal(refusalState.semantic_committed, false);
  assert(isObject(refusalState.terminal_intent));
  assert.equal(refusalState.terminal_intent.semantic_terminal, null);
  assert.equal(refusalState.terminal_intent.delivery, "unobserved");
  cases.push("provider_refusal_preserves_progressive_raw_bytes_status_and_headers");
  const emptyRefusal = await post("/v1/responses", { model: "deepseek-flash", input: "fixture:refusal-empty" });
  assert.equal(emptyRefusal.status, 416);
  assert.equal(emptyRefusal.headers.get("x-fixture-refusal"), "empty");
  assert.equal((await emptyRefusal.arrayBuffer()).byteLength, 0);
  cases.push("empty_provider_refusal_keeps_original_status");
}

async function observationCases(url: (path: string) => string, cases: string[]): Promise<void> {
  const oversized = await fetch(url("/admin/providers/capacity/observations"), {
    method: "POST",
    headers: { authorization: "Bearer fixture-admin", "content-type": "application/json" },
    body: " ".repeat(4 * 1024 * 1024) + "{}",
  });
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();
  cases.push("capacity_observation_limit_uses_original_whitespace_bytes");
  const promptAnalytics = await fetch(url("/admin/prompt-cache-analytics"), { headers: { authorization: "Bearer fixture-admin" } });
  assert.equal(promptAnalytics.status, 200);
  const analytics = await objectBody(promptAnalytics);
  assert(Array.isArray(analytics.buckets));
  assert.equal(analytics.bucket_ms, 900_000);
  cases.push("authenticated_prompt_analytics_reads_actual_authority");
}

async function authorityAtomicCases(rpc: (body: unknown) => Promise<Record<string, unknown>>, cases: string[]): Promise<void> {
  const anchor = tuple("fixture", "atomic", "anchor");
  const valueKey = tuple("fixture", "atomic", "value");
  const put = (key: string, revision: string, value: unknown): unknown => ({
    operation: "put",
    key,
    record: { schema_version: 1, revision, value, expires_at_ms: null },
  });
  assert.equal((await rpc({ operation: "commit", checks: [], mutations: [put(anchor, "anchor-one", 1)] })).committed, true);
  assert.equal(
    (await rpc({ operation: "commit", checks: [{ key: anchor, expected_revision: "anchor-one" }], mutations: [put(valueKey, "value-one", 1)] })).committed,
    true
  );
  assert.equal(
    (await rpc({ operation: "commit", checks: [{ key: anchor, expected_revision: "stale-anchor" }], mutations: [put(valueKey, "value-two", 2)] })).committed,
    false
  );
  const retained = (await rpc({ operation: "read", key: valueKey })).record;
  assert(isObject(retained));
  assert.equal(retained.revision, "value-one");
  assert.equal(retained.value, 1);
  assert.equal((await rpc({ operation: "commit", checks: [], mutations: [{ operation: "delete", key: valueKey }] })).committed, true);
  assert.equal((await rpc({ operation: "read", key: valueKey })).record, null);
  cases.push("actual_authority_unconditional_writes_and_cross_key_atomic_cas");
}

async function extrasCases(input: {
  url: (path: string) => string;
  post: (path: string, body: unknown) => Promise<Response>;
  rpc: (body: unknown) => Promise<Record<string, unknown>>;
  events: () => Promise<unknown[]>;
  lifecycle: (id: string) => Promise<Record<string, unknown>>;
  cases: string[];
}): Promise<void> {
  const { url, post, rpc, events, lifecycle, cases } = input;
  const requestBody = { model: "voyage-4-large", input: "fixture:embedding", dimensions: 256 };
  const embedding = await post("/uos/embeddings", requestBody);
  assert.equal(embedding.status, 200);
  assert.equal(embedding.headers.get("x-uos-upstream"), "voyage");
  const vectors = await objectBody(embedding);
  assert(Array.isArray(vectors.data) && isObject(vectors.data[0]) && Array.isArray(vectors.data[0].embedding));
  assert.equal(vectors.data[0].embedding.length, 256);
  assert.equal(vectors.data[0].embedding[0], 0.125);
  assert.deepEqual(vectors.usage, { prompt_tokens: 7, total_tokens: 7 });
  const embeddingId = embedding.headers.get("x-uos-request-id");
  assert(embeddingId);
  const committed = await lifecycle(embeddingId);
  assert(isObject(committed.extras_dispatch));
  assert.equal(committed.extras_dispatch.provider, "voyage");
  assert(isObject(committed.kernel_override));
  assert.equal(committed.kernel_override.terminal, "committed");
  const dispatchCount = (await events()).filter((event) => isObject(event) && event.kind === "extras_dispatch").length;
  assert.deepEqual(await objectBody(await post("/uos/embeddings", requestBody)), { ...vectors, usage: { prompt_tokens: 0, total_tokens: 0 } });
  assert.equal((await events()).filter((event) => isObject(event) && event.kind === "extras_dispatch").length, dispatchCount);
  cases.push("actual_voyage_embedding_fixed_transport_cache_and_one_original_admission");

  const queued = await post("/uos/embedding-jobs", { ...requestBody, input: "fixture:job-retry-secret", input_type: "document" });
  assert.equal(queued.status, 202);
  const job = await objectBody(queued);
  assert.equal(typeof job.id, "string");
  const encrypted = await rpc({
    operation: "query",
    selector: { kind: "prefix", prefix: tuple("embeddings", "jobs", "v2", "input"), start: null, end: null },
    reverse: false,
    limit: 10,
    cursor: null,
    now_ms: Date.now(),
  });
  assert(Array.isArray(encrypted.entries) && encrypted.entries.length > 0);
  for (const entry of encrypted.entries) {
    assert(isObject(entry) && isObject(entry.record) && isObject(entry.record.value));
    const value = entry.record.value;
    assert.equal(typeof value.iv_b64, "string");
    assert.equal(typeof value.data_b64, "string");
    assert.equal(Buffer.from(String(value.iv_b64), "base64").byteLength, 12);
    assert.equal(Buffer.from(String(value.data_b64), "base64").byteLength, Buffer.byteLength("fixture:job-retry-secret") + 16);
    assert(!JSON.stringify(value).includes("fixture:job-retry-secret"));
  }
  const recovered = await fetch(url(`/uos/embedding-jobs/${String(job.id)}`), { headers: { authorization: "Bearer fixture-access" } });
  assert.equal(recovered.status, 200);
  const completed = await objectBody(recovered);
  assert.equal(completed.status, "succeeded");
  assert(isObject(completed.result) && Array.isArray(completed.result.data) && completed.result.data.length === 1);
  const pollId = recovered.headers.get("x-uos-request-id");
  assert(pollId);
  const poll = await lifecycle(pollId);
  assert(isObject(poll.kernel_override));
  assert.equal(poll.kernel_override.terminal, "released");
  assert(isObject(poll.extras_dispatch));
  assert.equal(poll.extras_dispatch.provider, "voyage");
  assert.equal(poll.extras_dispatch.transport_started, true);
  cases.push("actual_worker_aes_gcm_encrypted_job_poll_retry_and_released_kernel");

  const decision = await post("/v1/systemone", { state: { ready: true }, questions: { proceed: { type: "noul", prompt: "Proceed?" } } });
  assert.equal(decision.status, 200);
  const answer = await objectBody(decision);
  assert(isObject(answer.answers) && isObject(answer.answers.proceed));
  assert.equal(answer.answers.proceed.probability, 0.75);
  const decisionId = decision.headers.get("x-uos-request-id");
  assert(decisionId);
  const systemone = await lifecycle(decisionId);
  assert(isObject(systemone.extras_dispatch));
  assert.equal(systemone.extras_dispatch.provider, "openrouter");
  assert.equal(systemone.extras_dispatch.transport_started, true);
  cases.push("actual_systemone_fixed_openrouter_transport_and_dispatch_attribution");
}

async function imageCases(input: {
  url: (path: string) => string;
  post: (path: string, body: unknown) => Promise<Response>;
  lifecycle: (id: string) => Promise<Record<string, unknown>>;
  cases: string[];
}): Promise<void> {
  const { url, post, lifecycle, cases } = input;
  // The isolated Rust fixture constructor installs and validates this source.
  const generated = await post("/v1/images/generations", { prompt: "fixture:image-generated", n: 2 });
  assert.equal(generated.status, 200);
  const images = await objectBody(generated);
  assert(Array.isArray(images.data) && images.data.length === 2);
  assert(images.data.every((image: unknown) => isObject(image) && image.b64_json === "aW1hZ2U="));
  const id = generated.headers.get("x-uos-request-id");
  assert(id);
  const state = await lifecycle(id);
  assert(
    Array.isArray(state.children) &&
      state.children.length === 2 &&
      state.children.every((child: unknown) => isObject(child) && child.settled === true && child.transport_started === true)
  );
  assert(isObject(state.children[0]) && isObject(state.children[1]));
  assert.equal(state.children[0].request_id, id);
  assert.equal(state.children[1].request_id, `${id}:image:generations:2`);
  assert(isObject(state.extras_dispatch) && isObject(state.kernel_override));
  assert.equal(state.extras_dispatch.provider, "chatgpt_codex");
  assert.equal(state.kernel_override.terminal, "committed");
  cases.push("actual_codex_image_fanout_child_identity_and_single_original_kernel");

  const form = new FormData();
  form.append("prompt", "fixture:image-edit");
  form.append("n", "1");
  form.append("image[]", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }), "fixture.png");
  const edited = await fetch(url("/v1/images/edits"), { method: "POST", headers: { authorization: "Bearer fixture-access" }, body: form });
  assert.equal(edited.status, 200);
  const editedBody = await objectBody(edited);
  assert(Array.isArray(editedBody.data) && editedBody.data.length === 1);
  const editId = edited.headers.get("x-uos-request-id");
  assert(editId);
  await lifecycle(editId);
  cases.push("actual_bounded_multipart_image_edit_and_native_codex_decoder");

  const invalid = await post("/v1/images/generations", { n: 0 });
  assert.equal(invalid.status, 400);
  const invalidId = invalid.headers.get("x-uos-request-id");
  assert(invalidId);
  await invalid.arrayBuffer();
  const rejected = await lifecycle(invalidId);
  assert.deepEqual(rejected.children, []);
  assert.equal(rejected.extras_dispatch, null);
  assert(isObject(rejected.kernel_override));
  assert.equal(rejected.kernel_override.terminal, "released");
  cases.push("invalid_image_plan_releases_original_without_claim_or_provider_call");
}

async function inner(): Promise<void> {
  const workspace = process.argv[4];
  assert(workspace && resolve(workspace).startsWith(join(root, ".data/rust-runtime-conformance/")));
  const controlHost = process.argv[5];
  const controlPort = Number(process.argv[6]);
  assert(controlHost && Number.isInteger(controlPort) && controlPort > 0 && controlPort < 65536);
  await deniedEgress(controlHost, controlPort);
  const cases = ["os_external_tcp_denied"];
  let config = await fixtureConfig(workspace);
  let running = await start(config, workspace);
  const url = (path: string): string => `${running.publicOrigin}${path}`;
  const post = (path: string, body: unknown, token = "fixture-access", signal?: AbortSignal): Promise<Response> =>
    fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, connection: "close" },
      body: JSON.stringify(body),
      signal,
    });
  const rpc = async (body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`${running.origin}/store`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return objectBody(response);
  };
  const read = async (key: string): Promise<Record<string, unknown> | null> => {
    const value = (await rpc({ operation: "read", key })).record;
    assert(value === null || isObject(value));
    return value;
  };
  const lifecycle = async (id: string, waitMs = 3000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const row = await read(tuple("uos_ai", "routing_runtime", "v1", "session", id));
      if (row && isObject(row.value) && row.value.finished === true) return row.value;
      await Bun.sleep(10);
    }
    throw new Error(`Lifecycle ${id} did not settle; evidence: ${workspace}`);
  };
  const events = async (): Promise<unknown[]> => {
    const value: unknown = await (await fetch(`${running.origin}/control`, { headers: { connection: "close" } })).json();
    assert(Array.isArray(value));
    return value;
  };
  const matrixContext: MatrixContext = { url, post, rpc, read, lifecycle, events, cases };
  let scenarioNumber = 0;
  const withScenario = async (kind: MatrixScenario, run: (context: MatrixContext, harness: ScenarioHarness) => Promise<void>): Promise<void> => {
    const previousConfig = config;
    await running.stop();
    const scope = join(workspace, `scenario-${kind}-${++scenarioNumber}`);
    await mkdir(scope, { recursive: true });
    config = await fixtureConfig(scope, kind);
    running = await start(config, scope);
    const harness: ScenarioHarness = {
      scope,
      restart: async () => {
        await running.stop();
        config = await fixtureConfig(scope, kind);
        running = await start(config, scope);
      },
    };
    try {
      const health = await objectBody(await fetch(url("/health")));
      assert(isObject(health.release) && health.release.git_sha === expectedSha, "Each fixture must execute the exact compiled product source.");
      await run(matrixContext, harness);
    } finally {
      await running.stop();
      config = previousConfig;
      running = await start(config, workspace);
    }
  };
  try {
    const health = await fetch(url("/health"));
    const identity = await objectBody(health);
    assert(isObject(identity.release));
    assert.equal(identity.release.git_sha, expectedSha);
    assert.equal(health.headers.get("x-uos-git-sha"), expectedSha);
    cases.push("exact_rust_source_identity");
    const preflight = await fetch(url("/v1/responses"), { method: "OPTIONS", headers: { origin: "https://ai.ubq.fi" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://ai.ubq.fi");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
    assert(preflight.headers.get("access-control-expose-headers")?.includes("x-uos-provider-request-id"));
    cases.push("source_credential_cors_preflight_before_authentication");
    await staticRouteCases(url, cases);
    await passportCases(url, cases);
    await cerebrasPaymentCases(url, cases);
    const dispatchBaseline = (await events()).length;
    assert.equal((await post("/uos/agent-messages", { agent_id: "fixture", body: "fixture" })).status, 403);
    assert.equal((await fetch(url("/uos/agent-messages"))).status, 401);
    assert.equal((await fetch(url("/uos/agent-messages"), { method: "PATCH" })).status, 405);
    cases.push("agent_messages_require_github_scope_and_source_methods");
    assert.equal((await fetch(url("/v1/models"))).status, 401);
    assert.equal((await post("/v1/responses", { model: "deepseek-flash", input: "fixture:unauthorized" }, "bad-token")).status, 401);
    assert.equal((await events()).length, dispatchBaseline);
    cases.push("unauthorized_requests_never_dispatch");
    const ordinary = await objectBody(await fetch(url("/v1/models"), { headers: { authorization: "Bearer fixture-access" } }));
    assert.equal(ordinary.object, "list");
    assert(Array.isArray(ordinary.data) && ordinary.data.some((row: unknown) => isObject(row) && row.id === "deepseek-flash"));
    assert(!("models" in ordinary));
    cases.push("authenticated_official_models_contract");
    const native = await objectBody(await fetch(url("/v1/models?client_version=0.163.0"), { headers: { authorization: "Bearer fixture-access" } }));
    assert(Array.isArray(native.models) && native.models.some((row: unknown) => isObject(row) && row.slug === "deepseek-flash"));
    cases.push("authenticated_exact_version_native_models_contract");
    for (const query of ["client_version=bad", "client_version=0.163.0&client_version=0.163.0"]) {
      assert.equal((await fetch(url(`/v1/models?${query}`), { headers: { authorization: "Bearer fixture-access" } })).status, 400);
    }
    cases.push("invalid_and_duplicate_client_versions_refused");
    await authorityAtomicCases(rpc, cases);
    await refusalCases(post, lifecycle, cases);
    await observationCases(url, cases);
    await extrasCases({ url, post, rpc, events, lifecycle, cases });
    const response = await post("/v1/responses", { model: "deepseek-flash", input: "fixture:json", stream: false });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-provider-request-id"), "provider-fixture-id");
    assert.equal(response.headers.get("x-request-id"), null);
    const requestId = response.headers.get("x-uos-request-id");
    assert(requestId);
    const body = await objectBody(response);
    assert.equal(body.status, "completed");
    assert(JSON.stringify(body.output).includes("fixture answer"));
    cases.push("actual_responses_json_translation_and_correlation");
    const settled = await lifecycle(requestId);
    assert(isObject(settled.terminal_intent));
    assert.equal(settled.terminal_intent.semantic_terminal, "response.completed");
    assert.equal(settled.terminal_intent.delivery, "unobserved");
    assert(Array.isArray(settled.attempts) && settled.attempts.length === 1 && isObject(settled.attempts[0]));
    assert.equal(settled.attempts[0].transport_started, true);
    cases.push("durable_terminal_and_unobserved_delivery_remain_separate");
    const chat = await post("/v1/chat/completions", { model: "deepseek-flash", messages: [{ role: "user", content: "fixture:chat" }], stream: false });
    assert.equal(chat.status, 200);
    assert((await chat.text()).includes("fixture answer"));
    cases.push("actual_chat_json_passthrough");
    const streamed = await post("/v1/responses", { model: "deepseek-flash", input: "fixture:stream", stream: true });
    assert.equal(streamed.status, 200);
    assert(streamed.body);
    const reader = streamed.body.getReader();
    const first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    assert(firstText.length > 0 && !firstText.includes("response.completed"));
    let text = firstText;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    assert(text.includes("response.completed") && text.includes("fixture "));
    const streamedId = streamed.headers.get("x-uos-request-id");
    assert(streamedId);
    assert.equal((await lifecycle(streamedId)).finished, true);
    cases.push("progressive_responses_sse_and_durable_settlement");
    const chatStream = await post("/v1/chat/completions", {
      model: "deepseek-flash",
      messages: [{ role: "user", content: "fixture:chatstream" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal(chatStream.status, 200);
    const chatText = await chatStream.text();
    assert(chatText.includes("data: [DONE]") && chatText.includes("fixture "));
    cases.push("actual_chat_sse");
    const cerebras = await post("/v1/chat/completions", { model: "gpt-oss-120b", messages: [{ role: "user", content: "fixture:cerebras" }], stream: true });
    assert.equal(cerebras.status, 200);
    assert((await cerebras.text()).includes("data: [DONE]"));
    const recorded = await events();
    assert(recorded.some((row: unknown) => isObject(row) && row.hostname === "api.cerebras.ai" && isObject(row.body) && row.body.stream === false));
    cases.push("cerebras_stream_request_uses_buffered_upstream");
    const malformed = await post("/v1/responses", { model: "deepseek-flash", input: "fixture:invalid", accidental_gateway_field: true });
    assert.equal(malformed.status, 400);
    cases.push("official_schema_unknown_fields_refused");
    const truncated = await post("/v1/responses", { model: "deepseek-flash", input: "fixture:truncate", stream: true });
    let truncatedText = "";
    try {
      truncatedText = await truncated.text();
    } catch {
      /* Reader failure remains an explicit failed body. */
    }
    assert(!truncatedText.includes("response.completed"));
    assert(truncatedText.includes("response.failed"));
    cases.push("truncated_upstream_never_becomes_completed");
    const capturedId = truncated.headers.get("x-uos-request-id");
    assert(capturedId);
    await failureCaptureCase(url, capturedId, requestId, cases);
    const created = await post(
      "/admin/api-keys",
      { name: "runtime quota fixture", usage_limit_requests: 2, window_ms: 604800000, paid_fallback_enabled: false },
      "fixture-admin"
    );
    assert.equal(created.status, 200);
    const key = await objectBody(created);
    assert(typeof key.token === "string");
    for (let index = 0; index < 2; index++) {
      const response = await post("/v1/responses", { model: "deepseek-flash", input: `fixture:key-${index}`, stream: index === 1 }, key.token);
      assert.equal(response.status, 200);
      await response.text();
    }
    const before = await events();
    assert.equal((await post("/v1/responses", { model: "deepseek-flash", input: "fixture:blocked" }, key.token)).status, 429);
    assert.deepEqual(await events(), before);
    cases.push("real_admin_key_creation_and_exact_dispatch_quota");
    await running.stop();
    running = await start(config, workspace);
    assert.equal((await post("/v1/responses", { model: "deepseek-flash", input: "fixture:still-blocked" }, key.token)).status, 429);
    const restartedEvents = await events();
    assert.deepEqual(restartedEvents.slice(0, before.length), before);
    const refreshedCatalogs = restartedEvents.slice(before.length).map((event: unknown) => {
      assert(isObject(event) && event.kind === "matrix_catalog" && event.credential_matched === true && typeof event.provider === "string");
      return event.provider;
    });
    assert.deepEqual(
      refreshedCatalogs.toSorted((left, right) => left.localeCompare(right)),
      ["lithos", "openrouter"],
      "Restart may refresh only its two fixed catalogs, never inference dispatch."
    );
    cases.push("actual_sqlite_restart_preserves_key_and_quota");
    await agentMessageCases(url, cases);
    const explicitSignal = await fetch(`${running.origin}/public/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture-access", "x-fixture-explicit-signal": "1", connection: "close" },
      body: JSON.stringify({ model: "deepseek-flash", input: "fixture:abort-explicit", stream: true }),
    });
    const explicitId = explicitSignal.headers.get("x-uos-request-id");
    assert(explicitId);
    try {
      await explicitSignal.text();
    } catch {
      /* The service-binding caller aborted its actual request signal. */
    }
    const explicitState = await lifecycle(explicitId);
    assert(isObject(explicitState.terminal_intent));
    assert.equal(explicitState.terminal_intent.delivery, "interrupted");
    await assertUpstreamCancelled(events, "fixture:abort-explicit");
    cases.push("real_service_binding_abort_signal_propagates");
    await withScenario("codex", async (fixture, harness) => {
      await imageCases(fixture);
      await liveCases({
        url: (path) => fixture.url(path),
        read: (key) => fixture.read(key),
        tuple,
        cases,
        restart: harness.restart,
      });
      await catalogRestartCases({ ...fixture, ...harness }, cases);
    });
    await runProviderMatrixCases({ ...matrixContext, withScenario });
    await withScenario("codex", replayProviderCases);
    await withScenario("codex", unicodeForwardingCases);
    await withScenario("direct", compactionFallbackCases);
    const cancelId = await disconnectAfterFirstChunk(url("/v1/responses"), { model: "deepseek-flash", input: "fixture:abort-tcp", stream: true }, workspace);
    const cancelState = await lifecycle(cancelId, 18_000);
    assert(isObject(cancelState.terminal_intent));
    assert(["interrupted", "unobserved"].includes(String(cancelState.terminal_intent.delivery)));
    assert.equal(cancelState.terminal_intent.reader_termination, "cancelled");
    assert.equal(cancelState.terminal_intent.body, "interrupted");
    assert.notEqual(cancelState.terminal_intent.semantic_terminal, "response.completed");
    await assertUpstreamCancelled(events, "fixture:abort-tcp");
    cases.push("actual_caller_abort_retains_non_successful_transport_state");
    await captureSuppressionCase(url, cancelId, cases);
    console.log(
      JSON.stringify({
        sourceSha: expectedSha,
        wasmSha256: createHash("sha256")
          .update(await readFile(join(root, "rust/crates/gateway-worker/build/index_bg.wasm")))
          .digest("hex"),
        fixtureWasmSha256: createHash("sha256")
          .update(await readFile(join(root, "rust/crates/gateway-worker-fixture/build/index_bg.wasm")))
          .digest("hex"),
        providerMatrixSha256: createHash("sha256")
          .update(await readFile(join(root, "tools/cloudflare/fixtures/provider-matrix.mjs")))
          .digest("hex"),
        workerd: "1.20261012.1",
        platform: process.platform,
        publicEntry: "direct-workerd-http-socket",
        harnessSha256: createHash("sha256")
          .update(await readFile(fileURLToPath(import.meta.url)))
          .digest("hex"),
        fixtureSha256: createHash("sha256")
          .update(await readFile(join(root, "tools/cloudflare/fixtures/runtime-driver.mjs")))
          .digest("hex"),
        workerdSha256: createHash("sha256")
          .update(await readFile(workerdBinary))
          .digest("hex"),
        cases,
      })
    );
  } finally {
    await writeFile(join(workspace, "progress.json"), JSON.stringify({ cases }, null, 2) + "\n");
    await running.stop();
  }
}

if (process.argv[2] === "--fixture-child") await inner();
else await outer();

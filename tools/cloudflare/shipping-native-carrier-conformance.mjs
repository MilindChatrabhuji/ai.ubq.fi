// Real workerd proof of the exported shipping entrypoint and UOS_NATIVE_CARRIER binding.
import assert from "node:assert/strict";
import { createHash, createHmac, createPrivateKey, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testNetworkArgv } from "../../scripts/test-network.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2).filter((value) => value !== "--sandbox");
const sandbox = process.argv.includes("--sandbox");
const [expectedSha, buildArg, evidenceArg, expectedTree] = args;
assert.match(expectedSha ?? "", /^[a-f0-9]{40}$/u);
assert.match(expectedTree ?? "", /^[a-f0-9]{40}$/u);
assert(buildArg, "Pass the exact compiled gateway-worker build directory.");
assert(evidenceArg, "Pass a task-local evidence directory.");
assert.equal(Bun.version, "1.4.0");

if (sandbox && process.env.M05_SANDBOX_CHILD !== "1") {
  const command = testNetworkArgv([
    process.execPath,
    "--no-env-file",
    "--no-install",
    fileURLToPath(import.meta.url),
    "--sandbox",
    expectedSha,
    buildArg,
    evidenceArg,
    expectedTree,
  ]);
  const child = Bun.spawn(command, {
    cwd: root,
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      M05_SANDBOX_CHILD: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}

const build = resolve(buildArg);
const evidence = resolve(evidenceArg);
await mkdir(evidence, { recursive: true });
const require = createRequire(import.meta.url);
const workerd = require("workerd");
assert(isObject(workerd) && typeof workerd.default === "string", "The prepared native workerd binary is required.");
const workerdBinary = workerd.default;
const workerdPackage = JSON.parse(await readFile(join(root, "node_modules/workerd/package.json"), "utf8"));
assert(isObject(workerdPackage) && workerdPackage.version === "1.20261012.1", "The locked workerd version is required.");
const version = Bun.spawnSync([workerdBinary, "--version"], { stdout: "pipe", stderr: "pipe" });
assert.equal(version.exitCode, 0, "workerd --version failed");
const workerdVersion = version.stdout.toString().trim();
assert(workerdVersion === "workerd 2026-10-12", `Unexpected workerd version: ${workerdVersion}`);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const q = JSON.stringify;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => Bun.sleep(ms);

async function assertExternalDenied() {
  if (process.env.M05_SANDBOX_CHILD !== "1") return { probed: false, result: "direct mode" };
  await new Promise((resolveProbe, rejectProbe) => {
    const socket = connect({ host: "1.1.1.1", port: 443 });
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectProbe(new Error("An external TCP timeout does not prove sandbox denial"));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      rejectProbe(new Error("The test sandbox allowed an external TCP connection"));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      const denied = ["EPERM", "EACCES", "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED"];
      if (!denied.includes(error.code ?? "")) rejectProbe(error);
      else resolveProbe();
    });
  });
  return { probed: true, result: "external TCP denied" };
}

const externalDenial = await assertExternalDenied();
const artifacts = await Promise.all(
  ["index.js", "index_bg.wasm"].map(async (name) => {
    const bytes = await readFile(join(build, name));
    return { name, bytes: bytes.length, sha256: hash(bytes) };
  })
);
const indexSource = await readFile(join(build, "index.js"), "utf8");
assert(!indexSource.includes("UOS_MATRIX_SCENARIO"), "The fixture composition must not be the shipping entrypoint.");

const fixture = join(root, "rust/crates/gateway-native/tests/fixtures/native-tls");
const ca = new X509Certificate(await readFile(join(fixture, "ca.der"))).toString();
const cert = new X509Certificate(await readFile(join(fixture, "leaf.der"))).toString();
const key = createPrivateKey({ key: await readFile(join(fixture, "leaf.pk8.der")), format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" });
await writeFile(join(evidence, "ca.pem"), ca);
const caPemPath = join(evidence, "ca.pem");
const keyId = "shipping-entrypoint-key";
const keyBytes = Buffer.alloc(32, 31);
const keyBase64url = keyBytes.toString("base64url");
const hmac = (text) => createHmac("sha256", keyBytes).update(text).digest("base64url");
const nonces = new Set();
const events = [];
const requests = [];
const failures = [];
let rpcCount = 0;

const server = createServer({ key, cert }, async (request, response) => {
  try {
    const bytes = Buffer.concat(await Array.fromAsync(request));
    const host = request.headers.host;
    const time = request.headers["x-uos-native-time-ms"];
    const nonce = request.headers["x-uos-native-nonce"];
    const mac = request.headers["x-uos-native-mac"];
    const event = {
      kind: "native_rpc",
      method: request.method,
      path: request.url,
      host,
      key_id: request.headers["x-uos-native-key-id"],
      nonce,
      body_sha256: hash(bytes),
      mac_valid: false,
    };
    events.push(event);
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/native/rpc");
    assert.equal(host, "localhost");
    assert.equal(request.headers["x-uos-native-version"], "1");
    assert.equal(request.headers["x-uos-native-key-id"], keyId);
    assert(time && Math.abs(Date.now() - Number(time)) <= 30_000);
    assert(Buffer.from(nonce ?? "", "base64url").length === 32);
    assert(!nonces.has(nonce), "A nonce was replayed");
    const frame = `uos-native-http-v1\0POST\0/v1/native/rpc\0${keyId}\0${time}\0${nonce}\0${hash(bytes)}`;
    assert.equal(mac, hmac(frame));
    nonces.add(nonce);
    event.mac_valid = true;
    const body = JSON.parse(bytes);
    assert.equal(body.v, 1);
    assert.equal(body.request?.operation, "supervisor_sessions");
    rpcCount += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ v: 1, status: 200, body: { source: "shipping-entrypoint", rpc: rpcCount }, stream: null }));
  } catch (error) {
    failures.push(error.message);
    if (!response.headersSent) response.writeHead(500);
    response.end("controlled native fixture rejected the request");
  }
});
const sockets = new Set();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const tlsPort = server.address().port;

function reservePort() {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = reservation.port;
  reservation.stop(true);
  return port;
}

const active = new Map();
const cases = [];
const caseRecords = [];
let sequence = 0;

function identity(overrides = {}) {
  return {
    key_id: keyId,
    owner_id: "shipping-entrypoint-owner",
    owner_epoch: "shipping-entrypoint-epoch",
    key_base64url: keyBase64url,
    capabilities: ["supervisor_read"],
    ...overrides,
  };
}
function validConfig(overrides = {}) {
  return JSON.stringify({ origin: "https://localhost", identity: identity(), ...overrides });
}
const binding = (name, value) => `(name = ${q(name)}, text = ${q(value)})`;
const caseBinding = (value) => (value === undefined ? "" : binding("UOS_NATIVE_CARRIER", value));

function configText(caseDirectory, nativeBinding) {
  const state = join(caseDirectory, "state");
  return `using Workerd = import ${q(join(root, "node_modules/workerd/workerd.capnp"))};
const config :Workerd.Config = (
  services = [
    (name = "internet", network = (allow = [])),
    (name = "state", disk = (path = ${q(state)}, writable = true)),
    (name = "assets", disk = (path = ${q(join(root, "static"))})),
    (name = "tls-native", external = (address = "127.0.0.1:${tlsPort}", https = (certificateHost = "localhost", tlsOptions = (trustBrowserCas = false, trustedCertificates = [embed ${q(caPemPath)}])))),
    (name = "gateway", worker = (
      modules = [(name = "index.js", esModule = embed ${q(join(build, "index.js"))}), (name = "index_bg.wasm", wasm = embed ${q(join(build, "index_bg.wasm"))})],
      compatibilityDate = "2026-10-18",
      compatibilityFlags = ["enable_request_signal", "request_signal_passthrough"],
      globalOutbound = "tls-native",
      bindings = [
        (name = "AUTHORITY", durableObjectNamespace = (className = "GatewayAuthority")),
        (name = "ASSETS", service = "assets"),
        (name = "UOS_AI_TOKEN", text = "fixture-access"),
        (name = "DENO_DEPLOY_TOKEN", text = "fixture-admin"),
        ${nativeBinding}
      ],
      durableObjectNamespaces = [(className = "GatewayAuthority", uniqueKey = "shipping-native-carrier-${sequence}", enableSql = true)],
      durableObjectStorage = (localDisk = "state")
    ))
  ],
  sockets = [(name = "public", http = (), service = "gateway")]
);`;
}

async function startCase(label, nativeBinding) {
  const caseDirectory = join(evidence, `${String(++sequence).padStart(2, "0")}-${label}`);
  await mkdir(join(caseDirectory, "state"), { recursive: true });
  const configPath = join(caseDirectory, "runtime.capnp");
  await writeFile(configPath, configText(caseDirectory, nativeBinding));
  const publicPort = reservePort();
  const command = [workerdBinary, "serve", configPath, "--experimental", "--import-path", "/", "--socket-addr", `public=127.0.0.1:${publicPort}`];
  const child = Bun.spawn(command, {
    cwd: caseDirectory,
    env: { PATH: "/usr/bin:/bin", TMPDIR: caseDirectory },
    stdout: Bun.file(join(caseDirectory, "workerd.stdout.log")),
    stderr: Bun.file(join(caseDirectory, "workerd.stderr.log")),
  });
  const record = {
    label,
    pid: child.pid,
    command,
    config: configPath,
    public_origin: `http://127.0.0.1:${publicPort}`,
    started_at_ms: Date.now(),
    exit_code: null,
    stopped_at_ms: null,
  };
  caseRecords.push(record);
  active.set(record.pid, { child, record });
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, "workerd exited during startup");
      try {
        const response = await fetch(`${record.public_origin}/health`);
        await response.arrayBuffer();
        record.health_status = response.status;
        record.health_headers = Object.fromEntries(response.headers);
        return record;
      } catch {
        await pause(20);
      }
    }
    throw new Error(`workerd ${label} did not become ready`);
  } catch (error) {
    await stopCase(record);
    throw error;
  }
}

async function stopCase(record) {
  const current = active.get(record.pid);
  if (!current) return;
  const { child } = current;
  if (child.exitCode === null) child.kill("SIGTERM");
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && Date.now() < deadline) await pause(20);
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
  record.exit_code = child.exitCode;
  record.stopped_at_ms = Date.now();
  active.delete(record.pid);
}

async function responseReceipt(label, kind, path, response) {
  const text = await response.text();
  const json = parseJson(text);
  const headers = Object.fromEntries(response.headers);
  requests.push({
    case: label,
    kind,
    method: "GET",
    path,
    status: response.status,
    body_sha256: hash(Buffer.from(text)),
    body: json ?? text,
    headers: {
      content_type: headers["content-type"],
      git_sha: headers["x-uos-git-sha"],
      deployment_id: headers["x-uos-deployment-id"],
      request_id: headers["x-uos-request-id"],
    },
  });
  return { status: response.status, headers, text, json };
}

async function requestHealth(origin, label) {
  return responseReceipt(label, "health", "/health", await fetch(`${origin}/health`));
}

async function requestSupervisor(origin, label, query = "") {
  const response = await fetch(`${origin}/admin/codex/supervisor/sessions${query}`, {
    headers: { authorization: "Bearer fixture-admin", "x-uos-native-origin": "https://evil.example" },
  });
  return responseReceipt(label, "supervisor_sessions", `/admin/codex/supervisor/sessions${query}`, response);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorCode(response) {
  if (!isObject(response.json) || !isObject(response.json.error)) return undefined;
  return response.json.error.code;
}

try {
  const valid = await startCase("valid-binding", caseBinding(validConfig()));
  const health = await requestHealth(valid.public_origin, "valid-binding");
  assert.equal(health.status, 200, health.text);
  assert.equal(health.headers["x-uos-git-sha"], expectedSha);
  assert.equal(health.headers["x-uos-deployment-id"], `cloudflare-${expectedSha}`);
  assert.equal(health.json.release.git_sha, expectedSha);
  cases.push("shipping_entrypoint_health_identity_matches_exact_source");

  const first = await requestSupervisor(valid.public_origin, "valid-binding");
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.source, "shipping-entrypoint");
  const second = await requestSupervisor(valid.public_origin, "valid-binding", "?origin=https%3A%2F%2Fevil.example");
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.source, "shipping-entrypoint");
  assert.equal(events.length, 2, "Only the fixed native RPC path may be reached");
  assert(events.every((event) => event.method === "POST" && event.path === "/v1/native/rpc" && event.host === "localhost" && event.mac_valid));
  assert.equal(new Set(events.map((event) => event.nonce)).size, 2);
  cases.push("exported_fetch_uses_exact_shipping_binding_and_signed_rpc");
  cases.push("query_and_origin_headers_do_not_select_another_destination");

  await stopCase(valid);
  assert.equal(valid.exit_code === null, false);
  cases.push("valid_workerd_cleanup");

  const beforeMissing = events.length;
  const missing = await startCase("missing-binding", caseBinding(undefined));
  const missingHealth = await requestHealth(missing.public_origin, "missing-binding");
  assert.equal(missingHealth.status, 200, missingHealth.text);
  const missingSupervisor = await requestSupervisor(missing.public_origin, "missing-binding");
  assert.equal(missingSupervisor.status, 503, missingSupervisor.text);
  assert.equal(errorCode(missingSupervisor), "native_carrier_unavailable");
  assert.equal(events.length, beforeMissing);
  await stopCase(missing);
  cases.push("missing_binding_keeps_native_unavailable_without_fallback");

  const denied = [
    ["malformed", caseBinding("{")],
    ["partial", caseBinding(JSON.stringify({ origin: "https://localhost", identity: { key_id: keyId } }))],
    ["oversized", caseBinding("x".repeat(16_385))],
    ["unknown-capability", caseBinding(validConfig({ identity: identity({ capabilities: ["live_sideband", "future_capability"] }) }))],
    ["invalid-origin", caseBinding(validConfig({ origin: "http://localhost" }))],
    ["wrong-type", `(name = "UOS_NATIVE_CARRIER", service = "assets")`],
  ];
  for (const [label, nativeBinding] of denied) {
    const before = events.length;
    const current = await startCase(label, nativeBinding);
    const currentHealth = await requestHealth(current.public_origin, label);
    assert.equal(currentHealth.status, 503, `${label}: ${currentHealth.text}`);
    assert.equal(errorCode(currentHealth), "native_configuration_invalid", label);
    const currentSupervisor = await requestSupervisor(current.public_origin, label);
    assert.equal(currentSupervisor.status, 503, `${label}: ${currentSupervisor.text}`);
    assert.equal(errorCode(currentSupervisor), "native_configuration_invalid", label);
    assert.equal(events.length, before, `${label}: invalid binding reached the native peer`);
    await stopCase(current);
    cases.push(`denied_${label}`);
  }

  assert.deepEqual(failures, []);
  assert.equal(active.size, 0);
  const receipt = {
    source_sha: expectedSha,
    source_tree: expectedTree,
    status: "passed",
    cases,
    artifacts,
    workerd: { binary: workerdBinary, version: workerdVersion, package: workerdPackage.version },
    harness_sha256: hash(await readFile(fileURLToPath(import.meta.url))),
    topology: "shipping gateway-worker build -> UOS_NATIVE_CARRIER deployment binding -> fixed https://localhost -> controlled TLS RPC peer",
    fixture_substituted: false,
    native_events: events,
    requests,
    failures,
    processes: caseRecords,
    sandboxed: sandbox,
    external_denial: externalDenial,
    evidence,
  };
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ source_sha: expectedSha, status: "passed", cases, evidence, artifacts, workerd: receipt.workerd }));
} finally {
  for (const record of [...caseRecords]) await stopCase(record);
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => server.close(done));
  await writeFile(join(evidence, "cleanup.json"), JSON.stringify({ active: active.size, processes: caseRecords }, null, 2) + "\n");
}

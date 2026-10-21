// Controlled physical TLS endpoints exercise the shipping Rust HTTPS carrier.
import assert from "node:assert/strict";
import { createHash, createHmac, createPrivateKey, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWebSocketModule } from "../../src/runtime/http.ts";
import { testNetworkArgv } from "../../scripts/test-network.ts";

const childMode = process.argv[2] === "--fixture-child";
const pendingOnly = process.argv.includes("--pending");
const websocketOnly = process.argv.includes("--websocket-only");
const traceNative = process.argv.includes("--trace-native");
const platformProbe = process.argv.includes("--probe-signal");
const httpSequence = process.argv.includes("--probe-http");
const [sha, build, binary, schema, parent, controlAddress] = process.argv.slice(childMode ? 3 : 2);
assert.match(sha ?? "", /^[a-f0-9]{40}$/u);
assert.equal(Bun.version, "1.4.0");
const root = process.cwd();
const q = JSON.stringify;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => Bun.sleep(ms);
function processIdentity(pid) {
  return { pid, observing_pid: process.pid, observer_uid: process.getuid(), observed_at_ms: Date.now() };
}
async function tcp(address, denied = false) {
  await new Promise((done, reject) => {
    const socket = connect({ host: address, port: 443 });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TCP timeout is not OS denial"));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      denied ? reject(new Error("External TCP escaped confinement")) : done();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      const refused = ["EPERM", "EACCES"];
      // The existing Darwin boundary requires paired outside TCP positives.
      if (process.platform === "darwin") refused.push("ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED");
      denied && refused.includes(error.code) ? done() : reject(error);
    });
  });
}
async function outer() {
  await mkdir(resolve(parent), { recursive: true });
  const workspace = await mkdtemp(join(resolve(parent), "run-"));
  await writeFile(join(workspace, "outer-owner.json"), JSON.stringify({ identity: processIdentity(process.pid), script: fileURLToPath(import.meta.url) }));
  const address = (await lookup("developers.cloudflare.com", { family: 4 })).address;
  await tcp(address);
  const command = testNetworkArgv([
    process.execPath,
    "--no-env-file",
    "--no-install",
    fileURLToPath(import.meta.url),
    "--fixture-child",
    sha,
    resolve(build),
    resolve(binary),
    resolve(schema),
    workspace,
    address,
    ...(pendingOnly ? ["--pending"] : []),
    ...(websocketOnly ? ["--websocket-only"] : []),
    ...(traceNative ? ["--trace-native"] : []),
    ...(platformProbe ? ["--probe-signal"] : []),
    ...(httpSequence ? ["--probe-http"] : []),
  ]);
  const task = Bun.spawn(command, {
    cwd: root,
    env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: workspace, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await writeFile(join(workspace, "supervisor-owner.json"), JSON.stringify({ pid: task.pid, identity: processIdentity(task.pid) }));
  const stop = () => {
    if (task.exitCode === null) task.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const deadline = setTimeout(stop, 90_000);
  try {
    const [code, stdout, stderr] = await Promise.all([task.exited, new Response(task.stdout).text(), new Response(task.stderr).text()]);
    await writeFile(join(workspace, "stdout.log"), stdout);
    await writeFile(join(workspace, "stderr.log"), stderr);
    assert.equal(code, 0, `Native carrier conformance failed: ${workspace}`);
    await tcp(address);
    console.log(stdout.trim());
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    stop();
  }
}
async function run() {
  await tcp(controlAddress, true);
  const workspace = resolve(parent);
  const owner = {
    identity: processIdentity(process.pid),
    uid: process.getuid(),
    script: fileURLToPath(import.meta.url),
    script_sha256: hash(await readFile(fileURLToPath(import.meta.url))),
    workerd_binary: resolve(binary),
    workerd_sha256: hash(await readFile(resolve(binary))),
  };
  await mkdir(join(workspace, "state"));
  const fixture = resolve("rust/crates/gateway-native/tests/fixtures/native-tls");
  const ca = new X509Certificate(await readFile(join(fixture, "ca.der"))).toString();
  const cert = new X509Certificate(await readFile(join(fixture, "leaf.der"))).toString();
  const key = createPrivateKey({ key: await readFile(join(fixture, "leaf.pk8.der")), format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" });
  await writeFile(join(workspace, "ca.pem"), ca);
  const { default: WebSocket, WebSocketServer } = await loadWebSocketModule();
  const events = [];
  const failures = [];
  const nonces = new Set();
  const hmac = (text) => createHmac("sha256", Buffer.alloc(32, 31)).update(text).digest("base64url");
  let redirect = false;
  function authenticate(request, bytes, live = false) {
    assert.equal(request.headers["x-uos-native-version"], "1");
    assert.equal(request.headers["x-uos-native-key-id"], "fixture-matrix-key");
    const time = request.headers["x-uos-native-time-ms"];
    const nonce = request.headers["x-uos-native-nonce"];
    assert(Math.abs(Date.now() - Number(time)) <= 30_000);
    assert.equal(Buffer.from(nonce, "base64url").length, 32);
    assert(!nonces.has(nonce), "The transport retried a native nonce");
    const input = live
      ? `uos-native-live-upgrade-v1\0GET\0/v1/native/live\0fixture-matrix-key\0${time}\0${nonce}\0${request.headers["x-uos-native-live-action"]}`
      : `uos-native-http-v1\0POST\0${request.url}\0fixture-matrix-key\0${time}\0${nonce}\0${hash(bytes)}`;
    assert.equal(request.headers["x-uos-native-mac"], hmac(input));
    nonces.add(nonce);
  }
  const server = createServer({ key, cert }, async (request, response) => {
    try {
      const bytes = Buffer.concat(await Array.fromAsync(request));
      events.push({ kind: "https_request", path: request.url, method: request.method, host: request.headers.host });
      if (request.url === "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas") {
        assert.equal(request.headers.host, "chatgpt.com");
        assert.equal(request.method, "POST");
        assert.equal(JSON.parse(bytes).sdp, "fixture SDP offer");
        response.writeHead(201, "Fixture Accepted", {
          "content-type": "application/sdp",
          connection: "close",
          location: "https://chatgpt.com/realtime/calls/rtc_fixture_live",
        });
        response.end("fixture SDP answer");
        return;
      }
      assert.equal(request.method, "POST");
      assert(["/v1/native/rpc", "/v1/native/follow"].includes(request.url));
      authenticate(request, bytes);
      const body = JSON.parse(bytes);
      if (request.url === "/v1/native/rpc") {
        assert.equal(body.v, 1);
        if (redirect) {
          response.writeHead(307, { location: "https://localhost/forbidden-redirect" });
          response.end();
          return;
        }
        const read = body.request;
        const stream =
          read.operation === "supervisor_output"
            ? { kind: "supervisor_follow", source_id: read.source_id, thread_id: read.thread_id, cursor: read.cursor }
            : null;
        const send = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ v: 1, status: 200, body: { source: "controlled-native-tls" }, stream }));
        };
        if (read.thread_id === "slow") {
          const timer = setTimeout(send, 2000);
          response.once("close", () => {
            clearTimeout(timer);
            events.push({ kind: "rpc_closed", thread: read.thread_id, finished: response.writableFinished });
          });
        } else send();
        return;
      }
      assert.equal(body.kind, "supervisor_follow");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write("data: first\n\n");
      const timer = setTimeout(() => {
        if (body.thread_id !== "cancel") {
          events.push({ kind: "follow_second", thread: body.thread_id });
          response.end("data: second\n\n");
        }
      }, 500);
      response.once("close", () => {
        clearTimeout(timer);
        events.push({ kind: "follow_closed", thread: body.thread_id, finished: response.writableFinished });
      });
    } catch (error) {
      failures.push(error.message);
      response.writeHead(500);
      response.end("Controlled fixture rejected the native protocol");
    }
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true });
  let connectionSequence = 0;
  wss.on("headers", (headers) => {
    headers[0] = "HTTP/1.1 101 Fixture Native Upgrade";
    headers.push("x-fixture-native-upgrade: original");
  });
  wss.on("connection", (socket) => {
    const connection = ++connectionSequence;
    events.push({ kind: "native_websocket_open", connection });
    checkpoint("peer_websocket_open");
    socket.on("message", (data, binaryMessage) => socket.send(data, { binary: binaryMessage }));
    socket.once("close", () => {
      events.push({ kind: "native_websocket_closed", connection });
      checkpoint("peer_websocket_closed");
    });
  });
  server.on("upgrade", (request, socket, head) => {
    events.push({ kind: "native_websocket_upgrade", method: request.method, path: request.url });
    checkpoint("peer_upgrade_request");
    try {
      assert.equal(request.method, "GET");
      assert.equal(request.url, "/v1/native/live");
      authenticate(request, Buffer.alloc(0), true);
      assert(request.headers["x-uos-native-live-action"]);
      wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket));
    } catch (error) {
      failures.push(error.message);
      socket.destroy();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const tlsPort = server.address().port;
  const reserve = () => {
    const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
    const port = s.port;
    s.stop(true);
    return port;
  };
  let task;
  let workerdIdentity = null;
  let sequence = 0;
  async function start(trust) {
    const label = `${++sequence}-${trust}`;
    const port = reserve();
    const publicPort = reserve();
    const diagnosticPort = reserve();
    const proxySource = `export default {async fetch(r){const h=new Headers();for(const [k,v]of r.headers)if(k.startsWith("x-uos-native-")||k==="upgrade")h.set(k,v);const path=new URL(r.url).pathname;if(path==="/after-http"){const created=await fetch("https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",{method:"POST",body:JSON.stringify({sdp:"fixture SDP offer"})});await created.arrayBuffer();console.error("raw-proxy-http-drained",created.status);}const signalled=path==="/signal";const init={method:"GET",headers:h,redirect:"manual"};if(signalled)init.signal=new AbortController().signal;console.error("raw-proxy-start",signalled);const response=await fetch(new Request("https://localhost/v1/native/live",init));console.error("raw-proxy-result",response.status,response.statusText,!!response.webSocket);return response;}}`;
    const traceSource = `import Shipping,{GatewayAuthority} from "./index.js";export {GatewayAuthority};const original=globalThis.fetch;globalThis.fetch=async function(input,init){const native=new URL(input.url??input).pathname==="/v1/native/live";if(native)console.error("native-fetch-start",!!input.signal?.aborted);const response=await original.call(this,input,init);if(native)console.error("native-fetch-resolved",response.status,!!response.webSocket);return response;};export default class extends Shipping{async fetch(request){const upgrade=request.headers.get("upgrade")==="websocket";const response=await super.fetch(request);if(upgrade)console.error("gateway-handler-resolved",response.status,!!response.webSocket);return response;}}`;
    const config = `using Workerd = import ${q(resolve(schema))};
const config :Workerd.Config = (services = [
 (name="internet",network=(allow=[])),
 (name="raw-proxy",worker=(modules=[(name="proxy.mjs",esModule=${q(proxySource)})],compatibilityDate="2026-10-18",compatibilityFlags=["enable_request_signal","request_signal_passthrough"],globalOutbound="tls-native")),
 (name="tls-native",external=(address="127.0.0.1:${tlsPort}",https=(certificateHost="localhost",tlsOptions=(trustBrowserCas=false,trustedCertificates=[${trust ? `embed ${q(join(workspace, "ca.pem"))}` : ""}])))),
 (name="state",disk=(path=${q(join(workspace, "state"))},writable=true)),(name="assets",disk=(path=${q(resolve("static"))})),
 (name="driver",worker=(modules=[(name="driver.mjs",esModule=embed ${q(resolve("tools/cloudflare/fixtures/runtime-driver.mjs"))}),(name="provider-matrix.mjs",esModule=embed ${q(resolve("tools/cloudflare/fixtures/provider-matrix.mjs"))})],compatibilityDate="2026-10-18",compatibilityFlags=["enable_request_signal","request_signal_passthrough"],globalOutbound="internet",bindings=[(name="GATEWAY",service="gateway"),(name="AUTHORITY",durableObjectNamespace=(serviceName="gateway",className="GatewayAuthority")),(name="CONTROL",durableObjectNamespace=(className="FixtureControl"))],durableObjectNamespaces=[(className="FixtureControl",uniqueKey="native-carrier-control",enableSql=true)],durableObjectStorage=(localDisk="state"))),
 (name="gateway",worker=(modules=[${traceNative ? `(name="trace.mjs",esModule=${q(traceSource)}),` : ""}(name="index.js",esModule=embed ${q(join(resolve(build), "index.js"))}),(name="index_bg.wasm",wasm=embed ${q(join(resolve(build), "index_bg.wasm"))})],compatibilityDate="2026-10-18",compatibilityFlags=["enable_request_signal","request_signal_passthrough"],globalOutbound="tls-native",bindings=[(name="AUTHORITY",durableObjectNamespace=(className="GatewayAuthority")),(name="ASSETS",service="assets"),(name="UOS_MATRIX_SCENARIO",text="native-carrier"),(name="UOS_AI_TOKEN",text="fixture-access"),(name="DENO_DEPLOY_TOKEN",text="fixture-admin"),(name="DENO_TIMELINE",text="production"),(name="DENO_DEPLOY",text="fixture-workerd")],durableObjectNamespaces=[(className="GatewayAuthority",uniqueKey="native-carrier-common-authority",enableSql=true)],durableObjectStorage=(localDisk="state")))],sockets=[(name="main",http=(),service="driver"),(name="public",http=(),service="gateway"),(name="diagnostic",http=(),service="raw-proxy")]);`;
    const configPath = join(workspace, `runtime-${label}.capnp`);
    await writeFile(configPath, config);
    task = Bun.spawn(
      [
        resolve(binary),
        "serve",
        configPath,
        "--experimental",
        "--import-path",
        "/",
        `--socket-addr=main=127.0.0.1:${port}`,
        `--socket-addr=public=127.0.0.1:${publicPort}`,
        `--socket-addr=diagnostic=127.0.0.1:${diagnosticPort}`,
      ],
      {
        cwd: workspace,
        env: { PATH: "/usr/bin:/bin", TMPDIR: workspace },
        stdout: Bun.file(join(workspace, `workerd-${label}.stdout.log`)),
        stderr: Bun.file(join(workspace, `workerd-${label}.stderr.log`)),
      }
    );
    workerdIdentity = processIdentity(task.pid);
    checkpoint("workerd_spawned");
    const origin = `http://127.0.0.1:${port}`;
    const publicOrigin = `http://127.0.0.1:${publicPort}`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      assert.equal(task.exitCode, null, "workerd exited before health");
      try {
        const health = await fetch(publicOrigin + "/health");
        assert.equal(health.status, 200);
        assert((await health.text()).includes(sha));
        return { origin, publicOrigin, diagnosticOrigin: `http://127.0.0.1:${diagnosticPort}` };
      } catch {
        await pause(25);
      }
    }
    throw new Error("workerd startup deadline expired");
  }
  async function stop() {
    if (!task || task.exitCode !== null) return;
    task.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (task.exitCode === null) task.kill("SIGKILL");
    }, 3000);
    try {
      await task.exited;
    } finally {
      clearTimeout(timer);
    }
  }
  const cases = ["os_external_tcp_denied"];
  function checkpoint(stage) {
    writeFileSync(
      join(workspace, "phase.json"),
      JSON.stringify(
        {
          stage,
          owner,
          pid: process.pid,
          workerd_pid: task?.pid,
          workerd_identity: workerdIdentity,
          workerd_exit_code: task?.exitCode,
          tls_port: tlsPort,
          cases,
          events,
          failures,
          at_ms: Date.now(),
        },
        null,
        2
      ) + "\n"
    );
  }
  const admin = { authorization: "Bearer fixture-admin" };
  const followPath = (thread) => `/admin/codex/supervisor/output?source=fixture&id=${thread}`;
  async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await pause(10);
    assert(predicate(), "Actual native socket event was not observed");
  }
  try {
    checkpoint("starting_workerd");
    let running;
    const readChallenge = async (challenge) => {
      const key =
        "tuple-v1:" +
        ["uos_ai", "auth", "challenges", challenge].map((part) => "02" + Buffer.from(part).toString("hex").replaceAll("00", "00ff") + "00").join("");
      const response = await fetch(running.origin + "/store", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "read", key }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).record;
    };
    if (!pendingOnly) {
      running = await start(false);
      const untrusted = await fetch(running.publicOrigin + "/admin/codex/supervisor/sessions", { headers: admin });
      assert.equal(untrusted.status, 503);
      await untrusted.arrayBuffer();
      assert.equal(events.filter((e) => e.kind === "https_request").length, 0);
      cases.push("untrusted_tls_refused_without_service_fallback");
      await stop();
      running = await start(true);
      const sessions = await fetch(running.publicOrigin + "/admin/codex/supervisor/sessions", { headers: admin });
      assert.equal(sessions.status, 200, await sessions.clone().text());
      assert.equal((await sessions.json()).source, "controlled-native-tls");
      cases.push("shipping_fixed_https_rpc_authenticates_original_signed_bytes");
      redirect = true;
      const refused = await fetch(running.publicOrigin + "/admin/codex/supervisor/sessions", { headers: admin });
      assert.equal(refused.status, 503);
      await refused.arrayBuffer();
      assert(!events.some((e) => e.path === "/forbidden-redirect"));
      redirect = false;
      cases.push("native_manual_redirect_never_selects_another_path");
      const stream = await fetch(running.publicOrigin + followPath("progress"), { headers: admin });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get("content-type"), /^text\/event-stream/u);
      const reader = stream.body.getReader();
      const first = await reader.read();
      assert.equal(new TextDecoder().decode(first.value), "data: first\n\n");
      assert(!events.some((e) => e.kind === "follow_second" && e.thread === "progress"), "SSE first event was buffered until completion");
      const second = await reader.read();
      assert.equal(new TextDecoder().decode(second.value), "data: second\n\n");
      assert((await reader.read()).done);
      cases.push("native_follow_sse_is_progressive_over_actual_tls");
      for (const thread of ["slow", "cancel"]) {
        try {
          const response = await fetch(running.origin + "/public" + followPath(thread), { headers: { ...admin, "x-fixture-explicit-signal": "1" } });
          await response.arrayBuffer();
        } catch {
          /* the real abort can reject headers or body consumption */
        }
        await until(() => events.some((e) => e.kind === (thread === "slow" ? "rpc_closed" : "follow_closed") && e.thread === thread && !e.finished));
      }
      cases.push("original_abort_signal_closes_native_tls_before_headers_and_mid_sse");
    } else running = await start(true);
    if (!websocketOnly) {
      const candidate = "https://rust-candidate.ai.ubq.fi";
      for (const invalid of [
        "https://foreign.workers.dev",
        "http://rust-candidate.ai.ubq.fi",
        "https://rust-candidate.ai.ubq.fi:8443",
        "https://user@rust-candidate.ai.ubq.fi",
        "https://rust-candidate.ai.ubq.fi.evil.example",
      ]) {
        const response = await fetch(running.publicOrigin + "/api/auth/login/start", {
          method: "POST",
          headers: { "content-type": "application/json", "x-uos-candidate-passkeys": "true" },
          body: JSON.stringify({ relay_origin: invalid }),
        });
        assert.equal(response.status, 400, await response.clone().text());
        await response.arrayBuffer();
      }
      const login = await fetch(running.publicOrigin + "/api/auth/login/start", {
        method: "POST",
        headers: { origin: candidate, "content-type": "application/json" },
        body: JSON.stringify({ relay_origin: candidate, client_origin: candidate }),
      });
      assert.equal(login.status, 200, await login.clone().text());
      const loginBody = await login.json();
      assert.equal(loginBody.publicKey.rpId, "ai.ubq.fi");
      const loginChallenge = await readChallenge(loginBody.publicKey.challenge);
      assert.equal(loginChallenge.value.origin, candidate);
      assert.equal(loginChallenge.value.audience_origin, candidate);
      cases.push("shipping_auth_config_exact_candidate_rp_and_relay_with_lookalike_refusals");
      const direct = await fetch(running.publicOrigin + "/api/auth/register/start", {
        method: "POST",
        headers: { ...admin, origin: candidate, "content-type": "application/json" },
        body: JSON.stringify({ handle: "carrier-fixture", client_origin: candidate }),
      });
      assert.equal(direct.status, 200, await direct.clone().text());
      const directBody = await direct.json();
      assert.equal(directBody.publicKey.rp.id, "ai.ubq.fi");
      const directChallenge = await readChallenge(directBody.publicKey.challenge);
      assert.equal(directChallenge.value.origin, candidate);
      assert.equal(directChallenge.value.audience_origin, undefined);
      cases.push("shipping_candidate_direct_same_origin_registration_challenge");
      await stop();
      running = await start(true);
      assert.deepEqual(await readChallenge(loginBody.publicKey.challenge), loginChallenge);
      assert.deepEqual(await readChallenge(directBody.publicKey.challenge), directChallenge);
      cases.push("candidate_challenge_origins_and_audiences_persist_in_common_do_across_restart");
      checkpoint("candidate_auth_passed");
      const directNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      const directTime = String(Date.now());
      const directAction = "controlled-peer-baseline";
      const directSocket = new WebSocket(`wss://127.0.0.1:${tlsPort}/v1/native/live`, {
        ca,
        servername: "localhost",
        handshakeTimeout: 3000,
        headers: {
          "x-uos-native-version": "1",
          "x-uos-native-key-id": "fixture-matrix-key",
          "x-uos-native-time-ms": directTime,
          "x-uos-native-nonce": directNonce,
          "x-uos-native-live-action": directAction,
          "x-uos-native-mac": hmac(`uos-native-live-upgrade-v1\0GET\0/v1/native/live\0fixture-matrix-key\0${directTime}\0${directNonce}\0${directAction}`),
        },
      });
      try {
        await new Promise((done, reject) => {
          directSocket.once("error", reject);
          directSocket.once("open", done);
        });
        cases.push("controlled_tls_peer_direct_websocket_handshake");
        checkpoint("direct_peer_websocket_passed");
      } finally {
        directSocket.terminate();
      }
    }
    let platformStatusText;
    {
      for (const probeSignal of httpSequence ? ["after-http"] : platformProbe ? [false, true] : [false]) {
        const probeNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
        const probeTime = String(Date.now());
        const probeAction = "controlled-platform-baseline";
        const probe = new WebSocket(
          running.diagnosticOrigin.replace("http:", "ws:") + (probeSignal === "after-http" ? "/after-http" : probeSignal ? "/signal" : "/"),
          {
            handshakeTimeout: 3000,
            headers: {
              "x-uos-native-version": "1",
              "x-uos-native-key-id": "fixture-matrix-key",
              "x-uos-native-time-ms": probeTime,
              "x-uos-native-nonce": probeNonce,
              "x-uos-native-live-action": probeAction,
              "x-uos-native-mac": hmac(`uos-native-live-upgrade-v1\0GET\0/v1/native/live\0fixture-matrix-key\0${probeTime}\0${probeNonce}\0${probeAction}`),
            },
          }
        );
        try {
          await new Promise((done, reject) => {
            probe.once("error", reject);
            probe.once("upgrade", (response) => {
              platformStatusText = response.statusMessage;
            });
            probe.once("open", done);
          });
          cases.push(
            probeSignal === "after-http"
              ? "workerd_javascript_http_then_websocket_proxy"
              : probeSignal
                ? "workerd_javascript_explicit_signal_websocket_proxy"
                : "workerd_javascript_raw_fetch_websocket_proxy"
          );
          checkpoint("workerd_proxy_passed");
        } finally {
          probe.terminate();
        }
      }
    }
    if (platformProbe) return;
    const form = new FormData();
    form.append("sdp", "fixture SDP offer");
    form.append("session", JSON.stringify({ model: "gpt-matrix-test" }));
    const created = await fetch(running.publicOrigin + "/v1/live", { method: "POST", headers: { authorization: "Bearer fixture-access" }, body: form });
    assert.equal(created.status, 201, await created.clone().text());
    await created.arrayBuffer();
    checkpoint("live_created");
    const socket = new WebSocket(running.publicOrigin.replace("http:", "ws:") + "/v1/live/rtc_fixture_live", {
      headers: { authorization: "Bearer fixture-access" },
      handshakeTimeout: 3000,
    });
    await new Promise((done, reject) => {
      socket.once("error", reject);
      socket.once("upgrade", (response) => {
        events.push({ kind: "client_websocket_upgrade", status: response.statusCode, status_text: response.statusMessage });
        checkpoint("client_websocket_upgrade");
        try {
          assert.equal(response.statusCode, 101);
          // Compare with the actual platform response; workerd normalizes the wire reason.
          assert.equal(response.statusMessage, platformStatusText);
          assert.equal(response.headers["x-fixture-native-upgrade"], "original");
        } catch (error) {
          reject(error);
        }
      });
      socket.once("open", () => {
        checkpoint("client_websocket_open");
        done();
      });
    });
    const echo = new Promise((done, reject) => {
      socket.once("message", (bytes) => {
        checkpoint("client_websocket_message");
        try {
          assert.equal(bytes.toString(), "native\0echo");
          done();
        } catch (error) {
          reject(error);
        }
      });
    });
    checkpoint("sending_websocket_echo");
    socket.send("native\0echo");
    await echo;
    const nativeConnection = events.findLast((event) => event.kind === "native_websocket_open").connection;
    socket.close(1000, "fixture done");
    await until(() => events.some((e) => e.kind === "native_websocket_closed" && e.connection === nativeConnection));
    cases.push("shipping_fixed_https_preserves_raw_101_status_text_headers_websocket_and_close");
    assert.deepEqual(failures, []);
    const artifacts = await Promise.all(
      ["index.js", "index_bg.wasm"].map(async (name) => ({ name, sha256: hash(await readFile(join(resolve(build), name))) }))
    );
    const receipt = {
      source_sha: sha,
      status: "passed",
      cases,
      artifacts,
      events,
      tls: { peer: "127.0.0.1", certificate_host: "localhost", fixture_ca_sha256: hash(ca), trust_browser_cas: false },
      topology: "shipping Rust global fetch -> fixed workerd ExternalServer HTTPS -> real loopback TLS peer; no Fetcher service fallback",
    };
    await writeFile(join(workspace, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify({ source_sha: sha, status: "passed", cases, evidence: workspace }));
  } finally {
    checkpoint("cleanup_workerd");
    await stop();
    checkpoint("cleanup_sockets");
    for (const socket of wss.clients) socket.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
    checkpoint("cleanup_complete");
    await writeFile(join(workspace, "observed-cases.json"), JSON.stringify({ cases, events, failures }, null, 2) + "\n");
  }
}
if (childMode) await run();
else await outer();

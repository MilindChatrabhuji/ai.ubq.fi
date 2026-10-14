import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testNetworkArgv } from "../scripts/test-network.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const sparseEnv = (root: string): Record<string, string> => ({
  PATH: "/usr/bin:/bin",
  HOME: join(root, "home"),
  TMPDIR: root,
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
});

const childSource = String.raw`
import assert from "node:assert/strict";
import { get } from "node:http";
import { connect, createServer } from "node:net";
import { readlinkSync } from "node:fs";
const config = JSON.parse(process.argv.at(-1));
const namespace = readlinkSync("/proc/self/ns/net");
assert.notEqual(namespace, config.parentNamespace);
for (const name of ["CEREBRAS_API_KEY", "METERED_API_KEY", "SURPLUS_API_KEY", "OPENROUTER_API_KEY", "HTTP_PROXY", "HTTPS_PROXY"])
  assert.equal(process.env[name], undefined);
const routes = Bun.spawn(["/usr/bin/ip", "-json", "route", "show", "table", "main"], { stdout: "pipe" });
assert.equal(await routes.exited, 0);
assert.deepEqual(await new Response(routes.stdout).json(), []);
await assert.rejects(fetch(config.remote, { signal: AbortSignal.timeout(500) }));
const tcp = (options) => new Promise((resolve, reject) => {
  const socket = connect(options);
  let value = "";
  socket.setTimeout(500, () => socket.destroy(new Error("fixture TCP timeout")));
  socket.on("data", (chunk) => value += chunk);
  socket.once("error", reject);
  socket.once("end", () => resolve(value));
});
await assert.rejects(tcp({ host: "192.0.2.10", port: config.remotePort }));
const http = (url) => new Promise((resolve, reject) => {
  const request = get(url, (response) => {
    let text = "";
    response.on("data", (chunk) => text += chunk);
    response.once("end", () => resolve(text));
    response.once("error", reject);
  });
  request.setTimeout(500, () => request.destroy(new Error("fixture HTTP timeout")));
  request.once("error", reject);
});
await assert.rejects(http(config.remote));
const websocket = (url, expected) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => { socket.close(); reject(new Error("fixture WS timeout")); }, 500);
  let received = false;
  socket.onopen = () => socket.send("hello");
  socket.onmessage = (event) => { assert.equal(event.data, expected); received = true; socket.close(); };
  socket.onerror = () => { clearTimeout(timer); reject(new Error("fixture WS connection denied")); };
  socket.onclose = () => { clearTimeout(timer); received ? resolve(true) : reject(new Error("fixture WS closed before message")); };
});
await assert.rejects(websocket(config.remote.replace("http:", "ws:") + "socket", "parent-WS"));
const local = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch(request, server) { if (new URL(request.url).pathname === "/socket" && server.upgrade(request)) return; return new Response("local-HTTP"); },
  websocket: { message(socket) { socket.send("local-WS"); } },
});
const localUrl = "http://127.0.0.1:" + local.port + "/";
assert.equal(await (await fetch(localUrl)).text(), "local-HTTP");
assert.equal(await http(localUrl), "local-HTTP");
await websocket(localUrl.replace("http:", "ws:") + "socket", "local-WS");
const localTcp = createServer((socket) => socket.end("local-TCP"));
await new Promise((resolve, reject) => { localTcp.once("error", reject); localTcp.listen(0, "127.0.0.1", resolve); });
assert.equal(await tcp({ host: "127.0.0.1", port: localTcp.address().port }), "local-TCP");
assert.equal(await tcp({ path: config.unix }), "parent-Unix");
const worker = new Worker(config.worker);
await new Promise((resolve, reject) => { worker.onmessage = resolve; worker.onerror = reject; });
const reply = new Promise((resolve, reject) => { worker.onmessage = (event) => resolve(event.data); worker.onerror = reject; });
worker.postMessage({ local: localUrl, remote: config.remote, namespace });
assert.deepEqual(await reply, { local: "local-HTTP", remoteDenied: true, sameNamespace: true });
worker.terminate();
const descendant = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e",
  'try { await fetch(process.argv.at(-1), { signal: AbortSignal.timeout(500) }); process.exit(90); } catch { process.exit(0); }', config.remote],
  { env: { PATH: "/usr/bin:/bin", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
assert.equal(await descendant.exited, 0);
await new Promise((resolve) => localTcp.close(resolve));
await local.stop(true);
console.log(JSON.stringify({ fetch: true, nodeHttp: true, tcp: true, websocket: true, unix: true, worker: true, descendant: true, remoteDenied: true }));
`;

const parentSource = String.raw`
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readlinkSync } from "node:fs";
const config = JSON.parse(process.argv.at(-1));
const { testNetworkArgv } = await import(config.module);
// This address is assigned only inside this task-owned private parent namespace.
const address = Bun.spawn(["/usr/bin/ip", "address", "add", "192.0.2.10/32", "dev", "lo"], { stdout: "pipe", stderr: "pipe" });
assert.equal(await address.exited, 0);
let hits = 0;
const parent = Bun.serve({ hostname: "192.0.2.10", port: 0,
  fetch(request, server) { hits += 1; if (new URL(request.url).pathname === "/socket" && server.upgrade(request)) return; return new Response("parent-HTTP"); },
  websocket: { message(socket) { socket.send("parent-WS"); } },
});
const remote = "http://192.0.2.10:" + parent.port + "/";
assert.equal(await (await fetch(remote)).text(), "parent-HTTP", "negative destination must first work in its owning parent namespace");
const unix = createServer((socket) => socket.end("parent-Unix"));
await new Promise((resolve, reject) => { unix.once("error", reject); unix.listen(config.unix, resolve); });
const childConfig = { ...config, remote, remotePort: parent.port, parentNamespace: readlinkSync("/proc/self/ns/net") };
const child = Bun.spawn(testNetworkArgv([process.execPath, config.child, JSON.stringify(childConfig)]), {
  env: { PATH: "/usr/bin:/bin", HOME: config.home, TMPDIR: config.root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  stdout: "pipe", stderr: "pipe", timeout: 10_000,
});
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
assert.equal(stderr, "");
assert.equal(code, 0);
assert.equal(hits, 1, "isolated child/worker/descendant must never reach the fake parent destination");
await new Promise((resolve) => unix.close(resolve));
await parent.stop(true);
console.log(JSON.stringify({ ...JSON.parse(stdout), parentBaseline: true, parentHitCount: hits, settled: true }));
`;

linuxTest(
  "test network isolates real fetch/HTTP/TCP/WS while preserving private loopback and pathname Unix sockets",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "m13-network-"));
    try {
      await mkdir(join(root, "home"));
      const child = join(root, "child.ts");
      const parent = join(root, "parent.ts");
      const worker = join(root, "worker.ts");
      await writeFile(child, childSource);
      await writeFile(parent, parentSource);
      await writeFile(
        worker,
        String.raw`
      import { readlinkSync } from "node:fs";
      self.postMessage("ready");
      self.onmessage = async (event) => {
        const local = await (await fetch(event.data.local)).text();
        let remoteDenied = false;
        try { await fetch(event.data.remote, { signal: AbortSignal.timeout(500) }); } catch { remoteDenied = true; }
        self.postMessage({ local, remoteDenied, sameNamespace: readlinkSync("/proc/self/ns/net") === event.data.namespace });
      };
    `
      );
      const config = {
        root,
        child,
        worker,
        unix: join(root, "parent.sock"),
        home: join(root, "home"),
        module: new URL("../scripts/test-network.ts", import.meta.url).href,
      };
      const run = Bun.spawn(testNetworkArgv([process.execPath, parent, JSON.stringify(config)]), {
        env: sparseEnv(root),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const proof = JSON.parse(stdout.trim()) as Record<string, unknown>;
      expect(proof.parentBaseline).toBe(true);
      expect(proof.parentHitCount).toBe(1);
      expect(proof.remoteDenied).toBe(true);
      expect(proof.settled).toBe(true);
      console.log(stdout.trim());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000
);

linuxTest("test network timeout settles the entire private process tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "m13-network-timeout-"));
  try {
    await mkdir(join(root, "home"));
    const marker = join(root, "heartbeat.txt");
    const source = `Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", ${JSON.stringify("setInterval(() => Bun.write(process.argv.at(-1), String(Date.now())), 10);")}, ${JSON.stringify(marker)}]); await new Promise(() => {});`;
    const child = Bun.spawn(testNetworkArgv([process.execPath, "-e", source]), { env: sparseEnv(root), stdout: "pipe", stderr: "pipe", timeout: 700 });
    const code = await child.exited;
    await new Response(child.stderr).text();
    expect(code).not.toBe(0);
    const first = await readFile(marker, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(marker, "utf8")).toBe(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

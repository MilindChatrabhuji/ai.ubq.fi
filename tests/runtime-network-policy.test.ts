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

const settlementSource = String.raw`
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const config = JSON.parse(process.argv.at(-1));
const { testNetworkArgv } = await import(config.module);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signalGroup = (pid, signal) => {
  try { process.kill(-pid, signal); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
const members = (pid) => readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
  try {
    const stat = readFileSync("/proc/" + name + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[2]) === pid ? [{ pid: Number(name), state: fields[0], parent: Number(fields[1]) }] : [];
  } catch { return []; }
});
const proof = [];
for (const mode of ["normal", "timeout", "SIGTERM", "SIGKILL"]) {
  const marker = join(config.root, config.depth + "-" + mode + ".txt");
  const heartbeat = 'import { writeFileSync } from "node:fs"; setInterval(() => writeFileSync(process.argv.at(-1), String(Date.now())), 10);';
  const source = 'import { existsSync } from "node:fs"; Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", ' + JSON.stringify(heartbeat) + ', ' + JSON.stringify(marker) + '], { stdout: "ignore", stderr: "ignore" });' +
    (mode === "normal" ? 'while (!existsSync(' + JSON.stringify(marker) + ')) await Bun.sleep(10); process.exit(7);' : 'await new Promise(() => {});');
  const child = Bun.spawn(testNetworkArgv([process.execPath, "-e", source]), {
    detached: true,
    env: { PATH: "/usr/bin:/bin", HOME: config.home, TMPDIR: config.root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdout: "pipe", stderr: "pipe", ...(mode === "timeout" ? { timeout: 1000 } : {}),
  });
  const readyDeadline = Date.now() + 3000;
  while (!existsSync(marker)) {
    if (Date.now() >= readyDeadline) throw new Error("Heartbeat never started: " + mode);
    await sleep(10);
  }
  if (mode === "SIGTERM" || mode === "SIGKILL") signalGroup(child.pid, mode);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(stdout, "");
  assert(mode === "normal" ? stderr === "" : stderr === "" || stderr === "Terminated\n");
  mode === "normal" ? assert.equal(code, 7) : assert.notEqual(code, 0);
  signalGroup(child.pid, "SIGKILL");
  const settlementDeadline = Date.now() + 3000;
  while (signalGroup(child.pid, 0)) {
    if (Date.now() >= settlementDeadline) throw new Error("Process group did not settle: " + JSON.stringify({ mode, members: members(child.pid) }));
    await sleep(20);
  }
  const stopped = readFileSync(marker, "utf8");
  await sleep(100);
  assert.equal(readFileSync(marker, "utf8"), stopped, "The descendant heartbeat must stop");
  proof.push({ mode, code, groupAbsent: true, heartbeatStopped: true });
}
console.log(JSON.stringify({ depth: config.depth, proof }));
`;

for (const depth of ["direct", "nested"]) {
  linuxTest(
    "test network reaps every process group after normal exit, timeout, SIGTERM and SIGKILL: " + depth,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "m22-network-settlement-"));
      try {
        const home = join(root, "home");
        await mkdir(home);
        const source = join(root, "settlement.ts");
        await writeFile(source, settlementSource);
        const config = { root, home, depth, module: new URL("../scripts/test-network.ts", import.meta.url).href };
        const command = [process.execPath, "--no-env-file", "--no-install", source, JSON.stringify(config)];
        const child = Bun.spawn(depth === "nested" ? testNetworkArgv(command) : command, {
          env: sparseEnv(root),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15_000,
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        const receipt = JSON.parse(stdout.trim()) as { depth: string; proof: { groupAbsent: boolean; heartbeatStopped: boolean }[] };
        expect(receipt.depth).toBe(depth);
        expect(receipt.proof).toHaveLength(4);
        for (const result of receipt.proof) {
          expect(result.groupAbsent).toBe(true);
          expect(result.heartbeatStopped).toBe(true);
        }
        console.log(stdout.trim());
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000
  );
}

const darwinChildSource = String.raw`
import assert from "node:assert/strict";
import { get } from "node:http";
import { connect, createServer } from "node:net";
import { createSocket } from "node:dgram";
const config = JSON.parse(process.argv.at(-1));
for (const name of ["CEREBRAS_API_KEY", "METERED_API_KEY", "SURPLUS_API_KEY", "OPENROUTER_API_KEY", "HTTP_PROXY", "HTTPS_PROXY"])
  assert.equal(process.env[name], undefined);
const tcp = (options) => new Promise((resolve, reject) => {
  const socket = connect(options);
  socket.once("connect", () => { socket.end(); resolve(true); });
  socket.once("error", reject);
});
const http = (url) => new Promise((resolve, reject) => {
  const request = get(url, (response) => {
    let value = "";
    response.on("data", (chunk) => value += chunk);
    response.once("end", () => resolve(value));
    response.once("error", reject);
  });
  request.setTimeout(500, () => request.destroy(new Error("HTTP fixture timeout")));
  request.once("error", reject);
});
const ws = (url, expected) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket fixture timeout")); }, 500);
  socket.onopen = () => socket.send("fixture");
  socket.onmessage = (event) => { clearTimeout(timer); assert.equal(event.data, expected); socket.close(); resolve(true); };
  socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket fixture denied")); };
});
const udp = (host, port) => new Promise((resolve, reject) => {
  const socket = createSocket("udp4");
  const timer = setTimeout(() => { socket.close(); reject(new Error("UDP fixture timeout")); }, 500);
  socket.once("error", (error) => { clearTimeout(timer); socket.close(); reject(error); });
  socket.once("message", (message) => { clearTimeout(timer); socket.close(); resolve(message.toString()); });
  socket.bind(0, "127.0.0.1", () => socket.send("fixture", port, host, (error) => { if (error) { clearTimeout(timer); socket.close(); reject(error); } }));
});
await assert.rejects(fetch(config.remote, { signal: AbortSignal.timeout(500) }));
await assert.rejects(tcp({ host: config.remoteHost, port: config.remotePort }));
await assert.rejects(http(config.remote));
await assert.rejects(ws(config.remote.replace("http:", "ws:") + "socket", "parent-WS"));
await assert.rejects(udp(config.remoteHost, config.udpPort));
const denied = createServer();
await assert.rejects(new Promise((resolve, reject) => {
  denied.once("error", reject);
  denied.listen(0, config.remoteHost, () => { denied.close(); resolve(true); });
}));
const local = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch(request, server) { if (new URL(request.url).pathname === "/socket" && server.upgrade(request)) return; return new Response("local-HTTP"); },
  websocket: { message(socket) { socket.send("local-WS"); } },
});
const url = "http://127.0.0.1:" + local.port + "/";
assert.equal(await (await fetch(url)).text(), "local-HTTP");
assert.equal(await http(url), "local-HTTP");
await ws(url.replace("http:", "ws:") + "socket", "local-WS");
await tcp({ host: "127.0.0.1", port: local.port });
await tcp({ path: config.unix });
const ipv6 = Bun.serve({ hostname: "::1", port: 0, fetch() { return new Response("IPv6"); } });
assert.equal(await (await fetch("http://[::1]:" + ipv6.port)).text(), "IPv6");
const echo = createSocket("udp4");
echo.on("message", (message, peer) => echo.send(message, peer.port, peer.address));
await new Promise((resolve, reject) => { echo.once("error", reject); echo.bind(0, "127.0.0.1", resolve); });
assert.equal(await udp("127.0.0.1", echo.address().port), "fixture");
const worker = new Worker(config.worker);
await new Promise((resolve, reject) => { worker.onmessage = resolve; worker.onerror = reject; });
const reply = new Promise((resolve, reject) => { worker.onmessage = (event) => resolve(event.data); worker.onerror = reject; });
worker.postMessage({ local: url, remote: config.remote });
assert.deepEqual(await reply, { local: "local-HTTP", remoteDenied: true });
worker.terminate();
const source = 'const config = JSON.parse(process.argv.at(-1)); if (await (await fetch(config.local)).text() !== "local-HTTP") process.exit(91); try { await fetch(config.remote, { signal: AbortSignal.timeout(500) }); process.exit(90); } catch { process.exit(0); }';
const descendant = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", source, JSON.stringify({ local: url, remote: config.remote })],
  { env: { PATH: "/usr/bin:/bin", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
assert.equal(await descendant.exited, 0);
echo.close();
await ipv6.stop(true);
await local.stop(true);
console.log(JSON.stringify({ fetch: true, nodeHttp: true, tcp: true, websocket: true, unix: true, udp: true, ipv6: true, worker: true, descendant: true, remoteDenied: true, bindDenied: true }));
`;

const darwinGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

const darwinOwnedGroups = (pid: number, root: string): number[] => {
  const listing = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,pgid="], { env: sparseEnv(root), stdout: "pipe", stderr: "pipe" });
  expect(listing.exitCode).toBe(0);
  const rows = new TextDecoder()
    .decode(listing.stdout)
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([pid]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [child, parent] of rows)
      if (owned.has(parent) && !owned.has(child)) {
        owned.add(child);
        expanded = true;
      }
  }
  return [...new Set([pid, ...rows.filter(([child]) => owned.has(child)).map((row) => row[2])])];
};

const darwinWaitGroups = async (groups: readonly number[]): Promise<void> => {
  const deadline = Date.now() + 3000;
  for (const pid of groups)
    while (darwinGroupExists(pid)) {
      if (Date.now() >= deadline) throw new Error(`Darwin task-owned process group did not settle: ${pid}`);
      await Bun.sleep(20);
    }
};

const darwinSettlementCase = async (root: string, mode: string): Promise<void> => {
  const { existsSync, readFileSync } = await import("node:fs");
  const marker = join(root, mode + ".json");
  const release = join(root, mode + ".release");
  const heartbeat =
    'import { writeFileSync } from "node:fs"; const group = Number(new TextDecoder().decode(Bun.spawnSync(["/bin/ps", "-o", "pgid=", "-p", String(process.pid)]).stdout).trim()); setInterval(() => writeFileSync(process.argv.at(-1), JSON.stringify({group, time:Date.now()})), 10);';
  const source =
    'import { existsSync } from "node:fs"; Bun.spawn([process.execPath,"--no-env-file","--no-install","-e",' +
    JSON.stringify(heartbeat) +
    "," +
    JSON.stringify(marker) +
    '], {stdout:"ignore",stderr:"ignore"});' +
    (mode === "normal" ? "while (!existsSync(" + JSON.stringify(release) + ")) await Bun.sleep(10); process.exit(7);" : "await new Promise(() => {});");
  const run = Bun.spawn(testNetworkArgv([process.execPath, "-e", source]), {
    detached: true,
    env: sparseEnv(root),
    stdout: "pipe",
    stderr: "pipe",
    ...(mode === "timeout" ? { timeout: 1000 } : {}),
  });
  let groups = [run.pid];
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(marker)) {
      if (Date.now() >= deadline) throw new Error("Darwin descendant never started");
      await Bun.sleep(10);
    }
    const group = (JSON.parse(readFileSync(marker, "utf8")) as { group: number }).group;
    expect(group).toBeGreaterThan(1);
    groups = [...new Set([...darwinOwnedGroups(run.pid, root), group])];
    if (mode === "normal") await writeFile(release, "ready");
    if (mode === "SIGTERM" || mode === "SIGKILL") process.kill(-run.pid, mode);
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    if (mode === "normal") expect(code).toBe(7);
    else expect(code).not.toBe(0);
    await darwinWaitGroups(groups);
    const stopped = readFileSync(marker, "utf8");
    await Bun.sleep(100);
    expect(readFileSync(marker, "utf8")).toBe(stopped);
    console.log(JSON.stringify({ mode, groups, groupAbsent: true, heartbeatStopped: true }));
  } finally {
    if (run.exitCode === null) run.kill("SIGTERM");
    await run.exited;
    for (const pid of groups) if (darwinGroupExists(pid)) process.kill(-pid, "SIGKILL");
  }
};

// This dedicated Darwin harness must run directly, outside Seatbelt, solely to own
// the synthetic nonloopback baseline on its own interface. All probed children use
// testNetworkArgv; native/startup suites retain their ordinary sandbox wrappers.
if (process.platform === "darwin") {
  test("Darwin Seatbelt preserves loopback/Unix and denies the real owned nonloopback fixture for children and Workers", async () => {
    const { networkInterfaces } = await import("node:os");
    const { createServer } = await import("node:net");
    const { createSocket } = await import("node:dgram");
    const address = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (!address) throw new Error("Darwin negative control requires the runner's own nonloopback IPv4 interface");
    const root = await mkdtemp(join(tmpdir(), "uos-m29-network-"));
    const unix = createServer((socket) => socket.end("parent-Unix"));
    const udp = createSocket("udp4");
    let hits = 0;
    let udpHits = 0;
    const parent = Bun.serve({
      hostname: address,
      port: 0,
      fetch(request, server) {
        hits++;
        if (new URL(request.url).pathname === "/socket" && server.upgrade(request)) return;
        return new Response("parent-HTTP");
      },
      websocket: {
        message(socket) {
          socket.send("parent-WS");
        },
      },
    });
    try {
      await mkdir(join(root, "home"));
      if (parent.port === undefined) throw new Error("Parent fixture did not bind a TCP port");
      const remoteUrl = new URL("http://localhost");
      remoteUrl.hostname = address;
      remoteUrl.port = String(parent.port);
      const remote = remoteUrl.href;
      expect(await (await fetch(remote)).text()).toBe("parent-HTTP");
      udp.on("message", (message, peer) => {
        udpHits++;
        udp.send(message, peer.port, peer.address);
      });
      await new Promise<void>((resolve, reject) => {
        udp.once("error", reject);
        udp.bind(0, address, resolve);
      });
      const udpPort = udp.address().port;
      const baseline = createSocket("udp4");
      try {
        await new Promise<void>((resolve, reject) => {
          baseline.once("message", () => {
            resolve();
          });
          baseline.once("error", reject);
          baseline.bind(0, "127.0.0.1", () => {
            baseline.send("baseline", udpPort, address);
          });
        });
      } finally {
        baseline.close();
      }
      const path = join(root, "parent.sock");
      await new Promise<void>((resolve, reject) => {
        unix.once("error", reject);
        unix.listen(path, resolve);
      });
      const child = join(root, "child.ts");
      const worker = join(root, "worker.ts");
      await writeFile(child, darwinChildSource);
      await writeFile(
        worker,
        'self.postMessage("ready"); self.onmessage = async (event) => { const local = await (await fetch(event.data.local)).text(); let remoteDenied = false; try { await fetch(event.data.remote, { signal: AbortSignal.timeout(500) }); } catch { remoteDenied = true; } self.postMessage({local, remoteDenied}); };'
      );
      const config = { remote, remoteHost: address, remotePort: parent.port, udpPort, unix: path, worker };
      const run = Bun.spawn(testNetworkArgv([process.execPath, child, JSON.stringify(config)]), {
        env: sparseEnv(root),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(hits).toBe(1);
      expect(udpHits).toBe(1);
      const proof = JSON.parse(stdout.trim()) as Record<string, unknown>;
      for (const key of ["fetch", "nodeHttp", "tcp", "websocket", "unix", "udp", "ipv6", "worker", "descendant", "remoteDenied", "bindDenied"])
        expect(proof[key]).toBe(true);
      console.log(stdout.trim());
    } finally {
      await parent.stop(true);
      udp.close();
      await new Promise<void>((resolve) => {
        unix.close(() => {
          resolve();
        });
      });
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("Darwin fixture lease settles child groups after normal exit, timeout, SIGTERM and SIGKILL", async () => {
    const root = await mkdtemp(join(tmpdir(), "uos-m29-settle-"));
    try {
      await mkdir(join(root, "home"));
      for (const mode of ["normal", "timeout", "SIGTERM", "SIGKILL"]) await darwinSettlementCase(root, mode);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}

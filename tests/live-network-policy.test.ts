import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupsFor, testNetworkPolicy, validatedGroups, withLiveRelayParent } from "../scripts/test-runner.ts";
import { LIVE_E2E_DEFAULT_BASE_URL, liveDestination, liveNetworkPlan, systemTool, testNetworkArgv, type TestNetworkPolicy } from "../scripts/test-network.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const FIXTURE_TOKEN = "fixture-live-client";

test("live destinations are explicit http(s) origins with their effective TCP port", () => {
  expect(liveDestination("https://ai.ubq.fi")).toEqual({ hostname: "ai.ubq.fi", port: 443 });
  expect(liveDestination("http://127.0.0.1:8000/v1?ignored=1")).toEqual({ hostname: "127.0.0.1", port: 8000 });
  expect(liveDestination("http://LOCALHOST")).toEqual({ hostname: "localhost", port: 80 });
  expect(liveDestination("http://[::1]:8000")).toEqual({ hostname: "::1", port: 8000 });
  expect(() => liveDestination("wss://ai.ubq.fi")).toThrow("http or https origin");
  expect(() => liveDestination("https://user:secret@ai.ubq.fi")).toThrow("must not embed credentials");
});

test("live network plans scope one endpoint per platform and fail closed elsewhere", () => {
  expect(liveNetworkPlan({ hostname: "127.0.0.1", port: 8000 }, "linux")).toEqual({ platform: "linux", port: 8000, listen: "127.0.0.1" });
  expect(liveNetworkPlan({ hostname: "192.0.2.10", port: 9000 }, "linux")).toEqual({
    platform: "linux",
    port: 9000,
    listen: "192.0.2.10",
    address: "192.0.2.10",
  });
  expect(liveNetworkPlan({ hostname: "ai.ubq.fi", port: 443 }, "linux")).toEqual({ platform: "linux", port: 443, listen: "127.0.0.1", hosts: "ai.ubq.fi" });
  expect(liveNetworkPlan({ hostname: "localhost", port: 8000 }, "linux")).toEqual({ platform: "linux", port: 8000, listen: "127.0.0.1", hosts: "localhost" });
  expect(() => liveNetworkPlan({ hostname: "::1", port: 8000 }, "linux")).toThrow("hostname or IPv4");
  expect(() => liveNetworkPlan({ hostname: "ai.ubq.fi", port: 0 }, "linux")).toThrow("TCP port");
  // Seatbelt filters can name only localhost or *: host loopback is the one scopable Darwin destination.
  for (const hostname of ["localhost", "127.0.0.1", "::1"]) expect(liveNetworkPlan({ hostname, port: 8000 }, "darwin")).toEqual({ platform: "darwin" });
  expect(() => liveNetworkPlan({ hostname: "ai.ubq.fi", port: 443 }, "darwin")).toThrow("no unscoped fallback");
  expect(() => liveNetworkPlan({ hostname: "192.0.2.10", port: 443 }, "darwin")).toThrow("host-loopback");
  expect(() => liveNetworkPlan({ hostname: "127.0.0.1", port: 8000 }, "win32")).toThrow("Linux namespaces or Darwin Seatbelt");
});

test("only the explicitly selected e2e segment selects the live policy", () => {
  for (const segment of ["main", "vps", "deploy-guards", "measurement", "stress", "sentinel", "benchmark", "quality"]) {
    for (const group of groupsFor(segment, [])) {
      expect(group.network).toBeUndefined();
      expect(testNetworkPolicy(group, { BASE_URL: "http://127.0.0.1:8000" })).toEqual({});
    }
  }
  expect(groupsFor("files", ["tests/live-default-model.e2e.ts"]).map((group) => group.network)).toEqual([undefined]);
  const [e2e] = groupsFor("e2e", []);
  expect(e2e.network).toBe("live");
  // The runner approves the same default origin the e2e file falls back to: one shared constant.
  expect(LIVE_E2E_DEFAULT_BASE_URL).toBe("https://ai.ubq.fi");
  expect(testNetworkPolicy(e2e, {})).toEqual({ live: liveDestination(LIVE_E2E_DEFAULT_BASE_URL) });
  expect(testNetworkPolicy(e2e, { BASE_URL: "  " })).toEqual({ live: { hostname: "ai.ubq.fi", port: 443 } });
  expect(testNetworkPolicy(e2e, { BASE_URL: " http://127.0.0.1:8123/ " })).toEqual({ live: { hostname: "127.0.0.1", port: 8123 } });
});

test("the runner builds every group's network boundary before the native build", () => {
  const [e2e] = groupsFor("e2e", []);
  const built: { command: readonly string[]; policy: TestNetworkPolicy }[] = [];
  const missingMount = (command: readonly string[], policy: TestNetworkPolicy = {}): string[] => {
    built.push({ command, policy });
    throw new Error("Local-only test transport requires system mount");
  };
  // A system tool the live plan needs is resolved while validating, not first in runFile.
  expect(() => validatedGroups([e2e], { BASE_URL: "http://gateway.fixture.test:8123" }, missingMount)).toThrow("requires system mount");
  expect(built).toEqual([{ command: [process.execPath], policy: { live: { hostname: "gateway.fixture.test", port: 8123 } } }]);
  const resolved: TestNetworkPolicy[] = [];
  const [validated] = validatedGroups([e2e], { BASE_URL: "http://127.0.0.1:8123" }, (_command, policy = {}) => {
    resolved.push(policy);
    return [];
  });
  expect(resolved).toEqual([{ live: { hostname: "127.0.0.1", port: 8123 } }]);
  expect(validated.policy).toEqual({ live: { hostname: "127.0.0.1", port: 8123 } });
  expect(validated.files.map((file) => file.label)).toEqual(["tests/live-default-model.e2e.ts"]);
});

linuxTest("live argv keeps the deterministic namespace and only adds the scoped relay and forwarder", () => {
  const command = [process.execPath, "-e", "0"];
  const deterministic = testNetworkArgv(command);
  expect(testNetworkArgv(command, {})).toEqual(deterministic);
  expect(deterministic).toContain("--net");
  const child = deterministic.slice(-5);
  expect(child[0]).toBe(process.execPath);
  const live = testNetworkArgv(command, { live: liveDestination("http://127.0.0.1:8123") });
  expect(live.slice(0, 4)).toEqual([process.execPath, "--no-env-file", "--no-install", "-e"]);
  const relay = JSON.parse(live.at(-1) ?? "") as { destination: unknown; command: string[] };
  expect(relay.destination).toEqual({ hostname: "127.0.0.1", port: 8123 });
  expect(relay.command.slice(0, -6)).toEqual(deterministic.slice(0, -5));
  const forwarder = JSON.parse(relay.command.at(-1) ?? "") as Record<string, unknown>;
  expect(forwarder).toEqual({ platform: "linux", port: 8123, listen: "127.0.0.1", command: child });
});

linuxTest(
  "a SIGKILLed live relay leaves no directory behind once the runner settles its file",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "uos-live-kill-"));
    try {
      await mkdir(join(root, "home"));
      let leaked: string[] = [];
      await withLiveRelayParent(
        { live: liveDestination("http://127.0.0.1:9") },
        async (policy) => {
          const parent = policy.relayParent ?? "";
          expect(parent.startsWith(join(root, "uos-live-run-"))).toBe(true);
          const child = Bun.spawn(testNetworkArgv([process.execPath, "-e", "await new Promise(() => {});"], policy), {
            detached: true,
            env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
            stdout: "ignore",
            stderr: "ignore",
          });
          const relayReady = (): boolean => readdirSync(parent).some((name) => name.startsWith("uos-live-") && existsSync(join(parent, name, "relay.sock")));
          for (let attempt = 0; attempt < 500 && !relayReady(); attempt += 1) await Bun.sleep(10);
          expect(relayReady()).toBe(true);
          // A timeout escalation, CI cancellation or the OOM killer: no finally block in the relay runs.
          process.kill(-child.pid, "SIGKILL");
          await child.exited;
          leaked = readdirSync(parent);
        },
        root
      );
      // The SIGKILLed relay could not remove its directory; the runner-owned parent took it away.
      expect(leaked.filter((name) => name.startsWith("uos-live-"))).toHaveLength(1);
      expect(await readdir(root)).toEqual(["home"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000
);

linuxTest("live timeout settles the private process tree and removes the relay directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "uos-live-timeout-"));
  try {
    await mkdir(join(root, "home"));
    const marker = join(root, "heartbeat.txt");
    const heartbeat = "setInterval(() => Bun.write(process.argv.at(-1), String(Date.now())), 10);";
    const source = `Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", ${JSON.stringify(heartbeat)}, ${JSON.stringify(marker)}]); await new Promise(() => {});`;
    const child = Bun.spawn(testNetworkArgv([process.execPath, "-e", source], { live: liveDestination("http://127.0.0.1:9") }), {
      env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 1000,
    });
    const code = await child.exited;
    await new Response(child.stderr).text();
    expect(code).not.toBe(0);
    const first = await readFile(marker, "utf8");
    await Bun.sleep(100);
    expect(await readFile(marker, "utf8")).toBe(first);
    expect((await readdir(root)).filter((name) => name.startsWith("uos-live-"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const probeSource = String.raw`
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
const config = JSON.parse(process.argv.at(-1));
assert.equal(process.env.UOS_TEST_LIVE_RELAY, undefined);
if (config.resolver) {
  // A hostname destination resolves from the private hosts file alone: no nsswitch source or
  // resolver daemon (nscd, systemd-resolved) can answer first with the public address.
  if (config.resolver.nsswitch) {
    const lines = readFileSync("/etc/nsswitch.conf", "utf8").split("\n").filter((line) => line.trim() !== "");
    assert.deepEqual(lines.filter((line) => /^\s*hosts\s*:/.test(line)), ["hosts: files"]);
    for (const line of config.resolver.nsswitch) assert.ok(lines.includes(line), "kept " + line);
  }
  for (const daemon of config.resolver.daemons) assert.deepEqual(existsSync(daemon) ? readdirSync(daemon) : [], [], daemon);
}
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.equal(process.env[name], undefined);
const reach = async (url) => {
  try { return await (await fetch(url, { signal: AbortSignal.timeout(1000) })).text(); }
  catch { return null; }
};
assert.equal(await reach(config.target), config.reachable ? config.expected : null, "approved target");
for (const url of config.denied) assert.equal(await reach(url), null, "unapproved " + url);
const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("local-HTTP") });
assert.equal(await reach("http://127.0.0.1:" + local.port + "/"), "local-HTTP");
const unix = await new Promise((resolve, reject) => {
  const socket = connect({ path: config.unix });
  let value = "";
  socket.setTimeout(1000, () => socket.destroy(new Error("Unix fixture timeout")));
  socket.on("data", (chunk) => (value += chunk));
  socket.once("error", reject);
  socket.once("end", () => resolve(value));
});
assert.equal(unix, "parent-Unix");
const descendantSource = 'const c = JSON.parse(process.argv.at(-1)); const reach = async (url) => { try { return await (await fetch(url, { signal: AbortSignal.timeout(1000) })).text(); } catch { return null; } }; if (await reach(c.target) !== c.expected) process.exit(90); if (await reach(c.denied) !== null) process.exit(91);';
const descendant = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", descendantSource,
  JSON.stringify({ target: config.target, expected: config.reachable ? config.expected : null, denied: config.denied[0] })],
  { env: { PATH: "/usr/bin:/bin", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
assert.equal(await descendant.exited, 0);
await local.stop(true);
console.log(JSON.stringify({ reachable: config.reachable, denied: config.denied.length, loopback: true, unix: true, descendant: true }));
`;

const parentSource = String.raw`
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const config = JSON.parse(process.argv.at(-1));
const { liveDestination, testNetworkArgv } = await import(config.module);
const setup = (argv) => {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, result.stderr.toString());
};
// These addresses and names exist only inside this task-owned private parent namespace.
setup([config.ip, "address", "add", "192.0.2.10/32", "dev", "lo"]);
setup([config.ip, "address", "add", "192.0.2.11/32", "dev", "lo"]);
const hosts = join(config.root, "parent-hosts");
writeFileSync(hosts, "127.0.0.1 localhost\n192.0.2.10 gateway.fixture.test\n192.0.2.11 other.fixture.test\n");
setup([config.mount, "--bind", hosts, "/etc/hosts"]);
// A host whose resolver consults a daemon before /etc/hosts: Arch's nsswitch order, a running nscd,
// and systemd-resolved, all reachable over Unix sockets from any network namespace.
setup([config.mount, "-t", "tmpfs", "tmpfs", "/run"]);
const daemons = ["/run/nscd", "/run/systemd/resolve"];
for (const daemon of daemons) {
  mkdirSync(daemon, { recursive: true });
  writeFileSync(join(daemon, "socket"), "");
}
const keptNsswitch = ["passwd: files", "group: files"];
let nsswitch = null;
if (existsSync("/etc/nsswitch.conf")) {
  const parentNsswitch = join(config.root, "parent-nsswitch.conf");
  writeFileSync(parentNsswitch, [keptNsswitch[0], "hosts: mymachines resolve [!UNAVAIL=return] files myhostname dns", keptNsswitch[1], ""].join("\n"));
  setup([config.mount, "--bind", parentNsswitch, "/etc/nsswitch.conf"]);
  nsswitch = keptNsswitch;
}

// Non-billable gateway fixture with the endpoints the live default-model e2e file uses.
const gatewayResponse = (request) => {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/v1/")) return undefined;
  if (request.headers.get("authorization") !== "Bearer " + config.token) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (path === "/v1/models") return Response.json({ object: "list", data: [{ id: "fixture-default", object: "model" }] });
  if (path === "/v1/responses") return Response.json({ model: "fixture-default", output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }] });
  if (path === "/v1/chat/completions") return Response.json({ model: "fixture-default", choices: [{ message: { role: "assistant", content: "pong" } }] });
  return Response.json({ error: "not found" }, { status: 404 });
};
const hits = {};
const servers = {};
for (const [name, hostname] of [["loopback", "127.0.0.1"], ["strayLoopback", "127.0.0.1"], ["gateway", "192.0.2.10"], ["strayPort", "192.0.2.10"], ["external", "192.0.2.11"]]) {
  hits[name] = 0;
  servers[name] = Bun.serve({ hostname, port: 0, fetch(request) { hits[name] += 1; return gatewayResponse(request) ?? new Response(name); } });
}
const url = (host, name) => "http://" + host + ":" + servers[name].port + "/";
const unix = createServer((socket) => socket.end("parent-Unix"));
await new Promise((resolve, reject) => { unix.once("error", reject); unix.listen(join(config.root, "parent.sock"), resolve); });
const denied = [url("127.0.0.1", "strayLoopback"), url("192.0.2.10", "strayPort"), url("192.0.2.11", "external"), url("other.fixture.test", "external")];
// Every destination first works from its owning parent namespace.
for (const target of [url("127.0.0.1", "loopback"), url("gateway.fixture.test", "gateway"), ...denied]) assert.ok((await fetch(target)).ok, target);
const baseline = { ...hits };
const env = { PATH: "/usr/bin:/bin", HOME: config.home, TMPDIR: config.root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
const run = async (command, policy, extra = {}) => {
  const child = Bun.spawn(testNetworkArgv(command, policy), { cwd: config.root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
};
const proof = [];
const scenarios = [
  { name: "host-loopback", target: url("127.0.0.1", "loopback"), server: "loopback", live: true },
  { name: "ipv4", target: url("192.0.2.10", "gateway"), server: "gateway", live: true },
  { name: "hostname", target: url("gateway.fixture.test", "gateway"), server: "gateway", live: true },
  { name: "deterministic-host-loopback", target: url("127.0.0.1", "loopback"), server: "loopback", live: false },
  { name: "deterministic-hostname", target: url("gateway.fixture.test", "gateway"), server: "gateway", live: false },
];
for (const scenario of scenarios) {
  const before = { ...hits };
  const resolver = scenario.name === "hostname" ? { nsswitch, daemons } : null;
  const probe = { target: scenario.target, reachable: scenario.live, expected: scenario.server, denied, unix: join(config.root, "parent.sock"), resolver };
  const result = await run([process.execPath, config.probe, JSON.stringify(probe)], scenario.live ? { live: liveDestination(scenario.target) } : {});
  assert.equal(result.stderr, "", scenario.name);
  assert.equal(result.code, 0, scenario.name + ": " + result.stdout);
  for (const name of Object.keys(hits)) assert.equal(hits[name] - before[name], scenario.live && name === scenario.server ? 2 : 0, scenario.name + " reached " + name);
  proof.push({ name: scenario.name, ...JSON.parse(result.stdout) });
}
// A same-user process outside the live namespace finds the relay socket under TMPDIR but cannot
// use it: the relay serves only the forwarder that holds its per-run key.
{
  const before = { ...hits };
  const release = join(config.root, "release-relay");
  const waitForRelease = "const path = process.argv.at(-1); while (!(await Bun.file(path).exists())) await Bun.sleep(10);";
  const waiting = run([process.execPath, "-e", waitForRelease, release], { live: liveDestination(url("192.0.2.10", "gateway")) });
  let socket = null;
  for (let attempt = 0; attempt < 500 && socket === null; attempt += 1) {
    const directory = readdirSync(config.root).find((name) => name.startsWith("uos-live-") && existsSync(join(config.root, name, "relay.sock")));
    if (directory === undefined) await Bun.sleep(10);
    else socket = join(config.root, directory, "relay.sock");
  }
  assert.ok(socket, "relay socket");
  const answer = await new Promise((resolve) => {
    const stray = connect({ path: socket });
    let value = "";
    stray.on("data", (chunk) => (value += chunk));
    stray.once("error", () => resolve(value));
    stray.once("close", () => resolve(value));
    stray.write("GET / HTTP/1.1\r\nHost: gateway.fixture.test\r\nConnection: close\r\n\r\n");
  });
  writeFileSync(release, "");
  const result = await waiting;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(answer, "", "a stray relay client got an answer");
  for (const name of Object.keys(hits)) assert.equal(hits[name] - before[name], 0, "a stray relay client reached " + name);
  proof.push({ name: "stray-relay-client", refused: true });
}
// The actual live e2e file reaches only its selected non-billable fixture gateway.
for (const live of [true, false]) {
  const before = { ...hits };
  const base = "http://gateway.fixture.test:" + servers.gateway.port;
  const result = await run([process.execPath, "test", "--timeout=20000", config.e2e], live ? { live: liveDestination(base) } : {}, { BASE_URL: base, UOS_AI_TOKEN: config.token });
  assert.equal(result.code, live ? 0 : 1, result.stdout + result.stderr);
  for (const name of Object.keys(hits)) assert.equal(hits[name] - before[name], live && name === "gateway" ? 3 : 0, "e2e reached " + name);
  proof.push({ name: live ? "live-e2e" : "deterministic-e2e", code: result.code });
}
for (const name of ["strayLoopback", "strayPort", "external"]) assert.equal(hits[name], baseline[name], name + " must only see its parent baseline");
await new Promise((resolve) => unix.close(resolve));
for (const server of Object.values(servers)) await server.stop(true);
console.log(JSON.stringify({ proof, hits }));
`;

linuxTest(
  "live policy reaches only its approved loopback, IPv4 or hostname fixture while deterministic profiles stay local-only",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "uos-live-net-"));
    try {
      await mkdir(join(root, "home"));
      const probe = join(root, "probe.ts");
      const parent = join(root, "parent.ts");
      await writeFile(probe, probeSource);
      await writeFile(parent, parentSource);
      const config = {
        root,
        probe,
        home: join(root, "home"),
        token: FIXTURE_TOKEN,
        e2e: new URL("./live-default-model.e2e.ts", import.meta.url).pathname,
        module: new URL("../scripts/test-network.ts", import.meta.url).href,
        ip: systemTool("ip"),
        mount: systemTool("mount"),
      };
      const run = Bun.spawn(testNetworkArgv([process.execPath, parent, JSON.stringify(config)]), {
        env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), TMPDIR: root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 110_000,
      });
      const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const receipt = JSON.parse(stdout.trim()) as { proof: { name: string }[] };
      expect(receipt.proof.map((item) => item.name)).toEqual([
        "host-loopback",
        "ipv4",
        "hostname",
        "deterministic-host-loopback",
        "deterministic-hostname",
        "stray-relay-client",
        "live-e2e",
        "deterministic-e2e",
      ]);
      console.log(stdout.trim());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000
);

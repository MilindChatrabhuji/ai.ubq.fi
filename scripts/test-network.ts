import { existsSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

/** Resolves a system tool from fixed system directories only; PATH never selects a boundary tool. */
export const systemTool = (name: string): string => {
  const path = ["/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/"].map((directory) => directory + name).find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Local-only test transport requires system " + name);
  return path;
};

// Seatbelt endpoint filters apply to descendants as well as the initial Bun process.
// Network syntax: chromium/chromium sandbox/policy/mac/network.sb; actual Darwin
// loopback/Unix positives and nonloopback negatives are a required platform gate.
const darwinProfile = [
  "(version 1)",
  "(allow default)",
  "(deny network*)",
  '(allow network-bind network-inbound (local ip "localhost:*"))',
  '(allow network-outbound (remote ip "localhost:*"))',
  "(allow network* (local unix-socket) (remote unix-socket))",
].join("\n");

// The guard owns a separate group and an IPC lease. If its supervisor is SIGKILLed,
// the lease closes and the guard still kills/reaps only its own detached child group.
const darwinGuard = String.raw`
if (!process.connected) throw new Error("Fixture guard requires its parent IPC lease");
const command = JSON.parse(process.argv.at(-1));
let child;
let stopped = false;
const signal = (value) => {
  if (!child) return false;
  try { process.kill(-child.pid, value); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
const stop = () => { stopped = true; signal("SIGKILL"); };
process.on("disconnect", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  if (!process.connected) throw new Error("Fixture parent lease closed before launch");
  child = Bun.spawn(command, { detached: true, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  signal("SIGKILL");
  const deadline = Date.now() + 3000;
  while (signal(0)) {
    if (Date.now() >= deadline) throw new Error("Fixture child process group " + child.pid + " did not settle");
    await Bun.sleep(20);
  }
  process.exitCode = stopped ? 143 : code;
} catch (error) {
  signal("SIGKILL");
  if (child) await child.exited;
  console.error(error.message);
  process.exitCode = 78;
} finally {
  process.off("disconnect", stop);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  if (process.connected) process.disconnect();
}
`;

const darwinNetworkArgv = (child: readonly string[]): string[] => {
  const command = [systemTool("sandbox-exec"), "-p", darwinProfile, ...child];
  const supervise = `
const command = JSON.parse(process.argv.at(-1));
const guard = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", ${JSON.stringify(darwinGuard)}, JSON.stringify(command)], {
  detached: true, stdin: "inherit", stdout: "inherit", stderr: "inherit", ipc() {},
});
const interrupt = () => { if (guard.exitCode === null) guard.kill("SIGINT"); };
const terminate = () => { if (guard.exitCode === null) guard.kill("SIGTERM"); };
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try { process.exitCode = await guard.exited; }
finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
`;
  return [process.execPath, "--no-env-file", "--no-install", "-e", supervise, JSON.stringify(command)];
};

const linuxNetworkArgv = (child: readonly string[]): string[] => {
  const before = readlinkSync("/proc/self/ns/net");
  const bootstrap =
    'if test "$("$1" /proc/self/ns/net)" = "$2"; then echo "Test network namespace was not isolated" >&2; exit 78; fi; shift 2; "$1" link set dev lo up; shift; "$@" <&0 & testChildPid=$!; set +e; wait "$testChildPid"; status=$?; exit "$status"';
  const namespace = [
    systemTool("unshare"),
    "--user",
    "--map-root-user",
    "--net",
    "--mount",
    "--pid",
    "--fork",
    "--mount-proc",
    "--kill-child=SIGKILL",
    "--",
    "/bin/sh",
    "-eu",
    "-c",
    bootstrap,
    "--",
    systemTool("readlink"),
    before,
    systemTool("ip"),
    ...child,
  ];
  // unshare --fork ignores SIGTERM while waiting. Translate a normal caller timeout
  // to SIGKILL of its leader; killing PID1 then settles every namespace descendant.
  const supervise =
    'testNamespacePid=""; stop() { if test -n "$testNamespacePid"; then kill -KILL "$testNamespacePid" 2>/dev/null || :; wait "$testNamespacePid" 2>/dev/null || :; fi; exit 143; }; trap stop TERM INT; "$@" <&0 & testNamespacePid=$!; set +e; wait "$testNamespacePid"; status=$?; exit "$status"';
  return ["/bin/sh", "-eu", "-c", supervise, "--", ...namespace];
};

/** One explicitly approved live TCP destination; every other destination stays outside the boundary. */
export type LiveDestination = Readonly<{ hostname: string; port: number }>;
/** `relayParent` is a runner-owned directory for the live relay's files, removed even after a SIGKILL. */
export type TestNetworkPolicy = Readonly<{ live?: LiveDestination; relayParent?: string }>;
/**
 * The live e2e origin when `BASE_URL` is unset or blank. The runner approves it as the live
 * destination and `tests/live-default-model.e2e.ts` falls back to it, so the two cannot drift.
 */
export const LIVE_E2E_DEFAULT_BASE_URL = "https://ai.ubq.fi";
type LiveNetworkPlan = Readonly<{ platform: "darwin" }> | Readonly<{ platform: "linux"; port: number; listen: string; address?: string; hosts?: string }>;

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const DARWIN_LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const LIVE_RELAY_ENV = "UOS_TEST_LIVE_RELAY";
// The relay's per-run key travels on this inherited descriptor, never a path, argv or the environment.
const LIVE_RELAY_KEY_FD = 3;
const LIVE_RELAY_KEY_BYTES = 32;

export const liveDestination = (origin: string): LiveDestination => {
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A live test destination must be an http or https origin");
  if (url.username || url.password) throw new Error("A live test destination must not embed credentials");
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const port = url.port === "" ? defaultPort : Number(url.port);
  return Object.freeze({ hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"), port });
};

/**
 * Darwin Seatbelt endpoint filters can name only localhost or *, so a host-loopback destination
 * is the only one it can scope; its deterministic profile already admits host loopback on every
 * port, so a Darwin live run admits no less than that, not only the destination's port. Linux
 * keeps the fresh namespace and adds exactly one in-namespace listener for the approved endpoint:
 * a loopback address as-is, another IPv4 address on the private lo, or a hostname bound to
 * 127.0.0.1 in the private mount namespace's hosts file. Anything else fails closed.
 */
export const liveNetworkPlan = (destination: LiveDestination, platform: NodeJS.Platform = process.platform): LiveNetworkPlan => {
  const { hostname, port } = destination;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("A live test destination requires a TCP port from 1 through 65535");
  if (platform === "darwin") {
    if (DARWIN_LOOPBACK.has(hostname)) return { platform };
    throw new Error(`Darwin Seatbelt can scope only a host-loopback live destination, not ${hostname}:${port}; there is no unscoped fallback`);
  }
  if (platform !== "linux") throw new Error("Live test transport requires supported Linux namespaces or Darwin Seatbelt");
  if (!/^[\w.-]+$/.test(hostname)) throw new Error(`Linux live test transport requires a hostname or IPv4 destination, not ${hostname}`);
  if (!IPV4.test(hostname)) return { platform, port, listen: "127.0.0.1", hosts: hostname };
  return hostname.startsWith("127.") ? { platform, port, listen: hostname } : { platform, port, listen: hostname, address: hostname };
};

const livePipe = String.raw`
import { connect, createServer } from "node:net";
const pipe = (client, upstream) => {
  client.once("error", () => upstream.destroy());
  upstream.once("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
};
`;

// Outside the namespace: the only egress. Every relayed stream connects to the one approved
// host and port, whatever the child sends; the private directory is removed on exit, and a
// runner-owned parent directory (when given) removes it after a SIGKILL too. The socket path is
// discoverable by any process of the same user, so a stream is relayed only after it presents the
// per-run key, which reaches the forwarder alone on an inherited socket (fd 3); anything else is
// closed before an upstream connection is opened.
const liveRelay = String.raw`${livePipe}
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { destination, command, parent } = JSON.parse(process.argv.at(-1));
const directory = mkdtempSync(join(parent ?? tmpdir(), "uos-live-"));
const key = randomBytes(${LIVE_RELAY_KEY_BYTES});
const sockets = new Set();
const own = (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); return socket; };
const admit = (client) => {
  own(client);
  let prefix = Buffer.alloc(0);
  const refuse = () => client.destroy();
  const read = (chunk) => {
    prefix = Buffer.concat([prefix, chunk]);
    if (prefix.length < key.length) return;
    client.off("data", read);
    client.off("end", refuse);
    client.pause();
    if (!timingSafeEqual(prefix.subarray(0, key.length), key)) return refuse();
    const upstream = own(connect({ host: destination.hostname, port: destination.port, allowHalfOpen: true }));
    if (prefix.length > key.length) upstream.write(prefix.subarray(key.length));
    pipe(client, upstream);
  };
  client.on("data", read);
  client.once("end", refuse);
  client.once("error", refuse);
};
const relay = createServer({ allowHalfOpen: true }, admit);
let child;
let stopped = false;
const stop = (signal) => { stopped = true; if (child && child.exitCode === null) child.kill(signal); };
const interrupt = () => stop("SIGINT");
const terminate = () => stop("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  await new Promise((resolve, reject) => { relay.once("error", reject); relay.listen(join(directory, "relay.sock"), resolve); });
  if (stopped) process.exitCode = 143;
  else {
    child = Bun.spawn(command, { env: { ...process.env, ${LIVE_RELAY_ENV}: directory }, stdio: ["inherit", "inherit", "inherit", "pipe"] });
    writeSync(child.stdio[${LIVE_RELAY_KEY_FD}], key);
    process.exitCode = await child.exited;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 78;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  relay.close();
  for (const socket of sockets) socket.destroy();
  rmSync(directory, { recursive: true, force: true });
}
`;

// Inside the namespace: take the relay key from fd 3 and close it, bind the approved endpoint before
// the child starts, forward it over the relay's pathname Unix socket with the key in front, and drop
// the relay variable from the test child's environment. The location stays discoverable (/proc,
// mountinfo); without the key, which neither the test child nor any other process inherits, the
// relay serves nothing.
const liveForwarder = String.raw`${livePipe}
import { closeSync, existsSync, mkdirSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const plan = JSON.parse(process.argv.at(-1));
const directory = process.env.${LIVE_RELAY_ENV};
const env = { ...process.env };
delete env.${LIVE_RELAY_ENV};
const setup = (argv) => {
  const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Live test transport setup failed: " + argv.join(" ") + ": " + result.stderr.toString().trim());
};
const readRelayKey = () => {
  const key = Buffer.alloc(${LIVE_RELAY_KEY_BYTES});
  let length = 0;
  try {
    while (length < key.length) {
      const count = readSync(${LIVE_RELAY_KEY_FD}, key, length, key.length - length, null);
      if (count === 0) throw new Error("Live test transport relay closed before sending its key");
      length += count;
    }
  } finally {
    closeSync(${LIVE_RELAY_KEY_FD});
  }
  return key;
};
let key;
try {
  if (!directory) throw new Error("Live test transport requires its parent destination relay");
  key = readRelayKey();
  if (plan.address) setup([plan.ip, "address", "add", plan.address + "/32", "dev", "lo"]);
  if (plan.hosts) {
    const hosts = join(directory, "hosts");
    writeFileSync(hosts, "127.0.0.1 localhost\n127.0.0.1 " + plan.hosts + "\n", { flag: "wx" });
    setup([plan.mount, "--bind", hosts, "/etc/hosts"]);
    // Make that file the only source for host lookups. An nsswitch order that lists another source
    // first (Arch's "resolve"), or a resolver daemon reached over a Unix socket from any network
    // namespace (nscd, systemd-resolved), would answer with the public address, which has no
    // route here. Every other nsswitch database keeps the host's own configuration.
    for (const [index, path] of ["/etc/nsswitch.conf", "/usr/etc/nsswitch.conf"].entries()) {
      if (!existsSync(path)) continue;
      const nsswitch = join(directory, "nsswitch-" + index + ".conf");
      const kept = readFileSync(path, "utf8").split("\n").filter((line) => !/^\s*hosts\s*:/.test(line) && line.trim() !== "");
      writeFileSync(nsswitch, [...kept, "hosts: files", ""].join("\n"), { flag: "wx" });
      setup([plan.mount, "--bind", nsswitch, path]);
    }
    const empty = join(directory, "resolver-hidden");
    mkdirSync(empty, { mode: 0o500 });
    const daemons = ["/run/nscd", "/var/run/nscd", "/run/systemd/resolve"].filter((path) => existsSync(path)).map((path) => realpathSync(path));
    for (const daemon of new Set(daemons)) setup([plan.mount, "--bind", empty, daemon]);
  }
  const relay = join(directory, "relay.sock");
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ path: relay, allowHalfOpen: true });
    upstream.write(key);
    pipe(client, upstream);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(plan.port, plan.listen, resolve); });
} catch (error) {
  console.error(error.message);
  process.exit(78);
}
const child = Bun.spawn(plan.command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
`;

const liveNetworkArgv = (child: readonly string[], destination: LiveDestination, relayParent?: string): string[] => {
  const plan = liveNetworkPlan(destination);
  if (plan.platform === "darwin") return darwinNetworkArgv(child);
  const bun = [process.execPath, "--no-env-file", "--no-install", "-e"];
  const tools = { ip: plan.address === undefined ? undefined : systemTool("ip"), mount: plan.hosts === undefined ? undefined : systemTool("mount") };
  const forwarder = [...bun, liveForwarder, JSON.stringify({ ...plan, ...tools, command: child })];
  return [...bun, liveRelay, JSON.stringify({ destination, command: linuxNetworkArgv(forwarder), parent: relayParent })];
};

/**
 * Wrap one test child, never the primary or a shared service. The fresh network namespace
 * has only its own loopback and no external routes. Children and Workers inherit it;
 * pathname Unix sockets remain usable. A waiting shell stays PID1 to reap orphaned
 * descendants; Bun cannot serve as namespace init. PID isolation plus kill-child settles
 * descendants when the wrapper exits or is killed. Missing kernel/tool support fails closed.
 * Primary CLI contract: https://man7.org/linux/man-pages/man1/unshare.1.html.
 * Darwin uses inherited Seatbelt endpoint rules plus a task-owned IPC lease guard;
 * unsupported tools/profile syntax fail closed, with no unconfined fallback.
 * Only an explicitly selected live policy adds its one approved destination to that boundary.
 */
export const testNetworkArgv = (command: readonly string[], policy: TestNetworkPolicy = {}): string[] => {
  if (!command.length || !command[0]) throw new Error("A test child command is required");
  const child = [...command];
  if (child[0] === process.execPath || basename(child[0]) === "bun") {
    if (!child.includes("--no-env-file")) child.splice(1, 0, "--no-env-file");
    if (!child.includes("--no-install")) child.splice(1, 0, "--no-install");
  }
  if (policy.live !== undefined) return liveNetworkArgv(child, policy.live, policy.relayParent);
  if (process.platform === "darwin") return darwinNetworkArgv(child);
  if (process.platform !== "linux") throw new Error("Local-only test transport requires supported Linux namespaces or Darwin Seatbelt");
  return linuxNetworkArgv(child);
};

if (import.meta.main) {
  const command = process.argv.slice(2);
  if (command[0] === "--") command.shift();
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  for (const name of ["HOME", "TMPDIR", "NODE_ENV"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const child = Bun.spawn(testNetworkArgv(command), { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const stop = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null) child.kill(signal);
  };
  const interrupt = (): void => {
    stop("SIGINT");
  };
  const terminate = (): void => {
    stop("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

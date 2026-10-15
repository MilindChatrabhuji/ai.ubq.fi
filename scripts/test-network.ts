import { existsSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

const systemTool = (name: string): string => {
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

/**
 * Wrap one test child, never the primary or a shared service. The fresh network namespace
 * has only its own loopback and no external routes. Children and Workers inherit it;
 * pathname Unix sockets remain usable. A waiting shell stays PID1 to reap orphaned
 * descendants; Bun cannot serve as namespace init. PID isolation plus kill-child settles
 * descendants when the wrapper exits or is killed. Missing kernel/tool support fails closed.
 * Primary CLI contract: https://man7.org/linux/man-pages/man1/unshare.1.html.
 * Darwin uses inherited Seatbelt endpoint rules plus a task-owned IPC lease guard;
 * unsupported tools/profile syntax fail closed, with no unconfined fallback.
 */
export const testNetworkArgv = (command: readonly string[]): string[] => {
  if (!command.length || !command[0]) throw new Error("A test child command is required");
  const child = [...command];
  if (child[0] === process.execPath || basename(child[0]) === "bun") {
    if (!child.includes("--no-env-file")) child.splice(1, 0, "--no-env-file");
    if (!child.includes("--no-install")) child.splice(1, 0, "--no-install");
  }
  if (process.platform === "darwin") return darwinNetworkArgv(child);
  if (process.platform !== "linux") throw new Error("Local-only test transport requires supported Linux namespaces or Darwin Seatbelt");
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

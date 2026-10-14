import { existsSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

const systemTool = (name: string): string => {
  const path = ["/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/"].map((directory) => directory + name).find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Local-only test transport requires system " + name);
  return path;
};

/**
 * Wrap one test child, never the primary or a shared service. The fresh network namespace
 * has only its own loopback and no external routes. Children and Workers inherit it;
 * pathname Unix sockets remain usable. A waiting shell stays PID1 to reap orphaned
 * descendants; Bun cannot serve as namespace init. PID isolation plus kill-child settles
 * descendants when the wrapper exits or is killed. Missing kernel/tool support fails closed.
 * Primary CLI contract: https://man7.org/linux/man-pages/man1/unshare.1.html.
 * Darwin needs a separately validated local-only Seatbelt profile; no unconfined fallback.
 */
export const testNetworkArgv = (command: readonly string[]): string[] => {
  if (!command.length || !command[0]) throw new Error("A test child command is required");
  if (process.platform !== "linux") throw new Error("Local-only test transport currently requires validated Linux user/network namespaces");
  const child = [...command];
  if (child[0] === process.execPath || basename(child[0]) === "bun") {
    if (!child.includes("--no-env-file")) child.splice(1, 0, "--no-env-file");
    if (!child.includes("--no-install")) child.splice(1, 0, "--no-install");
  }
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

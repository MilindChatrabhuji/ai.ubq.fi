import { test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from "node:fs";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDenoDeployLock } from "../deploy-lock.ts";
import { acquireBunDeployLock } from "../deploy-lock-bun.ts";
import { runOutput, spawnDeno, type DenoCommandHost, type DenoFileInfo, type DenoLockHost } from "../io.ts";

const repository = new URL("../../", import.meta.url).pathname;
/** The modules Sentinel's Deno release bridge evaluates from the pinned driver tree. */
const BRIDGE_ENTRIES = ["ops/vps-release-driver.ts", "ops/vps-release-metrics.ts", "ops/vps-metrics-storage.ts"];
// Sentinel's assertDenoLoadableVpsGraph (ubiquity/sentinel#150) walks literal relative specifiers and refuses any
// reachable file that names a bun: module. This is its specifier pattern with the optional "(" grouped, which
// matches the same text without backtracking.
const MODULE_SPECIFIER = /(?:\bfrom|\bimport)\s*(?:\(\s*)?["']([^"'\n]+)["']/g;
const BUN_ONLY = /["']bun:/;

const resolveSpecifier = (from: string, specifier: string): string => {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") assert.ok(parts.pop() !== undefined, `${from} imports outside the repository`);
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
};
const bridgeGraph = async (): Promise<{ reached: string[]; bunOnly: string[] }> => {
  const seen = new Set<string>(),
    bunOnly: string[] = [],
    pending = [...BRIDGE_ENTRIES];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    const text = await readFile(`${repository}${path}`, "utf8");
    if (BUN_ONLY.test(text)) bunOnly.push(path);
    for (const [, specifier] of text.matchAll(MODULE_SPECIFIER))
      if (specifier.startsWith("./") || specifier.startsWith("../")) pending.push(resolveSpecifier(path, specifier));
  }
  const byName = (left: string, right: string) => left.localeCompare(right);
  return { reached: [...seen].toSorted(byName), bunOnly: bunOnly.toSorted(byName) };
};

test("VPS bridge graph: no module the Deno bridge evaluates names a Bun-only module", async () => {
  const graph = await bridgeGraph();
  for (const path of ["ops/deploy-lock.ts", "ops/io.ts", "ops/vps-release-journal.ts", "ops/vps-release-store.ts"])
    assert.ok(graph.reached.includes(path), `the walk reaches ${path}, so the check is not vacuous`);
  assert.deepEqual(graph.bunOnly, [], "a Deno host refuses the whole pinned driver if any reachable module names a bun: module");
});

const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const fileInfo = (stats: Stats): DenoFileInfo => ({
  isFile: stats.isFile(),
  isSymlink: stats.isSymbolicLink(),
  mode: stats.mode,
  uid: stats.uid,
  dev: stats.dev,
  ino: stats.ino,
});
/** Deno.open follows a final link and FsFile.tryLockSync(true) is flock(LOCK_EX | LOCK_NB); this fake does the same. */
const fakeDeno = (events: string[], uid = process.getuid?.() ?? null): DenoLockHost => ({
  open: (path, options) => {
    events.push(`open ${JSON.stringify(options)}`);
    const descriptor = openSync(path, constants.O_CREAT | constants.O_WRONLY, options.mode);
    return Promise.resolve({
      stat: () => Promise.resolve(fileInfo(fstatSync(descriptor))),
      tryLockSync: (exclusive) => {
        events.push(`tryLock ${String(exclusive)}`);
        return libc.symbols.flock(descriptor, (exclusive ? 2 : 1) | 4) === 0;
      },
      unlockSync: () => {
        events.push("unlock");
        libc.symbols.flock(descriptor, 8);
      },
      close: () => {
        events.push("close");
        closeSync(descriptor);
      },
    });
  },
  lstat: (path) => Promise.resolve(fileInfo(lstatSync(path))),
  uid: () => uid,
});
const settled = async <T>(promise: Promise<T>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, ms);
    }),
  ]);
const withRoot = async (work: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "uos-bridge-lock-"));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const OPENED = `open ${JSON.stringify({ write: true, create: true, mode: 0o600 })}`;

test("VPS bridge host: the Deno deploy lock and the Bun deploy lock exclude each other on one inode", async () => {
  await withRoot(async (root) => {
    const path = join(root, "deploy.lock");
    const events: string[] = [];
    const releaseDeno = await acquireDenoDeployLock(fakeDeno(events), path);
    const bunWaiting = acquireBunDeployLock(path);
    assert.equal(await settled(bunWaiting, 300), false, "the Bun deployment waits while the Deno bridge holds the lock");
    releaseDeno();
    releaseDeno();
    const releaseBun = await bunWaiting;
    assert.deepEqual(events, [OPENED, "tryLock true", "unlock", "close"], "release unlocks and closes exactly once");
    events.length = 0;
    const denoWaiting = acquireDenoDeployLock(fakeDeno(events), path);
    assert.equal(await settled(denoWaiting, 300), false, "the Deno bridge waits while a Bun deployment holds the lock");
    assert.ok(events.filter((event) => event === "tryLock true").length > 1, "the wait polls a non-blocking exclusive lock");
    releaseBun();
    (await denoWaiting)();
    assert.deepEqual(events.slice(-2), ["unlock", "close"]);
  });
});

test("VPS bridge host: the Deno deploy lock refuses a link, a shared mode, another owner and an expired wait", async () => {
  await withRoot(async (root) => {
    const path = join(root, "deploy.lock");
    await writeFile(join(root, "target"), "", { mode: 0o600 });
    await symlink(join(root, "target"), path);
    const refusals: [string, DenoLockHost, string, RegExp][] = [];
    const events: string[] = [];
    refusals.push(["link", fakeDeno(events), path, /private owned regular file/]);
    const shared = join(root, "shared.lock");
    await writeFile(shared, "");
    await chmod(shared, 0o644);
    refusals.push(["shared mode", fakeDeno(events), shared, /private owned regular file/]);
    refusals.push(["another owner", fakeDeno(events, (process.getuid?.() ?? 0) + 1), join(root, "owned.lock"), /private owned regular file/]);
    const replaced = { ...fakeDeno(events), lstat: (entry: string) => Promise.resolve({ ...fileInfo(lstatSync(entry)), ino: lstatSync(entry).ino + 1 }) };
    refusals.push(["replaced entry", replaced, join(root, "replaced.lock"), /private owned regular file/]);
    for (const [name, host, target, refusal] of refusals) {
      events.length = 0;
      await assert.rejects(acquireDenoDeployLock(host, target), refusal, name);
      assert.deepEqual(events, [OPENED, "close"], `${name}: refused before locking and closed`);
    }
    const busy = join(root, "busy.lock");
    const releaseBun = await acquireBunDeployLock(busy);
    try {
      events.length = 0;
      await assert.rejects(acquireDenoDeployLock(fakeDeno(events), busy, 250), /Timed out waiting for the deployment lock/);
      assert.equal(events.at(-1), "close", "an expired wait never holds the lock");
      assert.ok(!events.includes("unlock"));
    } finally {
      releaseBun();
    }
  });
});

test("VPS bridge host: the Deno command runner inherits or replaces the environment and pipes output", async () => {
  const calls: unknown[] = [];
  const host: DenoCommandHost = {
    Command: class {
      constructor(program: string, options: unknown) {
        calls.push([program, options]);
      }
      spawn() {
        return {
          kill: (signal: "SIGKILL") => {
            calls.push(["kill", signal]);
            throw new TypeError("Child process has already terminated");
          },
          output: () => Promise.resolve({ code: 3, stdout: new TextEncoder().encode("out\n"), stderr: new TextEncoder().encode("boom") }),
        };
      }
    },
  };
  const inherited = spawnDeno(host, "git", ["status"], "/repo", undefined);
  assert.deepEqual(await inherited.result, { code: 3, stdout: new TextEncoder().encode("out\n"), stderr: "boom" });
  inherited.kill();
  const sparse = spawnDeno(host, "tar", ["-xf", "a.tar"], undefined, { PATH: "/usr/bin:/bin", TMPDIR: "/release/.uos-command-x" });
  await sparse.result;
  assert.deepEqual(calls, [
    ["git", { args: ["status"], cwd: "/repo", stdin: "null", stdout: "piped", stderr: "piped" }],
    ["kill", "SIGKILL"],
    [
      "tar",
      {
        args: ["-xf", "a.tar"],
        env: { PATH: "/usr/bin:/bin", TMPDIR: "/release/.uos-command-x" },
        clearEnv: true,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      },
    ],
  ]);
});

test("VPS bridge host: the command runner keeps its exit-status contract on the Bun host", async () => {
  assert.deepEqual(await runOutput("/bin/sh", ["-c", "printf 'a\\nb'"]), new TextEncoder().encode("a\nb"));
  await assert.rejects(runOutput("/bin/sh", ["-c", "echo boom >&2; exit 3"]), { message: "/bin/sh failed (3): boom\n" });
});

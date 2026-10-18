import { test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { acquireDenoDeployLock } from "../deploy-lock.ts";
import { acquireBunDeployLock } from "../deploy-lock-bun.ts";
import { runOutput, spawnDeno, type DenoCommandHost, type DenoFileInfo, type DenoLockHost } from "../io.ts";
import * as runtimes from "../bun-runtime.ts";
import type { BunReleaseManifest } from "../release-artifact.ts";
import { vpsTextDigest } from "../vps-release-store.ts";

const repository = new URL("../../", import.meta.url).pathname;
/** The modules Sentinel's Deno release bridge evaluates from the pinned driver tree. */
const BRIDGE_ENTRIES = ["ops/vps-release-driver.ts", "ops/vps-release-metrics.ts", "ops/vps-metrics-storage.ts"];
// Sentinel's assertDenoLoadableVpsGraph (ubiquity/sentinel#150) walks literal relative specifiers and refuses any
// reachable file that names a bun: module. This is its specifier pattern with the optional "(" grouped, which
// matches the same text without backtracking.
const MODULE_SPECIFIER = /(?:\bfrom|\bimport)\s*(?:\(\s*)?["']([^"'\n]+)["']/g;
const BUN_ONLY = /["']bun:/;
const BUN_GLOBAL = /\bBun\./;
// This edge is erased before execution, not a blanket exception for the build script's runtime imports.
const TYPE_ONLY_EDGES = new Set(["ops/native-kv-release.ts:scripts/build-native-kv.ts"]);

const resolveSpecifier = (from: string, specifier: string): string => {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") assert.ok(parts.pop() !== undefined, `${from} imports outside the repository`);
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
};
const bridgeEdges = (path: string, text: string, runtime: boolean) => {
  const edges: { path: string; runtime: boolean }[] = [];
  for (const match of text.matchAll(MODULE_SPECIFIER)) {
    const specifier = match[1];
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
    const target = resolveSpecifier(path, specifier);
    const prefix = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index);
    const typeOnly = TYPE_ONLY_EDGES.has(`${path}:${target}`) && /^\s*import\s+type\b/.test(prefix);
    // Preserve Sentinel's conservative bun: import gate even on erased edges; only global evaluation is exempt.
    edges.push({ path: target, runtime: runtime && !typeOnly });
  }
  return edges;
};
const bridgeGraph = async (extraSource: Record<string, string> = {}): Promise<{ reached: string[]; bunOnly: string[]; bunGlobals: string[] }> => {
  const seen = new Set<string>(),
    evaluated = new Set<string>(),
    bunOnly = new Set<string>(),
    bunGlobals = new Set<string>(),
    pending = BRIDGE_ENTRIES.map((path) => ({ path, runtime: true }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { path, runtime } = next;
    if (seen.has(path) && (!runtime || evaluated.has(path))) continue;
    seen.add(path);
    if (runtime) evaluated.add(path);
    const text = (await readFile(`${repository}${path}`, "utf8")) + (extraSource[path] ?? "");
    if (BUN_ONLY.test(text)) bunOnly.add(path);
    // Only the existing spawn inside the host-selected Bun implementation is allowed. A second use fails.
    const checked = path === "ops/io.ts" ? text.replace(/(const spawnBun = [\s\S]*?const child = )Bun\.spawn\(/, "$1hostSpawn(") : text;
    if (runtime && BUN_GLOBAL.test(checked)) bunGlobals.add(path);
    pending.push(...bridgeEdges(path, text, runtime));
  }
  const byName = (left: string, right: string) => left.localeCompare(right);
  return { reached: [...seen].toSorted(byName), bunOnly: [...bunOnly].toSorted(byName), bunGlobals: [...bunGlobals].toSorted(byName) };
};

test("VPS bridge graph: evaluated modules have no Bun-only imports or unguarded globals", async () => {
  const graph = await bridgeGraph();
  for (const path of ["ops/deploy-lock.ts", "ops/io.ts", "ops/vps-release-journal.ts", "ops/vps-release-store.ts"])
    assert.ok(graph.reached.includes(path), `the walk reaches ${path}, so the check is not vacuous`);
  assert.deepEqual(graph.bunOnly, [], "a Deno host refuses the whole pinned driver if any reachable module names a bun: module");
  assert.deepEqual(graph.bunGlobals, [], "Deno cannot evaluate unguarded Bun globals");
  assert.ok(graph.reached.includes("scripts/build-native-kv.ts"), "the static import gate still covers the explicit type-only edge");
});

test("VPS bridge graph: new globals, including in an allowed host module, and runtime build edges are rejected", async () => {
  for (const path of ["ops/vps-release-journal.ts", "ops/io.ts", "ops/release-artifact.ts"]) {
    assert.deepEqual((await bridgeGraph({ [path]: "\nawait Bun.sleep(100);\n" })).bunGlobals, [path]);
  }
  const graph = await bridgeGraph({ "ops/native-kv-release.ts": '\nimport "../scripts/build-native-kv.ts";\n' });
  assert.ok(graph.bunGlobals.includes("scripts/build-native-kv.ts"), "the type-only exception cannot hide a runtime edge");
  const conservative = await bridgeGraph({ "scripts/build-native-kv.ts": '\nimport "bun:ffi";\n' });
  assert.ok(conservative.bunOnly.includes("scripts/build-native-kv.ts"), "type-only globals never weaken Sentinel's static import gate");
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
/** Deno opens only the safe descriptor alias; FsFile.tryLockSync(true) is flock(LOCK_EX | LOCK_NB). */
const fakeDeno = (events: string[], uid = process.getuid?.() ?? null): DenoLockHost => ({
  open: (path, options) => {
    events.push(`open ${JSON.stringify(options)}`);
    assert.match(path, /^\/dev\/fd\/\d+$/);
    const descriptor = openSync(path, constants.O_WRONLY);
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
const OPENED = `open ${JSON.stringify({ write: true })}`;

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

test("VPS bridge host: the Deno deploy lock refuses a shared mode, another owner and an expired wait", async () => {
  await withRoot(async (root) => {
    const refusals: [string, DenoLockHost, string, RegExp][] = [];
    const events: string[] = [];
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

test("VPS bridge host: final links are refused before Deno opens anything, including dangling links", async () => {
  await withRoot(async (root) => {
    const target = join(root, "target");
    await writeFile(target, "untouched", { mode: 0o600 });
    for (const destination of [target, join(root, "missing")]) {
      const link = join(root, "deploy.lock");
      await symlink(destination, link);
      const events: string[] = [];
      await assert.rejects(acquireDenoDeployLock(fakeDeno(events), link), { code: "ELOOP" });
      assert.deepEqual(events, [], "a final link is refused by the no-follow open, not by a later inode check");
      assert.equal(await readFile(target, "utf8"), "untouched");
      await assert.rejects(readFile(join(root, "missing")), { code: "ENOENT" });
      await rm(link);
    }
  });
});

test("VPS bridge host: denied descriptor handoff closes the no-follow descriptor without a pathname fallback", async () => {
  await withRoot(async (root) => {
    let descriptor = -1;
    const host: DenoLockHost = {
      ...fakeDeno([]),
      open: (alias) => {
        assert.match(alias, /^\/dev\/fd\/\d+$/);
        descriptor = Number(alias.slice(alias.lastIndexOf("/") + 1));
        return Promise.reject(new Error("descriptor access denied"));
      },
    };
    await assert.rejects(acquireDenoDeployLock(host, join(root, "deploy.lock")), /descriptor access denied/);
    assert.throws(() => fstatSync(descriptor), { code: "EBADF" });
  });
});

test("VPS bridge host: a link swapped after the no-follow open never redirects the descriptor handoff", async () => {
  await withRoot(async (root) => {
    const path = join(root, "deploy.lock"),
      target = join(root, "target");
    await writeFile(target, "untouched", { mode: 0o600 });
    const events: string[] = [];
    const host = fakeDeno(events);
    await assert.rejects(
      acquireDenoDeployLock(
        {
          ...host,
          open: async (alias, options) => {
            await rm(path);
            await symlink(target, path);
            return host.open(alias, options);
          },
        },
        path
      ),
      /private owned regular file/
    );
    assert.deepEqual(events, [OPENED, "close"], "the old inode is closed without taking a lock");
    assert.equal(await readFile(target, "utf8"), "untouched");
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

// Bun's own global is non-configurable. Evaluate the real store and runner in a separate realm where it is absent.
const denoStore = async (host: DenoCommandHost, runtime: Record<string, unknown>, payload: Record<string, unknown>, driverRoot: string) => {
  const context = createContext({ Deno: host, process, URL, TextEncoder, TextDecoder, Uint8Array, Error, TypeError, crypto, setTimeout, clearTimeout });
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const modules = new Map<string, Promise<SourceTextModule | SyntheticModule>>();
  const entry = new URL("../vps-release-store.ts", import.meta.url).href;
  const overrides: Partial<Record<string, Record<string, unknown>>> = {
    [new URL("../bun-runtime.ts", import.meta.url).href]: runtime,
    [new URL("../release-artifact.ts", import.meta.url).href]: payload,
  };
  const load = (identifier: string): Promise<SourceTextModule | SyntheticModule> => {
    const existing = modules.get(identifier);
    if (existing) return existing;
    const pending = (async () => {
      const values: Record<string, unknown> | undefined = overrides[identifier] ?? (identifier.startsWith("node:") ? await import(identifier) : undefined);
      if (values)
        return new SyntheticModule(
          Object.keys(values),
          function (this: SyntheticModule) {
            for (const [name, value] of Object.entries(values)) this.setExport(name, value);
          },
          { context, identifier }
        );
      const text = transpiler.transformSync(await readFile(new URL(identifier), "utf8"));
      return new SourceTextModule(text, {
        context,
        identifier,
        initializeImportMeta: (meta) => {
          meta.url = identifier === entry ? pathToFileURL(join(driverRoot, "ops/vps-release-store.ts")).href : identifier;
          meta.main = false;
        },
      });
    })();
    modules.set(identifier, pending);
    return pending;
  };
  const module = await load(entry);
  await module.link((specifier, parent) => load(specifier.startsWith("node:") ? specifier : new URL(specifier, parent.identifier).href));
  await module.evaluate();
  assert.equal("Bun" in context, false);
  return module.namespace as typeof import("../vps-release-store.ts");
};

test("VPS bridge host: default and exported preparation run verified Bun with no calling Bun global", async () => {
  await withRoot(async (root) => {
    const driverRoot = join(root, "driver"),
      configuration = join(driverRoot, "ops/runtime-bunfig.toml"),
      configBytes = await readFile(new URL("../runtime-bunfig.toml", import.meta.url));
    await mkdir(join(driverRoot, "ops"), { recursive: true });
    await writeFile(configuration, configBytes);
    const sha = "a".repeat(40),
      archive = await vpsTextDigest("archive");
    const artifact = runtimes.BUN_RUNTIMES.linux;
    let manifest: BunReleaseManifest = {
      schema: 2,
      git_sha: sha,
      source_archive_sha256: archive,
      source_tree_sha256: "b".repeat(64),
      dependency_lock_sha256: "c".repeat(64),
      dependency_tree_sha256: "d".repeat(64),
      permissions_tree_sha256: "e".repeat(64),
      platform: artifact.platform,
      architecture: artifact.arch,
      runtime: artifact,
    };
    type Options = ConstructorParameters<DenoCommandHost["Command"]>[1];
    const calls: { program: string; options: Options }[] = [];
    let code = 0,
      corruptRuntime = false,
      verifiedBinaries = 0,
      verifiedPayloads = 0;
    const host: DenoCommandHost = {
      Command: class {
        constructor(program: string, options: Options) {
          calls.push({ program, options });
        }
        spawn() {
          return {
            kill: () => {
              throw new Error("unexpected timeout");
            },
            output: () => Promise.resolve({ code, stdout: new Uint8Array(), stderr: new TextEncoder().encode("prepare failed") }),
          };
        }
      },
    };
    const { bindBunVpsPayload, ImmutableVpsReleaseStore } = await denoStore(
      host,
      {
        selectedRuntime: () => artifact,
        runtimePath: runtimes.runtimePath,
        verifyRuntimeBinary: (binary: string, pin: runtimes.RuntimeArtifact) => {
          verifiedBinaries++;
          assert.equal(binary, runtimes.runtimePath(root, artifact));
          assert.equal(pin, artifact);
          return corruptRuntime ? Promise.reject(new Error("corrupt runtime")) : Promise.resolve();
        },
      },
      {
        prepareReleasePayload: () => {
          throw new Error("must not prepare in the Deno caller");
        },
        releaseSourceTree: () => {
          throw new Error("unexpected publication verification");
        },
        verifyReleasePayload: (release: string, revision: string) => {
          verifiedPayloads++;
          assert.ok(release.startsWith(root));
          assert.equal(revision, sha);
          return Promise.resolve(manifest);
        },
      },
      driverRoot
    );
    await mkdir(join(root, ".data/releases"), { recursive: true });
    const store = new ImmutableVpsReleaseStore(root, async (program, args) => {
      if (program === "git") await writeFile(args[2].slice("--output=".length), "archive");
      else {
        const staging = args.at(-1);
        assert.ok(staging);
        await mkdir(join(staging, "src"));
        await writeFile(join(staging, "package.json"), JSON.stringify({ packageManager: "bun@1.4.0" }));
      }
      return "";
    });
    const release = await store.checkedRelease(sha, true);
    assert.equal(release.path, `.data/releases/${sha}`);
    assert.equal(calls.length, 1, "the store default selects the Deno-safe capability");
    const call = calls[0];
    assert.equal(call.program, runtimes.runtimePath(root, artifact));
    assert.deepEqual(Array.from(call.options.args).slice(0, 5), [
      `--config=${configuration}`,
      "--no-env-file",
      "--no-install",
      join(driverRoot, "ops/release-artifact.ts"),
      "prepare",
    ]);
    assert.ok(call.options.args[5].startsWith(`${root}/.data/releases/.staging-`));
    assert.deepEqual(Array.from(call.options.args).slice(6), [sha, archive]);
    assert.equal(call.options.cwd, root);
    assert.equal(call.options.clearEnv, true);
    assert.deepEqual(
      Object.keys(call.options.env ?? {}).sort((left, right) => left.localeCompare(right)),
      ["PATH", "TMPDIR"],
      "no host credentials are inherited"
    );
    assert.equal(verifiedBinaries, 1);
    assert.equal(verifiedPayloads, 1);
    const prepare = bindBunVpsPayload(root);
    assert.deepEqual(await prepare(`${root}/${release.path}`, sha, archive), manifest);
    corruptRuntime = true;
    await assert.rejects(prepare(root, sha, archive), /corrupt runtime/);
    assert.equal(calls.length, 2, "corrupt or missing managed runtimes never spawn a child");
    corruptRuntime = false;
    code = 7;
    await assert.rejects(prepare(root, sha, archive), /failed \(7\): prepare failed/);
    assert.equal(verifiedPayloads, 2, "failed preparation is not treated as a verified payload");
    code = 0;
    manifest = { ...manifest, source_archive_sha256: "f".repeat(64) };
    await assert.rejects(prepare(root, sha, archive), /source archive changed/);
    const previousCalls = calls.length;
    await writeFile(configuration, 'preload = ["./untrusted.ts"]\n');
    await assert.rejects(prepare(root, sha, archive), /Pinned bridge Bun configuration/);
    await rm(configuration);
    await symlink(new URL("../runtime-bunfig.toml", import.meta.url).pathname, configuration);
    await assert.rejects(prepare(root, sha, archive), /Pinned bridge Bun configuration/);
    await rm(configuration);
    await assert.rejects(prepare(root, sha, archive), { code: "ENOENT" });
    assert.equal(calls.length, previousCalls, "corrupt, linked or missing configuration is refused before child execution");
  });
});

test("VPS bridge host: the command runner keeps its exit-status contract on the Bun host", async () => {
  assert.deepEqual(await runOutput("/bin/sh", ["-c", "printf 'a\\nb'"]), new TextEncoder().encode("a\nb"));
  await assert.rejects(runOutput("/bin/sh", ["-c", "echo boom >&2; exit 3"]), { message: "/bin/sh failed (3): boom\n" });
});

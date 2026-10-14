import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openKv } from "#kv";
import { normalizeDependencyLinks } from "../release-artifact.ts";
import { copyOps, copyRuntime, copyRuntimeModules, packageFixture, repository, writePackage } from "./fixture-release.ts";
import { outputFixture, spawnFixture } from "./fixture-process.ts";

const PRODUCTION_ROOT = "/home/codex/repos/ubiquity/ai.ubq.fi";
const FIXTURE_PARENT = fileURLToPath(new URL("../../.cleanup-evidence/vps-release-fixtures", import.meta.url));
const KV_KEY = ["vps-release-fixture"] as const;
const KV_VALUE = "survives-rollback";
const ENV_MARKER = "repository-root";
const TELEMETRY_ORDER = ["shutdownOptionalTelemetry", "kv.close"];
const sha = (digit: string): string => digit.repeat(40);
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const waitFor = async (path: string): Promise<void> => {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error("The actual VPS launcher did not publish its readiness probe");
};
const writeRelease = async (root: string, revision: string, label: string): Promise<void> => {
  const release = root + "/.data/releases/" + revision;
  await mkdir(release + "/src/runtime", { recursive: true });
  await mkdir(release + "/scripts", { recursive: true });
  await mkdir(release + "/ops", { recursive: true });
  await copyOps(release + "/ops");
  await copyRuntimeModules(release);
  for (const name of ["launch-service.ts", "launch-vps.sh"]) await copyFile(repository + "ops/" + name, release + "/ops/" + name);
  const launcher = await readFile(repository + "scripts/serve-vps.ts", "utf8");
  await writeFile(release + "/scripts/serve-vps.ts", "globalThis.fixtureLauncher = " + JSON.stringify(label) + ";\n" + launcher);
  await writePackage(release, { "#kv": "./src/runtime/fixture-kv.ts", "#http": "./src/runtime/fixture-http.ts", "#fixture-dependency": "./dependency.ts" });
  await writeFile(release + "/dependency.ts", "export const label = " + JSON.stringify(label) + ";\n");
  await writeFile(release + "/src/runtime/fixture-kv.ts", 'export { openKv } from "../storage/kv.ts";\n');
  await writeFile(
    release + "/src/runtime/fixture-http.ts",
    'import { serveHttp as actual } from "./http.ts"; export const serveHttp = (options, handler) => actual({ ...options, port: 0 }, handler);\n'
  );
  await writeFile(
    release + "/src/config.ts",
    "export const config = {isDeploy:false,adminTokens:new Set(['fixture-admin'])}; export const runtimeGitSha = () => " + JSON.stringify(revision) + ";\n"
  );
  await writeFile(
    release + "/src/kv.ts",
    `import { writeFileSync } from "node:fs";
    const events = []; export const recordEvent = name => events.push(name);
    export const initializeKv = kv => { const close = kv.close.bind(kv); kv.close = () => {
      recordEvent("kv.close"); writeFileSync(".data/telemetry-order.json", JSON.stringify(events)); close(); }; };\n`
  );
  await writeFile(
    release + "/serve.ts",
    `import assert from "node:assert/strict";
    import { readFileSync, writeFileSync } from "node:fs";
    import { label } from "#fixture-dependency";
    import { recordEvent } from "./src/kv.ts";
    import { runtimeGitSha } from "./src/config.ts";
    export const application = { onListen: address => {
      assert.equal(readFileSync(".env", "utf8"), "VPS_FIXTURE_VALUE=repository-root\\n");
      writeFileSync(".data/allowed.txt", "positive baseline");
      assert.equal(readFileSync(".data/allowed.txt", "utf8"), "positive baseline");
      for (const path of [${JSON.stringify(release + "/dependency.ts")}, ${JSON.stringify(root + "/.data/runtimes/forbidden.txt")}])
        assert.throws(() => writeFileSync(path, "forbidden"), error => ["EACCES", "EPERM", "EROFS"].includes(error.code));
      assert.throws(() => Bun.spawn(["/bin/sh", "-c", "exit 0"]), error => ["EACCES", "EPERM"].includes(error.code));
      writeFileSync(".data/probe.json", JSON.stringify({probe:"vps-release",dependency:label,launcher:globalThis.fixtureLauncher,
        sha:runtimeGitSha(),cwd:process.cwd(),env:process.env.VPS_FIXTURE_VALUE,port:address.port,readonlyMountDenials:true,processDenied:true}));
    }, fetch: () => new Response("fixture-runtime") };
    export const shutdownOptionalTelemetry = async () => recordEvent("shutdownOptionalTelemetry");\n`
  );
  await packageFixture(release, revision, "0".repeat(64));
};
type Probe = {
  dependency: string;
  launcher: string;
  sha: string;
  cwd: string;
  env: string;
  port: number;
  readonlyMountDenials: boolean;
  processDenied: boolean;
};
const runRelease = async (root: string, command: string, revision: string, label: string): Promise<Probe> => {
  await rm(root + "/.data/current", { force: true });
  await symlink("releases/" + revision, root + "/.data/current");
  await rm(root + "/.data/probe.json", { force: true });
  const mount = [
    "set -eu",
    ...["releases", "runtimes"].flatMap((name) => [
      "mount --bind " + quote(root + "/.data/" + name) + " " + quote(root + "/.data/" + name),
      "mount -o remount,bind,ro " + quote(root + "/.data/" + name),
    ]),
    "exec " + command,
  ].join("\n");
  const child = spawnFixture("/usr/bin/unshare", {
    args: ["-Urm", "/bin/sh", "-c", mount],
    cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: root + "/home", TMPDIR: root + "/tmp", DENO_TIMELINE: "production", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  const output = outputFixture(child);
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 20_000);
  try {
    await Promise.race([
      waitFor(root + "/.data/probe.json"),
      output.then((run) => {
        throw new Error(new TextDecoder().decode(run.stderr));
      }),
    ]);
    const probe = JSON.parse(await readFile(root + "/.data/probe.json", "utf8")) as Probe;
    assert.equal(await (await fetch("http://127.0.0.1:" + String(probe.port))).text(), "fixture-runtime");
    child.kill("SIGTERM");
    const result = await output;
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    assert.equal(probe.dependency, label, "the release's own package imports supply its dependency");
    assert.equal(probe.launcher, label, "the selected release supplies the launcher");
    assert.notEqual(probe.launcher, "checkout", "the mutable checkout launcher must never run");
    assert.equal(probe.sha, revision);
    assert.equal(probe.cwd, root);
    assert.equal(probe.env, ENV_MARKER);
    assert.equal(probe.readonlyMountDenials, true);
    assert.equal(probe.processDenied, true);
    assert.deepEqual(JSON.parse(await readFile(root + "/.data/telemetry-order.json", "utf8")), TELEMETRY_ORDER);
    return probe;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await output;
  }
};
test("VPS releases execute their own launcher, config, and lockfile across rollback", async () => {
  assert.equal(process.platform, "linux", "This actual-unit fixture requires Linux ARM64 user namespaces");
  assert.equal(process.arch, "arm64");
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const root = await realpath(await mkdtemp(FIXTURE_PARENT + "/case-"));
  try {
    for (const name of [".data/releases", "ops", "home", "tmp"]) await mkdir(root + "/" + name, { recursive: true });
    await copyRuntime(root);
    await copyFile(repository + "ops/launch-vps.sh", root + "/ops/launch-vps.sh");
    await writePackage(root, { "#fixture-dependency": "./dependency.ts" });
    await writeFile(root + "/dependency.ts", 'export const label = "checkout";\n');
    await mkdir(root + "/scripts");
    await writeFile(root + "/scripts/serve-vps.ts", 'throw new Error("checkout launcher must never run");\n');
    await writeFile(root + "/.env", "VPS_FIXTURE_VALUE=repository-root\n");
    const kv = await openKv(root + "/.data/kv-bun.sqlite3");
    await kv.set(KV_KEY, KV_VALUE);
    kv.close();
    const unit = await readFile(new URL("../ai-ubq-fi.service", import.meta.url), "utf8");
    assert.match(unit, /^ReadOnlyPaths=.*\/\.data\/releases$/m);
    assert.match(unit, /^ReadOnlyPaths=.*\/\.data\/runtimes$/m);
    const exec = /^ExecStart=(.+)$/m.exec(unit)?.[1];
    assert(exec);
    const command = exec.replaceAll(PRODUCTION_ROOT, root);
    assert.equal(command, "/bin/sh " + root + "/ops/launch-vps.sh");
    await writeRelease(root, sha("a"), "release-a");
    await writeRelease(root, sha("b"), "release-b");
    const first = await runRelease(root, command, sha("a"), "release-a");
    await runRelease(root, command, sha("b"), "release-b");
    const second = await runRelease(root, command, sha("a"), "release-a");
    assert.deepEqual({ ...second, port: 0 }, { ...first, port: 0 }, "reselecting A reproduces all release markers");
    await writeFile(root + "/package.json", "invalid mutable checkout configuration");
    await writeFile(root + "/bun.lock", "invalid mutable checkout lockfile");
    const rollback = await runRelease(root, command, sha("a"), "release-a");
    assert.deepEqual({ ...rollback, port: 0 }, { ...first, port: 0 }, "rollback ignores broken checkout configuration and lock");
    const reopened = await openKv(root + "/.data/kv-bun.sqlite3");
    assert.equal((await reopened.get(KV_KEY)).value, KV_VALUE);
    reopened.close();
    console.log(JSON.stringify({ actualUnit: true, readonlyBindMounts: true, nativeConfinement: true, rollback: true, childrenSettled: true }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("legacy rollback requires proof of latest stopped Bun state and preserves the frozen launcher profile", async () => {
  const { verifyLegacyRollback } = await import("../verify-legacy-rollback.ts");
  const { digest } = await import("../io.ts");
  const shell = await readFile(new URL("../launch-vps.sh", import.meta.url), "utf8");
  assert(shell.includes("50435a214d34cb7fbae3735a0a0502f8d96aaa3257dc502edc01bd64a8429ca7"));
  assert(shell.includes("6563f11090766cc784361bc71a0c9c244bfa41c0f0e2163355a1f558000d3d44"));
  assert(shell.includes("verify-legacy-rollback.ts"));
  assert(shell.includes('exec /usr/local/bin/deno run --config="$uos_release/deno.json" --lock="$uos_release/deno.lock" --frozen'));
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const root = await realpath(await mkdtemp(FIXTURE_PARENT + "/latest-state-"));
  try {
    await mkdir(root + "/.data");
    await verifyLegacyRollback(root);
    const source = root + "/.data/kv-bun.sqlite3";
    const destination = root + "/.data/kv.sqlite3";
    const receiptPath = root + "/.data/bun-rollback-receipt.json";
    await writeFile(source, "latest stopped Bun fixture bytes");
    await writeFile(destination, "reverse-converted fixture bytes");
    const receipt = {
      schema: "uos-kv-runtime-conversion-v1",
      direction: "bun-to-deno",
      source: {
        path: source,
        codec: "bun-jsc-v1",
        file: { sha256: digest(await readFile(source)) },
        snapshot: { wal: "absent", drain_boundary: "checkpointed-no-wal" },
      },
      destination: { path: destination, codec: "deno-v8", file: { sha256: digest(await readFile(destination)) } },
    };
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    await verifyLegacyRollback(root);
    const active = await readFile(root + "/.data/legacy-rollback-active.json");
    await verifyLegacyRollback(root);
    assert.deepEqual(await readFile(root + "/.data/legacy-rollback-active.json"), active);
    const corrupt = async (candidate: typeof receipt, corruption: string): Promise<void> => {
      if (corruption === "source-write") await writeFile(source, "newer durable Bun writes");
      if (corruption === "wal-write") await writeFile(source + "-wal", "newer WAL writes");
      if (corruption === "direction") candidate.direction = "deno-to-bun";
      if (corruption === "codec") candidate.source.codec = "deno-v8";
      if (corruption === "drain") candidate.source.snapshot.drain_boundary = "uncheckpointed";
      if (corruption === "destination-write") await writeFile(destination, "changed destination");
    };
    for (const corruption of ["source-write", "wal-write", "direction", "codec", "drain", "destination-write", "receipt-symlink", "receipt-mode"] as const) {
      await rm(root + "/.data/legacy-rollback-active.json", { force: true });
      await writeFile(source, "latest stopped Bun fixture bytes");
      await writeFile(destination, "reverse-converted fixture bytes");
      await rm(source + "-wal", { force: true });
      await rm(receiptPath, { force: true });
      const candidate = structuredClone(receipt);
      await corrupt(candidate, corruption);
      await writeFile(receiptPath, JSON.stringify(candidate), { mode: corruption === "receipt-mode" ? 0o644 : 0o600 });
      if (corruption === "receipt-mode") await chmod(receiptPath, 0o644);
      if (corruption === "receipt-symlink") {
        await rm(receiptPath);
        await writeFile(receiptPath + ".saved", JSON.stringify(candidate), { mode: 0o600 });
        await symlink(receiptPath + ".saved", receiptPath);
      }
      await assert.rejects(verifyLegacyRollback(root), Error, corruption + " must never restore stale legacy state");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable dependency directory aliases remain valid after normalization and reject unsafe graphs before mutation", async () => {
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const root = await realpath(await mkdtemp(FIXTURE_PARENT + "/cache-alias-"));
  try {
    for (const scenario of ["valid", "outside", "dangling", "cycle", "ancestor", "symlink-root"] as const) {
      const graph = root + "/" + scenario;
      const dependencies = graph + "/node_modules";
      const target = dependencies + "/.bun-cache/reflect-metadata@0.2.2@@@1";
      const alias = dependencies + "/.bun-cache/reflect-metadata/0.2.2@@@1";
      await mkdir(target, { recursive: true });
      await mkdir(dependencies + "/.bun-cache/reflect-metadata");
      await writeFile(target + "/payload.txt", "immutable dependency payload");
      await symlink(target, alias);
      assert.equal(await readFile(alias + "/payload.txt", "utf8"), "immutable dependency payload", "positive readable directory alias baseline");
      const original = await readlink(alias);
      if (scenario === "valid") {
        await normalizeDependencyLinks(dependencies);
        assert.equal((await readlink(alias)).startsWith("/"), false);
        assert.equal(await realpath(alias), target);
        assert.equal(await readFile(alias + "/payload.txt", "utf8"), "immutable dependency payload");
        continue;
      }
      if (scenario === "outside") {
        await mkdir(graph + "/outside");
        await symlink(graph + "/outside", dependencies + "/bad");
      } else if (scenario === "dangling") await symlink(dependencies + "/missing", dependencies + "/bad");
      else if (scenario === "cycle") {
        await symlink("bad-two", dependencies + "/bad");
        await symlink("bad", dependencies + "/bad-two");
      } else if (scenario === "ancestor") await symlink(dependencies, dependencies + "/bad");
      else {
        await rm(alias);
        await rm(dependencies, { recursive: true });
        await mkdir(graph + "/physical");
        await symlink(graph + "/physical", dependencies);
      }
      await assert.rejects(normalizeDependencyLinks(dependencies), Error, scenario + " must be refused before publication");
      if (scenario !== "symlink-root") assert.equal(await readlink(alias), original, "all links are validated before any normalization writes");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { strict as assert } from "node:assert";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { macSandboxProfile } from "./macos-sandbox.ts";
import { digest } from "./io.ts";
import { constants, Database } from "bun:sqlite";
import { withMacSqliteTemp } from "./mac-sqlite-temp.ts";

if (process.platform !== "darwin") throw new Error("Mac containment acceptance requires an actual macOS kernel");
const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || arguments_.some((argument) => !argument.startsWith("--native-kv-binding="))) throw new Error("Unexpected Mac acceptance argument");
const nativeBindingText = arguments_.length ? arguments_[0].slice("--native-kv-binding=".length) : null;
const root = await realpath(await mkdtemp(join(tmpdir(), "uos-bun-seatbelt-")));
try {
  const release = join(root, ".data/releases", "1".repeat(40));
  const runtime = join(root, ".data/runtimes/bun/bun");
  const nativeHome = join(root, "selected-native-home");
  const control = join(root, "physical-control");
  const sibling = join(root, "other-native-home");
  for (const directory of [release, join(root, ".data/runtimes/bun"), nativeHome, control, sibling]) await mkdir(directory, { recursive: true });
  await copyFile(await realpath(process.execPath), runtime);
  await chmod(runtime, 0o700);
  await writeFile(join(nativeHome, "auth.json"), "synthetic-selected-auth");
  await writeFile(join(sibling, "auth.json"), "synthetic-unrelated-auth");
  await writeFile(join(release, "immutable.txt"), "immutable-source");
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, root_metadata_probe: "unreadable" }));
  await writeFile(join(root, ".env"), "PRIVATE_VALUE=synthetic-root-secret\n");
  await writeFile(join(root, "config.json"), "synthetic-ungranted-root-config");
  const database = join(root, ".data/codec.sqlite3");
  const codec = new Database(database);
  codec.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  codec.run("PRAGMA journal_mode=WAL");
  codec.run("CREATE TABLE uos_kv_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
  codec.run("INSERT INTO uos_kv_metadata VALUES ('codec','bun-jsc-v1')");
  codec.close(true);
  await mkdir(join(release, "src/storage"), { recursive: true });
  await copyFile(new URL("../src/storage/sqlite-readonly.ts", import.meta.url), join(release, "src/storage/sqlite-readonly.ts"));
  const readonlyImport = "import { inspectSqliteReadOnly } from " + JSON.stringify("file://" + join(release, "src/storage/sqlite-readonly.ts")) + ";";
  const before = digest(await readFile(runtime));
  const probe = join(release, "probe.ts");
  const denialProbe = join(release, "denial-probe.ts");
  await writeFile(
    denialProbe,
    [
      'import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";',
      readonlyImport,
      "const paths = JSON.parse(process.argv[2]);",
      "const operation = Number(process.argv[3]);",
      'if (operation < 4) writeFileSync([paths.nativeHome + "/auth.json", paths.sibling + "/auth.json", paths.release + "/immutable.txt", paths.runtime][operation], "must-be-denied");',
      'else if (operation === 4) readFileSync(paths.sibling + "/auth.json");',
      'else if (operation === 5) Bun.spawnSync([paths.runtime, "--no-env-file", "--no-install", "-e", "process.exit(0)"]);',
      'else if (operation === 6) Bun.spawnSync(["/bin/sh", "-c", "exit 0"]);',
      'else if (operation === 7) readFileSync(paths.root + "/config.json");',
      'else if (operation === 8) readFileSync(paths.root + "/package.json");',
      'else if (operation === 9) writeFileSync(paths.root + "/outside-data.txt", "must-be-denied");',
      "else if (operation === 10) readdirSync(paths.ancestor);",
      'else { try { inspectSqliteReadOnly(paths.database, db => { const value = db.query("SELECT value FROM uos_kv_metadata WHERE key=\'codec\'").get().value; writeFileSync(paths.database + "-wal", ""); return value; }); } finally { rmSync(paths.database + "-wal", { force: true }); } }',
    ].join("\n")
  );
  await writeFile(
    probe,
    [
      'import { readFileSync, readdirSync, writeFileSync } from "node:fs";',
      readonlyImport,
      "const paths = JSON.parse(process.argv[2]);",
      "const operation = Number(process.argv[3]);",
      'if (operation === 0 && readFileSync(paths.nativeHome + "/auth.json", "utf8") !== "synthetic-selected-auth") throw new Error("selected auth mismatch");',
      'else if (operation === 1) writeFileSync(paths.root + "/.data/mutable.txt", "accepted");',
      'else if (operation === 2) writeFileSync(paths.control + "/state", "accepted");',
      'else if (operation === 3) { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("seatbelt-network") }); if (await (await fetch(server.url)).text() !== "seatbelt-network") throw new Error("network mismatch"); await server.stop(); }',
      'else if (operation === 4) { process.chdir(paths.root); if (process.cwd() !== paths.root) throw new Error("canonical cwd mismatch"); }',
      'else if (operation === 5 && !readdirSync(paths.root).includes(".data")) throw new Error("root directory names unavailable");',
      'else if (operation === 6 && readFileSync(paths.root + "/.env", "utf8") !== "PRIVATE_VALUE=synthetic-root-secret\\n") throw new Error("explicit dotenv read mismatch");',
      'else if (operation === 7 && inspectSqliteReadOnly(paths.database, db => db.query("SELECT value FROM uos_kv_metadata WHERE key=\'codec\'").get().value) !== "bun-jsc-v1") throw new Error("stopped WAL codec mismatch");',
    ].join("\n")
  );
  const profile = macSandboxProfile({ root, release, runtime, nativeHome, control });
  const paths = JSON.stringify({ root, release, runtime, nativeHome, control, sibling, database, ancestor: dirname(root) });
  for (let operation = 0; operation < 12; operation += 1) {
    const denied = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, runtime, "--no-env-file", "--no-install", denialProbe, paths, String(operation)], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.notEqual(denied.exitCode, 0, `denial probe ${operation} unexpectedly succeeded`);
  }
  for (let operation = 0; operation < 8; operation += 1) {
    const allowed = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, runtime, "--no-env-file", "--no-install", probe, paths, String(operation)], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(allowed.exitCode, 0, `allowed probe ${operation} failed: ${allowed.stderr.toString()}`);
  }
  if (nativeBindingText !== null) {
    const { verifiedTestNativeKvBinding } = await import("../scripts/test-native-kv.ts");
    const binding = verifiedTestNativeKvBinding(nativeBindingText);
    const repository = fileURLToPath(new URL("../", import.meta.url));
    await cp(join(repository, "src/storage"), join(release, "src/storage"), { recursive: true });
    await mkdir(join(release, "node_modules/@deno"), { recursive: true });
    await cp(join(repository, "node_modules/@deno/kv"), join(release, "node_modules/@deno/kv"), { recursive: true, dereference: true });
    await cp(binding.artifactDirectory, join(release, ".native/kv"), { recursive: true });
    const inputsManifest = join(release, "inputs-darwin-arm64.json");
    await copyFile(binding.inputsManifest, inputsManifest);
    const confinedBinding = { artifactDirectory: join(release, ".native/kv"), expectedProvenanceSha256: binding.expectedProvenanceSha256, inputsManifest };
    await writeFile(join(release, "package.json"), JSON.stringify({ type: "module" }));
    const nativeProbe = join(release, "native-probe.ts");
    await writeFile(
      nativeProbe,
      [
        'import assert from "node:assert/strict";',
        'import { prepareNativeKvBackend, openKv } from "./src/storage/kv.ts";',
        "prepareNativeKvBackend(" + JSON.stringify(confinedBinding) + ");",
        "const kv = await openKv(" + JSON.stringify(join(root, ".data/native.sqlite3")) + ");",
        "const phase = process.argv[2];",
        "try {",
        'if (phase === "seed") { let op = kv.atomic(); for (let i = 0; i < 32; i++) op = op.set(["spill", i], new Uint8Array(16384)); assert.equal((await op.commit()).ok, true); }',
        'else if (phase === "revisions") { const versions = []; for (let i = 0; i < 32; i++) versions.push((await kv.get(["spill", i])).versionstamp); console.log(JSON.stringify(versions)); }',
        'else if (phase === "write") { let op = kv.atomic().set(["partial"], true); for (let i = 0; i < 32; i++) op = op.set(["spill", i], new Uint8Array(16384).fill(1)); assert.equal((await op.set(["quota"], { reserved: 1 }).commit()).ok, true); }',
        'else if (phase === "rollback" || phase === "committed") { const committed = phase === "committed"; const versions = committed ? null : JSON.parse(process.argv[3]); for (let i = 0; i < 32; i++) { const row = await kv.get(["spill", i]); if (versions) assert.equal(row.versionstamp, versions[i]); assert.equal(row.value.byteLength, 16384); assert(row.value.every(byte => byte === (committed ? 1 : 0))); } assert.equal((await kv.get(["partial"])).value, committed ? true : null); assert.deepEqual((await kv.get(["quota"])).value, committed ? { reserved: 1 } : null); }',
        'else { const round = Number(phase); const previous = await kv.get(["confined-native"]); assert.deepEqual(previous.value, round === 1 ? null : { round: 1 }); await kv.set(["confined-native"], { round }); assert.deepEqual((await kv.get(["confined-native"])).value, { round }); }',
        "} finally { kv.close(); }",
      ].join("\n")
    );
    await withMacSqliteTemp(root, (sqliteTemp) => {
      const nativeProfile = profile + "\n(deny network*)";
      const runNative = (phase: string, privateTemp = true, versions = "") =>
        Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", nativeProfile, runtime, "--no-env-file", "--no-install", nativeProbe, phase, versions], {
          cwd: root,
          env: { PATH: "/usr/bin:/bin", TMPDIR: "/private/tmp", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...(privateTemp ? { SQLITE_TMPDIR: sqliteTemp } : {}) },
          stdout: "pipe",
          stderr: "pipe",
        });
      const expectNative = (phase: string): void => {
        const opened = runNative(phase);
        assert.equal(opened.exitCode, 0, `persistent native KV ${phase} failed: ${opened.stderr.toString()}`);
      };
      for (const phase of ["1", "2", "seed"]) expectNative(phase);
      const snapshot = runNative("revisions");
      assert.equal(snapshot.exitCode, 0, snapshot.stderr.toString());
      const failed = runNative("write", false);
      assert.notEqual(failed.exitCode, 0, "unbound native SQLite spill unexpectedly succeeded");
      assert.match(failed.stderr.toString(), /no such savepoint: denokv_atomic_write/);
      const rollback = runNative("rollback", true, snapshot.stdout.toString());
      assert.equal(rollback.exitCode, 0, rollback.stderr.toString());
      expectNative("write");
      expectNative("committed");
      return Promise.resolve();
    });
  }
  assert.equal(digest(await readFile(runtime)), before);
  assert.equal(await readFile(join(nativeHome, "auth.json"), "utf8"), "synthetic-selected-auth");
  assert.equal(await readFile(join(release, "immutable.txt"), "utf8"), "immutable-source");
  console.log(
    JSON.stringify({
      selected_auth_read: true,
      data_write: true,
      control_write: true,
      sibling_read_denied: true,
      native_write_denied: true,
      release_runtime_write_denied: true,
      runtime_self_execution_denied: true,
      shell_execution_denied: true,
      canonical_cwd: true,
      root_listing: true,
      existing_root_dotenv_read: true,
      root_contents_denied: true,
      root_write_denied: true,
      ancestor_listing_denied: true,
      stopped_wal_codec_read: true,
      readonly_sidecar_race_refused: true,
      native_persistent_startup_and_restart: nativeBindingText !== null,
      native_temp_spill_failure_rollback_and_private_path_success: nativeBindingText !== null,
      real_http: true,
    })
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

import { test } from "bun:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { currentTestNativeKvBinding, createTestNativeKvPreload, parseTestNativeKvBinding, type TestNativeKvBinding } from "./test-native-kv.ts";
import { testNetworkArgv } from "./test-network.ts";
import { verifyNativeKvArtifact } from "../src/storage/native-addon.ts";
import { openKv, KvU64 } from "../src/storage/kv.ts";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = (): string => {
  const directory = join(ROOT, ".cleanup-evidence", "native-kv-tests");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(directory, "run-"));
};
const run = async (argv: string[]): Promise<{ code: number; output: string }> => {
  const child = Bun.spawn(testNetworkArgv(argv), {
    env: { PATH: process.env.PATH ?? "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
};

test("parent-bound preload performs native typed CRUD, CAS, arithmetic and expiry", async () => {
  const binding = currentTestNativeKvBinding();
  assert.equal(verifyNativeKvArtifact(binding).provenanceSha256, binding.expectedProvenanceSha256);
  const kv = await openKv(":memory:");
  try {
    await kv.set(["typed"], { bytes: new Uint8Array([1, 255]), date: new Date(123), amount: 9n });
    assert.deepEqual((await kv.get(["typed"])).value, { bytes: new Uint8Array([1, 255]), date: new Date(123), amount: 9n });
    await kv.set(["counter"], new KvU64(5n));
    const before = await kv.get<KvU64>(["counter"]);
    assert.equal((await kv.atomic().check(before).sum(["counter"], 2n).commit()).ok, true);
    assert.equal((await kv.atomic().check(before).delete(["counter"]).commit()).ok, false);
    assert.equal((await kv.get<KvU64>(["counter"])).value?.value, 7n);
  } finally {
    kv.close();
  }
});

test("invalid native bindings fail before a child can write a database", async () => {
  const directory = scratch();
  const original = currentTestNativeKvBinding();
  try {
    const copied = join(directory, "artifact");
    cpSync(original.artifactDirectory, copied, { recursive: true, dereference: false });
    const preload = createTestNativeKvPreload(directory);
    const database = join(directory, "must-not-exist.sqlite3");
    const file = join(directory, "failure.test.ts");
    writeFileSync(
      file,
      `import { openKv } from ${JSON.stringify(new URL("../src/storage/kv.ts", import.meta.url).href)};\nconst kv = await openKv(${JSON.stringify(database)}); kv.close();\n`
    );
    const reject = async (binding?: TestNativeKvBinding, load = true): Promise<void> => {
      const argv = [process.execPath, "--no-env-file", "--no-install", "test"];
      if (binding !== undefined) argv.push("--define", "UOS_TEST_NATIVE_KV_BINDING:" + JSON.stringify(binding));
      if (load) argv.push("--preload", preload);
      argv.push(file);
      const result = await run(argv);
      assert.equal(result.code, 1, result.output);
      assert.equal(existsSync(database), false);
    };
    await reject();
    await reject(original, false);
    await reject({ ...original, expectedProvenanceSha256: "0".repeat(64) });
    assert.throws(() => parseTestNativeKvBinding({ artifactDirectory: copied }));
    const binding = { ...original, artifactDirectory: copied };
    const provenance = join(copied, "native-kv.provenance.json");
    const bytes = readFileSync(provenance);
    writeFileSync(provenance, Buffer.concat([bytes, Buffer.from(" ")]));
    writeFileSync(join(copied, "adjacent-selfhash.txt"), createHash("sha256").update(readFileSync(provenance)).digest("hex"));
    await reject(binding);
    writeFileSync(provenance, bytes);
    const native = join(copied, "native-kv.node");
    const nativeBytes = readFileSync(native);
    const changed = Buffer.from(nativeBytes);
    changed[0] ^= 1;
    writeFileSync(native, changed);
    await reject(binding);
    writeFileSync(native, nativeBytes);
    const unsupported = JSON.parse(bytes.toString()) as { artifact: { platform: string; napiVersion: number } };
    unsupported.artifact.napiVersion = 999;
    const unsupportedBytes = Buffer.from(JSON.stringify(unsupported));
    writeFileSync(provenance, unsupportedBytes);
    await reject({ ...binding, expectedProvenanceSha256: createHash("sha256").update(unsupportedBytes).digest("hex") });
    unsupported.artifact.napiVersion = 4;
    unsupported.artifact.platform = "unsupported-fixture-platform";
    const wrongPlatform = Buffer.from(JSON.stringify(unsupported));
    writeFileSync(provenance, wrongPlatform);
    await reject({ ...binding, expectedProvenanceSha256: createHash("sha256").update(wrongPlatform).digest("hex") });
    writeFileSync(provenance, bytes);
    rmSync(provenance);
    symlinkSync(join(original.artifactDirectory, "native-kv.provenance.json"), provenance);
    await reject(binding);
    rmSync(provenance);
    writeFileSync(provenance, bytes);
    rmSync(native);
    symlinkSync(join(original.artifactDirectory, "native-kv.node"), native);
    await reject(binding);
    const linked = join(directory, "linked");
    symlinkSync(original.artifactDirectory, linked);
    await reject({ ...original, artifactDirectory: linked });
    const inputs = join(directory, "inputs.json");
    writeFileSync(inputs, "{}\n");
    await reject({ ...original, inputsManifest: inputs });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("VPS discovery includes bound release and first-cutover suites exactly once without preparing again", async () => {
  const builds = join(ROOT, ".cleanup-evidence/native-kv-builds");
  mkdirSync(builds, { recursive: true });
  const before = readdirSync(builds).sort((left, right) => left.localeCompare(right));
  const result = await run([process.execPath, "--no-env-file", "--no-install", join(ROOT, "scripts/test-runner.ts"), "vps", "--list"]);
  assert.equal(result.code, 0, result.output);
  const groups = JSON.parse(result.output) as { files: string[] }[];
  assert.equal(groups.length, 1);
  assert.equal(groups[0].files.length, process.platform === "linux" ? 9 : 8);
  for (const name of [
    "vps-release-driver.test.ts",
    "vps-release-recovery.test.ts",
    "vps-release-metrics.test.ts",
    "vps-metrics-join.test.ts",
    "vps-journal-reader.test.ts",
    "vps-bridge-host.test.ts",
    "first-bun-cutover.test.ts",
  ]) {
    assert.equal(groups[0].files.filter((path) => path.endsWith(name)).length, 1);
    const focused = await run([process.execPath, "--no-env-file", "--no-install", join(ROOT, "scripts/test-runner.ts"), "vps", "ops/tests/" + name, "--list"]);
    assert.equal(focused.code, 0, focused.output);
    const selected = JSON.parse(focused.output) as { files: string[] }[];
    assert.deepEqual(selected[0].files, ["ops/tests/" + name]);
  }
  const unknown = await run([process.execPath, "--no-env-file", "--no-install", join(ROOT, "scripts/test-runner.ts"), "vps", "ops/tests/unknown.test.ts"]);
  assert.equal(unknown.code, 1, unknown.output);
  assert.match(unknown.output, /excluded or unknown/);
  assert.deepEqual(
    readdirSync(builds).sort((left, right) => left.localeCompare(right)),
    before
  );
});

test("one real parent build is reused across files and separate original profile processes", async () => {
  const binding = currentTestNativeKvBinding();
  const directory = scratch();
  const builds = join(ROOT, ".cleanup-evidence/native-kv-builds");
  mkdirSync(builds, { recursive: true });
  const before = readdirSync(builds).sort((left, right) => left.localeCompare(right));
  try {
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "tests"));
    writeFileSync(join(directory, "bun.lock"), "{}\n");
    writeFileSync(join(directory, "scripts/test-runner.ts"), readFileSync(join(ROOT, "scripts/test-runner.ts")));
    for (const name of ["test-network.ts", "test-native-kv.ts"]) symlinkSync(join(ROOT, "scripts", name), join(directory, "scripts", name));
    for (const name of ["one.test.ts", "two.test.ts", "usage-optimization-measurement.test.ts"]) {
      writeFileSync(
        join(directory, "tests", name),
        `import { test, expect } from "bun:test";\nimport { openKv } from ${JSON.stringify(new URL("../src/storage/kv.ts", import.meta.url).href)};\ntest("native reused", async () => { const kv=await openKv(":memory:"); try { await kv.set(["value"], "real"); expect((await kv.get(["value"])).value).toBe("real"); } finally {kv.close();} });\n`
      );
    }
    const argument = "--native-kv-binding=" + JSON.stringify(binding);
    const main = await run([
      process.execPath,
      "--no-env-file",
      "--no-install",
      join(directory, "scripts/test-runner.ts"),
      "main",
      "tests/one.test.ts",
      "tests/two.test.ts",
      argument,
    ]);
    assert.equal(main.code, 0, main.output);
    assert.match(main.output, /2 files, 0 failures/);
    const measurement = await run([
      process.execPath,
      "--no-env-file",
      "--no-install",
      join(directory, "scripts/test-runner.ts"),
      "measurement",
      "tests/usage-optimization-measurement.test.ts",
      argument,
    ]);
    assert.equal(measurement.code, 0, measurement.output);
    assert.deepEqual(
      readdirSync(builds).sort((left, right) => left.localeCompare(right)),
      before,
      "Reused profiles must not invoke another producer"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native TTL persists its exact deadline and does not expire before it", async () => {
  // SDK contract permits additional visibility after expiry; it promises no early deletion.
  const directory = scratch();
  const path = join(directory, "expiry.sqlite3");
  const kv = await openKv(path);
  try {
    const before = Date.now();
    await kv.set(["expiry"], "leased", { expireIn: 5000 });
    const after = Date.now();
    const database = new Database(path, { readonly: true });
    try {
      const row = database.query<{ expiration_ms: number }, []>("SELECT expiration_ms FROM kv WHERE expiration_ms > 0").get();
      assert.ok(row !== null);
      assert.ok(row.expiration_ms >= before + 5000 && row.expiration_ms <= after + 5000);
      assert.equal((await kv.get(["expiry"])).value, "leased");
    } finally {
      database.close(true);
    }
  } finally {
    kv.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

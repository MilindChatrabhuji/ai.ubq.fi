import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testNetworkArgv } from "../scripts/test-network.ts";

const ROOT = resolve(import.meta.dirname, "..");
const supported = process.platform === "linux" && process.arch === "arm64";

const fixture = (override: boolean): { directory: string; checkout: string; temporary: string; caller: string; toolchain: string } => {
  const root = join(ROOT, ".cleanup-evidence", "native-kv-scratch-tests");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(root, "run-"));
  const checkout = join(directory, "checkout");
  const temporary = join(directory, "inherited-temp");
  const caller = join(directory, "caller");
  for (const path of [join(checkout, "scripts"), join(checkout, "tools", "native-kv"), temporary, caller]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  copyFileSync(join(ROOT, "scripts", "build-native-kv.ts"), join(checkout, "scripts", "build-native-kv.ts"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "tools", "native-kv", "inputs.json"), "utf8")) as {
    artifact: { target: string };
    toolchain: { rustcSha256: string; cargoSha256: string };
  };
  const toolchain = override
    ? join(directory, "custom-toolchain")
    : join(directory, "home", ".rustup", "toolchains", `stable-${manifest.artifact.target}`, "bin");
  mkdirSync(toolchain, { recursive: true, mode: 0o700 });
  const compiler =
    '#!/bin/sh\nprintf child-temp > "$TMPDIR/child-temp-proof"\nprintf "TMPDIR=%s\\nCARGO_HOME=%s\\nCARGO_TARGET_DIR=%s\\n" "$TMPDIR" "$CARGO_HOME" "$CARGO_TARGET_DIR"\nexit 7\n';
  const cargo = "#!/bin/sh\nexit 9\n";
  writeFileSync(join(toolchain, "rustc"), compiler, { mode: 0o700 });
  writeFileSync(join(toolchain, "cargo"), cargo, { mode: 0o700 });
  manifest.toolchain.rustcSha256 = createHash("sha256").update(compiler).digest("hex");
  manifest.toolchain.cargoSha256 = createHash("sha256").update(cargo).digest("hex");
  writeFileSync(join(checkout, "tools", "native-kv", "inputs.json"), JSON.stringify(manifest));
  return { directory, checkout, temporary, caller, toolchain };
};

const run = async (state: ReturnType<typeof fixture>, entry: string, args: string[] = []): Promise<{ code: number; output: string }> => {
  const child = Bun.spawn(testNetworkArgv([process.execPath, "--no-env-file", "--no-install", entry, ...args]), {
    cwd: state.caller,
    env: { PATH: process.env.PATH ?? "", HOME: join(state.directory, "home"), TMPDIR: state.temporary, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
};

const scratchRoot = (state: ReturnType<typeof fixture>): string => join(state.directory, "retained-builds");
const retainedWorkspace = (state: ReturnType<typeof fixture>, root: string, before: readonly string[]): void => {
  assert.equal(existsSync(root), true, "The private temporary root must own the retained workspace");
  const entries = readdirSync(root);
  const created = entries.filter((entry) => !before.includes(entry));
  assert.equal(created.length, 1, "The build must retain exactly its task-owned workspace");
  assert.match(created[0], /^uos-native-kv-/);
  const workspace = join(root, created[0]);
  assert.equal(lstatSync(workspace).isDirectory(), true);
  assert.equal(lstatSync(join(workspace, "tmp")).isDirectory(), true);
  assert.equal(lstatSync(join(workspace, "tmp")).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(workspace, "tmp", "child-temp-proof"), "utf8"), "child-temp");
  const log = readFileSync(join(workspace, "build.log"), "utf8");
  for (const [name, path] of [
    ["TMPDIR", join(workspace, "tmp")],
    ["CARGO_HOME", join(workspace, "cargo-home")],
    ["CARGO_TARGET_DIR", join(workspace, "target")],
  ]) {
    assert.ok(log.includes(`${name}=${path}\n`), log);
  }
  assert.deepEqual(readdirSync(state.temporary), [], "Inherited TMPDIR must not receive a retained native build");
};

test.skipIf(!supported)("native builder retains scratch in its checkout for an explicit output and toolchain override", async () => {
  const state = fixture(true);
  try {
    const driver = join(state.checkout, "scripts", "scratch-driver.ts");
    const output = join(state.directory, "explicit-artifact-output");
    writeFileSync(
      driver,
      `import { buildNativeKv } from "./build-native-kv.ts";\nawait buildNativeKv(process.argv[2], { toolchainDirectory: process.argv[3], workspaceDirectory: process.argv[4] });\n`
    );
    const before = existsSync(scratchRoot(state)) ? readdirSync(scratchRoot(state)) : [];
    const result = await run(state, driver, [output, state.toolchain, join(state.directory, "retained-builds")]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Native KV command failed \(7\)/);
    assert.equal(existsSync(output), true, "The explicit artifact destination remains unchanged");
    retainedWorkspace(state, scratchRoot(state), before);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test.skipIf(!supported)("native builder CLI scratch ignores caller cwd and inherited TMPDIR", async () => {
  const state = fixture(false);
  try {
    const cliRoot = join(state.checkout, ".tmp/native-kv-builds");
    const before = existsSync(cliRoot) ? readdirSync(cliRoot) : [];
    const result = await run(state, join(state.checkout, "scripts", "build-native-kv.ts"));
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Native KV command failed \(7\)/);
    assert.equal(existsSync(join(state.checkout, ".tmp", "native-kv")), true, "The CLI artifact destination remains unchanged");
    retainedWorkspace(state, cliRoot, before);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

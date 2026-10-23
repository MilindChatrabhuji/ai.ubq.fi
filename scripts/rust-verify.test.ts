import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeRustPlan,
  DARWIN_NESTED_SANDBOX_CASES,
  executeDarwinNativeTests,
  executeDarwinNativeImportTests,
  NATIVE_IMPORT_CASES,
  parseRustArguments,
  planRustVerification as planRustVerificationForHost,
  runCommand,
  rustNativeTarget,
  rustCiComponents,
  rustSourceTarget,
  rustToolPath,
  rustVerificationEnvironment,
  verifyWorkerArtifact,
  type RustCommand,
  type CommandRunner,
  type RustStage,
} from "./rust-verify.ts";

const temporary = mkdtempSync(join(tmpdir(), "uos-rust-gate-contract-"));
const linux = { platform: "linux", arch: "arm64" };
const darwin = { platform: "darwin", arch: "arm64" };
const planRustVerification = (root: string, paths: readonly string[], stage: RustStage, complete = false, host = linux) =>
  planRustVerificationForHost(root, paths, stage, complete, host);
afterAll(() => {
  rmSync(temporary, { recursive: true, force: true });
});
const fixture = (): string => {
  const root = mkdtempSync(join(temporary, "workspace-"));
  mkdirSync(join(root, "rust/crates/gateway-core/tests"), { recursive: true });
  mkdirSync(join(root, "rust/crates/gateway-worker/src"), { recursive: true });
  mkdirSync(join(root, "rust/crates/gateway-native/src"), { recursive: true });
  writeFileSync(join(root, "rust/Cargo.toml"), '[workspace]\nmembers=["crates/gateway-core","crates/gateway-worker","crates/gateway-native"]\n');
  writeFileSync(join(root, "rust/Cargo.lock"), "version = 4\n");
  writeFileSync(join(root, "rust/crates/gateway-core/Cargo.toml"), '[package]\nname="gateway-core"\n');
  writeFileSync(
    join(root, "rust/crates/gateway-worker/Cargo.toml"),
    '[package]\nname="gateway-worker"\n[dependencies]\ngateway-core={path="../gateway-core"}\n'
  );
  writeFileSync(
    join(root, "rust/crates/gateway-native/Cargo.toml"),
    '[package]\nname="gateway-native"\n[dependencies]\ngateway-core={path="../gateway-core"}\n'
  );
  writeFileSync(join(root, "rust/crates/gateway-core/tests/contracts.rs"), "#[test]\nfn source_contract() {}\n");
  return root;
};

test("Rust source selects its real Cargo reverse dependencies without a native companion in WASM", () => {
  const root = fixture();
  const paths = ["rust/crates/gateway-core/src/lib.rs"];
  assert.deepEqual(planRustVerification(root, paths, "native").packages, ["gateway-core", "gateway-native", "gateway-worker"]);
  const wasm = planRustVerification(root, paths, "wasm");
  assert.deepEqual(wasm.packages, ["gateway-core", "gateway-worker"]);
  assert.equal(wasm.commands.at(-1)?.cwd, join(root, "rust/crates/gateway-worker"));
  assert.deepEqual(wasm.commands.at(-1)?.argv, ["worker-build", "--release", "--locked"]);
  assert.ok(
    wasm.commands
      .filter((command) => command.argv[0] === "cargo" && command.argv[1] !== "fmt")
      .every((command) => command.argv.includes("--locked") && command.argv.includes("--offline"))
  );
});

test("plan retains fmt, clippy, native tests and the Worker build without a redundant cargo check", () => {
  const root = fixture();
  const paths = ["rust/crates/gateway-core/src/lib.rs"];
  const packageFlags = (command: RustCommand): string[] => {
    const names: string[] = [];
    command.argv.forEach((value, index) => {
      if (value === "-p") names.push(command.argv[index + 1]);
    });
    return names;
  };
  const native = planRustVerification(root, paths, "native");
  const nativeFmt = native.commands.filter((command) => command.argv[0] === "cargo" && command.argv[1] === "fmt");
  const nativeClippy = native.commands.filter((command) => command.argv[0] === "cargo" && command.argv[1] === "clippy");
  assert.equal(nativeFmt.length, 1);
  const nativeFmtCommand = nativeFmt[0];
  assert.ok(nativeFmtCommand);
  assert.deepEqual(nativeFmtCommand.argv, ["cargo", "fmt", "--all", "--", "--check"]);
  assert.equal(nativeClippy.length, 1);
  const nativeClippyCommand = nativeClippy[0];
  assert.ok(nativeClippyCommand);
  assert.deepEqual(packageFlags(nativeClippyCommand), native.packages);
  assert.deepEqual(nativeClippyCommand.argv.slice(-4), ["--all-targets", "--", "-D", "warnings"]);
  assert.deepEqual(native.testPackages, ["gateway-core"]);
  const nativeTests = native.commands.filter((command) => command.testListing === true || command.testRun === true);
  assert.equal(nativeTests.length, 2);
  assert.ok(nativeTests.every((command) => command.argv[0] === "cargo" && command.argv[1] === "test" && packageFlags(command).includes("gateway-core")));
  assert.ok(native.commands.every((command) => command.argv[0] !== "cargo" || command.argv[1] !== "check"));

  const wasm = planRustVerification(root, paths, "wasm");
  const wasmFmt = wasm.commands.filter((command) => command.argv[0] === "cargo" && command.argv[1] === "fmt");
  const wasmClippy = wasm.commands.filter((command) => command.argv[0] === "cargo" && command.argv[1] === "clippy");
  assert.equal(wasmFmt.length, 1);
  const wasmFmtCommand = wasmFmt[0];
  assert.ok(wasmFmtCommand);
  assert.deepEqual(wasmFmtCommand.argv, ["cargo", "fmt", "--all", "--", "--check"]);
  assert.equal(wasmClippy.length, 1);
  const wasmClippyCommand = wasmClippy[0];
  assert.ok(wasmClippyCommand);
  assert.deepEqual(packageFlags(wasmClippyCommand), wasm.packages);
  assert.deepEqual(wasmClippyCommand.argv.slice(-4), ["--lib", "--", "-D", "warnings"]);
  assert.equal(wasm.buildWorker, true);
  assert.equal(wasm.testPackages.length, 0);
  assert.deepEqual(wasm.commands.at(-1)?.argv, ["worker-build", "--release", "--locked"]);
  assert.ok(wasm.commands.every((command) => command.argv[0] !== "cargo" || command.argv[1] !== "check"));
});

test("native command and test targets follow the actual supported host while WASM stays portable", () => {
  const root = fixture();
  const paths = ["rust/crates/gateway-core/src/lib.rs"];
  for (const [host, expected] of [
    [linux, "aarch64-unknown-linux-gnu"],
    [darwin, "aarch64-apple-darwin"],
  ] as const) {
    assert.equal(rustNativeTarget(host), expected);
    const native = planRustVerification(root, paths, "native", false, host);
    const compiled = native.commands.filter((command) => command.argv.includes("--target"));
    assert.equal(compiled.length, 3);
    assert.ok(compiled.every((command) => command.argv[command.argv.indexOf("--target") + 1] === expected));
    assert.ok(native.commands.some((command) => command.testListing));
    const wasm = planRustVerification(root, paths, "wasm", false, host);
    assert.ok(wasm.commands.filter((command) => command.argv.includes("--target")).every((command) => command.argv.includes("wasm32-unknown-unknown")));
    assert.ok(!wasm.packages.includes("gateway-native"));
  }
  for (const host of [
    { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "x64" },
    { platform: "win32", arch: "arm64" },
  ])
    assert.throws(() => planRustVerification(root, paths, "native", false, host), /supported Darwin or Linux ARM64/);
});

test("Mac tools bind to the prepared toolchain and cannot fall back to ambient binaries or escaped links", () => {
  const task = mkdtempSync(join(temporary, "prepared-"));
  const bin = join(task, "rustup/toolchains/1.98.1-aarch64-apple-darwin/bin");
  const tools = join(task, "tools/bin");
  const ambient = mkdtempSync(join(temporary, "ambient-"));
  for (const directory of [bin, tools]) mkdirSync(directory, { recursive: true });
  for (const name of ["rustc", "rustdoc", "cargo"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  for (const directory of [tools, ambient]) writeFileSync(join(directory, "worker-build"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const environment = rustVerificationEnvironment(
    {
      HOME: "/fixture-account",
      PATH: `${ambient}:${tools}:/usr/bin:/bin`,
      RUSTUP_HOME: join(task, "rustup"),
      CARGO_HOME: join(task, "cargo"),
      CARGO_TARGET_DIR: join(task, "target"),
      XDG_CACHE_HOME: join(task, "cache"),
    },
    darwin
  );
  assert.equal(environment.RUSTC, join(bin, "rustc"));
  assert.equal(environment.RUSTDOC, join(bin, "rustdoc"));
  assert.equal(environment.RUSTUP_TOOLCHAIN, "1.98.1-aarch64-apple-darwin");
  assert.ok(!environment.PATH.split(":").includes(ambient));
  assert.equal(rustToolPath("cargo", environment, darwin), join(bin, "cargo"));
  assert.equal(rustToolPath("worker-build", environment, darwin), join(tools, "worker-build"));
  rmSync(join(tools, "worker-build"));
  assert.throws(() => rustToolPath("worker-build", environment, darwin), /no ambient tool fallback/);
  symlinkSync(join(ambient, "worker-build"), join(tools, "worker-build"));
  assert.throws(() => rustToolPath("worker-build", environment, darwin), /no ambient tool fallback/);
  assert.equal(rustToolPath("cargo", environment, linux), "cargo");
});

test("source identities cannot share Mac build-script provenance targets", () => {
  const sha = "1".repeat(40);
  const tree = "2".repeat(40);
  const target = rustSourceTarget(temporary, sha, tree);
  assert.notEqual(target, rustSourceTarget(temporary, "3".repeat(40), tree));
  assert.notEqual(target, rustSourceTarget(temporary, sha, "4".repeat(40)));
  assert.throws(() => rustSourceTarget(temporary, "HEAD", tree), /full source\/tree identity/);
  assert.throws(() => rustSourceTarget("relative", sha, tree), /absolute path/);
});

test("the actual Worker build launcher reaches dotenv refusal on the supported host before any compiler", () => {
  const root = mkdtempSync(join(temporary, "launcher-"));
  mkdirSync(join(root, "ops"));
  const script = join(root, "ops/rust-worker-build.sh");
  copyFileSync(join(import.meta.dir, "../ops/rust-worker-build.sh"), script);
  writeFileSync(join(root, ".env"), "");
  const result = Bun.spawnSync(["/bin/bash", script], { cwd: root, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 1);
  const expected = process.arch === "arm64" ? /isolated build checkout without automatically discovered dotenv/ : /prepared Darwin or Linux ARM64 host/;
  assert.match(result.stderr.toString(), expected);
});

test("package-local changes stay scoped while lock/tooling changes select every member", () => {
  const root = fixture();
  assert.deepEqual(planRustVerification(root, ["rust/crates/gateway-worker/src/lib.rs"], "native").packages, ["gateway-worker"]);
  assert.deepEqual(planRustVerification(root, ["rust/Cargo.lock"], "native").packages, ["gateway-core", "gateway-native", "gateway-worker"]);
  assert.deepEqual(planRustVerification(root, ["scripts/rust-verify.ts"], "native").testPackages, ["gateway-core"]);
  assert.throws(() => planRustVerification(root, ["rust/crates/unregistered/src/lib.rs"], "native"), /no registered Cargo member/);
});

test("portable runtime crates outside the Worker closure receive scoped native tests and WASM checks", () => {
  const root = fixture();
  const runtimes = ["gateway-admin-runtime", "gateway-routing-runtime"];
  const members = ["gateway-core", "gateway-worker", "gateway-native", ...runtimes];
  const memberPaths = members.map((name) => `crates/${name}`);
  writeFileSync(join(root, "rust/Cargo.toml"), `[workspace]\nmembers=${JSON.stringify(memberPaths)}\n`);
  for (const name of runtimes) {
    const directory = join(root, "rust/crates", name);
    mkdirSync(join(directory, "tests"), { recursive: true });
    writeFileSync(join(directory, "Cargo.toml"), `[package]\nname="${name}"\n[dependencies]\ngateway-core={path="../gateway-core"}\n`);
    writeFileSync(join(directory, "tests/contracts.rs"), "#[test]\nfn runtime_contract() {}\n");
  }
  for (const name of runtimes) {
    const paths = [`rust/crates/${name}/src/lib.rs`];
    const native = planRustVerification(root, paths, "native");
    assert.deepEqual(native.packages, [name]);
    assert.deepEqual(native.testPackages, [name]);
    const wasm = planRustVerification(root, paths, "wasm");
    assert.deepEqual(wasm.packages, [name]);
    assert.deepEqual(wasm.testPackages, []);
    for (const command of wasm.commands.filter((command) => ["check", "clippy"].includes(command.argv[1] ?? ""))) {
      assert.ok(command.argv.includes(name));
      assert.ok(!command.argv.includes("gateway-native"));
    }
  }
  const wasm = planRustVerification(root, ["rust/Cargo.lock"], "wasm");
  assert.deepEqual(wasm.packages, ["gateway-admin-runtime", "gateway-core", "gateway-routing-runtime", "gateway-worker"]);
});

test("ordinary documentation is not Rust execution and complete documentation jobs retain zero selected tests", () => {
  const root = fixture();
  assert.throws(() => planRustVerification(root, ["rust/README.md"], "native"), /No Rust work selected/);
  const complete = planRustVerification(root, ["rust/README.md"], "native", true);
  assert.equal(complete.testPackages.length, 0);
  assert.ok(complete.commands.length > 0);
});

test("missing frozen lock and malformed workspace refuse a plan instead of skipped success", () => {
  const root = fixture();
  rmSync(join(root, "rust/Cargo.lock"));
  assert.throws(() => planRustVerification(root, ["rust/Cargo.toml"], "native"), /Cargo.lock is required/);
  writeFileSync(join(root, "rust/Cargo.lock"), "version = 4\n");
  writeFileSync(join(root, "rust/Cargo.toml"), '[workspace]\nmembers=["crates/*"]\n');
  assert.throws(() => planRustVerification(root, ["rust/Cargo.toml"], "native"), /explicit, nonempty member paths/);
});

test("gate runner refuses empty plans, nonzero child status and zero tests", async () => {
  const root = fixture();
  const plan = planRustVerification(root, ["rust/crates/gateway-core/src/lib.rs"], "native");
  await assert.rejects(
    executeRustPlan({ ...plan, packages: [] }, {}, () => Promise.resolve({ code: 0, stdout: "", stderr: "" })),
    /empty plan/
  );
  await assert.rejects(
    executeRustPlan(plan, {}, () => Promise.resolve({ code: 7, stdout: "", stderr: "fixture exit" })),
    /failed \(7\)/
  );
  await assert.rejects(
    executeRustPlan(plan, {}, () => Promise.resolve({ code: 0, stdout: "", stderr: "" })),
    /listed zero tests/
  );
  let calls = 0;
  const count = await executeRustPlan(plan, {}, (command) => {
    calls++;
    let stdout = "";
    if (command.testListing) stdout = "source_contract: test\n";
    if (command.testRun) stdout = "test result: ok. 1 passed; 0 failed; 0 ignored;\n";
    return Promise.resolve({
      code: 0,
      stdout,
      stderr: "",
    });
  });
  assert.equal(count, 1);
  assert.equal(calls, plan.commands.length);
  await assert.rejects(
    executeRustPlan(plan, {}, (command) =>
      Promise.resolve({
        code: 0,
        stdout: command.testListing ? "source_contract: test\n" : "test result: ok. 0 passed; 0 failed;\n",
        stderr: "",
      })
    ),
    /executed zero passing tests/
  );
});

test("real child nonzero status is preserved without running a Rust compiler", async () => {
  const command: RustCommand = { argv: [process.execPath, "--no-env-file", "--no-install", "-e", "process.exit(7)"], cwd: temporary };
  assert.equal((await runCommand(command, { PATH: process.env.PATH ?? "" })).code, 7);
});

test("artifact validation rejects absent, invalid and wrong-source generated WASM", () => {
  const root = fixture();
  const sha = "1".repeat(40);
  assert.throws(() => verifyWorkerArtifact(root, sha));
  const build = join(root, "rust/crates/gateway-worker/build");
  mkdirSync(build);
  writeFileSync(join(build, "index.js"), 'import wasm from "./index_bg.wasm"; export default wasm;\n');
  writeFileSync(join(build, "index_bg.wasm"), "not WASM");
  assert.throws(() => verifyWorkerArtifact(root, sha), /Invalid generated/);
  // A tiny controlled WASM validates the validator, not gateway behavior or Rust compilation.
  const identity = Buffer.from(`cloudflare-${sha}`);
  const bytes = Buffer.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    5,
    3,
    1,
    0,
    1,
    7,
    10,
    1,
    6,
    109,
    101,
    109,
    111,
    114,
    121,
    2,
    0,
    0,
    identity.length + 1,
    0,
    ...identity,
  ]);
  writeFileSync(join(build, "index_bg.wasm"), bytes);
  assert.equal(verifyWorkerArtifact(root, sha).length, 2);
  assert.throws(() => verifyWorkerArtifact(root, "2".repeat(40)), /exact source identity/);
});

test("Rust CLI refuses ambiguous preparation and unknown stages", () => {
  assert.deepEqual(parseRustArguments(["--list", "--stage", "wasm"]), { stage: "wasm", prepare: false, list: true });
  assert.deepEqual(parseRustArguments(["--prepare-ci", "native"]), { stage: "native", prepare: true, list: false });
  for (const args of [["--stage"], ["--stage", "other"], ["--list", "--prepare-ci", "wasm"], ["native", "wasm"]])
    assert.throws(() => parseRustArguments(args), /usage:/);
});

test("a native companion cannot enter the Worker dependency closure", () => {
  const root = fixture();
  writeFileSync(
    join(root, "rust/crates/gateway-worker/Cargo.toml"),
    '[package]\nname="gateway-worker"\n[dependencies]\ngateway-native={path="../gateway-native"}\n'
  );
  assert.throws(() => planRustVerification(root, ["rust/crates/gateway-worker/src/lib.rs"], "wasm"), /native-only package/);
});

test("a native-only test dependency stays outside the Worker library but remains an affected-test edge", () => {
  const root = fixture();
  writeFileSync(
    join(root, "rust/crates/gateway-worker/Cargo.toml"),
    '[package]\nname="gateway-worker"\n[dependencies]\ngateway-core={path="../gateway-core"}\n[target.\'cfg(not(target_arch = "wasm32"))\'.dev-dependencies]\ngateway-native={path="../gateway-native"}\n'
  );
  assert.deepEqual(planRustVerification(root, ["rust/crates/gateway-worker/src/lib.rs"], "wasm").packages, ["gateway-worker"]);
  assert.deepEqual(planRustVerification(root, ["rust/crates/gateway-native/src/lib.rs"], "native").packages, ["gateway-native", "gateway-worker"]);
});

test("the reviewed native-only NORMAL target edge stays outside WASM but remains a native reverse dependency", () => {
  const root = fixture();
  writeFileSync(
    join(root, "rust/crates/gateway-worker/Cargo.toml"),
    '[package]\nname="gateway-worker"\n[dependencies]\ngateway-core={path="../gateway-core"}\n[target.\'cfg(all(unix, not(target_arch = "wasm32")))\'.dependencies]\ngateway-native={path="../gateway-native"}\n'
  );
  assert.deepEqual(planRustVerification(root, ["rust/crates/gateway-worker/src/lib.rs"], "wasm").packages, ["gateway-worker"]);
  assert.deepEqual(planRustVerification(root, ["rust/crates/gateway-native/src/lib.rs"], "native").packages, ["gateway-native", "gateway-worker"]);
});

test("native target BUILD edges remain conservative for host-target semantics", () => {
  const root = fixture();
  writeFileSync(
    join(root, "rust/crates/gateway-worker/Cargo.toml"),
    '[package]\nname="gateway-worker"\n[target.\'cfg(all(unix, not(target_arch = "wasm32")))\'.build-dependencies]\ngateway-native={path="../gateway-native"}\n'
  );
  assert.throws(() => planRustVerification(root, ["rust/crates/gateway-worker/src/lib.rs"], "wasm"), /native-only package/);
});

test("WASM-applicable and unknown target predicates cannot hide a native Worker dependency", () => {
  for (const selector of [
    'cfg(target_arch = "wasm32")',
    'cfg(feature = "native-only")',
    'cfg(all(unix, not(target_arch = "wa sm32")))',
    'cfg(all(unix, not(target_arch = "wasm32"), new_predicate))',
  ]) {
    const root = fixture();
    writeFileSync(
      join(root, "rust/crates/gateway-worker/Cargo.toml"),
      `[package]\nname="gateway-worker"\n[target.'${selector}'.dependencies]\ngateway-native={path="../gateway-native"}\n`
    );
    assert.throws(() => planRustVerification(root, ["rust/crates/gateway-worker/src/lib.rs"], "wasm"), /native-only package/);
  }
});

test("isolated Rust children preserve account HOME and isolate ambient Git configuration", () => {
  const source = {
    HOME: "/home/build-account",
    PATH: "/usr/bin:/bin",
    CARGO_HOME: join(temporary, "rust-cargo"),
    RUSTUP_HOME: join(temporary, "rust-rustup"),
    CARGO_TARGET_DIR: join(temporary, "rust-target"),
    XDG_CACHE_HOME: join(temporary, "rust-cache"),
    GIT_CONFIG_GLOBAL: "/private/ambient-git-config",
    GIT_CONFIG_SYSTEM: "/private/system-git-config",
    GIT_CONFIG_NOSYSTEM: "0",
    UNLISTED_CREDENTIAL_PROBE: "fixture-only",
  };
  const environment = rustVerificationEnvironment(source, linux);
  assert.equal(environment.HOME, source.HOME);
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(environment.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(environment.CARGO_NET_OFFLINE, "true");
  assert.equal(environment.UNLISTED_CREDENTIAL_PROBE, undefined);
  assert.throws(() => rustVerificationEnvironment({ ...source, HOME: undefined }, linux), /explicit inherited absolute HOME/);
  assert.throws(() => rustVerificationEnvironment({ ...source, HOME: "relative-home" }, linux), /explicit inherited absolute HOME/);
});

const ownedChildCases = [
  "existing_account_import::foundation_tests::actual_owned_async_child_stop_wait_and_dirty_epoch_do_not_infer_external_absence",
  "existing_account_import::foundation_tests::actual_owned_child_reap_records_stopped_but_reopened_marker_grants_no_lease",
];
const nativeArtifacts = () => {
  const root = fixture();
  writeFileSync(join(root, "rust/Cargo.toml"), readFileSync(join(root, "rust/Cargo.toml"), "utf8") + '[workspace.package]\nversion="0.1.0"\n');
  const task = mkdtempSync(join(temporary, "darwin-artifacts-"));
  const sha = "1".repeat(40);
  const tree = "2".repeat(40);
  const target = rustSourceTarget(join(task, "target"), sha, tree);
  const bin = join(task, "rustup/toolchains/1.98.1-aarch64-apple-darwin/bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["cargo", "rustc", "rustdoc"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const directory = join(root, "rust/crates/gateway-native");
  const manifest = join(directory, "Cargo.toml");
  const artifact = (name: string, kind: string, test: boolean) => {
    const sourcePaths: Record<string, string> = { test: `tests/${name}.rs`, example: "tests/support/connector_fixture.rs", lib: "src/lib.rs" };
    const source = join(directory, sourcePaths[kind] ?? `src/bin/${name}.rs`);
    const runtimePath = kind === "example" ? `examples/${name}` : name;
    const executable = join(target, "aarch64-apple-darwin/debug", test ? `deps/${name}-exact-cargo-hash` : runtimePath);
    mkdirSync(join(source, ".."), { recursive: true });
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(source, test ? "#[test]\nfn selected_source_case() {}\n" : "// synthetic Cargo source\n");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    return {
      reason: "compiler-artifact",
      manifest_path: manifest,
      package_id: `path+file://${realpathSync(manifest).slice(0, -11)}#0.1.0`,
      target: { name, kind: [kind], src_path: source, doctest: kind === "lib" },
      profile: { test },
      executable,
    };
  };
  const prerequisites = ["uos-native", "uos-native-connector", "uos-native-request", "uos-native-supervisor"].map((name) => artifact(name, "bin", false));
  prerequisites.push(artifact("uos-native-connector-fixture", "example", false));
  const selected = [
    artifact("gateway_native", "lib", true),
    artifact("uos-native", "bin", true),
    artifact("connector_fd", "test", true),
    artifact("connector_process", "test", true),
    artifact("connector_confinement", "test", true),
  ];
  const prelaunch = selected.at(-1);
  assert.ok(prelaunch);
  const library = selected[0];
  const libraryNames = [...ownedChildCases, "ordinary_library_case", ownedChildCases[0] + "_neighbor"];
  const environment = {
    HOME: task,
    PATH: bin,
    RUSTUP_HOME: join(task, "rustup"),
    CARGO_HOME: join(task, "cargo"),
    CARGO_TARGET_DIR: target,
    XDG_CACHE_HOME: join(task, "cache"),
    UNLISTED_CREDENTIAL_PROBE: "must-not-inherit",
  };
  const calls: RustCommand[] = [];
  const json = (artifacts: unknown[]) => [...artifacts, { reason: "build-finished", success: true }].map((value) => JSON.stringify(value)).join("\n");
  const runtimeOutput = (command: RustCommand): string => {
    if (command.argv.includes("--lib") || command.argv[0] === library.executable) {
      const exact = command.argv[0] === library.executable ? libraryNames.find((name) => command.argv.includes(name)) : undefined;
      let names = exact ? [exact] : libraryNames;
      if (command.argv.includes("--skip")) {
        const skipped = command.argv.flatMap((value, index) => (command.argv[index - 1] === "--skip" ? [value] : []));
        names = names.filter((name) => !skipped.includes(name));
      }
      return command.argv.includes("--list")
        ? names.map((name) => name + ": test\n").join("")
        : `test result: ok. ${names.length} passed; 0 failed; 0 ignored;\n`;
    }
    return command.argv.includes("--list") ? "exact_selected: test\n" : "test result: ok. 1 passed; 0 failed; 0 ignored;\n";
  };
  const run: CommandRunner = (command, inherited) => {
    calls.push(command);
    assert.equal(inherited.UNLISTED_CREDENTIAL_PROBE, undefined);
    let stdout: string;
    if (command.argv[0] === "git") {
      stdout = "";
      if (command.argv[1] === "rev-parse") stdout = command.argv[2] === "HEAD" ? sha : tree;
    } else if (command.argv[1] === "build") stdout = json(prerequisites);
    else if (command.argv.includes("--no-run")) stdout = json(command.argv.includes("--test") ? [library, prelaunch] : selected);
    else stdout = runtimeOutput(command);
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  };
  return { root, cwd: join(root, "rust"), environment, calls, run, json, selected, prerequisites, prelaunch, library, libraryNames };
};

test("Darwin native packages alone select the source-bound prelaunch split; Linux and WASM keep their policies", () => {
  const fixture = nativeArtifacts();
  const paths = ["rust/crates/gateway-native/tests/connector_confinement.rs"];
  for (const host of [darwin, linux]) {
    const plan = planRustVerification(fixture.root, paths, "native", false, host);
    assert.deepEqual(plan.testPackages, ["gateway-native"]);
    assert.equal(plan.commands.filter((command) => command.darwinNativeTests).length, host === darwin ? 1 : 0);
    assert.ok(plan.commands.every((command) => command.isolated));
    if (host === linux) assert.equal(plan.commands.filter((command) => command.testListing === true || command.testRun === true).length, 2);
  }
  assert.ok(
    !planRustVerification(fixture.root, ["rust/crates/gateway-core/src/lib.rs"], "wasm", false, darwin).commands.some((command) => command.darwinNativeTests)
  );
});

test("Darwin exact emitted inventory runs each lib/bin/test plus doctests once without broad unconfined Cargo", async () => {
  const fixture = nativeArtifacts();
  assert.equal(await executeDarwinNativeTests(fixture.cwd, fixture.environment, "package", fixture.run), 7);
  const unconfined = fixture.calls.filter((command) => command.argv[0] !== "git" && !command.isolated);
  assert.equal(unconfined.length, 6);
  assert.equal(unconfined.filter((command) => command.argv[0] === fixture.prelaunch.executable).length, 2);
  for (const name of ownedChildCases) {
    const exact = unconfined.filter((command) => command.argv[0] === fixture.library.executable && command.argv.includes(name));
    assert.equal(exact.length, 2);
    assert.ok(exact.every((command) => command.argv.includes("--exact")));
  }
  const normal = fixture.calls.filter(
    (command) => command.argv[1] === "test" && !command.argv.includes("--no-run") && !command.argv.includes("--doc") && !command.argv.includes("--lib")
  );
  assert.equal(normal.length, 2);
  for (const command of normal) {
    assert.ok(command.isolated);
    assert.ok(!command.argv.includes("--lib"));
    for (const name of ["uos-native", "connector_fd", "connector_process"]) assert.equal(command.argv.filter((value) => value === name).length, 1);
    assert.ok(!command.argv.includes("connector_confinement"));
  }
  assert.equal(fixture.calls.filter((command) => command.argv.includes("--doc")).length, 2);
  assert.ok(fixture.calls.findIndex((command) => command.argv[1] === "build") < fixture.calls.findIndex((command) => command.argv.includes("--no-run")));
});

test("nested-sandbox tests are excluded from the outer profile and run once directly", async () => {
  const fixture = nativeArtifacts();
  fixture.libraryNames.push(...DARWIN_NESTED_SANDBOX_CASES);
  assert.equal(await executeDarwinNativeTests(fixture.cwd, fixture.environment, "package", fixture.run), 9);
  const wrapped = fixture.calls.filter((command) => command.isolated && command.argv.includes("--skip") && !command.argv.includes("--list"));
  const skipped = (command: RustCommand) => command.argv.flatMap((value, index) => (command.argv[index - 1] === "--skip" ? [value] : []));
  assert.equal(wrapped.length, 1);
  const wrappedCommand = wrapped[0];
  assert.ok(wrappedCommand);
  for (const name of DARWIN_NESTED_SANDBOX_CASES) assert.ok(skipped(wrappedCommand).includes(name));
  const direct = fixture.calls.filter((command) => !command.isolated && command.argv[0] === fixture.library.executable && !command.argv.includes("--list"));
  for (const name of DARWIN_NESTED_SANDBOX_CASES) assert.equal(direct.filter((command) => command.argv.includes(name)).length, 1);
});

test("Darwin runtime TMPDIR is private outside compiler/cache ancestry and is cleaned on success or failure", async () => {
  for (const fail of [false, true]) {
    const fixture = nativeArtifacts();
    const inherited = { ...fixture.environment, TMPDIR: join(fixture.root, "compiler-tmp") };
    const original = rustVerificationEnvironment(inherited, darwin);
    const directories = new Set<string>();
    const run: CommandRunner = (command, environment) => {
      if (command.argv[0] === "git" || command.argv[1] === "build" || command.argv.includes("--no-run")) assert.deepEqual(environment, original);
      else {
        const directory = environment.TMPDIR;
        directories.add(directory);
        assert.equal(directory, realpathSync(directory));
        assert.equal(join(directory, ".."), realpathSync("/tmp"));
        const info = lstatSync(directory);
        assert.ok(info.isDirectory());
        assert.equal(info.uid, process.getuid?.());
        assert.equal(info.mode & 0o777, 0o700);
        assert.deepEqual({ ...environment, TMPDIR: original.TMPDIR }, original);
        if (fail && command.argv[0] === fixture.prelaunch.executable) throw new Error("fixed runtime failure");
      }
      return fixture.run(command, environment);
    };
    if (fail) await assert.rejects(executeDarwinNativeTests(fixture.cwd, inherited, "package", run), /fixed runtime failure/);
    else assert.equal(await executeDarwinNativeTests(fixture.cwd, inherited, "package", run), 7);
    assert.equal(directories.size, 1);
    for (const directory of directories) assert.equal(existsSync(directory), false);
  }
});

test("focused internal acceptance compiles and executes only the exact prelaunch target with all its cases", async () => {
  const fixture = nativeArtifacts();
  assert.equal(await executeDarwinNativeTests(fixture.cwd, fixture.environment, "prelaunch", fixture.run), 3);
  const compile = fixture.calls.find((command) => command.argv.includes("--no-run"));
  assert.ok(compile?.isolated);
  assert.ok(compile.argv.includes("--lib") && compile.argv.includes("--test") && compile.argv.includes("connector_confinement"));
  assert.ok(!fixture.calls.some((command) => command.argv.includes("--doc")));
  assert.equal(fixture.calls.filter((command) => command.argv[0] === fixture.prelaunch.executable).length, 2);
});

test("prelaunch dispatch refuses missing fixtures, missing targets, mismatched source/profile/build identities and empty inventory", async () => {
  for (const corrupt of ["fixture", "target", "source", "profile", "identity", "build"] as const) {
    const fixture = nativeArtifacts();
    const run: CommandRunner = (command, environment) => {
      if (command.argv[1] === "build" && corrupt === "fixture") return Promise.resolve({ code: 0, stdout: fixture.json([]), stderr: "" });
      if (command.argv.includes("--no-run")) {
        const artifact = structuredClone(fixture.prelaunch);
        if (corrupt === "target") artifact.target.name = "not-the-selected-target";
        if (corrupt === "source") artifact.target.src_path = fixture.selected[0].target.src_path;
        if (corrupt === "profile") artifact.profile.test = false;
        if (corrupt === "identity") artifact.package_id += "mismatch";
        return Promise.resolve({ code: 0, stdout: corrupt === "build" ? JSON.stringify(artifact) : fixture.json([fixture.library, artifact]), stderr: "" });
      }
      return fixture.run(command, environment);
    };
    await assert.rejects(executeDarwinNativeTests(fixture.cwd, fixture.environment, "prelaunch", run), /missing|mismatch|incomplete/);
    assert.ok(!fixture.calls.some((command) => command.argv[0] === fixture.prelaunch.executable));
  }
});

test("prelaunch dispatch rechecks artifact hashes between listing and execution and refuses wrong source-bound targets", async () => {
  const fixture = nativeArtifacts();
  const run: CommandRunner = async (command, environment) => {
    const result = await fixture.run(command, environment);
    if (command.argv[0] === fixture.prelaunch.executable && command.argv.includes("--list"))
      writeFileSync(fixture.prelaunch.executable, "changed executable\n");
    return result;
  };
  await assert.rejects(executeDarwinNativeTests(fixture.cwd, fixture.environment, "prelaunch", run), /hash changed/);
  assert.equal(fixture.calls.filter((command) => command.argv[0] === fixture.prelaunch.executable).length, 1);
  await assert.rejects(
    executeDarwinNativeTests(fixture.cwd, { ...fixture.environment, CARGO_TARGET_DIR: temporary }, "prelaunch", fixture.run),
    /source\/tree identity/
  );
});

test("Darwin retains Cargo's actual disabled doc-test selection instead of forcing extra cases", async () => {
  const fixture = nativeArtifacts();
  fixture.selected[0].target.doctest = false;
  assert.equal(await executeDarwinNativeTests(fixture.cwd, fixture.environment, "package", fixture.run), 6);
  assert.ok(!fixture.calls.some((command) => command.argv.includes("--doc")));
});

test("prelaunch refuses duplicate or missing executable artifacts and zero executed tests", async () => {
  for (const corrupt of ["duplicate", "missing", "zero"] as const) {
    const fixture = nativeArtifacts();
    const run: CommandRunner = (command, environment) => {
      if (command.argv.includes("--no-run") && corrupt === "duplicate")
        return Promise.resolve({ code: 0, stdout: fixture.json([fixture.library, fixture.prelaunch, fixture.prelaunch]), stderr: "" });
      if (command.argv.includes("--no-run") && corrupt === "missing") rmSync(fixture.prelaunch.executable);
      if (command.argv[0] === fixture.prelaunch.executable && corrupt === "zero")
        return Promise.resolve({ code: 0, stdout: "test result: ok. 0 passed; 0 failed;\n", stderr: "" });
      return fixture.run(command, environment);
    };
    await assert.rejects(executeDarwinNativeTests(fixture.cwd, fixture.environment, "prelaunch", run), /duplicate|ENOENT|zero passing/);
  }
});

test("the serial native library retains ordinary tests and excludes only the two exact owned-child cases", async () => {
  const fixture = nativeArtifacts();
  await executeDarwinNativeTests(fixture.cwd, fixture.environment, "package", fixture.run);
  const wrapped = fixture.calls.filter((command) => command.argv.includes("--skip"));
  assert.ok(
    wrapped.length > 0 &&
      wrapped.every(
        (command) => command.isolated && command.argv.includes("--lib") && command.argv.includes("--exact") && command.argv.includes("--test-threads=1")
      )
  );
  for (const command of wrapped)
    assert.deepEqual(
      command.argv.filter((value, index) => command.argv[index - 1] === "--skip"),
      ownedChildCases
    );
  const actual = fixture.calls.filter((command) => !command.isolated && command.argv[0] === fixture.library.executable && !command.argv.includes("--list"));
  assert.deepEqual(
    actual.map((command) => command.argv[1]),
    ownedChildCases
  );
  assert.ok(actual.every((command) => command.argv.includes("--exact")));
  for (const host of [darwin, linux]) {
    const ordinary = planRustVerification(fixture.root, ["rust/crates/gateway-core/src/lib.rs"], "native", false, host).commands.filter(
      (command) => command.testRun === true || command.testListing === true
    );
    assert.ok(ordinary.length > 0 && ordinary.every((command) => !command.argv.includes("--test-threads=1")));
  }
});

test("missing lib artifacts, missing exact cases, overbroad filtered inventory and lib hash drift refuse dispatch", async () => {
  for (const corrupt of ["library", "case", "overbroad", "hash"] as const) {
    const fixture = nativeArtifacts();
    const run: CommandRunner = async (command, environment) => {
      if (command.argv.includes("--no-run") && corrupt === "library") return { code: 0, stdout: fixture.json([fixture.prelaunch]), stderr: "" };
      const result = await fixture.run(command, environment);
      if (command.argv.includes("--list") && command.argv.includes("--lib")) {
        if (corrupt === "case" && !command.argv.includes("--skip")) return { ...result, stdout: "ordinary_library_case: test\n" };
        if (corrupt === "overbroad" && command.argv.includes("--skip")) return { ...result, stdout: "ordinary_library_case: test\n" };
        if (corrupt === "hash") writeFileSync(fixture.library.executable, "changed source-bound library\n");
      }
      return result;
    };
    await assert.rejects(executeDarwinNativeTests(fixture.cwd, fixture.environment, "prelaunch", run), /missing|inventory mismatch|hash changed/);
    assert.ok(!fixture.calls.some((command) => !command.isolated && command.argv[0] === fixture.library.executable));
  }
});

const importFixture = () => {
  const fixture = nativeArtifacts();
  const target = join(fixture.environment.CARGO_TARGET_DIR, "native-import-fixture-opt3");
  const task = join(fixture.environment.RUSTUP_HOME, "..");
  mkdirSync(join(task, "mac-bootstrap"), { recursive: true });
  writeFileSync(join(task, "mac-bootstrap/check.sb"), "(version 1) (deny network*)");
  const environment = { ...fixture.environment, TMPDIR: join(task, "tmp") };
  mkdirSync(environment.TMPDIR, { recursive: true });
  const directory = join(fixture.root, "rust/crates/gateway-native");
  const make = (name: string, kind: string, test: boolean) => {
    const source = kind === "lib" ? "src/lib.rs" : `src/bin/${name}.rs`;
    const src = join(directory, source);
    const runtimePath = kind === "example" ? `examples/${name}` : name;
    const executable = join(target, "debug", test ? `deps/${name}-cargo-emitted` : runtimePath);
    mkdirSync(join(src, ".."), { recursive: true });
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(src, "// fixture\n");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    return {
      reason: "compiler-artifact",
      manifest_path: join(directory, "Cargo.toml"),
      package_id: `path+file://${realpathSync(directory)}#0.1.0`,
      target: { name, kind: [kind], src_path: src, doctest: true },
      profile: { test, opt_level: "3", debug_assertions: true },
      features: ["native-import-fixture"],
      executable,
    };
  };
  const library = make("gateway_native", "lib", true);
  const built = ["uos-native-owner-inspect", "uos-native", "uos-native-supervisor", "uos-native-request", "uos-native-connector", "uos-native-import"].map(
    (name) => make(name, "bin", false)
  );
  built.push(make("uos-native-import-fixture", "example", false), make("uos-native-connector-fixture", "example", false));
  const calls: RustCommand[] = [];
  const payloads: { argv: string[]; seconds: number; environment: Record<string, string> }[] = [];
  const run: CommandRunner = (command, environment) => {
    calls.push(command);
    if (command.argv[0] === "git") return fixture.run(command, environment);
    if (command.argv.includes("--no-run")) return Promise.resolve({ code: 0, stdout: fixture.json([library]), stderr: "" });
    if (command.argv.includes("--message-format=json")) return Promise.resolve({ code: 0, stdout: fixture.json(built), stderr: "" });
    if (command.argv.includes("--list"))
      return Promise.resolve({ code: 0, stdout: NATIVE_IMPORT_CASES.map((item) => item.name + ": test\n").join(""), stderr: "" });
    assert.equal(command.argv[0], "/usr/bin/python3");
    assert.ok(command.ownedImportDriver);
    payloads.push(JSON.parse(command.argv.at(-1) ?? ""));
    return Promise.resolve({ code: 0, stdout: "test result: ok. 1 passed; 0 failed; 0 ignored;\n", stderr: "" });
  };
  return { ...fixture, environment, calls, payloads, run, library, built };
};

test("finite native import stage is Darwin/native only and never changes production Worker features", () => {
  const fixture = nativeArtifacts();
  const paths = ["rust/crates/gateway-native/src/lib.rs"];
  const mac = planRustVerification(fixture.root, paths, "native", false, darwin);
  assert.equal(mac.commands.filter((command) => command.nativeImportFixture).length, 1);
  assert.equal(mac.commands.filter((command) => command.darwinNativeTests).length, 1);
  assert.ok(!planRustVerification(fixture.root, paths, "native", false, linux).commands.some((command) => command.nativeImportFixture));
  const wasm = planRustVerification(fixture.root, ["rust/crates/gateway-core/src/lib.rs"], "wasm", false, darwin);
  assert.ok(!wasm.commands.some((command) => command.argv.includes("native-import-fixture")));
  assert.deepEqual(wasm.commands.at(-1)?.argv, ["worker-build", "--release", "--locked"]);
});

test("finite optimized-debug import selector runs exactly11 cases with8 prelaunch2 loopback1 offline and verified role artifacts", async () => {
  const fixture = importFixture();
  const before = fixture.environment.CARGO_TARGET_DIR;
  assert.equal(await executeDarwinNativeImportTests(fixture.cwd, fixture.environment, fixture.run), 11);
  assert.equal(fixture.environment.CARGO_TARGET_DIR, before);
  assert.equal(fixture.payloads.length, 11);
  for (const [index, payload] of fixture.payloads.entries()) {
    const expected = NATIVE_IMPORT_CASES[index];
    assert.equal(payload.seconds, expected.seconds);
    assert.ok(JSON.stringify(payload.argv).includes("--exact"));
    assert.ok(payload.argv.includes(expected.name) || JSON.stringify(payload.argv).includes(expected.name));
    assert.ok(!("UNLISTED_CREDENTIAL_PROBE" in payload.environment));
    if (expected.boundary === "prelaunch") assert.equal(payload.argv[0], fixture.library.executable);
    if (expected.boundary === "offline") assert.deepEqual(payload.argv.slice(0, 2), ["/usr/bin/sandbox-exec", "-f"]);
  }
  const compilation = fixture.calls.filter((command) => command.argv.includes("--message-format=json"));
  assert.equal(compilation.length, 2);
  assert.ok(
    compilation.every(
      (command) => command.argv[0] === "/usr/bin/sandbox-exec" && command.argv.includes("profile.test.opt-level=3") && !command.argv.includes("--release")
    )
  );
});

test("finite import selector refuses missing names, wrong optimized profile and failed cases without continuing", async () => {
  for (const corrupt of ["inventory", "profile", "failure"] as const) {
    const fixture = importFixture();
    if (corrupt === "profile") fixture.library.profile.debug_assertions = false;
    const run: CommandRunner = (command, environment) => {
      if (corrupt === "inventory" && command.argv.includes("--list")) return Promise.resolve({ code: 0, stdout: "unrelated: test\n", stderr: "" });
      if (corrupt === "failure" && command.ownedImportDriver) return Promise.resolve({ code: 7, stdout: "original failure retained", stderr: "" });
      return fixture.run(command, environment);
    };
    await assert.rejects(executeDarwinNativeImportTests(fixture.cwd, fixture.environment, run), /Missing exact|optimized-debug|failed \(7\)/);
    assert.equal(fixture.payloads.length, 0);
  }
});

test("native CI preparation selects only pinned matching Darwin components and retains the Worker Linux tool graph", () => {
  assert.deepEqual(
    rustCiComponents(darwin).map(([component, target]) => [component, target]),
    [
      ["clippy", "aarch64-apple-darwin"],
      ["rustfmt", "aarch64-apple-darwin"],
    ]
  );
  assert.deepEqual(
    rustCiComponents(linux).map(([component, target]) => [component, target]),
    [
      ["clippy", "aarch64-unknown-linux-gnu"],
      ["rustfmt", "aarch64-unknown-linux-gnu"],
      ["rust-std", "wasm32-unknown-unknown"],
    ]
  );
  assert.throws(() => rustCiComponents({ platform: "darwin", arch: "x64" }), /supported Darwin or Linux ARM64/);
  const bootstrap = readFileSync(new URL("../ops/prepare-ci-native-toolchain.sh", import.meta.url), "utf8");
  for (const checksum of [
    "738e3f60114b20550fcf4f8a57c9cea0544239f214709f45594ff3fde327f577",
    "de51d4fade4f31ad8ec405261cc96bedc000d905f98980027610d6e288dbe21b",
    "2de831ef563ce772519a4d18ba2659f0f7428d497ef66dad24b5a35e8f8cd177",
  ])
    assert.ok(bootstrap.includes(checksum));
  assert.ok(bootstrap.includes("Darwin-arm64") && bootstrap.includes("--disable-ldconfig") && bootstrap.includes("uos_check"));
  assert.ok(bootstrap.includes('mkdir "$uos_toolchain"'), "Prepared tool destinations must still be fresh");
});

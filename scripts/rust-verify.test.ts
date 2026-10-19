import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeRustPlan,
  parseRustArguments,
  planRustVerification as planRustVerificationForHost,
  runCommand,
  rustNativeTarget,
  rustSourceTarget,
  rustToolPath,
  rustVerificationEnvironment,
  verifyWorkerArtifact,
  type RustCommand,
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
    assert.equal(compiled.length, 4);
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

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCiScope, isDocumentationPath, isRustGatePath, RUST_NATIVE_ONLY_PACKAGES } from "./test-scope.ts";
import { testNetworkArgv } from "./test-network.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_TARGET = "aarch64-unknown-linux-gnu";
const WASM_TARGET = "wasm32-unknown-unknown";
const RUST_VERSION = "1.98.1";
const RUST_REVISION = "48a229ce";
const WORKER_BUILD_VERSION = "0.8.7";
export type RustStage = "native" | "wasm";
export type RustHost = Readonly<{ platform: string; arch: string }>;
export const rustNativeTarget = (host: RustHost = process): string => {
  if (host.arch === "arm64" && host.platform === "linux") return NATIVE_TARGET;
  if (host.arch === "arm64" && host.platform === "darwin") return "aarch64-apple-darwin";
  throw new Error("Rust verification requires a supported Darwin or Linux ARM64 host");
};
type Package = Readonly<{
  name: string;
  directory: string;
  dependencies: readonly string[];
  runtimeDependencies: readonly string[];
  hasTests: boolean;
}>;
export type RustPlan = Readonly<{
  stage: RustStage;
  packages: readonly string[];
  testPackages: readonly string[];
  buildWorker: boolean;
  commands: readonly RustCommand[];
}>;
export type RustCommand = Readonly<{
  argv: readonly string[];
  cwd: string;
  isolated?: boolean;
  testListing?: boolean;
  testRun?: boolean;
  darwinNativeTests?: boolean;
  nativeImportFixture?: boolean;
  ownedImportDriver?: boolean;
}>;
export type CommandResult = Readonly<{ code: number; stdout: string; stderr: string }>;
export type CommandRunner = (command: RustCommand, environment: Record<string, string>) => Promise<CommandResult>;
type Table = Record<string, unknown>;
const table = (value: unknown): Table => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Table) : {});
const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const toml = (path: string): Table => table(Bun.TOML.parse(readFileSync(path, "utf8")));
const strings = (value: unknown): string[] => (Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []);
const unique = (items: readonly string[]): string[] => [...new Set(items)].sort((left, right) => left.localeCompare(right));
const inside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
};
const sourceHasTests = (directory: string): boolean =>
  existsSync(directory) &&
  readdirSync(directory, { withFileTypes: true }).some((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceHasTests(path) : entry.name.endsWith(".rs") && /#\s*\[\s*(?:test|tokio::test)\s*\]/.test(readFileSync(path, "utf8"));
  });
// Recognize only the reviewed native-target predicate. Unknown selectors remain
// in the portable closure so a new or malformed cfg cannot hide native code.
const excludesWasmTarget = (selector: string): boolean => /^cfg\(\s*all\(\s*unix\s*,\s*not\(\s*target_arch\s*=\s*"wasm32"\s*\)\s*\)\s*\)$/.test(selector);
const portableTargetDependencies = (value: unknown, names: ReadonlySet<string>, includeTests: boolean): string[] =>
  Object.entries(table(value)).flatMap(([selector, configuration]) => {
    // Only NORMAL edges use the reviewed target exclusion. BUILD dependencies
    // may depend on the host; retain them until separately proven safe.
    const selected = Object.entries(table(configuration)).filter(([kind]) => kind !== "dependencies" || !excludesWasmTarget(selector));
    return packageDependencies(Object.fromEntries(selected), names, includeTests, true);
  });
const packageDependencies = (value: unknown, names: ReadonlySet<string>, includeTests = true, portable = false): string[] => {
  const found: string[] = [];
  const entries = Object.entries(table(value)).filter(([key]) => includeTests || key !== "dev-dependencies");
  for (const [key, child] of entries) {
    if (["dependencies", "dev-dependencies", "build-dependencies"].includes(key)) {
      for (const [alias, dependency] of Object.entries(table(child))) {
        const name = table(dependency).package ?? alias;
        if (typeof name === "string" && names.has(name)) found.push(name);
      }
    } else if (key === "target" && portable) found.push(...portableTargetDependencies(child, names, includeTests));
    else if (typeof child === "object" && child !== null) found.push(...packageDependencies(child, names, includeTests, portable));
  }
  return unique(found);
};
export const rustPackages = (root: string): readonly Package[] => {
  const workspaceDirectory = join(root, "rust");
  const manifest = toml(join(workspaceDirectory, "Cargo.toml"));
  const members = strings(table(manifest.workspace).members);
  if (members.length === 0 || members.some((member) => ["*", "?", "[", "]"].some((part) => member.includes(part))))
    throw new Error("Rust workspace needs explicit, nonempty member paths");
  const manifests = members.map((member) => {
    const directory = resolve(workspaceDirectory, member);
    if (!inside(workspaceDirectory, directory)) throw new Error("Rust workspace member escapes rust/");
    const value = toml(join(directory, "Cargo.toml"));
    const name = table(value.package).name;
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Rust workspace member has no safe package name");
    return { name, directory, value };
  });
  const names = new Set(manifests.map((item) => item.name));
  if (names.size !== manifests.length) throw new Error("Rust workspace contains duplicate package names");
  return manifests.map(({ name, directory, value }) => ({
    name,
    directory,
    dependencies: packageDependencies(value, names),
    runtimeDependencies: packageDependencies(value, names, false, true),
    hasTests: sourceHasTests(join(directory, "src")) || sourceHasTests(join(directory, "tests")),
  }));
};
const reverseDependencies = (packages: readonly Package[], affected: Set<string>): Set<string> => {
  for (;;) {
    const before = affected.size;
    for (const item of packages) if (item.dependencies.some((name) => affected.has(name))) affected.add(item.name);
    if (before === affected.size) return affected;
  }
};
const affectedPackages = (root: string, packages: readonly Package[], changed: readonly string[], complete: boolean): Set<string> => {
  const owners = changed.map((path) => {
    const owner = packages.find((item) => inside(item.directory, resolve(root, path)));
    if (owner) return owner.name;
    if (path.startsWith("rust/crates/")) throw new Error(`Changed Rust path has no registered Cargo member: ${path}`);
    return null;
  });
  const names = complete || owners.includes(null) ? packages.map((item) => item.name) : owners.filter((name): name is string => name !== null);
  return reverseDependencies(packages, new Set(names));
};
const workerDependencies = (packages: readonly Package[], worker: Package): Set<string> => {
  const names = new Set([worker.name]);
  for (;;) {
    const before = names.size;
    for (const item of packages) if (names.has(item.name)) for (const name of item.runtimeDependencies) names.add(name);
    if (before === names.size) return names;
  }
};
const testCommands = (names: readonly string[], target: string, cwd: string): RustCommand[] =>
  names.flatMap<RustCommand>((name) => {
    const argv = ["cargo", "test", "--locked", "--offline", "--target", target, "-p", name];
    // Darwin prelaunch tests install their own child profiles; nesting those
    // beneath the package-wide Seatbelt changes the policy being tested.
    if (name === "gateway-native" && target === "aarch64-apple-darwin")
      return [
        { argv, cwd, isolated: true, darwinNativeTests: true },
        { argv: [...argv, "--features", "native-import-fixture"], cwd, isolated: true, nativeImportFixture: true },
      ];
    return [
      { argv: [...argv, "--", "--list"], cwd, isolated: true, testListing: true },
      { argv, cwd, isolated: true, testRun: true },
    ];
  });
export const planRustVerification = (root: string, paths: readonly string[], stage: RustStage, complete = false, host: RustHost = process): RustPlan => {
  if (!existsSync(join(root, "rust/Cargo.lock")) || readFileSync(join(root, "rust/Cargo.lock"), "utf8").trim() === "")
    throw new Error("Committed rust/Cargo.lock is required; verification never generates it");
  const packages = rustPackages(root);
  const changed = paths.filter((path) => !isDocumentationPath(path) && isRustGatePath(path));
  if (!complete && changed.length === 0) throw new Error("No Rust work selected; this invocation is not a verification result");
  const affected = affectedPackages(root, packages, changed, complete);
  const worker = packages.find((item) => item.name === "gateway-worker");
  if (!worker) throw new Error("Rust workspace is missing gateway-worker");
  const wasm = workerDependencies(packages, worker);
  if (RUST_NATIVE_ONLY_PACKAGES.some((name) => wasm.has(name))) throw new Error("Worker dependency closure contains a native-only package");
  const selected = packages.filter((item) => affected.has(item.name) && (stage === "native" || !RUST_NATIVE_ONLY_PACKAGES.some((name) => name === item.name)));
  if (selected.length === 0) throw new Error(`Rust ${stage} gate has no selected packages`);
  const names = unique(selected.map((item) => item.name));
  const flags = names.flatMap((name) => ["-p", name]);
  const cwd = join(root, "rust");
  const target = stage === "native" ? rustNativeTarget(host) : WASM_TARGET;
  const cargo = ["--locked", "--offline", "--target", target, ...flags];
  const commands: RustCommand[] = [
    { argv: ["cargo", "fmt", "--all", "--", "--check"], cwd, isolated: true },
    { argv: ["cargo", "clippy", ...cargo, ...(stage === "native" ? ["--all-targets"] : ["--lib"]), "--", "-D", "warnings"], cwd, isolated: true },
  ];
  // A complete CI job still retains documentation-only zero-test selection.
  const testAffected = affectedPackages(root, packages, changed, false);
  const tests = stage === "native" ? selected.filter((item) => item.hasTests && testAffected.has(item.name)).map((item) => item.name) : [];
  commands.push(...testCommands(tests, target, cwd));
  if (stage === "wasm") commands.push({ argv: ["worker-build", "--release", "--locked"], cwd: worker.directory, isolated: true });
  return { stage, packages: names, testPackages: tests, buildWorker: stage === "wasm", commands };
};

const macRustBin = (environment: Record<string, string>): string => join(environment.RUSTUP_HOME, "toolchains", `${RUST_VERSION}-aarch64-apple-darwin`, "bin");
export const rustToolPath = (name: string, environment: Record<string, string>, host: RustHost = process): string => {
  if (host.platform !== "darwin" || isAbsolute(name) || name === "git") return name;
  rustNativeTarget(host);
  const task = dirname(environment.RUSTUP_HOME);
  let candidate: string | null;
  if (["cargo", "rustc", "rustdoc", "rustfmt", "cargo-clippy"].includes(name)) candidate = join(macRustBin(environment), name);
  else if (name === "wasm-bindgen") candidate = environment.WASM_BINDGEN_BIN;
  else {
    const paths = environment.PATH.split(delimiter).filter((path) => isAbsolute(path) && inside(task, path));
    candidate = paths.length ? Bun.which(name, { PATH: paths.join(delimiter) }) : null;
  }
  const executable = candidate && isAbsolute(candidate) ? Bun.which(candidate) : null;
  if (!executable || !inside(realpathSync(task), realpathSync(executable)))
    throw new Error(`Prepared task-local ${name} is required; no ambient tool fallback`);
  return executable;
};
export const rustSourceTarget = (directory: string, sha: string, tree: string): string => {
  if (!isAbsolute(directory) || !/^[a-f0-9]{40}$/.test(sha) || !/^[a-f0-9]{40}$/.test(tree))
    throw new Error("Exact Rust target requires an absolute path and full source/tree identity");
  return join(directory, "exact-rust", `${sha}-${tree}`);
};
export const rustVerificationEnvironment = (source: NodeJS.ProcessEnv = process.env, host: RustHost = process): Record<string, string> => {
  // unshare maps the child to UID0: without HOME, config lookup falls back to
  // /root rather than the invoking account. Refuse that ambiguous identity.
  if (!source.HOME || !isAbsolute(source.HOME)) throw new Error("An explicit inherited absolute HOME is required for isolated Rust checks");
  const environment: Record<string, string> = {
    CARGO_NET_OFFLINE: "true",
    CARGO_BUILD_JOBS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "CARGO_TARGET_DIR",
    "XDG_CACHE_HOME",
    "WASM_BINDGEN_BIN",
    "WASM_OPT_BIN",
    "ESBUILD_BIN",
  ])
    if (source[name] !== undefined) environment[name] = source[name];
  for (const name of ["CARGO_HOME", "RUSTUP_HOME", "CARGO_TARGET_DIR", "XDG_CACHE_HOME"])
    if (!environment[name] || !isAbsolute(environment[name])) throw new Error(`Prepared task-local ${name} is required`);
  rustNativeTarget(host);
  if (host.platform === "darwin") {
    const paths = (source.PATH ?? "").split(delimiter).filter((path) => isAbsolute(path) && inside(dirname(environment.RUSTUP_HOME), path));
    environment.PATH = [...new Set([macRustBin(environment), ...paths, "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter);
    environment.RUSTUP_TOOLCHAIN = `${RUST_VERSION}-aarch64-apple-darwin`;
    environment.CARGO_INCREMENTAL = "0";
    environment.CARGO_PROFILE_DEV_DEBUG = "0";
    environment.CARGO_PROFILE_TEST_DEBUG = "0";
    environment.RUSTC = rustToolPath("rustc", environment, host);
    environment.RUSTDOC = rustToolPath("rustdoc", environment, host);
  }
  return environment;
};
export const runCommand: CommandRunner = async (command, environment) => {
  const argv = command.isolated ? testNetworkArgv(command.argv) : [...command.argv];
  const child = Bun.spawn(argv, { cwd: command.cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  const control = { expired: false };
  const stop = (signal: "SIGKILL" | "SIGTERM" = "SIGKILL"): void => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(() => {
    control.expired = true;
    stop();
  }, 1_800_000);
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const interrupt = (): void => {
    if (command.ownedImportDriver) {
      stop("SIGTERM");
      escalation ??= setTimeout(stop, 15_000);
    } else stop();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: control.expired ? 124 : code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    stop();
  }
};
const observeCommandResult = (command: RustCommand, result: CommandResult): number => {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0) throw new Error(`Rust command failed (${result.code}): ${command.argv.join(" ")}`);
  const tests = command.testListing ? result.stdout.split("\n").filter((line) => /: test\s*$/.test(line)).length : 0;
  if (command.testListing && tests === 0) throw new Error("Selected Rust test package listed zero tests");
  if (command.testRun && !/^test result: ok\..* [1-9]\d* passed;/m.test(result.stdout))
    throw new Error("Selected Rust test package executed zero passing tests");
  return tests;
};
const PRELAUNCH_TARGET = "connector_confinement";
// Prelaunch fixtures apply their own Seatbelt profile. macOS refuses a second
// sandbox_apply from inside the outer test-network profile, so these cases run
// in the release-shaped environment without that outer wrapper.
export const DARWIN_NESTED_SANDBOX_CASES = [
  "daemon_startup::live_bootstrap::tests::exact_reverse_fd_binding_and_all_bootstrap_faults_settle_the_receiver_process",
  "native_request_process::tests::actual_config_ancillary_rejected_before_service",
] as const;
const OWNED_CHILD_CASES = [
  "existing_account_import::foundation_tests::actual_owned_async_child_stop_wait_and_dirty_epoch_do_not_infer_external_absence",
  "existing_account_import::foundation_tests::actual_owned_child_reap_records_stopped_but_reopened_marker_grants_no_lease",
] as const;
const CONNECTOR_EXAMPLE = "uos-native-connector-fixture";
type CargoExecutable = Readonly<{ name: string; kind: string; source: string; executable: string; sha256: string; test: boolean }>;
const artifactHash = (path: string, target: string): string => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || (stat.mode & 0o111) === 0 || !inside(realpathSync(target), realpathSync(path)))
    throw new Error("Cargo executable is missing, unsafe or outside the source-bound target");
  return digest(readFileSync(path));
};
const cargoExecutable = (message: Table, manifest: string, cwd: string, target: string): CargoExecutable => {
  const artifact = table(message.target);
  const kind = strings(artifact.kind);
  const profile = table(message.profile);
  if (kind.length !== 1 || !["lib", "bin", "test", "example", "bench"].includes(kind[0]) || typeof profile.test !== "boolean")
    throw new Error("Cargo executable target/profile identity is invalid");
  if (
    typeof artifact.name !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(artifact.name) ||
    typeof artifact.src_path !== "string" ||
    typeof message.executable !== "string"
  )
    throw new Error("Cargo executable source identity is invalid");
  const source = realpathSync(artifact.src_path);
  if (!inside(dirname(manifest), source)) throw new Error("Cargo executable source escapes its native manifest");
  const version = table(table(toml(join(cwd, "Cargo.toml"))).workspace).package;
  const expectedVersion = table(version).version;
  if (typeof expectedVersion !== "string" || message.package_id !== `path+file://${dirname(manifest)}#${expectedVersion}`)
    throw new Error("Cargo executable package identity mismatch");
  const executable = message.executable;
  return { name: artifact.name, kind: kind[0], source, executable, sha256: artifactHash(executable, target), test: profile.test };
};
const cargoExecutables = (stdout: string, cwd: string, target: string): CargoExecutable[] => {
  const manifest = realpathSync(join(cwd, "crates/gateway-native/Cargo.toml"));
  const executables: CargoExecutable[] = [];
  let finished = false;
  for (const line of stdout.split("\n").filter((line) => line.trim() !== "")) {
    const message = table(JSON.parse(line));
    if (message.reason === "build-finished") {
      if (message.success !== true || finished) throw new Error("Cargo build identity is missing or ambiguous");
      finished = true;
    }
    if (message.reason !== "compiler-artifact" || message.executable === null || message.executable === undefined) continue;
    if (typeof message.manifest_path !== "string" || realpathSync(message.manifest_path) !== manifest) continue;
    const item = cargoExecutable(message, manifest, cwd, target);
    if (executables.some((old) => old.kind === item.kind && old.name === item.name && old.test === item.test))
      throw new Error("Cargo emitted duplicate executable identities");
    executables.push(item);
  }
  if (!finished) throw new Error("Cargo build identity is missing or incomplete");
  return executables;
};
const cargoDoctestsSelected = (stdout: string, cwd: string): boolean => {
  const manifest = realpathSync(join(cwd, "crates/gateway-native/Cargo.toml"));
  const selected = new Set<boolean>();
  for (const line of stdout.split("\n").filter((line) => line.trim() !== "")) {
    const message = table(JSON.parse(line));
    if (message.reason !== "compiler-artifact" || typeof message.manifest_path !== "string" || realpathSync(message.manifest_path) !== manifest) continue;
    const target = table(message.target);
    if (!strings(target.kind).includes("lib")) continue;
    if (typeof target.doctest !== "boolean") throw new Error("Cargo library doc-test identity is missing");
    selected.add(target.doctest);
  }
  if (selected.size !== 1) throw new Error("Cargo library doc-test selection is missing or ambiguous");
  return selected.has(true);
};
const checkedArtifacts = (items: readonly CargoExecutable[], target: string): void => {
  for (const item of items)
    if (artifactHash(item.executable, target) !== item.sha256) throw new Error("Cargo executable hash changed after isolated compilation");
};
const nativeTestNames = (stdout: string): string[] => {
  const names = stdout.split("\n").flatMap((line) => {
    const match = /^(.*): test\s*$/.exec(line);
    return match ? [match[1]] : [];
  });
  if (new Set(names).size !== names.length) throw new Error("Native test inventory contains duplicate names");
  return names.sort((left, right) => left.localeCompare(right));
};
const requireTestNames = (actual: readonly string[], expected: readonly string[]): void => {
  if (
    JSON.stringify([...actual].sort((left, right) => left.localeCompare(right))) !==
    JSON.stringify([...expected].sort((left, right) => left.localeCompare(right)))
  )
    throw new Error("Exact native test-name inventory mismatch");
};
const nativeLibraryArtifact = (tests: readonly CargoExecutable[], cwd: string): CargoExecutable => {
  const libraries = tests.filter((item) => item.kind === "lib");
  const library = libraries[0];
  if (libraries.length !== 1 || library.source !== realpathSync(join(cwd, "crates/gateway-native/src/lib.rs")))
    throw new Error("Exact native library test artifact/source is missing");
  return library;
};
const nativeLibrarySelection = async (
  cargo: string,
  flags: readonly string[],
  cwd: string,
  checked: (command: RustCommand) => Promise<CommandResult>
): Promise<Readonly<{ argv: readonly string[]; names: readonly string[] }>> => {
  const argv = [cargo, "test", ...flags, "--lib", "--"];
  const original = nativeTestNames((await checked({ argv: [...argv, "--list"], cwd, isolated: true })).stdout);
  if (OWNED_CHILD_CASES.some((name) => !original.includes(name))) throw new Error("Expected exact owned-child lib case is missing");
  // Same-binary diagnostics failed in parallel and passed serially; fixtures share TMPDIR ancestors
  // whose ACL observations require stable metadata.
  const filtered = [...argv, "--exact", ...OWNED_CHILD_CASES.flatMap((name) => ["--skip", name]), "--test-threads=1"];
  const names = nativeTestNames((await checked({ argv: [...filtered, "--list"], cwd, isolated: true })).stdout);
  requireTestNames(
    names,
    original.filter((name) => !OWNED_CHILD_CASES.some((owned) => owned === name))
  );
  console.log(JSON.stringify({ nativeLibraryInventory: original, loopbackLibraryInventory: names, trustedLibraryCases: OWNED_CHILD_CASES }));
  return { argv: filtered, names };
};
type NativeTestPair = (argv: readonly string[], isolated: boolean, expected?: readonly string[]) => Promise<void>;
const runLibraryCases = async (library: CargoExecutable, names: readonly string[], pair: NativeTestPair): Promise<void> => {
  for (const name of names) await pair([library.executable, name, "--exact", "--test-threads=1", "--nocapture"], false, [name]);
};
const requirePrivateRuntimeDirectory = (directory: string): void => {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
    throw new Error("Native runtime TMPDIR is not private and owned");
};
const isExactRustTarget = (source: string, tree: string, target: string): boolean =>
  /^[a-f0-9]{40}$/.test(source) && /^[a-f0-9]{40}$/.test(tree) && basename(target) === `${source}-${tree}` && basename(dirname(target)) === "exact-rust";
const requiresDarwinHost = (run: CommandRunner): boolean => run === runCommand && (process.platform !== "darwin" || process.arch !== "arm64");
const bothTestCountsPositive = (listed: number, passed: number): boolean => listed > 0 && passed > 0;
// An internal acceptance seam, not a CLI escape: only this fixed native target
// and two exact owned-child lib cases may run without the outer Darwin profile.
export const executeDarwinNativeTests = async (
  cwd: string,
  inherited: Record<string, string>,
  selection: "package" | "prelaunch" = "package",
  run: CommandRunner = runCommand
): Promise<number> => {
  if (requiresDarwinHost(run)) throw new Error("Prelaunch execution requires Darwin ARM64");
  if (!["package", "prelaunch"].includes(selection)) throw new Error("Unknown native test selection");
  const environment = rustVerificationEnvironment(inherited, { platform: "darwin", arch: "arm64" });
  const checked = async (command: RustCommand, childEnvironment = environment): Promise<CommandResult> => {
    console.log(JSON.stringify({ stage: "native", ...command }));
    const result = await run(command, childEnvironment);
    observeCommandResult(command, result);
    return result;
  };
  const git = async (args: readonly string[]): Promise<string> => (await checked({ argv: ["git", ...args], cwd })).stdout.trim();
  const source = await git(["rev-parse", "HEAD"]);
  const tree = await git(["rev-parse", "HEAD^{tree}"]);
  const target = environment.CARGO_TARGET_DIR;
  if (!isExactRustTarget(source, tree, target)) throw new Error("Native test target is not bound to the exact source/tree identity");
  const unchanged = async (): Promise<void> => {
    if (
      (await git(["rev-parse", "HEAD"])) !== source ||
      (await git(["rev-parse", "HEAD^{tree}"])) !== tree ||
      (await git(["status", "--porcelain", "--untracked-files=no"]))
    )
      throw new Error("Native test source changed or is not clean");
  };
  await unchanged();
  const cargo = rustToolPath("cargo", environment, { platform: "darwin", arch: "arm64" });
  const flags = ["--locked", "--offline", "--target", "aarch64-apple-darwin", "-p", "gateway-native"];
  const build = await checked({ argv: [cargo, "build", ...flags, "--bins", "--example", CONNECTOR_EXAMPLE, "--message-format=json"], cwd, isolated: true });
  const prerequisites = cargoExecutables(build.stdout, cwd, target);
  const fixture = prerequisites.find((item) => item.kind === "example" && item.name === CONNECTOR_EXAMPLE && !item.test);
  const binaries = ["uos-native", "uos-native-connector", "uos-native-request", "uos-native-supervisor"].map((name) =>
    prerequisites.find((item) => item.kind === "bin" && item.name === name && !item.test)
  );
  if (!fixture || binaries.some((item) => !item)) throw new Error("Exact named native fixture/binary prerequisite is missing");
  const compile = await checked({
    argv: [cargo, "test", ...flags, ...(selection === "prelaunch" ? ["--lib", "--test", PRELAUNCH_TARGET] : []), "--no-run", "--message-format=json"],
    cwd,
    isolated: true,
  });
  const compiled = cargoExecutables(compile.stdout, cwd, target);
  const tests = compiled.filter((item) => item.test);
  const library = nativeLibraryArtifact(tests, cwd);
  const prelaunch = tests.find((item) => item.kind === "test" && item.name === PRELAUNCH_TARGET);
  if (prelaunch?.source !== realpathSync(join(cwd, "crates/gateway-native/tests/connector_confinement.rs")))
    throw new Error("Exact native prelaunch target/source is missing");
  const runtimeDirectory = realpathSync(dirname(dirname(prelaunch.executable)));
  if (
    realpathSync(dirname(dirname(fixture.executable))) !== runtimeDirectory ||
    binaries.some((item) => !item || realpathSync(dirname(item.executable)) !== runtimeDirectory)
  )
    throw new Error("Native prelaunch fixture layout differs from Cargo's actual emitted paths");
  const allArtifacts = [...prerequisites, ...compiled];
  await unchanged();
  checkedArtifacts(allArtifacts, target);
  console.log(JSON.stringify({ nativePrelaunchSource: source, tree, artifacts: allArtifacts }));
  // Custody validates every ancestor; compiler/cache roots may sit below a home ACL.
  const runtimeTmp = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "uos-rust-native-")));
  try {
    requirePrivateRuntimeDirectory(runtimeTmp);
    const checkedRuntime = (command: RustCommand) => checked(command, { ...environment, TMPDIR: runtimeTmp });
    let listed = 0;
    let passed = 0;
    const pair = async (argv: readonly string[], isolated: boolean, expected?: readonly string[]): Promise<void> => {
      checkedArtifacts(allArtifacts, target);
      const listing = await checkedRuntime({ argv: [...argv, "--list"], cwd, isolated });
      const names = nativeTestNames(listing.stdout);
      if (expected) requireTestNames(names, expected);
      checkedArtifacts(allArtifacts, target);
      const result = await checkedRuntime({ argv, cwd, isolated });
      const executed = [...result.stdout.matchAll(/^test result: ok\.\s+(\d+) passed;/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
      if (!isolated && (!names.length || executed !== names.length))
        throw new Error("Selected prelaunch target listed or executed zero passing or incomplete tests");
      listed += names.length;
      passed += executed;
    };
    const normalLibrary = await nativeLibrarySelection(cargo, flags, cwd, (command) => {
      checkedArtifacts(allArtifacts, target);
      return checkedRuntime(command);
    });
    if (selection === "package") {
      const nestedSandbox = normalLibrary.names.filter((name) => DARWIN_NESTED_SANDBOX_CASES.some((caseName) => caseName === name));
      const ordinaryLibrary = normalLibrary.names.filter((name) => !nestedSandbox.includes(name));
      await pair([...normalLibrary.argv, ...nestedSandbox.flatMap((name) => ["--skip", name])], true, ordinaryLibrary);
      await runLibraryCases(library, nestedSandbox, pair);
      // Cargo's actual default-selection artifacts, not a guessed test directory,
      // supply every remaining lib/bin/integration/example/bench target exactly once.
      const normal = tests.filter((item) => item !== prelaunch && item !== library);
      const selectors = normal.flatMap((item) => (item.kind === "lib" ? ["--lib"] : [`--${item.kind}`, item.name]));
      if (selectors.length) await pair([cargo, "test", ...flags, ...selectors, "--"], true);
      // Explicit test selectors suppress doctests; preserve the original Cargo
      // package default by retaining its separate, still-isolated doc-test pass.
      if (cargoDoctestsSelected(compile.stdout, cwd)) await pair([cargo, "test", ...flags, "--doc", "--"], true);
    } else if (tests.length !== 2) throw new Error("Focused prelaunch compilation emitted additional selected tests");
    await pair([prelaunch.executable, "--test-threads=1", "--nocapture"], false);
    await runLibraryCases(library, OWNED_CHILD_CASES, pair);
    await unchanged();
    checkedArtifacts(allArtifacts, target);
    if (!bothTestCountsPositive(listed, passed)) throw new Error("Selected native tests listed or executed zero passing tests");
    return listed;
  } finally {
    rmSync(runtimeTmp, { recursive: true });
  }
};

export const NATIVE_IMPORT_CASES = [
  {
    name: "existing_account_import::flow_tests::actual_existing_account_original_start_owned_child_custody_durability_and_publication",
    boundary: "prelaunch",
    seconds: 90,
  },
  {
    name: "existing_account_import::flow_tests::negatives::actual_quiet_client_eof_before_and_after_started_never_writes_or_publishes",
    boundary: "prelaunch",
    seconds: 90,
  },
  {
    name: "existing_account_import::flow_tests::negatives::actual_custodian_death_after_stop_closes_live_actor_without_late_effect",
    boundary: "prelaunch",
    seconds: 90,
  },
  {
    name: "existing_account_import::flow_tests::negatives::actual_admin_revocation_before_native_write_refuses_the_same_started_claim",
    boundary: "prelaunch",
    seconds: 90,
  },
  {
    name: "existing_account_import::flow_tests::negatives::actual_original_deadline_expiry_after_stop_never_renews_mutation_authority",
    boundary: "prelaunch",
    seconds: 90,
  },
  {
    name: "existing_account_import::flow_tests::negatives::actual_revoked_publication_retains_native_receipt_but_never_source_success",
    boundary: "prelaunch",
    seconds: 90,
  },
  {
    name: "existing_account_import::flow_tests::negatives::actual_lost_publication_reply_reconciles_only_the_same_native_receipt",
    boundary: "prelaunch",
    seconds: 90,
  },
  {
    name: "existing_account_import::flow_tests::negatives::fixture_enabled_ordinary_entrypoints_refuse_before_reading_stdin",
    boundary: "loopback",
    seconds: 20,
  },
  {
    name: "connector_policy::import_policy_tests::actual_import_profile_exact_names_fixed_ports_process_and_sibling_controls",
    boundary: "prelaunch",
    seconds: 30,
  },
  {
    name: "existing_account_import::live_custody::tests::raw_stopped_replay_wrong_session_sequence_challenge_and_binding_are_not_live_custody",
    boundary: "loopback",
    seconds: 15,
  },
  {
    name: "existing_account_import::custodian_runtime::tests::a_stopped_session_rejects_new_kernel_epoch_or_root_identity",
    boundary: "offline",
    seconds: 10,
  },
] as const;
// Same accepted M44 all-exit cleanup. Process census is task cleanup only, never custody authority.
const NATIVE_IMPORT_PROCESS = String.raw`import subprocess,json,os,signal,time,sys,tempfile,re
payload=json.loads(sys.argv[1]);receipt={};p=None;owned={};interrupted=None
def snapshot():
 rows={}
 for line in subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,pgid=,lstart=,command='],text=True).splitlines():
  parts=line.strip().split(None,8)
  if len(parts)==9:rows[int(parts[0])]={'ppid':int(parts[1]),'pgid':int(parts[2]),'started':' '.join(parts[3:8]),'command':parts[8]}
 return rows
def observe():
 rows=snapshot()
 if p is not None and p.poll() is None and p.pid in rows and p.pid not in owned:owned[p.pid]=rows[p.pid]
 changed=True
 while changed:
  changed=False
  for pid,row in rows.items():
   parent=rows.get(row['ppid']);prior=owned.get(row['ppid'])
   if pid not in owned and parent is not None and prior is not None and parent['started']==prior['started'] and parent['pgid']==prior['pgid']:
    owned[pid]=row;changed=True
 return {pid:rows[pid] for pid,prior in owned.items() if pid in rows and rows[pid]['started']==prior['started'] and rows[pid]['pgid']==prior['pgid']}
def stop_groups(current,sig):
 for group in sorted({row['pgid'] for row in current.values()}):
  try:os.killpg(group,sig)
  except ProcessLookupError:pass
  receipt.setdefault('settlement_signals',[]).append({'group':group,'signal':sig})
def settle():
 if p is None:return
 current=observe()
 if current:stop_groups(current,signal.SIGTERM)
 until=time.monotonic()+3
 while current and time.monotonic()<until:
  p.poll();time.sleep(.05);current=observe()
 if current:stop_groups(current,signal.SIGKILL)
 if p.poll() is None:p.wait(timeout=5)
 until=time.monotonic()+2
 current=observe()
 while current and time.monotonic()<until:
  time.sleep(.05);current=observe()
 receipt['owned_process_observations']=owned;receipt['owned_processes_remaining']=current
 if current:raise RuntimeError('Owned task processes did not settle: '+repr(current))
def interrupt(signum,_frame):
 global interrupted
 interrupted=signum
 raise InterruptedError('Native flow driver received signal '+str(signum))
old_handlers={sig:signal.signal(sig,interrupt) for sig in [signal.SIGINT,signal.SIGTERM]}
output=tempfile.TemporaryFile()
try:
 p=subprocess.Popen(payload['argv'],cwd=payload['cwd'],env=payload['environment'],stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
 deadline=time.monotonic()+payload['seconds']
 while p.poll() is None:
  observe()
  if time.monotonic()>=deadline:raise TimeoutError('Exact native import case deadline')
  time.sleep(.1)
 output.seek(0);text=output.read().decode();print(text,flush=True)
 results=re.findall(r'test result: (.+)',text)
 assert p.returncode==0 and len(results)==1 and results[0].startswith('ok. 1 passed; 0 failed; 0 ignored;'), 'Exact native import case failed'
 receipt['status']='passed'
except BaseException as error:receipt['status']='failed';receipt['error']=repr(error);raise
finally:
 for sig in old_handlers:signal.signal(sig,signal.SIG_IGN)
 try:settle()
 except BaseException as error:receipt['status']='failed';receipt['settlement_error']=repr(error)
 output.seek(0)
 if receipt.get('status')!='passed':print(output.read().decode(),flush=True)
 output.close();receipt['exit']=None if p is None else p.returncode;receipt['interrupted_signal']=interrupted
 if interrupted is not None:receipt['status']='failed'
 print(json.dumps({'nativeImportProcess':receipt}),flush=True)
 if receipt.get('status')!='passed' and 'error' not in receipt:raise RuntimeError('Owned native import cleanup failed')
`;
const importFixtureArtifacts = (stdout: string, cwd: string, target: string): CargoExecutable[] => {
  const artifacts = cargoExecutables(stdout, cwd, target);
  const manifest = realpathSync(join(cwd, "crates/gateway-native/Cargo.toml"));
  for (const line of stdout.split("\n").filter((line) => line.trim() !== "")) {
    const message = table(JSON.parse(line));
    if (
      message.reason !== "compiler-artifact" ||
      !message.executable ||
      typeof message.manifest_path !== "string" ||
      realpathSync(message.manifest_path) !== manifest
    )
      continue;
    const profile = table(message.profile);
    if (!strings(message.features).includes("native-import-fixture") || profile.opt_level !== "3" || profile.debug_assertions !== true)
      throw new Error("Native fixture must be optimized-debug with its exact feature, never production release");
  }
  return artifacts;
};
export const executeDarwinNativeImportTests = async (cwd: string, inherited: Record<string, string>, run: CommandRunner = runCommand): Promise<number> => {
  if (run === runCommand && (process.platform !== "darwin" || process.arch !== "arm64")) throw new Error("Native import fixtures require Darwin ARM64");
  const environment = rustVerificationEnvironment(inherited, { platform: "darwin", arch: "arm64" });
  const checked = async (command: RustCommand): Promise<CommandResult> => {
    console.log(JSON.stringify({ stage: "native-import-fixture", ...command }));
    const result = await run(command, environment);
    observeCommandResult(command, result);
    return result;
  };
  const git = async (arg: string): Promise<string> => (await checked({ argv: ["git", "rev-parse", arg], cwd })).stdout.trim();
  const source = await git("HEAD"),
    tree = await git("HEAD^{tree}");
  const sourceTarget = environment.CARGO_TARGET_DIR;
  if (!isExactRustTarget(source, tree, sourceTarget)) throw new Error("Native fixture target is not bound to source/tree identity");
  const unchanged = async (): Promise<void> => {
    const status = await checked({ argv: ["git", "status", "--porcelain", "--untracked-files=no"], cwd });
    if (status.stdout.trim() || (await git("HEAD")) !== source || (await git("HEAD^{tree}")) !== tree)
      throw new Error("Native fixture source changed or is dirty");
  };
  await unchanged();
  environment.CARGO_TARGET_DIR = join(sourceTarget, "native-import-fixture-opt3");
  const target = environment.CARGO_TARGET_DIR;
  const offline = join(dirname(environment.RUSTUP_HOME), "mac-bootstrap/check.sb");
  const profileHash = digest(readFileSync(offline));
  if (!environment.TMPDIR || !inside(realpathSync(dirname(environment.RUSTUP_HOME)), realpathSync(environment.TMPDIR)))
    throw new Error("Prepared task-local TMPDIR is required for native import fixtures");
  const cargo = rustToolPath("cargo", environment, { platform: "darwin", arch: "arm64" });
  const flags = [
    "--locked",
    "--offline",
    "--config",
    "profile.test.opt-level=3",
    "--config",
    "profile.dev.opt-level=3",
    "-p",
    "gateway-native",
    "--features",
    "native-import-fixture",
  ];
  const compile = async (argv: readonly string[]): Promise<CargoExecutable[]> => {
    const result = await checked({ argv: ["/usr/bin/sandbox-exec", "-f", offline, cargo, ...argv], cwd });
    return importFixtureArtifacts(result.stdout, cwd, target);
  };
  const tests = await compile(["test", ...flags, "--lib", "--no-run", "--message-format=json"]);
  const library = nativeLibraryArtifact(
    tests.filter((item) => item.test),
    cwd
  );
  const names = ["uos-native-owner-inspect", "uos-native", "uos-native-supervisor", "uos-native-request", "uos-native-connector", "uos-native-import"];
  const built = await compile([
    "build",
    ...flags,
    "--example",
    "uos-native-import-fixture",
    "--example",
    CONNECTOR_EXAMPLE,
    ...names.flatMap((name) => ["--bin", name]),
    "--message-format=json",
  ]);
  for (const name of [...names, "uos-native-import-fixture", CONNECTOR_EXAMPLE])
    if (!built.some((item) => item.name === name && !item.test)) throw new Error("Missing exact native fixture role/guard artifact");
  const artifacts = [...tests, ...built];
  const verify = (): void => {
    checkedArtifacts(artifacts, target);
    if (digest(readFileSync(offline)) !== profileHash) throw new Error("Native fixture offline profile changed");
  };
  verify();
  const listing = await checked({ argv: [library.executable, "--list"], cwd, isolated: true });
  const inventory = nativeTestNames(listing.stdout);
  if (NATIVE_IMPORT_CASES.some((item) => !inventory.includes(item.name))) throw new Error("Missing exact finite native import case");
  console.log(
    JSON.stringify({ nativeImportSource: source, tree, feature: "native-import-fixture", profile: "optimized-debug", artifacts, cases: NATIVE_IMPORT_CASES })
  );
  for (const item of NATIVE_IMPORT_CASES) {
    verify();
    const selected = [library.executable, "--exact", item.name, "--nocapture", "--test-threads=1"];
    let argv: readonly string[] = selected;
    if (item.boundary === "loopback") argv = testNetworkArgv(selected);
    if (item.boundary === "offline") argv = ["/usr/bin/sandbox-exec", "-f", offline, ...selected];
    const payload = {
      argv,
      cwd,
      seconds: item.seconds,
      environment: { HOME: environment.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: environment.TMPDIR, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    };
    await checked({ argv: ["/usr/bin/python3", "-c", NATIVE_IMPORT_PROCESS, JSON.stringify(payload)], cwd, ownedImportDriver: true });
  }
  verify();
  await unchanged();
  return NATIVE_IMPORT_CASES.length;
};

export const executeRustPlan = async (plan: RustPlan, environment: Record<string, string>, run: CommandRunner = runCommand): Promise<number> => {
  if (plan.packages.length === 0 || plan.commands.length === 0) throw new Error("Rust gate refuses an empty plan");
  let listedTests = 0;
  for (const command of plan.commands) {
    console.log(JSON.stringify({ stage: plan.stage, cwd: command.cwd, argv: command.argv }));
    if (command.nativeImportFixture) listedTests += await executeDarwinNativeImportTests(command.cwd, environment, run);
    else
      listedTests += command.darwinNativeTests
        ? await executeDarwinNativeTests(command.cwd, environment, "package", run)
        : observeCommandResult(command, await run(command, environment));
  }
  return listedTests;
};

export const verifyWorkerArtifact = (root: string, sha: string) => {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Worker artifact requires an exact source SHA");
  const directory = join(root, "rust/crates/gateway-worker/build");
  const files = ["index.js", "index_bg.wasm"].map((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Worker artifact is missing or unsafe: ${name}`);
    const bytes = readFileSync(path);
    return { name, bytes, sha256: digest(bytes) };
  });
  const wasm = files.find((item) => item.name === "index_bg.wasm");
  const script = files.find((item) => item.name === "index.js");
  if (!wasm || !script || !WebAssembly.validate(wasm.bytes) || !script.bytes.toString().includes("index_bg.wasm"))
    throw new Error("Invalid generated Rust Worker JS/WASM");
  if (!wasm.bytes.includes(Buffer.from(`cloudflare-${sha}`))) throw new Error("Worker WASM is not bound to the exact source identity");
  if (!WebAssembly.Module.exports(new WebAssembly.Module(wasm.bytes)).some((item) => item.name === "memory"))
    throw new Error("Worker WASM has no Rust linear memory");
  return files.map(({ name, bytes, sha256 }) => ({ name, bytes: bytes.length, sha256 }));
};
const checkedRun = async (argv: readonly string[], cwd: string, environment: Record<string, string>): Promise<string> => {
  const result = await runCommand({ argv: [rustToolPath(argv[0], environment), ...argv.slice(1)], cwd }, environment);
  if (result.code !== 0) throw new Error(`Preparation command failed (${result.code}): ${argv.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
};
const COMPONENTS = [
  ["clippy", NATIVE_TARGET, "396e17c0a669399823d0e59073686a4e5f50b2d41f062f1d3afc9210f9d3553d"],
  ["rustfmt", NATIVE_TARGET, "7d4c136278b61096d46ef23019c29acb7ee5a2a1412cbfee5050316110c6fd8c"],
  ["rust-std", WASM_TARGET, "cf1fcf68880d8b2b90128cede7416cfb82ad3584357ce9fb668f2b6244c26e55"],
] as const;
const MAC_COMPONENTS = [
  ["clippy", "aarch64-apple-darwin", "1ad080040ff0f4f8af0751bd7fa1fb1901212f8d164cecaa3c47b0654e0916f2"],
  ["rustfmt", "aarch64-apple-darwin", "86aa28e2f23edb0045a85288c3f69998dd30294fd2d3f1480efa9485cf137bfd"],
] as const;
export const rustCiComponents = (host: RustHost = process): readonly (readonly [string, string, string])[] => {
  rustNativeTarget(host);
  return host.platform === "darwin" ? MAC_COMPONENTS : COMPONENTS;
};
const fetchArchive = async (url: string, path: string, expected: string): Promise<void> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Pinned tool archive returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (digest(bytes) !== expected) throw new Error("Pinned tool archive checksum mismatch");
  writeFileSync(path, bytes, { mode: 0o600 });
};
const prepareCi = async (root: string, stage: RustStage): Promise<void> => {
  rustNativeTarget();
  if (!process.env.RUNNER_TEMP || (process.platform === "darwin" && stage !== "native"))
    throw new Error("Rust CI preparation requires ARM64 Linux or native-only Darwin");
  const base = mkdtempSync(join(process.env.RUNNER_TEMP, "uos-rust-gateway-"));
  const prefix =
    process.platform === "darwin" ? join(base, "rustup/toolchains", `${RUST_VERSION}-aarch64-apple-darwin`) : join(base, "uos-native-kv/toolchain");
  const tools = join(base, "tools");
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    RUNNER_TEMP: base,
    HOME: join(base, "home"),
    CARGO_HOME: join(base, "cargo"),
    RUSTUP_HOME: join(base, "rustup"),
    CARGO_TARGET_DIR: join(base, "tool-target"),
    XDG_CACHE_HOME: join(base, "cache"),
    TMPDIR: join(base, "tmp"),
    CARGO_BUILD_JOBS: "1",
  };
  for (const path of [tools, environment.HOME, environment.CARGO_HOME, environment.RUSTUP_HOME, environment.XDG_CACHE_HOME, environment.TMPDIR])
    mkdirSync(path, { recursive: true });
  await checkedRun(["/bin/bash", "ops/prepare-ci-native-toolchain.sh"], root, environment);
  for (const [component, target, checksum] of rustCiComponents()) {
    const name = `${component}-${RUST_VERSION}-${target}`;
    const archive = join(base, `${name}.tar.xz`);
    await fetchArchive(`https://static.rust-lang.org/dist/2026-09-03/${name}.tar.xz`, archive, checksum);
    await checkedRun(["/usr/bin/tar", "-xJf", archive, "-C", base], root, environment);
    await checkedRun(["/bin/sh", join(base, name, "install.sh"), `--prefix=${prefix}`, "--disable-ldconfig"], root, environment);
  }
  environment.PATH = `${prefix}/bin:${tools}/bin:${environment.PATH}`;
  if (process.platform === "darwin") {
    environment.RUSTUP_TOOLCHAIN = `${RUST_VERSION}-aarch64-apple-darwin`;
    mkdirSync(join(base, "mac-bootstrap"));
    writeFileSync(
      join(base, "mac-bootstrap/check.sb"),
      `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(realpathSync(base))})) (allow file-write-data (literal "/dev/null")) (deny network*)`,
      { mode: 0o600 }
    );
  }
  if (stage === "wasm") {
    await checkedRun(["cargo", "install", "worker-build", "--version", `=${WORKER_BUILD_VERSION}`, "--locked", "--root", tools], root, environment);
    await checkedRun(["cargo", "install", "wasm-bindgen-cli", "--version", "=0.2.129", "--locked", "--root", tools], root, environment);
    for (const [name, url, checksum] of [
      [
        "binaryen",
        "https://github.com/WebAssembly/binaryen/releases/download/version_132/binaryen-version_132-aarch64-linux.tar.gz",
        "c58562417836c5d0493d89bdefc434933bdc097db641b483df86bcfa557a107f",
      ],
      [
        "esbuild",
        "https://registry.npmjs.org/@esbuild/linux-arm64/-/linux-arm64-0.28.2.tgz",
        "a96dbfa41d3ef5dbd1ef22b1c10d5187be9267e86093a870f06402a7ec931596",
      ],
    ]) {
      if (!name || !url || !checksum) throw new Error("Incomplete pinned Worker tool");
      const destination = join(tools, name);
      mkdirSync(destination);
      const archive = join(base, `${name}.tar.gz`);
      await fetchArchive(url, archive, checksum);
      await checkedRun(["/usr/bin/tar", "-xzf", archive, "--strip-components=1", "-C", destination], root, environment);
    }
    environment.WASM_BINDGEN_BIN = join(tools, "bin/wasm-bindgen");
    environment.WASM_OPT_BIN = join(tools, "binaryen/bin/wasm-opt");
    environment.ESBUILD_BIN = join(tools, "esbuild/bin/esbuild");
  }
  await checkedRun(["cargo", "fetch", "--manifest-path", "rust/Cargo.toml", "--locked"], root, environment);
  environment.CARGO_TARGET_DIR = join(base, "app-target");
  const output = process.env.GITHUB_ENV;
  if (!output || !process.env.GITHUB_PATH) throw new Error("Rust CI preparation requires GitHub output paths");
  const values = Object.entries(environment)
    .filter(([name]) => !["PATH", "RUNNER_TEMP"].includes(name))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  writeFileSync(output, values + "\n", { flag: "a" });
  writeFileSync(process.env.GITHUB_PATH, `${prefix}/bin\n${tools}/bin\n`, { flag: "a" });
};
const verifyWorkerTools = async (environment: Record<string, string>): Promise<void> => {
  for (const [name, expected] of [
    ["WASM_BINDGEN_BIN", "0.2.129"],
    ["WASM_OPT_BIN", "132"],
    ["ESBUILD_BIN", "0.28.2"],
  ] as const) {
    const path = environment[name];
    if (!path || !isAbsolute(path) || !existsSync(path)) throw new Error(`Prepared ${name} is required; no implicit tool download`);
    if (!(await checkedRun([path, "--version"], ROOT, environment)).includes(expected)) throw new Error(`Pinned ${name} version mismatch`);
  }
};
const verifyTools = async (stage: RustStage, environment: Record<string, string>): Promise<void> => {
  for (const [argv, expected] of [
    [["rustc", "--version"], `rustc ${RUST_VERSION} `],
    [["cargo", "--version"], `cargo ${RUST_VERSION} `],
    [["rustfmt", "--version"], RUST_REVISION],
    [["cargo-clippy", "--version"], RUST_REVISION],
    ...(stage === "wasm"
      ? [
          [["worker-build", "--version"], WORKER_BUILD_VERSION],
          [["wasm-bindgen", "--version"], "0.2.129"],
        ]
      : []),
  ] as [string[], string][]) {
    const version = await checkedRun(argv, ROOT, environment);
    if (!version.includes(expected)) throw new Error(`Pinned Rust tool version mismatch: ${argv[0]}`);
  }
  if (stage === "wasm") await verifyWorkerTools(environment);
};
export const parseRustArguments = (args: readonly string[]): Readonly<{ stage: RustStage; prepare: boolean; list: boolean }> => {
  const values = [...args];
  const list = values[0] === "--list";
  if (list) values.shift();
  if (values.length === 0) return { stage: "native", prepare: false, list };
  const [mode, stage] = values;
  if (values.length !== 2 || !["--stage", "--prepare-ci"].includes(mode) || (stage !== "native" && stage !== "wasm") || (list && mode === "--prepare-ci"))
    throw new Error("usage: rust-verify.ts [--list] [--stage native|wasm] | --prepare-ci native|wasm");
  return { stage, prepare: mode === "--prepare-ci", list };
};
const main = async (): Promise<void> => {
  if (Bun.version !== "1.4.0") throw new Error("Rust gate orchestration requires Bun 1.4.0");
  const options = parseRustArguments(process.argv.slice(2));
  const { stage } = options;
  if (options.prepare) {
    await prepareCi(ROOT, stage);
    return;
  }
  const selection = detectCiScope();
  const complete = selection.completeCheckSet || selection.runAll;
  const plan = planRustVerification(ROOT, selection.paths, stage, complete);
  if (options.list) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const nativeTarget = rustNativeTarget();
  const environment = rustVerificationEnvironment();
  const sha = await checkedRun(["git", "rev-parse", "HEAD"], ROOT, environment);
  const tree = await checkedRun(["git", "rev-parse", "HEAD^{tree}"], ROOT, environment);
  if (await checkedRun(["git", "status", "--porcelain", "--untracked-files=no"], ROOT, environment))
    throw new Error("Rust gates require a clean committed source tree");
  await checkedRun(["git", "ls-files", "--error-unmatch", "rust/Cargo.lock"], ROOT, environment);
  if (table(toml(join(ROOT, "rust/rust-toolchain.toml")).toolchain).channel !== RUST_VERSION)
    throw new Error("Rust toolchain manifest disagrees with pinned CI tools");
  if (process.platform === "darwin") environment.CARGO_TARGET_DIR = rustSourceTarget(environment.CARGO_TARGET_DIR, sha, tree);
  const lock = readFileSync(join(ROOT, "rust/Cargo.lock"));
  await verifyTools(stage, environment);
  const bound = {
    ...plan,
    commands: plan.commands.map((command) => ({ ...command, argv: [rustToolPath(command.argv[0], environment), ...command.argv.slice(1)] })),
  };
  const tests = await executeRustPlan(bound, environment);
  const artifacts = plan.buildWorker ? verifyWorkerArtifact(ROOT, sha) : [];
  if (digest(lock) !== digest(readFileSync(join(ROOT, "rust/Cargo.lock")))) throw new Error("Rust verification changed its frozen lockfile");
  if (await checkedRun(["git", "status", "--porcelain", "--untracked-files=no"], ROOT, environment))
    throw new Error("Rust verification changed committed source");
  console.log(
    JSON.stringify({
      status: "passed",
      stage,
      gitSha: sha,
      tree,
      nativeTarget,
      targetDirectory: environment.CARGO_TARGET_DIR,
      lockSha256: digest(lock),
      packages: plan.packages,
      listedTests: tests,
      artifacts,
      runtimeConformance: "pending",
    })
  );
};
if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

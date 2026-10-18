import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
type Package = Readonly<{ name: string; directory: string; dependencies: readonly string[]; hasTests: boolean }>;
export type RustPlan = Readonly<{
  stage: RustStage;
  packages: readonly string[];
  testPackages: readonly string[];
  buildWorker: boolean;
  commands: readonly RustCommand[];
}>;
export type RustCommand = Readonly<{ argv: readonly string[]; cwd: string; isolated?: boolean; testListing?: boolean; testRun?: boolean }>;
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
const packageDependencies = (value: unknown, names: ReadonlySet<string>): string[] => {
  const found: string[] = [];
  for (const [key, child] of Object.entries(table(value))) {
    if (["dependencies", "dev-dependencies", "build-dependencies"].includes(key)) {
      for (const [alias, dependency] of Object.entries(table(child))) {
        const name = table(dependency).package ?? alias;
        if (typeof name === "string" && names.has(name)) found.push(name);
      }
    } else if (typeof child === "object" && child !== null) found.push(...packageDependencies(child, names));
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
    for (const item of packages) if (names.has(item.name)) for (const name of item.dependencies) names.add(name);
    if (before === names.size) return names;
  }
};
const testCommands = (names: readonly string[], target: string, cwd: string): RustCommand[] =>
  names.flatMap((name) => {
    const argv = ["cargo", "test", "--locked", "--offline", "--target", target, "-p", name];
    return [
      { argv: [...argv, "--", "--list"], cwd, isolated: true, testListing: true },
      { argv, cwd, isolated: true, testRun: true },
    ];
  });
export const planRustVerification = (root: string, paths: readonly string[], stage: RustStage, complete = false): RustPlan => {
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
  const selected = packages.filter((item) => affected.has(item.name) && (stage === "native" || wasm.has(item.name)));
  if (selected.length === 0) throw new Error(`Rust ${stage} gate has no selected packages`);
  const names = unique(selected.map((item) => item.name));
  const flags = names.flatMap((name) => ["-p", name]);
  const cwd = join(root, "rust");
  const target = stage === "native" ? NATIVE_TARGET : WASM_TARGET;
  const cargo = ["--locked", "--offline", "--target", target, ...flags];
  const commands: RustCommand[] = [
    { argv: ["cargo", "fmt", "--all", "--", "--check"], cwd, isolated: true },
    { argv: ["cargo", "check", ...cargo, ...(stage === "native" ? ["--all-targets"] : ["--lib"])], cwd, isolated: true },
    { argv: ["cargo", "clippy", ...cargo, ...(stage === "native" ? ["--all-targets"] : ["--lib"]), "--", "-D", "warnings"], cwd, isolated: true },
  ];
  // A complete CI job still retains documentation-only zero-test selection.
  const testAffected = affectedPackages(root, packages, changed, false);
  const tests = stage === "native" ? selected.filter((item) => item.hasTests && testAffected.has(item.name)).map((item) => item.name) : [];
  commands.push(...testCommands(tests, target, cwd));
  if (stage === "wasm") commands.push({ argv: ["worker-build", "--release", "--locked"], cwd: worker.directory, isolated: true });
  return { stage, packages: names, testPackages: tests, buildWorker: stage === "wasm", commands };
};

export const rustVerificationEnvironment = (source: NodeJS.ProcessEnv = process.env): Record<string, string> => {
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
  return environment;
};
export const runCommand: CommandRunner = async (command, environment) => {
  const argv = command.isolated ? testNetworkArgv(command.argv) : [...command.argv];
  const child = Bun.spawn(argv, { cwd: command.cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  const control = { expired: false };
  const stop = (): void => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(() => {
    control.expired = true;
    stop();
  }, 1_800_000);
  const interrupt = (): void => {
    stop();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: control.expired ? 124 : code, stdout, stderr };
  } finally {
    clearTimeout(timer);
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
export const executeRustPlan = async (plan: RustPlan, environment: Record<string, string>, run: CommandRunner = runCommand): Promise<number> => {
  if (plan.packages.length === 0 || plan.commands.length === 0) throw new Error("Rust gate refuses an empty plan");
  let listedTests = 0;
  for (const command of plan.commands) {
    console.log(JSON.stringify({ stage: plan.stage, cwd: command.cwd, argv: command.argv }));
    listedTests += observeCommandResult(command, await run(command, environment));
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
  const result = await runCommand({ argv, cwd }, environment);
  if (result.code !== 0) throw new Error(`Preparation command failed (${result.code}): ${argv.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
};
const COMPONENTS = [
  ["clippy", NATIVE_TARGET, "396e17c0a669399823d0e59073686a4e5f50b2d41f062f1d3afc9210f9d3553d"],
  ["rustfmt", NATIVE_TARGET, "7d4c136278b61096d46ef23019c29acb7ee5a2a1412cbfee5050316110c6fd8c"],
  ["rust-std", WASM_TARGET, "cf1fcf68880d8b2b90128cede7416cfb82ad3584357ce9fb668f2b6244c26e55"],
] as const;
const fetchArchive = async (url: string, path: string, expected: string): Promise<void> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Pinned tool archive returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (digest(bytes) !== expected) throw new Error("Pinned tool archive checksum mismatch");
  writeFileSync(path, bytes, { mode: 0o600 });
};
const prepareCi = async (root: string, stage: RustStage): Promise<void> => {
  if (process.platform !== "linux" || process.arch !== "arm64" || !process.env.RUNNER_TEMP)
    throw new Error("Rust CI preparation requires the Linux ARM64 runner");
  const base = mkdtempSync(join(process.env.RUNNER_TEMP, "uos-rust-gateway-"));
  const prefix = join(base, "uos-native-kv/toolchain");
  const tools = join(base, "tools");
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    RUNNER_TEMP: base,
    CARGO_HOME: join(base, "cargo"),
    RUSTUP_HOME: join(base, "rustup"),
    CARGO_TARGET_DIR: join(base, "tool-target"),
    XDG_CACHE_HOME: join(base, "cache"),
    TMPDIR: join(base, "tmp"),
    CARGO_BUILD_JOBS: "1",
  };
  for (const path of [tools, environment.CARGO_HOME, environment.RUSTUP_HOME, environment.XDG_CACHE_HOME, environment.TMPDIR])
    mkdirSync(path, { recursive: true });
  await checkedRun(["/bin/bash", "ops/prepare-ci-native-toolchain.sh"], root, environment);
  for (const [component, target, checksum] of COMPONENTS) {
    const name = `${component}-${RUST_VERSION}-${target}`;
    const archive = join(base, `${name}.tar.xz`);
    await fetchArchive(`https://static.rust-lang.org/dist/2026-09-03/${name}.tar.xz`, archive, checksum);
    await checkedRun(["tar", "-xJf", archive, "-C", base], root, environment);
    await checkedRun(["/bin/sh", join(base, name, "install.sh"), `--prefix=${prefix}`, "--disable-ldconfig"], root, environment);
  }
  environment.PATH = `${prefix}/bin:${tools}/bin:${environment.PATH}`;
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
      await checkedRun(["tar", "-xzf", archive, "--strip-components=1", "-C", destination], root, environment);
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
  if (process.platform !== "linux" || process.arch !== "arm64") throw new Error("Interactive Rust compilation requires the primary Linux ARM64 build host");
  const environment = rustVerificationEnvironment();
  const sha = await checkedRun(["git", "rev-parse", "HEAD"], ROOT, environment);
  const tree = await checkedRun(["git", "rev-parse", "HEAD^{tree}"], ROOT, environment);
  if (await checkedRun(["git", "status", "--porcelain", "--untracked-files=no"], ROOT, environment))
    throw new Error("Rust gates require a clean committed source tree");
  await checkedRun(["git", "ls-files", "--error-unmatch", "rust/Cargo.lock"], ROOT, environment);
  if (table(toml(join(ROOT, "rust/rust-toolchain.toml")).toolchain).channel !== RUST_VERSION)
    throw new Error("Rust toolchain manifest disagrees with pinned CI tools");
  const lock = readFileSync(join(ROOT, "rust/Cargo.lock"));
  await verifyTools(stage, environment);
  const tests = await executeRustPlan(plan, environment);
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

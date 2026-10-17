import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_E2E_DEFAULT_BASE_URL, liveDestination, testNetworkArgv, type TestNetworkPolicy } from "./test-network.ts";
import { createTestNativeKvPreload, prepareTestNativeKv, verifiedTestNativeKvBinding, type TestNativeKvBinding } from "./test-native-kv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let interrupted = false;
const MAX_FILE_WALL_TIME_MS = 600_000;
const KILL_GRACE_MS = 3000;
const PROVIDER_ENV = [
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "LITHOSAI_API_KEY",
  "VOYAGEAI_API_KEY",
  "METERED_API_KEY",
  "SURPLUS_API_KEY",
  "OPENROUTER_API_KEY",
  "IMAGE_BASE_MODEL",
  "GIT_REVISION",
  "GITHUB_SHA",
  "DENO_DEPLOYMENT_ID",
  "DENO_DEPLOY_BUILD_ID",
];
const SPECIAL_MAIN_FILES = new Set([
  "failover-stress-http.test.ts",
  "usage-optimization-measurement.test.ts",
  "sentinel-replay-consumer.test.ts",
  "precommit-formatter-availability.test.ts",
  "oss-gateway-http.test.ts",
  "vps-deploy-guards.test.ts",
]);
const SENTINEL_FILES = [
  "sentinel-replay-export",
  "sentinel-request-capture",
  "sentinel-incident-index",
  "sentinel-retirement",
  "handler-replay-background",
  "sentinel-upstream-capture",
  "sentinel-replay-limits",
  "sentinel-replay-retention",
  "sentinel-replay-retention-metadata",
  "sentinel-replay-bootstrap-retry",
  "sentinel-replay-staging",
  "sentinel-replay-deletion-budget",
];
type Group = Readonly<{ profile: string; files: readonly string[]; environment: readonly string[]; network?: "live" }>;
const filesBelow = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesBelow(path));
    else if (entry.isFile() && /(?:\.test|_test)\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found.sort((left, right) => left.localeCompare(right));
};
const group = (profile: string, files: readonly string[], environment: readonly string[] = []): Group => ({ profile, files, environment });
const measurement = (): Group => group("measurement", ["tests/usage-optimization-measurement.test.ts"], ["UOS_AI_TOKEN", "DENO_DEPLOY_TOKEN"]);
const quality = (): Group => group("quality", ["scripts/quality-contract.test.ts", "scripts/test-native-kv.test.ts"], ["PATH"]);
const allGroupsFor = (segment: string, explicitFiles: readonly string[]): Group[] => {
  switch (segment) {
    case "main":
      return [
        group(
          "main",
          filesBelow("tests").filter((path) => !SPECIAL_MAIN_FILES.has(path.split("/").at(-1) ?? "")),
          PROVIDER_ENV
        ),
        group(
          "oss",
          ["tests/oss-gateway-http.test.ts"],
          PROVIDER_ENV.filter((name) => !["SURPLUS_API_KEY", "METERED_API_KEY"].includes(name))
        ),
        measurement(),
        group("precommit", ["tests/precommit-formatter-availability.test.ts"]),
        group("mac-runtime", ["ops/tests/mac-runtime.test.ts"]),
        group("mac-native-auth", ["ops/tests/mac-native-auth-permissions.test.ts"]),
        group("mac-maintenance", ["ops/tests/mac-event-maintenance.test.ts"], ["PATH"]),
      ];
    case "vps":
      return [
        group("vps", [
          ...(process.platform === "linux" ? ["ops/tests/vps-release.test.ts"] : []),
          "ops/tests/release-retention.test.ts",
          "ops/tests/vps-release-driver.test.ts",
          "ops/tests/vps-release-recovery.test.ts",
          "ops/tests/vps-release-metrics.test.ts",
          "ops/tests/vps-metrics-join.test.ts",
          "ops/tests/vps-journal-reader.test.ts",
          "ops/tests/first-bun-cutover.test.ts",
        ]),
      ];
    case "deploy-guards":
      return [group("deploy-guards", ["tests/vps-deploy-guards.test.ts"], ["PATH"])];
    case "measurement":
      return [measurement()];
    case "stress":
      return [group("stress", ["tests/failover-stress-http.test.ts"], ["METERED_API_KEY", "SURPLUS_API_KEY"])];
    case "e2e":
      // The only separately selected live segment: it reaches its selected gateway origin and nothing else.
      return [{ ...group("e2e", ["tests/live-default-model.e2e.ts"], ["BASE_URL", "UOS_AI_TOKEN", "DENO_DEPLOY_TOKEN"]), network: "live" }];
    case "sentinel":
      return [
        group(
          "sentinel",
          SENTINEL_FILES.map((name) => `tests/${name}.test.ts`),
          ["SENTINEL_REPLAY_KEY"]
        ),
        group("sentinel-upstream", ["tests/sentinel-upstream-providers.test.ts"], ["SENTINEL_REPLAY_KEY"]),
        ...(process.platform === "linux"
          ? [group("sentinel-consumer", ["tests/sentinel-replay-consumer.test.ts"], ["DENO_DIR", "DENO_NO_UPDATE_CHECK", "PATH", "HOME"])]
          : []),
      ];
    case "benchmark":
      return [group("benchmark", [...filesBelow("benchmarks/tests"), ...filesBelow("benchmarks/baselines/tests")])];
    case "quality":
      return [quality()];
    case "files":
      if (explicitFiles.length === 0) throw new Error("The files segment requires explicit test paths");
      return [group("focused", explicitFiles)];
    default:
      throw new Error(`Unknown test segment: ${segment}`);
  }
};
const segmentHints = new Map([
  ["tests/sentinel-replay-consumer.test.ts", "sentinel"],
  ["tests/failover-stress-http.test.ts", "stress"],
  ["tests/live-default-model.e2e.ts", "e2e"],
  ["tests/vps-deploy-guards.test.ts", "deploy-guards"],
]);
export const groupsFor = (segment: string, explicitFiles: readonly string[]): Group[] => {
  const groups = allGroupsFor(segment, explicitFiles);
  if (explicitFiles.length === 0 || segment === "files") return groups;
  const requested = new Set(explicitFiles.map((path) => relative(ROOT, resolve(ROOT, path)).split(sep).join("/")));
  const available = new Set(groups.flatMap((item) => item.files));
  for (const path of requested) {
    if (!available.has(path)) {
      const hint = segmentHints.get(path);
      const suffix = hint === undefined ? "" : "; use segment " + hint;
      throw new Error(`Test file ${path} is excluded or unknown in segment ${segment}${suffix}`);
    }
  }
  return groups.map((item) => ({ ...item, files: item.files.filter((path) => requested.has(path)) })).filter((item) => item.files.length !== 0);
};
const checkedPath = (path: string): string => {
  const absolute = realpathSync(resolve(ROOT, path));
  const local = relative(ROOT, absolute);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error("Test paths must stay inside this checkout");
  return absolute;
};
/** Deterministic profiles keep the local-only boundary; only a live group admits its one selected origin. */
export const testNetworkPolicy = (selected: Pick<Group, "network">, environment: NodeJS.ProcessEnv = process.env): TestNetworkPolicy => {
  if (selected.network !== "live") return {};
  const baseUrl = environment.BASE_URL?.trim() ?? "";
  return { live: liveDestination(baseUrl === "" ? LIVE_E2E_DEFAULT_BASE_URL : baseUrl) };
};
export const validatedGroups = (groups: readonly Group[], environment: NodeJS.ProcessEnv = process.env, networkArgv = testNetworkArgv) =>
  groups.map((item) => {
    if (item.files.length === 0) throw new Error(`Test segment ${item.profile} contains no files`);
    const policy = testNetworkPolicy(item, environment);
    // Build the group's boundary once without spawning it: an unscopable live destination or a
    // missing system tool (unshare, ip, mount, sandbox-exec) fails closed here, before the parent
    // native build starts, instead of in runFile minutes later.
    networkArgv([process.execPath], policy);
    return { ...item, policy, files: item.files.map((label) => ({ label, path: checkedPath(label) })) };
  });
/**
 * A live file's relay keeps its socket and hosts files in a directory it removes on exit. A
 * SIGKILLed relay (timeout escalation, CI cancellation, the OOM killer) cannot, so that directory
 * is created under a runner-owned parent that is removed once the file's process group settles.
 */
export const withLiveRelayParent = async <T>(policy: TestNetworkPolicy, run: (policy: TestNetworkPolicy) => Promise<T>, base = tmpdir()): Promise<T> => {
  if (policy.live === undefined) return await run(policy);
  const relayParent = mkdtempSync(join(base, "uos-live-run-"));
  try {
    return await run({ ...policy, relayParent });
  } finally {
    rmSync(relayParent, { recursive: true, force: true });
  }
};
const childEnvironment = (selected: Pick<Group, "profile" | "environment">): Record<string, string> => {
  const environment: Record<string, string> = { UOS_TEST_PROFILE: selected.profile, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  // Keep only transport necessities and this segment's existing named inputs.
  for (const name of new Set(["PATH", "TMPDIR", "SYSTEMROOT", ...selected.environment])) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};
const signalGroup = (pid: number, signal: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};
const settleGroup = async (pid: number): Promise<void> => {
  signalGroup(pid, "SIGKILL");
  const deadline = Date.now() + KILL_GRACE_MS;
  while (signalGroup(pid, 0)) {
    if (Date.now() >= deadline) throw new Error(`Test child process group ${pid} did not settle`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
};
const runFile = async (
  path: string,
  selected: Pick<Group, "profile" | "environment"> & Readonly<{ policy: TestNetworkPolicy }>,
  wallTimeMs: number,
  binding: TestNativeKvBinding,
  preload: string
): Promise<number> => {
  if (interrupted) throw new Error("Test runner interrupted; no further files were started");
  const argv = testNetworkArgv(
    [
      process.execPath,
      "--no-env-file",
      "--no-install",
      "test",
      "--define",
      "UOS_TEST_NATIVE_KV_BINDING:" + JSON.stringify(binding),
      "--preload",
      preload,
      "--no-orphans",
      "--max-concurrency=1",
      "--timeout=300000",
      path,
    ],
    selected.policy
  );
  const child = Bun.spawn(argv, {
    cwd: ROOT,
    detached: true,
    env: childEnvironment(selected),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const control = { timedOut: false };
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    signalGroup(child.pid, "SIGTERM");
    forceTimer = setTimeout(() => {
      signalGroup(child.pid, "SIGKILL");
    }, KILL_GRACE_MS);
  };
  const interrupt = () => {
    interrupted = true;
    terminate();
  };
  const timer = setTimeout(() => {
    control.timedOut = true;
    console.error(`Wall-time limit exceeded for ${path} (${wallTimeMs}ms)`);
    terminate();
  }, wallTimeMs);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const code = await child.exited;
    return control.timedOut ? 124 : code;
  } finally {
    clearTimeout(timer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await settleGroup(child.pid);
  }
};
const invocation = (args: readonly string[]): Readonly<{ files: string[]; list: boolean; wallTimeMs: number; nativeBinding?: string }> => {
  const files: string[] = [];
  let list = false;
  let wallTimeMs = MAX_FILE_WALL_TIME_MS;
  let nativeBinding: string | undefined;
  for (const arg of args) {
    if (arg === "--list") list = true;
    else if (arg.startsWith("--file-timeout-ms=")) {
      wallTimeMs = Number(arg.slice("--file-timeout-ms=".length));
      if (!Number.isInteger(wallTimeMs) || wallTimeMs <= 0 || wallTimeMs > MAX_FILE_WALL_TIME_MS) {
        throw new Error(`--file-timeout-ms must be an integer from 1 through ${MAX_FILE_WALL_TIME_MS}`);
      }
    } else if (arg.startsWith("--native-kv-binding=")) nativeBinding = arg.slice("--native-kv-binding=".length);
    else files.push(arg);
  }
  return { files, list, wallTimeMs, nativeBinding };
};
const main = async (): Promise<void> => {
  if (Bun.version !== "1.4.0") throw new Error("The test runner requires Bun 1.4.0");
  if (!existsSync(join(ROOT, "bun.lock"))) throw new Error("Restore bun.lock before running tests");
  const [segment = "main", ...args] = process.argv.slice(2);
  const options = invocation(args);
  const selected = groupsFor(segment, options.files);
  if (options.list) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }
  // Resolve every requested file before an expensive parent build can start.
  const resolved = validatedGroups(selected);
  const binding = options.nativeBinding === undefined ? await prepareTestNativeKv(ROOT) : verifiedTestNativeKvBinding(options.nativeBinding);
  const preload = createTestNativeKvPreload(ROOT);
  let files = 0;
  let failures = 0;
  for (const item of resolved) {
    for (const file of item.files) {
      console.log(`\n==> ${item.profile}: ${file.label}`);
      const code = await withLiveRelayParent(item.policy, (policy) => runFile(file.path, { ...item, policy }, options.wallTimeMs, binding, preload));
      files++;
      if (code !== 0) {
        failures++;
        console.error(`FAILED ${file.label} (exit ${code})`);
      }
    }
  }
  console.log(`test:${segment}: ${files} files, ${failures} failures`);
  process.exitCode = failures === 0 && !interrupted ? 0 : 1;
};
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

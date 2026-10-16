import { cp } from "node:fs/promises";
import { copyOps, packageFixture, writePackage } from "./fixture-release.ts";
import { runtimePath, selectedRuntime } from "../bun-runtime.ts";
import { test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawnFixture, runFixture, fsError, denied, type FixtureChild } from "./fixture-process.ts";
import { openKv } from "#kv";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MAC_RUNTIME } from "../mac-runtime.ts";
import type { bindNativeCodexAuthPool, refreshNativeCodexAuthIfOwned, setNativeCodexAuthHooksForTest } from "../../src/codex/native-auth.ts";
import type { CODEX_AUTH_POOL_KV_KEY } from "../../src/codex/auth.ts";
import type { initializeKv } from "../../src/kv.ts";
import type { CodexAuthState } from "../../src/types.ts";

const PRODUCTION_ROOT = "/Users/nv/repos/ubiquity/ai.ubq.fi";

const FIXTURE_PARENT = fileURLToPath(new URL("../../.cleanup-evidence/mac-native-auth-fixtures", import.meta.url));
const RELEASE_SHA = "a".repeat(40);
const TIMEOUT_MS = 10_000;
const decoder = new TextDecoder();
// Permission/launcher proof uses a local module graph, not the production dependency graph.

type ChildApi = {
  bindNativeCodexAuthPool: typeof bindNativeCodexAuthPool;
  refreshNativeCodexAuthIfOwned: typeof refreshNativeCodexAuthIfOwned;
  setNativeCodexAuthHooksForTest: typeof setNativeCodexAuthHooksForTest;
  initializeKv: typeof initializeKv;
  CODEX_AUTH_POOL_KV_KEY: typeof CODEX_AUTH_POOL_KV_KEY;
};
type FixtureInput = {
  root: string;
  home: string;
  deniedReads: string[];
  first: CodexAuthState;
  sibling: CodexAuthState;
  absent: boolean;
  runtime: string;
  runtimeHash: string;
  dormantRuntime: string;
  namedFile?: string;
};
type FixtureCase = {
  name: string;
  dotenv?: "custom" | "empty";
  inherited?: boolean;
  noHome?: boolean;
  comma?: boolean;
  missing?: boolean;
  symlink?: boolean;
  absent?: boolean;
  runtimeFailure?: "missing" | "corrupt";
};
type FixtureRun = {
  child: FixtureChild;
  lines: AsyncIterator<string>;
  stderr: Promise<string>;
  writer: Bun.FileSink;
  pid?: number;
};

const bounded = async <T>(work: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(label + " exceeded " + String(TIMEOUT_MS) + "ms"));
        }, TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Runs in the launch-derived restricted child; no home/env/file-reading hook. */
const childFixture = async (api: ChildApi, input: FixtureInput): Promise<void> => {
  const lines = Bun.stdin.stream().pipeThrough(new TextDecoderStream());
  const reader = lines.getReader();
  const nextPhase = async (): Promise<void> => {
    const phase = await reader.read();
    assert.equal(phase.done, false, "the parent must persist the next fake generation");
    assert.equal(phase.value, "persisted\n");
  };
  const message = (phase: string): void => {
    console.log(JSON.stringify({ phase, pid: process.pid }));
  };
  let nativeRefreshes = 0;
  globalThis.fetch = Object.assign(() => Promise.reject(new Error("No real provider call is permitted")), { preconnect: fetch.preconnect });
  assert.equal(Bun.version, "1.4.0");
  assert.equal(process.execPath, input.runtime, "the child must execute the managed fixture artifact");
  process.chdir(input.root);
  assert.equal(process.cwd(), input.root, "the confined service must adopt its canonical repository working directory");
  if (process.platform === "darwin") {
    assert((await readdir(input.root)).includes(".data"), "the root directory-data right needed by getcwd also permits its names");
    for (const name of ["package.json", "bun.lock"]) await assert.rejects(readFile(input.root + "/" + name, "utf8"), denied);
  }
  if (input.namedFile) {
    assert.equal(await readFile(input.namedFile, "utf8"), "synthetic-external-native-leaf");
    await assert.rejects(writeFile(input.namedFile, "forbidden"), denied);
    await assert.rejects(writeFile(input.namedFile.replace("auth.json", "other.txt"), "forbidden"), denied);
  }
  api.setNativeCodexAuthHooksForTest({
    os: "darwin",
    refresh: async (home, email, accountId) => {
      assert.equal(home, input.home);
      assert.equal(email, "uos-native@example.invalid");
      assert.equal(accountId, input.first.account_id);
      nativeRefreshes += 1;
      message("refresh");
      await nextPhase();
    },
  });
  const kv = await openKv(":memory:");
  await writeFile(input.root + "/.data/baseline.txt", "native positive baseline");
  assert.equal(await readFile(input.root + "/.data/baseline.txt", "utf8"), "native positive baseline");
  await assert.rejects(writeFile(input.runtime, "forbidden"), (error) => denied(error) || fsError("ETXTBSY")(error));
  await assert.rejects(writeFile(input.dormantRuntime, "forbidden"), denied);
  await assert.rejects(writeFile(input.root + "/.data/runtimes/other.txt", "forbidden"), denied);
  api.initializeKv(kv);
  const pool = { accounts: [input.first, input.sibling], updated_at_ms: Date.now() };
  await kv.set(api.CODEX_AUTH_POOL_KV_KEY, pool);
  const entry = await kv.get<typeof pool>(api.CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" });
  assert(entry.value);
  const bound = await api.bindNativeCodexAuthPool({ kv, entry, pool });
  const owner = bound.pool.accounts[0];
  if (input.absent) {
    assert.equal(owner.native_owner, undefined, "absent credentials must not bind ownership");
    assert.deepEqual(bound.pool, pool, "absent native credentials must preserve every uploaded account");
    assert.equal(process.env.CODEX_HOME, input.home, "configured home identity must remain verbatim");
    await assert.rejects(readFile(input.home + "/auth.json", "utf8"), fsError("ENOENT"));
    await assert.rejects(writeFile(input.home + "/app-server-control/probe.txt", "control"), fsError("ENOENT"));
    await writeFile(input.root + "/.data/probe.txt", "absent-home-entry");
    for (const path of input.deniedReads) await assert.rejects(readFile(path, "utf8"), denied);
    await assert.rejects(mkdir(input.home, { recursive: true }), denied);
    for (const path of [input.home + "/auth.json", input.home + "/sibling.txt"])
      await assert.rejects(writeFile(path, "forbidden"), (error) => denied(error) || fsError("ENOENT")(error));
    assert.equal(nativeRefreshes, 0);
    process.once("SIGTERM", () => {
      kv.close();
      message("drained");
      process.exit(0);
    });
    message("ready");
    await new Promise<void>(() => {});
    return;
  }
  assert.equal(owner.native_owner?.codex_home, input.home, "real file equality must bind the resolved environment home");
  assert.deepEqual(bound.pool.accounts[1], input.sibling);
  message("bound");
  await nextPhase();
  const adopted = await api.refreshNativeCodexAuthIfOwned(owner);
  assert(adopted);
  assert.equal(adopted.refresh_token, "uos-fake-refresh-2");
  assert.equal(nativeRefreshes, 0, "an already-persisted generation must be adopted without refresh");
  const refreshed = await api.refreshNativeCodexAuthIfOwned(adopted);
  assert(refreshed);
  assert.equal(refreshed.refresh_token, "uos-fake-refresh-3");
  assert.equal(refreshed.native_owner?.codex_home, input.home);
  assert.equal(nativeRefreshes, 1);
  assert.deepEqual((await kv.get<typeof pool>(api.CODEX_AUTH_POOL_KV_KEY)).value?.accounts[1], input.sibling);
  const control = input.home + "/app-server-control/probe.txt";
  await writeFile(control, "scoped-control");
  assert.equal(await readFile(control, "utf8"), "scoped-control");
  await writeFile(input.root + "/.data/probe.txt", "scoped-data");
  for (const path of input.deniedReads) await assert.rejects(readFile(path, "utf8"), denied);
  for (const path of [input.home + "/auth.json", input.home + "/sibling.txt"]) {
    await assert.rejects(writeFile(path, "forbidden"), denied);
  }
  assert.throws(() => Bun.spawn(["/bin/sh", "-c", "exit 0"]), denied);
  const shutdown = (): void => {
    kv.close();
    message("drained");
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  reader.releaseLock();
  await lines.cancel();
  message("ready");
  await new Promise<void>(() => {});
};

const jwt = (generation: number): string =>
  "header." + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + generation * 3600, email: "uos-native@example.invalid", generation })) + ".signature";
const auth = (generation: number, accountId = "uos-native-account"): CodexAuthState => ({
  account_id: accountId,
  access_token: jwt(generation),
  refresh_token: "uos-fake-refresh-" + String(generation),
  updated_at_ms: Date.now(),
});
const authDocument = (state: CodexAuthState): string => JSON.stringify({ auth_mode: "chatgpt", tokens: { ...state, id_token: jwt(1) } });
const decodeXml = (value: string): string =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");

const launcherArguments = async (): Promise<string[]> => {
  const source = await readFile(new URL("../com.ubiquity.ai.local.plist", import.meta.url), "utf8");
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(source)?.[1];
  assert(array);
  const args = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => decodeXml(match[1]));
  assert.deepEqual(args, ["/bin/sh", PRODUCTION_ROOT + "/ops/launch-mac.sh"]);
  const shell = await readFile(new URL("../launch-mac.sh", import.meta.url), "utf8");
  assert(shell.includes("cd -P .data/current"));
  assert(shell.includes("--no-env-file --no-install"));
  assert(shell.includes("ops/launch-service.ts"));
  assert.equal(shell.split(MAC_RUNTIME.binarySha256).length - 1, 2);
  assert(!shell.includes("/Users/nv/.deno/bin/deno"));
  const entry = await readFile(new URL("../launch-service.ts", import.meta.url), "utf8");
  assert(entry.includes('loadEnvFile(join(root, ".env"))'));
  assert(entry.includes('Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile'));
  assert(!/--allow-all|--allow-run|(?:^|\s)-A(?:\s|$)/.test(shell));
  return args;
};

const childSource = (input: FixtureInput): string => {
  const moduleUrl = (path: string): string => JSON.stringify("file://" + input.root + "/.data/releases/" + RELEASE_SHA + "/" + path);
  return [
    'import assert from "node:assert/strict";',
    'import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";',
    'import { openKv } from "#kv";',
    "import { verifyReleasePayload } from " + moduleUrl("ops/release-artifact.ts") + ";",
    "import { nativeKvReleaseBinding } from " + moduleUrl("ops/native-kv-release.ts") + ";",
    "import { prepareNativeKvBackend } from " + moduleUrl("src/storage/native-addon.ts") + ";",
    "const release = " + JSON.stringify(input.root + "/.data/releases/" + RELEASE_SHA) + ";",
    "const manifest = await verifyReleasePayload(release, " + JSON.stringify(RELEASE_SHA) + ");",
    'if (manifest.schema !== 3) throw new Error("Fixture requires schema 3");',
    "prepareNativeKvBackend(nativeKvReleaseBinding(release, manifest.native_kv));",
    "const fsError = code => error => error && error.code === code;",
    'const denied = error => ["EACCES", "EPERM", "EROFS"].includes(error.code);',
    "import { bindNativeCodexAuthPool, refreshNativeCodexAuthIfOwned, setNativeCodexAuthHooksForTest } from " + moduleUrl("src/codex/native-auth.ts") + ";",
    "import { CODEX_AUTH_POOL_KV_KEY } from " + moduleUrl("src/codex/auth.ts") + ";",
    "import { initializeKv } from " + moduleUrl("src/kv.ts") + ";",
    "await (" +
      childFixture.toString() +
      ")({ bindNativeCodexAuthPool, refreshNativeCodexAuthIfOwned, setNativeCodexAuthHooksForTest, initializeKv, CODEX_AUTH_POOL_KV_KEY }, " +
      JSON.stringify(input) +
      ");",
  ].join("\n");
};

const prepareRuntime = async (root: string, testCase: FixtureCase): Promise<{ runtime: string; runtimeHash: string }> => {
  assert.equal(Bun.version, "1.4.0", "run the Mac launcher fixture with the pinned version (CI also pins Bun 1.4.0)");
  const runtime = runtimePath(root, selectedRuntime());
  await mkdir(runtime.slice(0, runtime.lastIndexOf("/")), { recursive: true });
  const hostBytes = await readFile(process.execPath);
  const runtimeHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", hostBytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (testCase.runtimeFailure === "corrupt") await writeFile(runtime, "invalid managed executable");
  else if (testCase.runtimeFailure !== "missing") {
    await copyFile(process.execPath, runtime);
    await chmod(runtime, 0o500);
  }
  return { runtime, runtimeHash };
};

const prepareHomes = async (base: string, custom: string, testCase: FixtureCase, directories: string[]): Promise<void> => {
  for (const directory of directories) {
    if (directory === custom && (testCase.absent || testCase.symlink)) continue;
    await mkdir(directory, { recursive: true });
  }
  if (testCase.symlink) {
    const realHome = base + "/native-real";
    await mkdir(realHome, { recursive: true });
    const linked = await bounded(runFixture("/bin/ln", { args: ["-s", realHome, custom] }), "native alias");
    assert.equal(linked.code, 0, decoder.decode(linked.stderr));
  }
};

const prepare = async (testCase: FixtureCase): Promise<{ base: string; input: FixtureInput; env: Record<string, string> }> => {
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const base = await realpath(await mkdtemp(FIXTURE_PARENT + "/" + "case-"));
  const root = base + "/repo";
  let custom = base + "/custom";
  if (testCase.comma) custom = base + "/native home," + base + "/injected";
  if (testCase.symlink) custom = base + "/native alias,comma";
  const inherited = base + "/inherited";
  const defaultHome = base + "/owner-home/.codex";
  let home = defaultHome;
  if (testCase.dotenv === "custom") home = custom;
  if (testCase.inherited) home = inherited;
  const release = root + "/.data/releases/" + RELEASE_SHA;
  const deniedReads = [base + "/unrelated/secret.txt", base + "/native home/auth.json", base + "/injected/auth.json"];
  if (home !== defaultHome) deniedReads.push(defaultHome + "/auth.json");
  if (home !== custom) deniedReads.push(custom + "/auth.json");
  await prepareHomes(base, custom, testCase, [
    release,
    root + "/.data/deno",
    custom,
    inherited,
    defaultHome,
    base + "/unrelated",
    base + "/native home",
    base + "/injected",
  ]);
  const { runtime, runtimeHash } = await prepareRuntime(root, testCase);
  const dormantRuntime = runtime.slice(0, runtime.lastIndexOf("/")) + "/dormant-bun";
  await writeFile(dormantRuntime, "unrestricted dormant-runtime baseline");
  assert.equal(await readFile(dormantRuntime, "utf8"), "unrestricted dormant-runtime baseline");
  await copyFile(process.execPath, dormantRuntime);
  const namedFile = base + "/owner-home/.codex-ubiquity/auth.json";
  await mkdir(base + "/owner-home/.codex-ubiquity", { recursive: true });
  await writeFile(namedFile, "synthetic-external-native-leaf");
  const input = {
    root,
    home,
    deniedReads,
    first: auth(1),
    sibling: auth(1, "uos-uploaded-sibling"),
    absent: Boolean(testCase.absent),
    runtime,
    runtimeHash,
    dormantRuntime,
    namedFile: process.platform !== "darwin" || testCase.noHome || testCase.missing ? undefined : namedFile,
  };
  if (!testCase.absent) await mkdir(home + "/app-server-control", { recursive: true });
  await mkdir(release + "/scripts", { recursive: true });
  if (!testCase.absent) await writeFile(home + "/auth.json", authDocument(input.first));
  for (const path of deniedReads) await writeFile(path, "private-fake-sentinel");
  await cp(new URL("../../src", import.meta.url), release + "/src", { recursive: true });
  await mkdir(release + "/ops", { recursive: true });
  await copyOps(release + "/ops");
  await copyFile(new URL("../launch-service.ts", import.meta.url), release + "/ops/launch-service.ts");
  await writePackage(release, { "#kv": "./src/storage/kv.ts", "#http": "./src/runtime/http.ts" });
  await writeFile(release + "/scripts/serve-vps.ts", childSource(input));
  await writeFile(release + "/scripts/serve-mac.ts", childSource(input));
  await mkdir(root + "/bin", { recursive: true });
  await writeFile(root + "/bin/bun", "#!/bin/sh\nexit 72\n", { mode: 0o700 });
  await packageFixture(release, RELEASE_SHA, "0".repeat(64));
  await writeFile(root + "/package.json", "mutable root config sentinel");
  await writeFile(root + "/bun.lock", "mutable root lock sentinel");
  let dotenv = "";
  if (testCase.dotenv === "custom") dotenv = "CODEX_HOME='" + custom + "'\n";
  if (testCase.dotenv === "empty") dotenv = "CODEX_HOME=\n";
  await writeFile(root + "/.env", dotenv);
  // The real .data/current release-selection command remains intact.
  const linked = await bounded(runFixture("/bin/ln", { args: ["-s", "releases/" + RELEASE_SHA, root + "/.data/current"] }), "release link");
  assert.equal(linked.code, 0, decoder.decode(linked.stderr));
  const env: Record<string, string> = {
    PATH: root + "/bin:/usr/bin:/bin",
    TMPDIR: base,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    DENO_TIMELINE: "production",
    DENO_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  if (!testCase.noHome && !testCase.missing) env.HOME = base + "/owner-home";
  if (testCase.inherited) env.CODEX_HOME = inherited;
  return { base, input, env };
};

async function* outputLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffer += decoder.decode(new Uint8Array(chunk), { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

/**
 * The tracked plist pins the Mac absolute hash tool. A non-Mac host can still
 * run this fixture with the same real shasum interface from another absolute
 * path (Arch: /usr/bin/core_perl/shasum): the fixture substitutes that real
 * executable only when the pinned Mac path is absent, and the unchanged
 * integrity guard still verifies the real digest, so no check is weakened.
 */
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const start = async (_args: string[], input: FixtureInput, env: Record<string, string>): Promise<FixtureRun> => {
  const name = process.platform === "darwin" ? "launch-mac.sh" : "launch-vps.sh";
  const source = await readFile(new URL("../" + name, import.meta.url), "utf8");
  const artifact = selectedRuntime();
  const relocated = source.replaceAll(artifact.binarySha256, input.runtimeHash);
  assert.equal(relocated.replaceAll(input.runtimeHash, artifact.binarySha256), source, "only the disposable runtime digest may change");
  await mkdir(input.root + "/ops", { recursive: true });
  await writeFile(input.root + "/ops/" + name, relocated);
  await copyFile(new URL("../runtime-bunfig.toml", import.meta.url), input.root + "/ops/runtime-bunfig.toml");
  let command = "exec /bin/sh " + quote(input.root + "/ops/" + name);
  if (process.platform === "linux") {
    command = [
      "set -eu",
      ...["releases", "runtimes"].flatMap((directory) => [
        "mount --bind " + quote(input.root + "/.data/" + directory) + " " + quote(input.root + "/.data/" + directory),
        "mount -o remount,bind,ro " + quote(input.root + "/.data/" + directory),
      ]),
      command,
    ].join("\n");
  }
  const child = spawnFixture(process.platform === "linux" ? "/usr/bin/unshare" : "/bin/sh", {
    args: process.platform === "linux" ? ["-Urm", "/bin/sh", "-c", command] : ["-c", command],
    cwd: input.root,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  return { child, lines: outputLines(child.stdout), stderr: new Response(child.stderr).text(), writer: child.stdin };
};

const phase = async (run: FixtureRun, expected: string): Promise<void> => {
  const next = await bounded(run.lines.next(), expected + " phase");
  if (next.done) throw new Error("Child exited before " + expected + ": " + (await bounded(run.stderr, "child stderr")));
  const message: { phase: string; pid: number } = JSON.parse(next.value);
  assert.equal(message.phase, expected);
  assert.equal(typeof message.pid, "number");
  run.pid = message.pid;
};
const persisted = async (run: FixtureRun, home: string, generation: number): Promise<void> => {
  await writeFile(home + "/auth.json", authDocument(auth(generation)));
  await Promise.resolve(run.writer.write(new TextEncoder().encode("persisted\n")));
  await bounded(Promise.resolve(run.writer.flush()), "persisted input");
};
const assertGone = async (pid: number): Promise<void> => {
  const result = await bounded(runFixture("/bin/sh", { args: ["-c", 'kill -0 "$1" 2>/dev/null', "--", String(pid)] }), "server exit");
  assert.notEqual(result.code, 0, "Fixture PID " + String(pid) + " must be settled");
};
const stop = async (run: FixtureRun): Promise<void> => {
  try {
    run.child.kill("SIGKILL");
  } catch {
    // A normal signal acceptance already settled this exact task-owned process.
  }
  await bounded(Promise.resolve(run.writer.end()), "stdin close").catch(() => {});
  await bounded(run.child.exited, "outer cleanup");
  if (run.pid) {
    const result = await bounded(runFixture("/bin/sh", { args: ["-c", 'kill -KILL "$1" 2>/dev/null || true', "--", String(run.pid)] }), "server cleanup");
    assert.equal(result.code, 0);
    await assertGone(run.pid);
  }
  await bounded(run.stderr, "stderr settlement");
};

const cases: FixtureCase[] = [
  { name: "dotenv custom home", dotenv: "custom" },
  { name: "default home" },
  { name: "empty override", dotenv: "empty" },
  { name: "inherited override wins", dotenv: "custom", inherited: true },
  { name: "spaces and literal comma", dotenv: "custom", comma: true },
  { name: "custom without HOME", dotenv: "custom", noHome: true },
  { name: "missing home refuses startup", missing: true },
  { name: "literal symlink alias", dotenv: "custom", symlink: true },
  { name: "absent native directory permits entry", dotenv: "custom", absent: true },
  { name: "missing managed runtime fails closed", runtimeFailure: "missing" },
  { name: "corrupt managed runtime fails closed", runtimeFailure: "corrupt" },
];

for (const testCase of cases) {
  test("Mac plist native permissions: " + testCase.name, async () => {
    const args = await launcherArguments();
    const { base, input, env } = await prepare(testCase);
    const release = input.root + "/.data/releases/" + RELEASE_SHA;
    const immutablePackage = await readFile(release + "/package.json", "utf8");
    const immutableLock = await readFile(release + "/bun.lock", "utf8");
    let run: FixtureRun | undefined;
    try {
      if (testCase.missing)
        assert.match(
          await readFile(new URL("../launch-service.ts", import.meta.url), "utf8"),
          /HOME or CODEX_HOME is required/,
          "Do not execute a missing-HOME child until the launcher refuses fallback to a real native home"
        );
      run = await start(args, input, env);
      if (testCase.missing || testCase.runtimeFailure) {
        const status = await bounded(run.child.exited, "missing-home exit");
        assert.notEqual(status, 0);
        const stderr = await bounded(run.stderr, "startup-refusal stderr");
        assert.match(stderr, testCase.runtimeFailure ? /integrity|invalid|test|No such file/ : /HOME or CODEX_HOME is required/);
        assert.equal((await bounded(run.lines.next(), "missing-home output")).done, true, "entry must never run");
        return;
      }
      if (!testCase.absent) {
        await phase(run, "bound");
        await persisted(run, input.home, 2);
        await phase(run, "refresh");
        await persisted(run, input.home, 3);
      }
      await phase(run, "ready");
      assert(run.pid);
      if (process.platform === "darwin") assert.notEqual(run.pid, run.child.pid, "the Seatbelt supervisor forwards the signal to its server child");
      run.child.kill("SIGTERM");
      await phase(run, "drained");
      await bounded(run.child.exited, "task SIGTERM settlement");
      assert.equal((await bounded(run.lines.next(), "descendant stdout settlement")).done, true);
      await assertGone(run.pid);
      if (testCase.absent) {
        await assert.rejects(readFile(input.home + "/auth.json", "utf8"), fsError("ENOENT"));
        assert.equal(await readFile(input.root + "/.data/probe.txt", "utf8"), "absent-home-entry");
      } else {
        const document: { tokens: { refresh_token: string } } = JSON.parse(await readFile(input.home + "/auth.json", "utf8"));
        assert.equal(document.tokens.refresh_token, "uos-fake-refresh-3", "credential-write denials must preserve the parent's persisted file");
      }
      assert.equal(await readFile(release + "/package.json", "utf8"), immutablePackage);
      assert.equal(await readFile(release + "/bun.lock", "utf8"), immutableLock);
      assert.equal(await readFile(input.root + "/package.json", "utf8"), "mutable root config sentinel");
      assert.equal(await readFile(input.root + "/bun.lock", "utf8"), "mutable root lock sentinel");
      console.log(
        JSON.stringify({
          case: testCase.name,
          runtimeHash: input.runtimeHash,
          actualKernel: process.platform,
          realSeatbelt: process.platform === "darwin",
          taskPid: run.child.pid,
          serverPid: run.pid,
          settled: true,
        })
      );
      run.pid = undefined;
    } finally {
      if (run) await stop(run);
      await rm(base, { recursive: true });
    }
  });
}

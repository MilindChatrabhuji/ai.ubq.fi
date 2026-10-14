import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MAC_RUNTIME } from "../mac-runtime.ts";
import type { bindNativeCodexAuthPool, refreshNativeCodexAuthIfOwned, setNativeCodexAuthHooksForTest } from "../../src/codex/native-auth.ts";
import type { CODEX_AUTH_POOL_KV_KEY } from "../../src/codex/auth.ts";
import type { initializeKv } from "../../src/kv.ts";
import type { CodexAuthState } from "../../src/types.ts";

const PRODUCTION_ROOT = "/Users/nv/repos/ubiquity/ai.ubq.fi";
const RUNTIME_RELATIVE = ".data/runtimes/deno/" + MAC_RUNTIME.version + "-" + MAC_RUNTIME.binarySha256 + "/deno";
const FIXTURE_PARENT = fileURLToPath(new URL("../../.cleanup-evidence/mac-native-auth-fixtures", import.meta.url));
const RELEASE_SHA = "a".repeat(40);
const TIMEOUT_MS = 10_000;
const decoder = new TextDecoder();
// Permission/launcher proof uses a local module graph, not the production dependency graph.
const FIXTURE_CONFIGURATION = '{"workspace":[],"nodeModulesDir":"none"}\n';
const FIXTURE_LOCK = '{"version":"5","specifiers":{}}\n';

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
  child: Deno.ChildProcess;
  lines: AsyncIterator<string>;
  stderr: Promise<string>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
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
  const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream());
  const reader = lines.getReader();
  const nextPhase = async (): Promise<void> => {
    const phase = await reader.read();
    assert.equal(phase.done, false, "the parent must persist the next fake generation");
    assert.equal(phase.value, "persisted\n");
  };
  const message = (phase: string): void => {
    console.log(JSON.stringify({ phase, pid: Deno.pid }));
  };
  let nativeRefreshes = 0;
  globalThis.fetch = () => Promise.reject(new Error("No real provider call is permitted"));
  assert.equal(Deno.version.deno, "2.9.5");
  assert.equal(Deno.execPath(), input.runtime, "the child must execute the managed fixture artifact");
  await assert.rejects(Deno.writeTextFile(input.runtime, "forbidden"), Deno.errors.NotCapable);
  await assert.rejects(Deno.writeTextFile(input.root + "/.data/runtimes/other.txt", "forbidden"), Deno.errors.NotCapable);
  if (input.namedFile) {
    assert.equal(await Deno.readTextFile(input.namedFile), "synthetic-external-native-leaf");
    await assert.rejects(Deno.writeTextFile(input.namedFile, "forbidden"), Deno.errors.NotCapable);
    await assert.rejects(Deno.writeTextFile(input.namedFile.replace("auth.json", "other.txt"), "forbidden"), Deno.errors.NotCapable);
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
  const kv = await Deno.openKv(":memory:");
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
    assert.equal(Deno.env.get("CODEX_HOME"), input.home, "configured home identity must remain verbatim");
    await assert.rejects(Deno.readTextFile(input.home + "/auth.json"), Deno.errors.NotFound);
    await assert.rejects(Deno.writeTextFile(input.home + "/app-server-control/probe.txt", "control"), Deno.errors.NotFound);
    await Deno.writeTextFile(input.root + "/.data/probe.txt", "absent-home-entry");
    for (const path of input.deniedReads) await assert.rejects(Deno.readTextFile(path), Deno.errors.NotCapable);
    for (const path of [input.home + "/auth.json", input.home + "/sibling.txt"])
      await assert.rejects(Deno.writeTextFile(path, "forbidden"), Deno.errors.NotCapable);
    assert.equal(nativeRefreshes, 0);
    Deno.addSignalListener("SIGTERM", () => {
      kv.close();
      message("drained");
      Deno.exit(0);
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
  await Deno.writeTextFile(control, "scoped-control");
  assert.equal(await Deno.readTextFile(control), "scoped-control");
  await Deno.writeTextFile(input.root + "/.data/probe.txt", "scoped-data");
  for (const path of input.deniedReads) await assert.rejects(Deno.readTextFile(path), Deno.errors.NotCapable);
  for (const path of [input.home + "/auth.json", input.home + "/sibling.txt"]) {
    await assert.rejects(Deno.writeTextFile(path, "forbidden"), Deno.errors.NotCapable);
  }
  assert.notEqual((await Deno.permissions.query({ name: "run" })).state, "granted");
  const shutdown = (): void => {
    kv.close();
    message("drained");
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGTERM", shutdown);
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
  const source = await Deno.readTextFile(new URL("../com.ubiquity.ai.local.plist", import.meta.url));
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(source)?.[1];
  assert(array, "the tracked plist must have ProgramArguments");
  const args = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => decodeXml(match[1]));
  assert.deepEqual(args.slice(0, 2), ["/bin/sh", "-c"]);
  assert.equal(args.length, 3);
  assert(args[2].includes("cd -P .data/current"));
  assert(args[2].includes(" task "));
  assert(args[2].includes("--env-file=" + PRODUCTION_ROOT + "/.env"));
  assert(args[2].includes(" --eval "));
  assert(args[2].includes('--config="$PWD/deno.json" --no-lock'));
  assert(args[2].includes("--deny-write=" + PRODUCTION_ROOT + "/.data/runtimes"));
  assert.equal(args[2].split(MAC_RUNTIME.binarySha256).length - 1, 3, "both paths and integrity guard must keep the production pin");
  assert(!args[2].includes("/Users/nv/.deno/bin/deno"));
  assert(!/--allow-all|--allow-run|(?:^|\s)-A(?:\s|$)/.test(args[2]));
  return args;
};

const childSource = (input: FixtureInput): string => {
  const moduleUrl = (path: string): string => JSON.stringify(new URL("../../" + path, import.meta.url).href);
  return [
    'import assert from "node:assert/strict";',
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
  assert.equal(Deno.version.deno, "2.9.5", "run the Mac launcher fixture with the pinned version (CI also pins2.9.5)");
  const runtime = root + "/" + RUNTIME_RELATIVE;
  await Deno.mkdir(runtime.slice(0, runtime.lastIndexOf("/")), { recursive: true });
  const hostBytes = await Deno.readFile(Deno.execPath());
  const runtimeHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", hostBytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (testCase.runtimeFailure === "corrupt") await Deno.writeTextFile(runtime, "invalid managed executable");
  else if (testCase.runtimeFailure !== "missing") {
    await Deno.copyFile(Deno.execPath(), runtime);
    await Deno.chmod(runtime, 0o500);
  }
  return { runtime, runtimeHash };
};

const prepareHomes = async (base: string, custom: string, testCase: FixtureCase, directories: string[]): Promise<void> => {
  for (const directory of directories) {
    if (directory === custom && (testCase.absent || testCase.symlink)) continue;
    await Deno.mkdir(directory, { recursive: true });
  }
  if (testCase.symlink) {
    const realHome = base + "/native-real";
    await Deno.mkdir(realHome, { recursive: true });
    const linked = await bounded(new Deno.Command("/bin/ln", { args: ["-s", realHome, custom] }).output(), "native alias");
    assert.equal(linked.code, 0, decoder.decode(linked.stderr));
  }
};

const prepare = async (testCase: FixtureCase): Promise<{ base: string; input: FixtureInput; env: Record<string, string> }> => {
  await Deno.mkdir(FIXTURE_PARENT, { recursive: true });
  const base = await Deno.realPath(await Deno.makeTempDir({ dir: FIXTURE_PARENT, prefix: "case-" }));
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
  const namedFile = base + "/owner-home/.codex-ubiquity/auth.json";
  await Deno.mkdir(base + "/owner-home/.codex-ubiquity", { recursive: true });
  await Deno.writeTextFile(namedFile, "synthetic-external-native-leaf");
  const input = {
    root,
    home,
    deniedReads,
    first: auth(1),
    sibling: auth(1, "uos-uploaded-sibling"),
    absent: Boolean(testCase.absent),
    runtime,
    runtimeHash,
    namedFile: testCase.noHome || testCase.missing ? undefined : namedFile,
  };
  if (!testCase.absent) await Deno.mkdir(home + "/app-server-control", { recursive: true });
  await Deno.mkdir(release + "/scripts", { recursive: true });
  if (!testCase.absent) await Deno.writeTextFile(home + "/auth.json", authDocument(input.first));
  for (const path of deniedReads) await Deno.writeTextFile(path, "private-fake-sentinel");
  await Deno.writeTextFile(release + "/deno.json", FIXTURE_CONFIGURATION);
  await Deno.writeTextFile(release + "/deno.lock", FIXTURE_LOCK);
  // An ancestor is deliberately invalid; selected physical release config must win.
  await Deno.writeTextFile(root + "/deno.json", "mutable root config sentinel");
  await Deno.writeTextFile(root + "/deno.lock", "mutable root lock sentinel");
  await Deno.mkdir(root + "/bin", { recursive: true });
  await Deno.writeTextFile(root + "/bin/deno", "#!/bin/sh\nexit 72\n");
  await Deno.chmod(root + "/bin/deno", 0o700);
  await Deno.writeTextFile(release + "/scripts/native-auth-fixture.ts", childSource(input));
  let dotenv = "";
  if (testCase.dotenv === "custom") dotenv = "CODEX_HOME='" + custom + "'\n";
  if (testCase.dotenv === "empty") dotenv = "CODEX_HOME=\n";
  await Deno.writeTextFile(root + "/.env", dotenv);
  // The real .data/current release-selection command remains intact.
  const linked = await bounded(new Deno.Command("/bin/ln", { args: ["-s", "releases/" + RELEASE_SHA, root + "/.data/current"] }).output(), "release link");
  assert.equal(linked.code, 0, decoder.decode(linked.stderr));
  const env: Record<string, string> = {
    PATH: root + "/bin:/usr/bin:/bin",
    TMPDIR: base,
    DENO_DIR: root + "/.data/deno",
    DENO_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  if (!testCase.noHome && !testCase.missing) env.HOME = base + "/owner-home";
  if (testCase.inherited) env.CODEX_HOME = inherited;
  return { base, input, env };
};

async function* outputLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = "";
  for await (const text of stream.pipeThrough(new TextDecoderStream())) {
    buffer += text;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer) yield buffer;
}

/**
 * The tracked plist pins the Mac absolute hash tool. A non-Mac host can still
 * run this fixture with the same real shasum interface from another absolute
 * path (Arch: /usr/bin/core_perl/shasum): the fixture substitutes that real
 * executable only when the pinned Mac path is absent, and the unchanged
 * integrity guard still verifies the real digest, so no check is weakened.
 */
const MAC_HASH_EXECUTABLE = "/usr/bin/shasum";
const hostHashExecutable = async (): Promise<string> => {
  for (const candidate of [MAC_HASH_EXECUTABLE, "/usr/bin/core_perl/shasum"]) {
    const probe = await new Deno.Command("/bin/sh", { args: ["-c", 'test -x "$1"', "--", candidate] }).output();
    if (probe.code === 0) return candidate;
  }
  throw new Error("No real shasum executable is available for the Mac launcher fixture");
};

const start = async (args: string[], input: FixtureInput, env: Record<string, string>): Promise<FixtureRun> => {
  const hashExecutable = await hostHashExecutable();
  const command = args[2]
    .replaceAll(PRODUCTION_ROOT, input.root)
    .replace("!= " + MAC_RUNTIME.binarySha256, "!= " + input.runtimeHash)
    .replaceAll(MAC_HASH_EXECUTABLE, hashExecutable)
    .replace("scripts/serve-mac.ts", "scripts/native-auth-fixture.ts");
  const child = new Deno.Command(args[0], {
    args: [args[1], command],
    cwd: input.root,
    clearEnv: true,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return { child, lines: outputLines(child.stdout), stderr: new Response(child.stderr).text(), writer: child.stdin.getWriter() };
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
  await Deno.writeTextFile(home + "/auth.json", authDocument(auth(generation)));
  await bounded(run.writer.write(new TextEncoder().encode("persisted\n")), "persisted input");
};
const assertGone = async (pid: number): Promise<void> => {
  const result = await bounded(new Deno.Command("/bin/sh", { args: ["-c", 'kill -0 "$1" 2>/dev/null', "--", String(pid)] }).output(), "server exit");
  assert.notEqual(result.code, 0, "Fixture PID " + String(pid) + " must be settled");
};
const stop = async (run: FixtureRun): Promise<void> => {
  try {
    run.child.kill("SIGKILL");
  } catch {
    // A normal signal acceptance already settled this exact task-owned process.
  }
  await bounded(run.writer.close(), "stdin close").catch(() => {});
  await bounded(run.child.status, "outer cleanup");
  if (run.pid) {
    const result = await bounded(
      new Deno.Command("/bin/sh", { args: ["-c", 'kill -KILL "$1" 2>/dev/null || true', "--", String(run.pid)] }).output(),
      "server cleanup"
    );
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

Deno.test("Mac named native leaf read grant has a matched negative control", async () => {
  const args = await launcherArguments();
  const anchor = "uos_permissions_read=$uos_permissions_read,${uos_consumer_file%_};";
  assert.equal(args[2].split(anchor).length, 2, "the negative control must remove the actual composed named-file grant");
  args[2] = args[2].replace(anchor, "uos_permissions_read=$uos_permissions_read;");
  const { base, input, env } = await prepare({ name: "named read negative control" });
  let run: FixtureRun | undefined;
  try {
    run = await start(args, input, env);
    const status = await bounded(run.child.status, "negative read grant exit");
    assert.notEqual(status.code, 0);
    assert.match(await bounded(run.stderr, "negative read grant stderr"), /read access|NotCapable/);
    assert(input.namedFile);
    assert.equal(await Deno.readTextFile(input.namedFile), "synthetic-external-native-leaf");
  } finally {
    if (run) await stop(run);
    await Deno.remove(base, { recursive: true });
  }
});

for (const testCase of cases) {
  Deno.test("Mac plist native permissions: " + testCase.name, async () => {
    const args = await launcherArguments();
    const { base, input, env } = await prepare(testCase);
    let run: FixtureRun | undefined;
    try {
      run = await start(args, input, env);
      if (testCase.missing || testCase.runtimeFailure) {
        const status = await bounded(run.child.status, "missing-home exit");
        assert.notEqual(status.code, 0);
        const stderr = await bounded(run.stderr, "startup-refusal stderr");
        assert.match(stderr, testCase.runtimeFailure ? /Managed Mac runtime unavailable or invalid/ : /HOME or CODEX_HOME is required/);
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
      assert.notEqual(run.pid, run.child.pid, "the supervisor must forward the signal to its server child");
      run.child.kill("SIGTERM");
      await phase(run, "drained");
      await bounded(run.child.status, "task SIGTERM settlement");
      assert.equal((await bounded(run.lines.next(), "descendant stdout settlement")).done, true);
      await assertGone(run.pid);
      if (testCase.absent) {
        await assert.rejects(Deno.readTextFile(input.home + "/auth.json"), Deno.errors.NotFound);
        assert.equal(await Deno.readTextFile(input.root + "/.data/probe.txt"), "absent-home-entry");
      } else {
        const document: { tokens: { refresh_token: string } } = JSON.parse(await Deno.readTextFile(input.home + "/auth.json"));
        assert.equal(document.tokens.refresh_token, "uos-fake-refresh-3", "credential-write denials must preserve the parent's persisted file");
      }
      const release = input.root + "/.data/releases/" + RELEASE_SHA;
      assert.equal(await Deno.readTextFile(release + "/deno.json"), FIXTURE_CONFIGURATION);
      assert.equal(await Deno.readTextFile(release + "/deno.lock"), FIXTURE_LOCK);
      assert.equal(await Deno.readTextFile(input.root + "/deno.json"), "mutable root config sentinel");
      assert.equal(await Deno.readTextFile(input.root + "/deno.lock"), "mutable root lock sentinel");
      console.log(JSON.stringify({ case: testCase.name, runtimeHash: input.runtimeHash, taskPid: run.child.pid, serverPid: run.pid, settled: true }));
      run.pid = undefined;
    } finally {
      if (run) await stop(run);
      await Deno.remove(base, { recursive: true });
    }
  });
}

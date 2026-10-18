import { test } from "bun:test";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { spawnFixture, runFixture, outputFixture, fsError, type FixtureChild, type FixtureOutput } from "../ops/tests/fixture-process.ts";
import { copyOps, copyRuntime, copyRuntimeModules, repository, seedStore, writePackage } from "../ops/tests/fixture-release.ts";
import { currentTestNativeKvBinding } from "../scripts/test-native-kv.ts";
import { acquireDeployLock } from "../ops/deploy-lock.ts";
import { bindPreparedVpsPayload, type VpsPayloadPreparation } from "../ops/vps-release-store.ts";
import { serveHttp, type HttpServer } from "#http";
import { openKv } from "#kv";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const VPS_LAUNCHER = await readFile(new URL("../scripts/serve-vps.ts", import.meta.url), "utf8");
const VPS_UNIT = await readFile(new URL("../ops/ai-ubq-fi.service", import.meta.url), "utf8");

const OPS_DEPLOY_SOURCE = fileURLToPath(new URL("../ops/deploy.ts", import.meta.url));
const CANONICAL_ROOT_LITERAL = '"/home/codex/repos/ubiquity/ai.ubq.fi"';
const FIXTURE_PARENT = fileURLToPath(new URL("../.cleanup-evidence/vps-deploy-guards-fixtures", import.meta.url));
const CHILD_TIMEOUT_MS = 30_000;
const PREFLIGHT_TIMEOUT_MS = 15_000;
const FIXTURE_IDENTITY = { name: "vps-deploy-guards-fixture", email: "vps-deploy-guards-fixture@example.invalid" } as const;

// Every dedicated profile executes its fixture capabilities; no availability skips.
const fixtureHostPath = process.env.PATH ?? "/usr/bin:/bin";
assert.equal((await runFixture("git", { args: ["--version"], env: { PATH: fixtureHostPath } })).code, 0);
assert.equal((await runFixture(process.execPath, { args: ["--no-env-file", "--version"] })).code, 0);
type FixtureRun = { code: number; stdout: string; stderr: string };
type Fixture = { root: string; script: string; env: Record<string, string>; dispose: () => Promise<void>; previous?: string };
type DeployOptions = { write?: string; env?: Record<string, string>; fakeCommands?: string[]; script?: string; allowLn?: boolean; network?: boolean };

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Every fixture Git call runs with a synthetic identity and no global, system,
 * template, hook, or signing configuration. The child environment is replaced
 * rather than extended, so fixture Git and the fixture deploy process never
 * observe host environment, credential, or `.env` state, and no remote is ever
 * configured.
 */
const fixtureEnvironment = (root: string, hostPath: string): Record<string, string> => ({
  PATH: hostPath,
  HOME: root,
  DENO_DIR: `${root}/.deno-cache`,
  NO_COLOR: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
});

const runFixtureGit = async (root: string, env: Record<string, string>, args: string[]): Promise<string> => {
  const result = await runFixture("git", { args, cwd: root, env, clearEnv: true, stdout: "piped", stderr: "piped" });
  if (!result.success) throw new Error(`fixture git ${args.join(" ")} failed: ${decode(result.stderr).trim()}`);
  return decode(result.stdout).trim();
};

/**
 * Writes the disposable script copy used by the relocated fixtures. The copy is
 * byte-identical to `ops/deploy.ts` except for the canonical-root constant, and
 * that is proven rather than assumed: the literal must occur exactly once, the
 * fixture path must appear exactly once in the copy, and restoring the original
 * literal must reproduce the source byte for byte, so no guard or lock logic can
 * have been altered by the relocation.
 */
const relocateDeployScript = async (root: string): Promise<string> => {
  const source = await readFile(OPS_DEPLOY_SOURCE, "utf8");
  assert.equal(source.split(CANONICAL_ROOT_LITERAL).length - 1, 1, "ops/deploy.ts must contain exactly one canonical-root literal");
  const replacement = JSON.stringify(root);
  const relocated = source.replace(CANONICAL_ROOT_LITERAL, replacement);
  assert.equal(relocated.split(replacement).length - 1, 1, "the relocated canonical root must appear exactly once");
  assert.equal(relocated.replace(replacement, CANONICAL_ROOT_LITERAL), source, "relocation must change only the canonical-root constant");
  const script = `${root}/deploy.fixture.ts`;
  await writeFile(script, relocated);
  return script;
};

/**
 * The relocated copy imports `./release-retention.ts` exactly as `ops/deploy.ts`
 * does, and the deploy child may read only the fixture root, so the real module
 * must sit beside it. It is copied from the repository source rather than
 * stubbed, so the fixtures keep exercising the production import chain, and it
 * needs no relocation of its own: every path it uses is relative to the working
 * directory.
 */
const relocateRetentionModule = async (root: string): Promise<void> => {
  await copyOps(root);
  for (const name of ["vps-release-store.ts", "vps-release-journal.ts", "vps-release-contract.ts", "vps-ingress.ts"])
    await writeFile(`${root}/${name}`, await readFile(new URL("../ops/" + name, import.meta.url)));
};

const createFixture = async (options: { branch: string; tracking: "match" | "mismatch" | "missing"; relocate: boolean }): Promise<Fixture> => {
  const hostPath = fixtureHostPath;
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const root = await realpath(await mkdtemp(FIXTURE_PARENT + "/" + "case-"));
  const env = fixtureEnvironment(root, hostPath);
  await mkdir(`${root}/empty-hooks`, { recursive: true });
  await runFixtureGit(root, env, ["-c", `init.templateDir=${root}/empty-hooks`, "init", "-q"]);
  await runFixtureGit(root, env, ["symbolic-ref", "HEAD", "refs/heads/development"]);
  await runFixtureGit(root, env, ["config", "core.hooksPath", `${root}/empty-hooks`]);
  await runFixtureGit(root, env, ["config", "commit.gpgsign", "false"]);
  await runFixtureGit(root, env, ["config", "tag.gpgsign", "false"]);
  await runFixtureGit(root, env, ["config", "user.name", FIXTURE_IDENTITY.name]);
  await runFixtureGit(root, env, ["config", "user.email", FIXTURE_IDENTITY.email]);
  const script = options.relocate ? await relocateDeployScript(root) : OPS_DEPLOY_SOURCE;
  if (options.relocate) await relocateRetentionModule(root);
  await writeFile(`${root}/release.txt`, "fixture release\n");
  await runFixtureGit(root, env, ["add", "--", "release.txt"]);
  // The relocated script and the module it imports are committed with the
  // release so the fixture checkout stays tracked-clean for the guard's
  // `git status --porcelain --untracked-files=no` check.
  if (options.relocate) await runFixtureGit(root, env, ["add", "--", "."]);
  await runFixtureGit(root, env, ["commit", "-q", "-m", "fixture release"]);
  const releaseSha = await runFixtureGit(root, env, ["rev-parse", "HEAD"]);
  if (options.tracking === "mismatch") {
    await writeFile(`${root}/next.txt`, "newer local change\n");
    await runFixtureGit(root, env, ["add", "--", "next.txt"]);
    await runFixtureGit(root, env, ["commit", "-q", "-m", "newer local change"]);
    await runFixtureGit(root, env, ["update-ref", "refs/remotes/origin/development", releaseSha]);
  } else if (options.tracking === "match") {
    await runFixtureGit(root, env, ["update-ref", "refs/remotes/origin/development", releaseSha]);
  }
  if (options.branch !== "development") {
    await runFixtureGit(root, env, ["update-ref", `refs/heads/${options.branch}`, releaseSha]);
    await runFixtureGit(root, env, ["symbolic-ref", "HEAD", `refs/heads/${options.branch}`]);
  }
  assert.equal(await runFixtureGit(root, env, ["branch", "--show-current"]), options.branch, "fixture branch setup failed");
  return {
    root,
    script,
    env,
    dispose: async () => {
      await rm(root, { recursive: true }).catch(() => {});
      await rm(FIXTURE_PARENT).catch(() => {});
    },
  };
};

/**
 * The deploy child gets only `git` execution plus read access to its disposable
 * fixture. The lock-wait case additionally gets write access to that fixture's
 * `.data` directory alone. Ingress cases may also execute exact task-owned fake
 * command paths. No child can execute real sudo, gh, or tar or use the network.
 */
const launchDeployFixture = (fixture: Fixture, options: DeployOptions = {}): FixtureChild => {
  const script = options.script ?? fixture.script;
  const command =
    options.write === undefined
      ? [
          "set -eu",
          "mount --bind " + quote(fixture.root) + " " + quote(fixture.root),
          "mount -o remount,bind,ro " + quote(fixture.root),
          "cd -P " + quote(fixture.root),
          "exec " + quote(process.execPath) + " --no-env-file --no-install " + quote(script),
        ].join("\n")
      : "exec " + quote(process.execPath) + " --no-env-file --no-install " + quote(script);
  return spawnFixture(options.write === undefined ? "/usr/bin/unshare" : "/bin/sh", {
    args: options.write === undefined ? ["-Urm", "/bin/sh", "-c", command] : ["-c", command],
    cwd: fixture.root,
    env: options.env ?? fixture.env,
    stdout: "piped",
    stderr: "piped",
  });
};

const killChild = (child: FixtureChild): void => {
  try {
    child.kill("SIGKILL");
  } catch {
    /* The child already exited. */
  }
};

/**
 * Bounded settlement: the child is killed and reaped if it does not settle, so a
 * failed assertion cannot leave a fixture process behind.
 */
const settleChild = async (child: FixtureChild, timeoutMs: number): Promise<FixtureRun> => {
  const output = outputFixture(child);
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    killChild(child);
    timeout.reject(new Error(`the deploy fixture child did not settle within ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    const result = await Promise.race([output, timeout.promise]);
    return { code: result.code, stdout: decode(result.stdout), stderr: decode(result.stderr) };
  } catch (error) {
    await output.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const runDeployFixture = (fixture: Fixture, options: DeployOptions = {}): Promise<FixtureRun> =>
  settleChild(launchDeployFixture(fixture, options), CHILD_TIMEOUT_MS);

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (fsError("ENOENT")(error)) return false;
    throw error;
  }
};

const readDirNames = async (path: string): Promise<string[]> => {
  const names: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) names.push(entry.name);
  return names.sort((a, b) => a.localeCompare(b));
};

const waitForPath = async (path: string, timeoutMs: number, label: string): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await pathExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const RELOAD_COMMAND = "sudo -n systemctl reload caddy";
const RESTART_COMMAND = "sudo -n systemctl restart ai-ubq-fi.service";
const quote = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'";
const hash = async (b: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b))))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const calls = async (f: Fixture): Promise<string[]> => (await readFile(f.root + "/.data/trace", "utf8")).trim().split("\n");
// `bootstrap` is a first deployment: no earlier release, selector or listener exists.
type Profile = "current" | "unknown" | "env-port" | "legacy" | "bootstrap";
type Active = { options: DeployOptions; sha: string; oldSha: string; publicHealth: () => Promise<Response> };
const write = (root: string, path: string, source: string): Promise<void> => writeFile(root + "/" + path, source);
const archivePrevious = async (f: Fixture, sha: string, preparePayload: VpsPayloadPreparation): Promise<void> => {
  const release = f.root + "/.data/releases/" + sha;
  const archive = f.root + "/.data/previous.tar";
  await mkdir(release, { recursive: true });
  await runFixtureGit(f.root, f.env, ["archive", "--format=tar", "--output=" + archive, sha]);
  const result = await runFixture("/bin/sh", {
    args: ["-c", "exec /usr/bin/tar -xf " + quote(archive) + " -C " + quote(release)],
    env: f.env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  });
  assert.equal(result.code, 0, decode(result.stderr));
  await writeFile(release + "/src/release.ts", '// Generated for this immutable VPS release.\nexport const RELEASE_GIT_SHA = "' + sha + '";\n', {
    mode: 0o600,
  });
  await chmod(release + "/src/release.ts", 0o600);
  await preparePayload(release, sha, await hash(await readFile(archive)));
  await rm(archive);
};

const prepareActivationFixture = async (f: Fixture, profile: Profile = "current"): Promise<Active> => {
  const root = f.root;
  const preparationInputs = {
    dependencies: repository + "/node_modules",
    dependencyLockSha256: await hash(await readFile(repository + "/bun.lock")),
    nativeArtifact: currentTestNativeKvBinding(),
  };
  const preparePayload = bindPreparedVpsPayload(preparationInputs);
  for (const dir of ["bin", "ops", "scripts", "src", ".data/releases"]) await mkdir(root + "/" + dir, { recursive: true });
  await write(root, ".data/trace", "");
  await writeFile(root + "/ops/Caddyfile", "fixture config\n", { mode: 0o604 });
  await chmod(root + "/ops/Caddyfile", 0o604);
  await write(root, "ops/ai-ubq-fi.service", VPS_UNIT);
  const reserve = async () => {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    assert(address && typeof address !== "string");
    return { listener, port: address.port };
  };
  const reservations = await Promise.all([reserve(), reserve()]);
  const ports = reservations.map((value) => value.port);
  let oldLauncher = VPS_LAUNCHER.replace("port: 7999", "port: 8001");
  if (profile === "unknown") oldLauncher += "\n// Unknown body.\n";
  if (profile === "env-port") oldLauncher = oldLauncher.replace("port: 8001", 'port: Number(process.env["PORT"])');
  if (profile === "legacy") {
    oldLauncher =
      '// Keep the database and secrets in the repository root across code updates.\nconst root = new URL("../", import.meta.url);\nDeno.chdir(root);\n// Resolve the symlink once: static assets and lazy imports must stay on this release.\nconst releasePath = await Deno.realPath(new URL(".data/current", root));\nconst release = new URL(`file://${releasePath}/`);\nconst { config, runtimeGitSha } = await import(new URL("src/config.ts", release).href);\nconst { initializeKv } = await import(new URL("src/kv.ts", release).href);\nif (config.isDeploy) throw new Error("The VPS entrypoint cannot run in Deno Deploy");\nif (!config.adminTokens.size) throw new Error("DENO_DEPLOY_TOKEN must configure administrator authentication");\nif (Deno.env.get("DENO_TIMELINE") !== "production") throw new Error("The VPS service requires the production timeline");\n\nconst gitSha = runtimeGitSha();\nif (!/^[0-9a-f]{40}$/.test(gitSha) || !releasePath.endsWith(`/releases/${gitSha}`)) {\n  throw new Error("The immutable release does not match its Git identity");\n}\n\nconst database = new URL(".data/kv.sqlite3", root);\nif (!(await Deno.stat(database)).isFile) {\n  throw new Error("Migrate the production KV database before starting the service");\n}\nconst kv = await Deno.openKv(database.pathname);\ninitializeKv(kv);\n\nconst { default: handler } = (await import(new URL("serve.ts", release).href)) as typeof import("../serve.ts");\nconst server = Deno.serve({ hostname: "127.0.0.1", port: 8001, onListen: handler.onListen }, handler.fetch);\nlet stopping = false;\nconst shutdown = () => {\n  if (stopping) return;\n  stopping = true;\n  console.log("[ai.ubq.fi] Draining requests before shutdown");\n  void server.shutdown();\n};\nDeno.addSignalListener("SIGTERM", shutdown);\nDeno.addSignalListener("SIGINT", shutdown);\nconsole.log(`[ai.ubq.fi] VPS serving Git revision ${gitSha}`);\nawait server.finished;\nkv.close();\nDeno.exit(0);\n';
    assert.equal(await hash(new TextEncoder().encode(oldLauncher)), "fde18debbfe01ba17716d34d0e8de2415ec92de75b7d9e3804e4e5cdb627e8ea");
  }
  await write(root, "scripts/serve-vps.ts", oldLauncher);
  await write(
    root,
    "src/config.ts",
    'import { RELEASE_GIT_SHA } from "./release.ts";\nexport const config = { isDeploy: false, adminTokens: new Set(["synthetic"]) };\nexport const runtimeGitSha = () => RELEASE_GIT_SHA;\n'
  );
  await write(root, "src/release.ts", 'export const RELEASE_GIT_SHA = "unprepared";\n');
  await write(root, "src/kv.ts", "export const initializeKv = (_kv: unknown) => {};\n");
  await write(
    root,
    "serve.ts",
    [
      'import { RELEASE_GIT_SHA as sha } from "./src/release.ts";',
      'import { statSync } from "node:fs";',
      'const id = "vps-" + sha;',
      "export const application = { onListen() {}, fetch() {",
      ' let refused = false; try { statSync("readiness-refused"); refused = process.env["FIXTURE_CANDIDATE"] === sha; } catch {}',
      ' return new Response(JSON.stringify({ release: { git_sha: sha, deployment_id: id } }), { status: refused ? 503 : 200, headers: { "content-type": "application/json", "x-uos-git-sha": sha, "x-uos-deployment-id": id } });',
      "} };",
      "export async function shutdownOptionalTelemetry() {}",
    ].join("\n")
  );
  await copyRuntimeModules(root);
  await mkdir(root + "/tools", { recursive: true });
  await cp(repository + "/tools/native-kv", root + "/tools/native-kv", { recursive: true });
  await write(root, "scripts/build-permissions.ts", await readFile(new URL("../scripts/build-permissions.ts", import.meta.url), "utf8"));
  await copyOps(root + "/ops");
  for (const name of ["launch-service.ts", "launch-vps.sh"])
    await write(root, "ops/" + name, await readFile(new URL("../ops/" + name, import.meta.url), "utf8"));
  await writePackage(root, { "#kv": "./src/storage/kv.ts", "#http": "./fixture-http.ts" });
  await write(
    root,
    "fixture-http.ts",
    [
      'import { serveHttp as actual } from "./src/runtime/http.ts";',
      'import { writeFileSync } from "node:fs";',
      "export const serveHttp = (options, handler) => { const requested = options.port;",
      'if (requested !== 7999 && requested !== 8001) throw new Error("unexpected declared port");',
      "const physical = requested === 8001 ? " + String(ports[0]) + " : " + String(ports[1]) + ";",
      'writeFileSync(".data/trace", "launcher-options " + JSON.stringify({requested_port:requested,physical_port:physical,env_port:process.env.PORT}) + "\\n", {flag:"a"});',
      "return actual({...options,port:physical},handler); };",
    ].join("\n")
  );
  await copyRuntime(root);
  await runFixtureGit(root, f.env, ["add", "--", "ops", "scripts", "src", "tools", "serve.ts", "package.json", "bun.lock", "fixture-http.ts"]);
  await runFixtureGit(root, f.env, ["commit", "-q", "-m", "previous launcher"]);
  const oldSha = await runFixtureGit(root, f.env, ["rev-parse", "HEAD"]);
  if (profile !== "bootstrap") {
    await archivePrevious(f, oldSha, preparePayload);
    const link = await runFixture("/bin/ln", {
      args: ["-s", "releases/" + oldSha, root + "/.data/current"],
      env: f.env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    });
    assert.equal(link.code, 0, decode(link.stderr));
  }
  const fixtureKv = await openKv(root + "/.data/kv-bun.sqlite3");
  await fixtureKv.set(["fixture"], "positive");
  fixtureKv.close();
  await write(root, ".env", "PORT=8001\n");
  await write(root, "scripts/serve-vps.ts", VPS_LAUNCHER);
  await write(root, "release.txt", "candidate\n");
  await runFixtureGit(root, f.env, ["add", "--", "scripts/serve-vps.ts", "release.txt"]);
  await runFixtureGit(root, f.env, ["commit", "-q", "-m", "candidate launcher"]);
  const sha = await runFixtureGit(root, f.env, ["rev-parse", "HEAD"]);
  await runFixtureGit(root, f.env, ["update-ref", "refs/remotes/origin/development", sha]);
  // The release ports stay reserved until both helper servers below have bound
  // their own ephemeral ports. Releasing them earlier lets the kernel hand a
  // released port to the proxy or control helper, which silently satisfies the
  // readiness wait and leaves the real child unable to bind its mapped port.
  const closeReservations = async (): Promise<void> => {
    for (const value of reservations.splice(0))
      await new Promise<void>((resolve) => {
        value.listener.close(() => {
          resolve();
        });
      });
  };
  const helperServers: HttpServer[] = [];
  const releaseFixture = f.dispose;
  f.dispose = async () => {
    await closeReservations();
    for (const server of helperServers.splice(0)) await server.shutdown();
    await releaseFixture();
  };
  assert.notEqual(ports[0], ports[1]);
  assert.ok(!ports.includes(7999) && !ports.includes(8001));
  const record = (event: string): Promise<void> =>
    write(root, ".data/last-event", event).then(() => writeFile(root + "/.data/trace", event + "\n", { flag: "a" }));
  let child: FixtureChild | undefined;
  let output: Promise<FixtureOutput> | undefined;
  const stop = async (): Promise<void> => {
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* settled */
    }
    const timer = setTimeout(() => {
      if (child) killChild(child);
    }, 1500);
    try {
      await output;
    } finally {
      clearTimeout(timer);
      child = undefined;
      output = undefined;
    }
  };
  const foreignListeners = new Map<number, HttpServer>();
  // Controlled negative for the readiness contract: a foreign listener that
  // answers HTTP 200 with a valid but different release identity must never be
  // mistaken for the release this start is waiting for. It also reproduces the
  // release-port collision directly, because it holds the mapped port before the
  // real child is spawned.
  const occupyReleasePort = async (port: number): Promise<void> => {
    if (foreignListeners.has(port)) return;
    let markBound: () => void = () => {};
    const bound = new Promise<void>((resolve) => {
      markBound = resolve;
    });
    const foreignBody = JSON.stringify({ release: { git_sha: oldSha, deployment_id: "vps-" + oldSha } });
    const server = serveHttp(
      {
        hostname: "127.0.0.1",
        port,
        onListen: () => {
          markBound();
        },
      },
      () =>
        new Response(foreignBody, {
          status: 200,
          headers: { "content-type": "application/json", "x-uos-git-sha": oldSha, "x-uos-deployment-id": "vps-" + oldSha },
        })
    );
    foreignListeners.set(port, server);
    helperServers.push(server);
    await bound;
    await record("foreign-listener " + String(port));
  };
  const unitLine = VPS_UNIT.split("\n").find((line) => line.startsWith("ExecStart="));
  assert.ok(unitLine);
  const start = async (_legacy = false): Promise<void> => {
    await stop();
    const selected = await readlink(root + "/.data/current");
    if (selected === "releases/" + sha && (await pathExists(root + "/restart-refused"))) throw new Error("fixture restart refused");
    let command = unitLine.slice("ExecStart=".length).replaceAll("/home/codex/repos/ubiquity/ai.ubq.fi", root);
    assert.equal(command, "/bin/sh " + root + "/ops/launch-vps.sh");
    if (_legacy) {
      const listener = root + "/legacy-listener.ts";
      await writeFile(
        listener,
        [
          "import { serveHttp } from " + JSON.stringify(new URL("../src/runtime/http.ts", import.meta.url).href) + ";",
          "const sha = " + JSON.stringify(oldSha) + '; const id = "vps-" + sha;',
          'const server = serveHttp({hostname:"127.0.0.1",port:' +
            String(ports[0]) +
            '}, () => Response.json({release:{git_sha:sha,deployment_id:id}}, {headers:{"x-uos-git-sha":sha,"x-uos-deployment-id":id}}));',
          'process.once("SIGTERM", () => { void server.shutdown(); }); await server.finished;',
        ].join("\n")
      );
      command = quote(process.execPath) + " --no-env-file --no-install " + quote(listener);
    }
    const namespaced = [
      "set -eu",
      ...["releases", "runtimes"].flatMap((name) => [
        "mount --bind " + quote(root + "/.data/" + name) + " " + quote(root + "/.data/" + name),
        "mount -o remount,bind,ro " + quote(root + "/.data/" + name),
      ]),
      "exec " + command,
    ].join("\n");
    const port = selected === "releases/" + oldSha ? ports[0] : ports[1];
    const expected = selected === "releases/" + oldSha ? oldSha : sha;
    if (await pathExists(root + "/foreign-listener")) await occupyReleasePort(port);
    await record("unit-exec " + command);
    child = spawnFixture("/usr/bin/unshare", {
      args: ["-Urm", "/bin/sh", "-c", namespaced],
      cwd: root,
      env: {
        ...f.env,
        PATH: "/usr/bin:/bin",
        DENO_TIMELINE: "production",
        FIXTURE_CANDIDATE: sha,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    });
    output = outputFixture(child);
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      try {
        const response = await fetch("http://127.0.0.1:" + String(port) + "/health");
        if (await servesExpectedRelease(response, expected)) return;
      } catch {
        /* startup */
      }
      const state = await Promise.race([
        output.then((result) => ({ result })),
        new Promise<null>((resolve) => {
          setTimeout(() => {
            resolve(null);
          }, 25);
        }),
      ]);
      if (state) throw new Error("actual launcher failed: " + decode(state.result.stderr));
    }
    throw new Error("actual launcher did not bind mapped physical port");
  };
  let loadedPort = ports[0];
  const proxy = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async () => {
    const response = await fetch("http://127.0.0.1:" + String(loadedPort) + "/health");
    const body = await response.text();
    await record("proxy-observed " + JSON.stringify({ loaded_port: loadedPort, status: response.status, body }));
    const refused = loadedPort === ports[1] && (await pathExists(root + "/public-refused"));
    return new Response(body, { status: refused ? 503 : response.status, headers: response.headers });
  });
  await proxy.ready;
  const proxyPort = proxy.addr.port;
  helperServers.push(proxy);
  const control = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    try {
      const action = new URL(request.url).pathname;
      if (action === "/restart") {
        await write(root, ".env", "PORT=43210\n");
        await start();
      } else if (action === "/reload") {
        if (await pathExists(root + "/reload-refused")) throw new Error("fixture reload refused");
        loadedPort = ports[1];
        await record("ingress-loaded " + String(loadedPort));
      } else throw new Error("unexpected control action");
      return new Response("applied");
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  });
  helperServers.push(control);
  await control.ready;
  const controlPort = control.addr.port;
  // Both reservations were still held while these two helpers bound, so a
  // release port here means the reservation contract regressed.
  assert.notEqual(proxyPort, controlPort);
  assert.ok(!ports.includes(proxyPort) && !ports.includes(controlPort), "fixture helpers must not bind a release physical port");
  await write(
    root,
    "control-client.ts",
    'const response = await fetch("http://127.0.0.1:' +
      String(control.addr.port) +
      '/" + process.argv[2]);\nif (!response.ok) { console.error(await response.text()); process.exit(72); }\nawait response.body?.cancel();\n'
  );
  const childDispose = f.dispose;
  f.dispose = async () => {
    await stop();
    await childDispose();
  };
  // Cleanup is installed and both helpers are bound on distinct ephemeral
  // ports, so the release ports can now be handed to the real children.
  await closeReservations();
  try {
    if (profile !== "bootstrap") await start(profile === "legacy");
  } catch (error) {
    await f.dispose();
    throw error;
  }
  const prefix = "#!/bin/sh\nset -eu\nfixture_root=" + quote(root) + "\nfixture_log=" + quote(root + "/.data/trace") + "\n";
  const scripts = {
    cc: prefix + 'PATH=/usr/bin:/bin exec /usr/bin/cc "$@"\n',
    git:
      prefix +
      'printf "git %s\\n" "$*" >> "$fixture_log"\nif [ "$1" = "archive" ] && [ -f "$fixture_root/archive-refused" ]; then printf "fixture archive refused\\n" >&2; exit 76; fi\nexec /usr/bin/git "$@"\n',
    tar:
      prefix +
      'printf "tar %s\\n" "$*" >> "$fixture_log"\n[ "$#" -eq 4 ] && [ "$1" = "-xf" ] && [ "$3" = "-C" ] && [ "$2" = "$4.tar" ]\ncase "$4" in .data/releases/.staging-*|"$fixture_root"/.data/releases/.staging-*) ;; *) exit 75 ;; esac\nif [ -f "$fixture_root/preparation-refused" ]; then printf "fixture preparation refused\\n" >&2; exit 78; fi\nexec /usr/bin/tar "$@"\n',
    sudo:
      prefix +
      [
        'printf "sudo %s\\n" "$*" >> "$fixture_log"',
        'case "$*" in',
        ' "-n systemctl show caddy -p MainPID --value") if [ -f "$fixture_root/no-caddy" ]; then printf "0\\n"; else printf "42\\n"; fi ;;',
        ' "-n nsenter -t 42 -m -- sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile") if [ -f "$fixture_root/invalid-caddy" ]; then printf "fixture validation refused\\n" >&2; exit 71; fi ;;',
        ' "-n systemctl daemon-reload") if [ -f "$fixture_root/daemon-refused" ]; then printf "fixture daemon-reload refused\\n" >&2; exit 79; fi ;;',
        ' "-n systemctl restart ai-ubq-fi.service") exec ' +
          quote(process.execPath) +
          ' --no-env-file --no-install "$fixture_root/control-client.ts" restart ;;',
        ' "-n systemctl reload caddy") exec ' + quote(process.execPath) + ' --no-env-file --no-install "$fixture_root/control-client.ts" reload ;;',
        ' *) printf "unexpected fixture sudo arguments\\n" >&2; exit 74 ;;',
        "esac",
      ].join("\n") +
      "\n",
  };
  for (const [name, source] of Object.entries(scripts)) {
    const path = root + "/bin/" + name;
    await writeFile(path, source, { mode: 0o700 });
    assert.equal(await realpath(path), path);
    assert.equal((await lstat(path)).isFile(), true);
  }
  const source = await readFile(f.script, "utf8");
  const bootstrap = [
    'import { writeFileSync } from "node:fs";',
    "const actualFetch = globalThis.fetch;",
    'const log = (event: string): void => writeFileSync(".data/trace", event + "\\n", { flag: "a" });',
    "globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {",
    " const url = String(input);",
    ' const port = url === "https://ai.ubq.fi/health" ? ' +
      String(proxyPort) +
      ' : url === "http://127.0.0.1:7999/health" ? ' +
      String(ports[1]) +
      ' : url === "http://127.0.0.1:8001/health" ? ' +
      String(ports[0]) +
      " : null;",
    ' if (port === null) throw new Error("fixture fetch scope refused");',
    ' const response = await actualFetch("http://127.0.0.1:" + String(port) + "/health", init);',
    ' log("fetch-observed " + JSON.stringify({ url, status: response.status, sha: response.headers.get("x-uos-git-sha") })); return response;',
    "};",
    "const timer = globalThis.setTimeout;",
    "globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => timer(handler, delay === 1000 ? 1 : delay, ...args)) as typeof setTimeout;",
    "",
  ].join("\n");
  const script = root + "/deploy.activation.fixture.ts";
  const invocation = [
    'import { existsSync } from "node:fs";',
    'import { bindPreparedVpsPayload } from "./vps-release-store.ts";',
    'const { deploy } = await import("./deploy.fixture.ts");',
    "const preparation = " + JSON.stringify(preparationInputs) + ";",
    'if (existsSync("preparation-refused")) preparation.dependencyLockSha256 = "0".repeat(64);',
    "await deploy(bindPreparedVpsPayload(preparation));",
    "",
  ].join("\n");
  await writeFile(script, bootstrap + invocation);
  assert.equal(await readFile(f.script, "utf8"), source, "the imported production entry keeps its exact relocated source");
  assert.equal((await readFile(script, "utf8")).slice(bootstrap.length), invocation);
  console.log(
    JSON.stringify({
      fixture: "actual_launcher",
      profile,
      sha,
      oldSha,
      physical_ports: ports,
      proxy_port: proxyPort,
      control_port: controlPort,
      launcher_hash: await hash(new TextEncoder().encode(oldLauncher)),
      unit_hash: await hash(new TextEncoder().encode(VPS_UNIT)),
      bootstrap_hash: await hash(new TextEncoder().encode(bootstrap)),
    })
  );
  return {
    options: {
      write: root + "/.data",
      env: { ...f.env, PATH: root + "/bin" },
      fakeCommands: [root + "/bin/sudo", root + "/bin/tar"],
      script,
      allowLn: true,
      network: true,
    },
    sha,
    oldSha,
    publicHealth: () => fetch("http://127.0.0.1:" + String(proxyPort) + "/health"),
  };
};
const identity = async (response: Response): Promise<string> => {
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.release.git_sha, response.headers.get("x-uos-git-sha"));
  assert.equal(body.release.deployment_id, "vps-" + String(body.release.git_sha));
  assert.equal(response.headers.get("x-uos-deployment-id"), body.release.deployment_id);
  return body.release.git_sha;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * The fixture's launcher wait must prove the identity of the release it is
 * starting, not merely that some process answered on the mapped port: its own
 * proxy or control helper, a stale release, a foreign listener, or a dead child
 * must never satisfy readiness. The production HTTP-200 gate stays authoritative
 * in `ops/deploy.ts` (`ready`), which is what reports a started-but-not-ready
 * candidate, so this check is status-agnostic and never replaces that guard.
 */
const servesExpectedRelease = async (response: Response, expected: string): Promise<boolean> => {
  const deploymentId = "vps-" + expected;
  if (response.headers.get("x-uos-git-sha") !== expected || response.headers.get("x-uos-deployment-id") !== deploymentId) {
    await response.body?.cancel();
    return false;
  }
  const health: unknown = await response.json().catch(() => undefined);
  const release = isRecord(health) ? health.release : undefined;
  return isRecord(release) && release.git_sha === expected && release.deployment_id === deploymentId;
};
const snapshot = async (root: string): Promise<string> => {
  const entries: unknown[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const name of await readDirNames(path)) {
      const full = path + "/" + name;
      const stat = await lstat(full);
      let entryContent = "directory";
      if (stat.isSymbolicLink()) entryContent = await readlink(full);
      else if (stat.isFile()) entryContent = await hash(await readFile(full));
      entries.push([full.slice(root.length), stat.mode, stat.mtime.getTime(), entryContent]);
      if (stat.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return hash(new TextEncoder().encode(JSON.stringify(entries)));
};
const withLauncher = (name: string, run: (f: Fixture, active: Active) => Promise<void>, profile: Profile = "current"): void => {
  test(name, async () => {
    const f = await createFixture({ branch: "development", tracking: "match", relocate: true });
    try {
      await run(f, await prepareActivationFixture(f, profile));
    } finally {
      await f.dispose();
    }
  });
};
withLauncher("VPS actual rollback and persistent/cleared same-SHA retry preserve immutable bytes", async (f, a) => {
  assert.equal(await identity(await a.publicHealth()), a.oldSha);
  const retainedBeforeAcceptance: string[] = [];
  for (let index = 1; index <= 7; index++) {
    const name = "0".repeat(39) + String(index);
    const path = f.root + "/.data/releases/" + name;
    await mkdir(path);
    await utimes(path, 1, 1);
    retainedBeforeAcceptance.push(name);
  }
  await write(f.root, "reload-refused", "fault\n");
  let saved: string | undefined;
  for (let i = 0; i < 2; i++) {
    const run = await runDeployFixture(f, a.options);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /fixture reload refused/);
    assert.equal(await readlink(f.root + "/.data/current"), "releases/" + a.oldSha);
    assert.equal(await identity(await a.publicHealth()), a.oldSha);
    assert.equal(JSON.parse(await readFile(f.root + "/.data/deploy-recovery.json", "utf8")).phase, "rolled_back");
    assert.doesNotMatch(run.stdout, /"health_verified":true/);
    for (const name of retainedBeforeAcceptance) assert.equal(await pathExists(f.root + "/.data/releases/" + name), true);
    const current = await snapshot(f.root + "/.data/releases/" + a.sha);
    if (saved) assert.equal(current, saved);
    saved = current;
  }
  await rm(f.root + "/reload-refused");
  const run = await runDeployFixture(f, a.options);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(await identity(await a.publicHealth()), a.sha);
  assert.equal(await snapshot(f.root + "/.data/releases/" + a.sha), saved);
  assert.equal(await pathExists(f.root + "/.data/deploy-recovery.json"), false);
  assert.equal((await readDirNames(f.root + "/.data/releases")).length, 5);
  const trace = await calls(f);
  assert.ok(trace.some((line) => line.includes('"requested_port":8001') && line.includes('"env_port":"43210"')));
  assert.equal(trace.filter((line) => line === RESTART_COMMAND).length, 5);
  console.log(JSON.stringify({ proof: "same_sha_actual_recovery", candidate: a.sha, previous: a.oldSha, snapshot: saved, trace }));
});
withLauncher("VPS post-ingress failure retains candidate and retries without restart", async (f, a) => {
  await write(f.root, "public-refused", "fault\n");
  const first = await runDeployFixture(f, a.options);
  assert.notEqual(first.code, 0);
  assert.match(first.stderr, /public route/);
  const saved = await snapshot(f.root + "/.data/releases/" + a.sha);
  assert.equal(JSON.parse(await readFile(f.root + "/.data/deploy-recovery.json", "utf8")).phase, "ingress_applied");
  await write(f.root, "reload-refused", "later fault\n");
  const later = await runDeployFixture(f, a.options);
  assert.notEqual(later.code, 0);
  assert.match(later.stderr, /fixture reload refused/);
  assert.equal(await readlink(f.root + "/.data/current"), "releases/" + a.sha);
  await rm(f.root + "/reload-refused");
  const persistent = await runDeployFixture(f, a.options);
  assert.notEqual(persistent.code, 0);
  await rm(f.root + "/public-refused");
  const accepted = await runDeployFixture(f, a.options);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(await identity(await a.publicHealth()), a.sha);
  assert.equal(await snapshot(f.root + "/.data/releases/" + a.sha), saved);
  assert.equal((await calls(f)).filter((line) => line === RESTART_COMMAND).length, 1);
  console.log(JSON.stringify({ proof: "post_ingress_retry", trace: await calls(f) }));
});
withLauncher("VPS daemon-reload refusal preserves prior listener and issues no gateway restart (#264)", async (f, a) => {
  await write(f.root, "daemon-refused", "fault\n");
  const run = await runDeployFixture(f, a.options);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /fixture daemon-reload refused/);
  const trace = await calls(f);
  assert.equal(trace.filter((line) => line === RESTART_COMMAND).length, 0);
  assert.equal(trace.filter((line) => line === RELOAD_COMMAND).length, 0);
  assert.ok(!trace.some((line) => line.startsWith("fetch-observed ") && line.includes(":7999/health")));
  assert.doesNotMatch(run.stdout, /public_health_verified|health_verified/);
  assert.equal(await readlink(f.root + "/.data/current"), "releases/" + a.oldSha);
  assert.equal(await identity(await a.publicHealth()), a.oldSha);
  assert.equal(trace.filter((line) => line.startsWith("unit-exec ")).length, 1);
  console.log(JSON.stringify({ proof: "daemon_refusal_prior_listener_untouched", exit_code: run.code, trace }));
});
for (const profile of ["unknown", "env-port", "legacy"] as const)
  withLauncher(
    "VPS refuses unsupported predecessor " + profile + " before activation",
    async (f, a) => {
      assert.equal(await identity(await a.publicHealth()), a.oldSha);
      const run = await runDeployFixture(f, a.options);
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /Unsupported previous launcher or service layout/);
      const trace = await calls(f);
      assert.ok(!trace.includes(RESTART_COMMAND) && !trace.includes(RELOAD_COMMAND) && !trace.some((line) => line.startsWith("selector-link ")));
      assert.equal(await readlink(f.root + "/.data/current"), "releases/" + a.oldSha);
      assert.equal(await identity(await a.publicHealth()), a.oldSha);
      assert.equal(await pathExists(f.root + "/.data/releases/" + a.sha), false);
      console.log(JSON.stringify({ proof: "unsupported_predecessor_preserved", profile, trace }));
    },
    profile
  );
for (const marker of ["archive-refused", "preparation-refused", "restart-refused", "readiness-refused"] as const)
  withLauncher("VPS prior listener survives " + marker, async (f, a) => {
    await write(f.root, marker, "fault\n");
    const run = await runDeployFixture(f, a.options);
    assert.notEqual(run.code, 0);
    const expected = {
      "archive-refused": /fixture archive refused/,
      "preparation-refused": /Prepared VPS dependencies do not match the frozen release lock/,
      "restart-refused": /fixture restart refused/,
      "readiness-refused": /did not serve the expected release/,
    }[marker];
    assert.match(run.stderr, expected);
    assert.equal(await readlink(f.root + "/.data/current"), "releases/" + a.oldSha);
    assert.equal(await identity(await a.publicHealth()), a.oldSha);
    assert.doesNotMatch(run.stdout, /"health_verified":true/);
    assert.ok(!(await calls(f)).includes(RELOAD_COMMAND));
  });
withLauncher("VPS fixture readiness rejects a foreign listener on the mapped release port", async (f, a) => {
  await write(f.root, "foreign-listener", "fault\n");
  const run = await runDeployFixture(f, a.options);
  assert.notEqual(run.code, 0);
  // A foreign HTTP 200 without the expected release identity must never satisfy
  // the launcher wait. Without the identity check this run instead advances to
  // the deploy's own health gate and reports /did not serve the expected release/.
  assert.match(run.stderr, /actual launcher (failed|did not bind)/);
  assert.doesNotMatch(run.stderr, /did not serve the expected release/);
  assert.ok(
    (await calls(f)).some((line) => line.startsWith("foreign-listener ")),
    "the controlled negative must hold the release port"
  );
  assert.equal(await readlink(f.root + "/.data/current"), "releases/" + a.oldSha);
});
for (const corruption of [
  "no-receipt",
  "malformed",
  "stale",
  "symlink",
  "wrong-selector",
  "candidate-file",
  "manifest",
  "extra-file",
  "candidate-symlink",
  "manifest-symlink",
  "generated-identity",
  "previous-file",
] as const)
  withLauncher("VPS rejects unsafe recovery " + corruption, async (f, a) => {
    await write(f.root, "reload-refused", "fault\n");
    const first = await runDeployFixture(f, a.options);
    assert.notEqual(first.code, 0);
    assert.match(first.stderr, /fixture reload refused/);
    const receipt = f.root + "/.data/deploy-recovery.json";
    const candidate = f.root + "/.data/releases/" + a.sha;
    if (corruption === "no-receipt") await rm(receipt);
    if (corruption === "malformed") await writeFile(receipt, "{}\n");
    if (corruption === "stale") {
      const data = JSON.parse(await readFile(receipt, "utf8"));
      data.candidate.tree = "0".repeat(64);
      await writeFile(receipt, JSON.stringify(data));
    }
    if (corruption === "symlink") {
      await rename(receipt, receipt + ".saved");
      const r = await runFixture("/bin/ln", { args: ["-s", receipt + ".saved", receipt] });
      assert.equal(r.code, 0);
    }
    if (corruption === "wrong-selector") {
      await rm(f.root + "/.data/current");
      const r = await runFixture("/bin/ln", { args: ["-s", "./releases/" + a.oldSha, f.root + "/.data/current"] });
      assert.equal(r.code, 0);
    }
    if (corruption === "candidate-file") await write(candidate, "release.txt", "changed\n");
    if (corruption === "manifest") await write(candidate, ".uos-release.json", "{}\n");
    if (corruption === "extra-file") await write(candidate, "unexpected.txt", "extra\n");
    if (corruption === "candidate-symlink") {
      await rename(candidate, candidate + ".saved");
      const result = await runFixture("/bin/ln", { args: ["-s", candidate + ".saved", candidate] });
      assert.equal(result.code, 0);
    }
    if (corruption === "manifest-symlink") {
      await rename(candidate + "/.uos-release.json", candidate + "/manifest.saved");
      const result = await runFixture("/bin/ln", { args: ["-s", "manifest.saved", candidate + "/.uos-release.json"] });
      assert.equal(result.code, 0);
    }
    if (corruption === "generated-identity") await write(candidate, "src/release.ts", "changed identity\n");
    if (corruption === "previous-file") await write(f.root + "/.data/releases/" + a.oldSha, "release.txt", "changed prior bytes\n");
    const before = (await calls(f)).length;
    const run = await runDeployFixture(f, a.options);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /recovery|Immutable(?: Bun)? release/i);
    const trace = (await calls(f)).slice(before);
    assert.ok(!trace.includes(RESTART_COMMAND) && !trace.includes(RELOAD_COMMAND) && !trace.some((line) => line.startsWith("selector-link ")));
    assert.equal(await identity(await a.publicHealth()), a.oldSha);
  });
withLauncher("VPS selected immutable release retries without restart and refuses not-ready identity", async (f, a) => {
  const first = await runDeployFixture(f, a.options);
  assert.equal(first.code, 0, first.stderr);
  const saved = await snapshot(f.root + "/.data/releases/" + a.sha);
  const retry = await runDeployFixture(f, a.options);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(await snapshot(f.root + "/.data/releases/" + a.sha), saved);
  await write(f.root, "readiness-refused", "fault\n");
  const refused = await runDeployFixture(f, a.options);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /not ready/);
  assert.equal((await calls(f)).filter((line) => line === RESTART_COMMAND).length, 1);
});
const recoveryPhase = async (f: Fixture): Promise<unknown> => JSON.parse(await readFile(f.root + "/.data/deploy-recovery.json", "utf8")).phase;
const assertUnaccepted = (run: FixtureRun, error: RegExp): void => {
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, error);
  assert.doesNotMatch(run.stderr, /Recovery failed|no proven rollback disposition|identity is ambiguous/);
  assert.doesNotMatch(run.stdout, /public_health_verified|"health_verified":true/);
};
withLauncher(
  "VPS first deployment keeps its restarted candidate selected and resumes reload and public verification for the same SHA (#764)",
  async (f, a) => {
    await write(f.root, "reload-refused", "fault\n");
    let saved: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      assertUnaccepted(await runDeployFixture(f, a.options), /fixture reload refused/);
      // Clearing the selector cannot stop the restarted unit; it would only break its next start.
      assert.equal(await pathExists(f.root + "/.data/current"), true, "a restarted first candidate must stay selected");
      assert.equal(await readlink(f.root + "/.data/current"), "releases/" + a.sha);
      assert.equal(await recoveryPhase(f), "candidate_ready");
      const current = await snapshot(f.root + "/.data/releases/" + a.sha);
      if (saved) assert.equal(current, saved);
      saved = current;
    }
    await rm(f.root + "/reload-refused");
    await write(f.root, "public-refused", "fault\n");
    assertUnaccepted(await runDeployFixture(f, a.options), /public route/);
    assert.equal(await recoveryPhase(f), "ingress_applied");
    await rm(f.root + "/public-refused");
    const accepted = await runDeployFixture(f, a.options);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stdout, /"health_verified":true/);
    assert.equal(await identity(await a.publicHealth()), a.sha);
    assert.equal(await snapshot(f.root + "/.data/releases/" + a.sha), saved);
    assert.equal(await pathExists(f.root + "/.data/deploy-recovery.json"), false);
    const trace = await calls(f);
    assert.equal(trace.filter((line) => line === RESTART_COMMAND).length, 1, "a ready first candidate resumes without another restart");
    assert.equal(trace.filter((line) => line === RELOAD_COMMAND).length, 4);
  },
  "bootstrap"
);
withLauncher(
  "VPS first deployment restarts only its selected verified candidate on a same-SHA retry after a readiness fault (#764)",
  async (f, a) => {
    await write(f.root, "readiness-refused", "fault\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      assertUnaccepted(await runDeployFixture(f, a.options), /did not serve the expected release/);
      assert.equal(await pathExists(f.root + "/.data/current"), true, "a restarted first candidate must stay selected");
      assert.equal(await readlink(f.root + "/.data/current"), "releases/" + a.sha);
      assert.equal(await recoveryPhase(f), "selected");
      assert.ok(!(await calls(f)).includes(RELOAD_COMMAND), "an unready candidate must never reach ingress");
    }
    const saved = await snapshot(f.root + "/.data/releases/" + a.sha);
    await rm(f.root + "/readiness-refused");
    const accepted = await runDeployFixture(f, a.options);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(await identity(await a.publicHealth()), a.sha);
    assert.equal(await snapshot(f.root + "/.data/releases/" + a.sha), saved);
    assert.equal(await pathExists(f.root + "/.data/deploy-recovery.json"), false);
    // One restart per faulted attempt; the accepted retry finds the last start ready and does not restart it again.
    assert.equal((await calls(f)).filter((line) => line === RESTART_COMMAND).length, 2);
  },
  "bootstrap"
);
withLauncher(
  "VPS first deployment clears its unstarted selector on daemon-reload refusal and retries the same SHA (#764)",
  async (f, a) => {
    await write(f.root, "daemon-refused", "fault\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      assertUnaccepted(await runDeployFixture(f, a.options), /fixture daemon-reload refused/);
      assert.equal(await pathExists(f.root + "/.data/current"), false, "nothing started, so the original absent selector is restored");
      assert.equal(await recoveryPhase(f), "rolled_back");
      const trace = await calls(f);
      assert.equal(trace.filter((line) => line === RESTART_COMMAND).length, 0);
      assert.equal(trace.filter((line) => line === RELOAD_COMMAND).length, 0);
    }
    await rm(f.root + "/daemon-refused");
    const accepted = await runDeployFixture(f, a.options);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(await identity(await a.publicHealth()), a.sha);
    assert.equal(await readlink(f.root + "/.data/current"), "releases/" + a.sha);
    assert.equal(await pathExists(f.root + "/.data/deploy-recovery.json"), false);
    assert.equal((await calls(f)).filter((line) => line === RESTART_COMMAND).length, 1);
  },
  "bootstrap"
);
withLauncher(
  "VPS first deployment refuses a same-SHA retry once its restarted candidate is no longer selected (#764)",
  async (f, a) => {
    await write(f.root, "reload-refused", "fault\n");
    assertUnaccepted(await runDeployFixture(f, a.options), /fixture reload refused/);
    assert.equal(await readlink(f.root + "/.data/current"), "releases/" + a.sha);
    await rm(f.root + "/reload-refused");
    // An out-of-band selector change leaves no deployment-owned disposition for the restarted candidate.
    await rm(f.root + "/.data/current");
    const before = (await calls(f)).length;
    const run = await runDeployFixture(f, a.options);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /no proven rollback disposition/);
    const trace = (await calls(f)).slice(before);
    assert.ok(!trace.includes(RESTART_COMMAND) && !trace.includes(RELOAD_COMMAND));
    assert.equal(await pathExists(f.root + "/.data/current"), false);
  },
  "bootstrap"
);
for (const failure of [
  { marker: "unreadable", error: /not readable by the caddy user/ },
  { marker: "no-caddy", error: /Caddy is not running/ },
  { marker: "invalid-caddy", error: /fixture validation refused/ },
])
  withLauncher("VPS ingress preflight preserves same-SHA retry on " + failure.marker, async (f, a) => {
    if (failure.marker === "unreadable") await chmod(f.root + "/ops/Caddyfile", 0o600);
    else await write(f.root, failure.marker, "fault\n");
    const first = await runDeployFixture(f, a.options);
    assert.notEqual(first.code, 0);
    assert.match(first.stderr, failure.error);
    assert.equal(await pathExists(f.root + "/.data/releases/" + a.sha), false);
    assert.equal(await identity(await a.publicHealth()), a.oldSha);
    if (failure.marker === "unreadable") {
      await rm(f.root + "/ops/Caddyfile");
      await writeFile(f.root + "/ops/Caddyfile", "fixture config\n", { mode: 0o604 });
      await chmod(f.root + "/ops/Caddyfile", 0o604);
    } else await rm(f.root + "/" + failure.marker);
    const retry = await runDeployFixture(f, a.options);
    assert.equal(retry.code, 0, retry.stderr);
  });

test("VPS deployment rejects a non-canonical root before any Git subprocess runs", async () => {
  const fixture = await createFixture({ branch: "development", tracking: "match", relocate: false });
  try {
    // A marker-writing Git shim proves the root boundary runs first: if the
    // script reached Git in this arbitrary directory, the shim would record
    // it even though the root check fails later.
    const shimDir = `${fixture.root}/bin`;
    const marker = `${fixture.root}/git-ran.marker`;
    await mkdir(shimDir, { recursive: true });
    await writeFile(`${shimDir}/git`, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\necho "fixture git shim must not run" >&2\nexit 70\n`);
    await chmod(`${shimDir}/git`, 0o700);
    const run = await runDeployFixture(fixture, { env: { ...fixture.env, PATH: `${shimDir}:${fixture.env.PATH}` } });
    assert.notStrictEqual(run.code, 0, "a non-canonical root must fail closed");
    assert.match(run.stderr, /Run from the canonical VPS repository root/);
    assert.equal(await pathExists(marker), false, "the canonical-root check must precede every Git subprocess");
    assert.doesNotMatch(run.stderr, /fixture git shim must not run/);
    assert.equal(run.stdout.trim(), "", "no deployment step may report before the root boundary passes");
  } finally {
    await fixture.dispose();
  }
});

test("VPS deployment guards reject a relocated fixture that is not on the development branch", async () => {
  const fixture = await createFixture({ branch: "feature/not-development", tracking: "match", relocate: true });
  try {
    const run = await runDeployFixture(fixture);
    assert.notStrictEqual(run.code, 0, "a non-development branch must fail closed");
    assert.match(run.stderr, /allowed only from the development branch/);
    assert.doesNotMatch(run.stderr, /Run from the canonical VPS repository root/);
    assert.equal(await pathExists(`${fixture.root}/.data`), false, "the branch guard must precede .data creation");
    assert.equal(run.stdout.trim(), "");
  } finally {
    await fixture.dispose();
  }
});

test("VPS deployment guards reject a relocated HEAD that differs from origin/development", async () => {
  const fixture = await createFixture({ branch: "development", tracking: "mismatch", relocate: true });
  try {
    const run = await runDeployFixture(fixture);
    assert.notStrictEqual(run.code, 0, "a stale tracking ref must fail closed");
    assert.match(run.stderr, /exactly match origin\/development/);
    assert.doesNotMatch(run.stderr, /Run from the canonical VPS repository root/);
    assert.equal(await pathExists(`${fixture.root}/.data`), false, "the tracking-ref guard must precede .data creation");
    assert.equal(run.stdout.trim(), "");
  } finally {
    await fixture.dispose();
  }
});

test("VPS deployment guards fail closed when the relocated fixture lacks the origin/development tracking ref", async () => {
  const fixture = await createFixture({ branch: "development", tracking: "missing", relocate: true });
  try {
    const run = await runDeployFixture(fixture);
    assert.notStrictEqual(run.code, 0, "a missing tracking ref must fail closed");
    assert.match(run.stderr, /origin\/development tracking ref is missing/);
    assert.doesNotMatch(run.stderr, /Run from the canonical VPS repository root/);
    assert.equal(await pathExists(`${fixture.root}/.data`), false, "the missing-ref guard must precede .data creation");
    assert.equal(run.stdout.trim(), "");
  } finally {
    await fixture.dispose();
  }
});

test("VPS deployment guards accept a relocated matching preflight and stop at the .data write boundary", async () => {
  const fixture = await createFixture({ branch: "development", tracking: "match", relocate: true });
  await seedStore(fixture.root);
  const dataBefore = await snapshot(fixture.root + "/.data");
  try {
    const run = await runDeployFixture(fixture);
    // Positive control: the matching checkout clears every guard and is denied
    // only by the next boundary, the unpermitted `.data` write.
    assert.notStrictEqual(run.code, 0, "the unpermitted .data write must fail closed");
    assert.match(run.stderr, /EROFS|EACCES|EPERM/);
    const failureMessage = run.stderr.split("\n").find((line) => /^error:|^[A-Z_]+:/.test(line));
    assert(failureMessage, "the real readonly filesystem failure must report its message");
    assert.doesNotMatch(failureMessage, /development branch|exactly match origin\/development|tracking ref is missing|canonical VPS repository root/);
    assert.equal(
      await snapshot(fixture.root + "/.data"),
      dataBefore,
      "the denied write preserves every existing converted-store byte and creates no deployment state"
    );
    for (const entry of ["releases", "deploy.lock", "current"]) assert.equal(await pathExists(`${fixture.root}/.data/${entry}`), false);
    assert.equal(run.stdout.trim(), "");
  } finally {
    await fixture.dispose();
  }
});

test("VPS deployment revalidates under the deployment lock and rejects a candidate that changed while queued", async () => {
  const fixture = await createFixture({ branch: "development", tracking: "match", relocate: true });
  let lock: (() => void) | undefined;
  let child: FixtureChild | undefined;
  let lockReleased = false;
  try {
    const dataDir = `${fixture.root}/.data`;
    await seedStore(fixture.root);
    await mkdir(dataDir, { recursive: true });
    lock = await acquireDeployLock(`${dataDir}/deploy.lock`);
    child = launchDeployFixture(fixture, { write: dataDir });
    const pending = child;
    // The pre-lock preflight created `releases`, so the child has passed the
    // first validation and can now only be waiting on the held lock.
    await waitForPath(`${dataDir}/releases`, PREFLIGHT_TIMEOUT_MS, "the pre-lock checkout preflight");
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Move HEAD while the deployment is queued; the tracking ref stays behind,
    // so only the post-lock revalidation can reject this candidate.
    await writeFile(`${fixture.root}/queued.txt`, "queued local change\n");
    await runFixtureGit(fixture.root, fixture.env, ["add", "--", "queued.txt"]);
    await runFixtureGit(fixture.root, fixture.env, ["commit", "-q", "-m", "queued local change"]);
    lock();
    lockReleased = true;
    // From here settlement owns the process and reaps it on timeout.
    child = undefined;
    const run = await settleChild(pending, CHILD_TIMEOUT_MS);
    assert.notStrictEqual(run.code, 0, "the post-lock revalidation must fail closed");
    assert.match(run.stderr, /exactly match origin\/development/);
    assert.deepEqual(await readDirNames(`${dataDir}/releases`), [], "no release staging or archive may exist before the post-lock preflight passes");
    assert.equal(await pathExists(`${dataDir}/current`), false, "no release may be selected before the post-lock preflight passes");
    assert.equal(run.stdout.trim(), "", "no deployment step may report before the post-lock preflight passes");
  } finally {
    if (child !== undefined) {
      killChild(child);
      await outputFixture(child).catch(() => {});
    }
    if (!lockReleased) lock?.();
    await fixture.dispose();
  }
});

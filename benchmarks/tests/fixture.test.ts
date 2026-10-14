import { runCommand } from "../process.ts";
import { test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { rm, symlink, chmod, readFile, lstat } from "node:fs/promises";
import { isFsError } from "../fs-errors.ts";
import { FixtureWorkspace, WriteScopeViolationError } from "../fixture.ts";
import { loadTasks } from "../manifest.ts";
import type { TaskManifest } from "../schemas.ts";

const TASKS_DIR = `${process.cwd()}/benchmarks/tasks`;
const FIXTURES_DIR = `${process.cwd()}/benchmarks/fixtures`;
const SANDBOX_OS = process.platform === "darwin" || process.platform === "linux";
/** Variables the sandbox itself sets, plus the ones `sh` exports for itself. */
const SANDBOX_ENV_ALLOWLIST = new Set(["PATH", "HOME", "USER", "GIT_CONFIG_GLOBAL", "PWD", "OLDPWD", "SHLVL", "_"]);

function requiredTask(id: string): TaskManifest {
  const task = loadTasks(TASKS_DIR).find((candidate) => candidate.id === id);
  if (!task) throw new Error(`fixture test requires the ${id} benchmark task manifest`);
  return task;
}

function tempRunsDir(): string {
  const runsRoot = `${process.cwd()}/benchmark-runs`;
  mkdirSync(runsRoot, { recursive: true });
  return mkdtempSync(join(runsRoot, "fixture-"));
}

function parseEnv(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

async function removeAll(...paths: string[]): Promise<void> {
  for (const path of paths) await rm(path, { recursive: true }).catch(() => {});
}

async function expectWriteScopeViolation(run: () => Promise<unknown>): Promise<WriteScopeViolationError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof WriteScopeViolationError) return err;
    throw err;
  }
  throw new Error("expected a WriteScopeViolationError");
}

test.skipIf(!SANDBOX_OS)("fixture: shell writes cannot escape the disposable workspace", async () => {
  const task = requiredTask("nav-001");
  const tmpParent = tempRunsDir();
  const outside = tempRunsDir();
  const workspace = new FixtureWorkspace({
    fixtureDir: `${FIXTURES_DIR}/${task.fixture}`,
    runId: "workspace",
    tmpParent,
    task,
  });
  try {
    await workspace.prepare();
    const link = await runCommand(["sh", "-c", 'ln -s "$1" "$2"', "fixture-test", outside, `${workspace.root}/escape-link`]);
    if (link.code !== 0) throw new Error("failed to create the escape-test symlink");
    const inside = await workspace.execShell("touch inside-workspace", 20_000);
    if (inside.code !== 0 || !(await exists(`${workspace.root}/inside-workspace`))) {
      throw new Error(`sandbox rejected an in-workspace write: ${inside.stderr}`);
    }

    const absolute = await workspace.execShell(`touch ${outside}/absolute-escape`, 20_000);
    const symlink = await workspace.execShell("touch escape-link/symlink-escape", 20_000);

    if (absolute.code === 0 || symlink.code === 0) throw new Error("expected the attempted host writes to fail");
    if ((await exists(`${outside}/absolute-escape`)) || (await exists(`${outside}/symlink-escape`))) {
      throw new Error("sandbox allowed a write outside the disposable workspace");
    }
  } finally {
    await removeAll(tmpParent, outside);
  }
});

test.skipIf(!SANDBOX_OS)("fixture: shell commands cannot read host files outside the disposable workspace", async () => {
  const task = requiredTask("nav-001");
  const tmpParent = tempRunsDir();
  const outside = tempRunsDir();
  const secret = "TASK_OWNED_HOST_SECRET_789";
  writeFileSync(`${outside}/host-secret.txt`, secret);
  const workspace = new FixtureWorkspace({
    fixtureDir: `${FIXTURES_DIR}/${task.fixture}`,
    runId: "read-isolation",
    tmpParent,
    task,
  });
  try {
    await workspace.prepare();
    const direct = await workspace.execShell(`cat ${outside}/host-secret.txt`, 20_000);
    if (direct.code === 0 || direct.stdout.includes(secret)) {
      throw new Error("sandbox exposed a host file outside the disposable workspace");
    }

    await symlink(`${outside}/host-secret.txt`, `${workspace.root}/secret-link`);
    const viaSymlink = await workspace.execShell("cat secret-link", 20_000);
    if (viaSymlink.code === 0 || viaSymlink.stdout.includes(secret)) {
      throw new Error("sandbox followed a workspace symlink to a host file");
    }
  } finally {
    await removeAll(tmpParent, outside);
  }
});

test.skipIf(!SANDBOX_OS)("fixture: shell commands run with a replaced environment, not the host environment", async () => {
  const task = requiredTask("nav-001");
  const tmpParent = tempRunsDir();
  const workspace = new FixtureWorkspace({
    fixtureDir: `${FIXTURES_DIR}/${task.fixture}`,
    runId: "env-isolation",
    tmpParent,
    task,
  });
  try {
    await workspace.prepare();
    const result = await workspace.execShell("env", 20_000);
    if (result.code !== 0) throw new Error(`sandboxed env failed: ${result.stderr}`);
    const sandboxed = parseEnv(result.stdout);
    if (sandboxed.get("HOME") !== realpathSync(workspace.root)) {
      throw new Error(`expected HOME to be the disposable workspace, got ${sandboxed.get("HOME") ?? "(unset)"}`);
    }
    if (sandboxed.get("USER") !== "benchmark") {
      throw new Error(`expected a sandbox-owned USER, got ${sandboxed.get("USER") ?? "(unset)"}`);
    }
    if (sandboxed.get("GIT_CONFIG_GLOBAL") !== "/dev/null") {
      throw new Error("expected the sandbox to disable the host git configuration");
    }
    // A cleared environment can only contain the variables the sandbox and
    // `sh` set themselves; anything else is an inherited host variable.
    const inherited = [...sandboxed.keys()].filter((name) => !SANDBOX_ENV_ALLOWLIST.has(name));
    if (inherited.length > 0) throw new Error(`sandbox inherited host environment variables: ${inherited.join(", ")}`);
  } finally {
    await removeAll(tmpParent);
  }
});

test.skipIf(!SANDBOX_OS)("fixture: shell.exec enforces allowed_write_scope and restores unauthorized changes", async () => {
  // fail-002 declares allowed_write_scope ["**", "!protected/**"].
  const task = requiredTask("fail-002");
  const tmpParent = tempRunsDir();
  const workspace = new FixtureWorkspace({
    fixtureDir: `${FIXTURES_DIR}/${task.fixture}`,
    runId: "scope-enforcement",
    tmpParent,
    task,
  });
  try {
    await workspace.prepare();

    // A failing command stays a failure; nothing here invents success.
    const failed = await workspace.execShell("false", 20_000);
    if (failed.code === 0 || failed.timedOut) throw new Error("expected the shell failure to propagate");

    // In-scope creation and deletion are not touched by enforcement.
    const allowedWrite = await workspace.execShell("printf 'changed\\n' > data/allowed.txt", 20_000);
    if (allowedWrite.code !== 0 || workspace.read("data/allowed.txt") !== "changed\n") {
      throw new Error(`expected the in-scope write to succeed: ${allowedWrite.stderr}`);
    }
    const allowedDelete = await workspace.execShell("rm data/allowed.txt", 20_000);
    if (allowedDelete.code !== 0 || (await exists(`${workspace.root}/data/allowed.txt`))) {
      throw new Error("expected the in-scope deletion to succeed");
    }

    // Out-of-scope modification: rejected with the established error and restored.
    const mutation = await expectWriteScopeViolation(() => workspace.execShell("printf 'TAMPERED\\n' > protected/keep.txt", 20_000));
    if (mutation.path !== "protected/keep.txt") throw new Error(`expected the violation to name protected/keep.txt, got ${mutation.path}`);
    if (!mutation.message.includes("write scope violation")) throw new Error(`unexpected violation message: ${mutation.message}`);
    if (workspace.read("protected/keep.txt") !== "ORIGINAL\n") throw new Error("unauthorized modification was not restored");

    // Out-of-scope creation: rejected and removed, including symlink creations.
    await expectWriteScopeViolation(() => workspace.execShell("printf 'new\\n' > protected/created.txt", 20_000));
    if (await exists(`${workspace.root}/protected/created.txt`)) throw new Error("unauthorized creation was not removed");
    await expectWriteScopeViolation(() => workspace.execShell("ln -s ../data/target.txt protected/escape-link", 20_000));
    if (await exists(`${workspace.root}/protected/escape-link`)) throw new Error("unauthorized symlink creation was not removed");
    await expectWriteScopeViolation(() => workspace.execShell("mkdir -p protected/newdir && printf 'x\\n' > protected/newdir/file.txt", 20_000));
    if (await exists(`${workspace.root}/protected/newdir`)) throw new Error("unauthorized directory creation left a directory shell behind");

    // Out-of-scope deletion: rejected and restored.
    await expectWriteScopeViolation(() => workspace.execShell("rm protected/keep.txt", 20_000));
    if (workspace.read("protected/keep.txt") !== "ORIGINAL\n") throw new Error("unauthorized deletion was not restored");

    // A command that mixes in-scope and out-of-scope writes keeps the
    // allowed write and rolls back only the unauthorized one.
    await expectWriteScopeViolation(() => workspace.execShell("printf 'changed\\n' > data/target.txt; printf 'TAMPERED\\n' > protected/keep.txt", 20_000));
    if (workspace.read("data/target.txt") !== "changed\n") throw new Error("the in-scope write from a violating command was rolled back");
    if (workspace.read("protected/keep.txt") !== "ORIGINAL\n") throw new Error("the out-of-scope write from a violating command was not restored");
  } finally {
    await removeAll(tmpParent);
  }
});

test.skipIf(!SANDBOX_OS)("fixture: a pre-existing directory change is not excused by allowed descendants", async () => {
  // Entries below data/ are writable and the data/ directory itself is
  // explicitly excluded, so a directory-only change must be rejected even
  // when the command also makes an allowed descendant write.
  const task = { ...requiredTask("fail-002"), allowed_write_scope: ["data/**", "!data"] };
  const tmpParent = tempRunsDir();
  const workspace = new FixtureWorkspace({
    fixtureDir: `${FIXTURES_DIR}/${task.fixture}`,
    runId: "preexisting-dir",
    tmpParent,
    task,
  });
  try {
    await workspace.prepare();
    // Owner-only starting mode, different from the attempted one, so the
    // chmod is a real change regardless of the process umask.
    await chmod(`${workspace.root}/data`, 0o700);
    const originalMode = lstatSync(`${workspace.root}/data`).mode;
    // The allowed child is created before the directory is made read-only,
    // because no descendant write is possible after chmod 0500.
    const violation = await expectWriteScopeViolation(() => workspace.execShell("printf 'y\\n' > data/child.txt && chmod 500 data", 20_000));
    if (violation.path !== "data") throw new Error(`expected the violation to name the changed directory, got ${violation.path}`);
    if (lstatSync(`${workspace.root}/data`).mode !== originalMode) throw new Error("the pre-existing directory mode was not restored");
    if (workspace.read("data/child.txt") !== "y\n") throw new Error("the allowed descendant write from the violating command was rolled back");
  } finally {
    await removeAll(tmpParent);
  }
});

test.skipIf(!SANDBOX_OS)("fixture: a created directory the scope excludes is not excused by allowed descendants", async () => {
  // `!data/sub` names that path as unwritable, so creating it to hold an
  // allowed descendant is still an unauthorized mutation of the excluded
  // path and is rolled back.
  const task = { ...requiredTask("fail-002"), allowed_write_scope: ["data/**", "!data/sub"] };
  const tmpParent = tempRunsDir();
  const workspace = new FixtureWorkspace({
    fixtureDir: `${FIXTURES_DIR}/${task.fixture}`,
    runId: "created-excluded-dir",
    tmpParent,
    task,
  });
  try {
    await workspace.prepare();
    const violatingCommand = "printf 'a\\n' > data/ok.txt && mkdir data/sub && printf 'y\\n' > data/sub/f";
    const violation = await expectWriteScopeViolation(() => workspace.execShell(violatingCommand, 20_000));
    if (violation.path !== "data/sub") throw new Error(`expected the violation to name data/sub, got ${violation.path}`);
    if (await exists(`${workspace.root}/data/sub`)) throw new Error("the explicitly excluded directory survived the rollback");
    if (workspace.read("data/ok.txt") !== "a\n") throw new Error("the in-scope write from the violating command was rolled back");

    // Directories no scope pattern describes are still allowed when every
    // changed entry below them is in scope, so `mkdir -p` keeps working.
    const undescribed = { ...task, allowed_write_scope: ["**/ok.txt"] };
    const other = new FixtureWorkspace({
      fixtureDir: `${FIXTURES_DIR}/${undescribed.fixture}`,
      runId: "undescribed-dir",
      tmpParent,
      task: undescribed,
    });
    await other.prepare();
    const allowed = await other.execShell("mkdir -p data/nested/deep && printf 'z\\n' > data/nested/deep/ok.txt", 20_000);
    if (allowed.code !== 0 || other.read("data/nested/deep/ok.txt") !== "z\n") {
      throw new Error(`expected the in-scope descendant write to succeed: ${allowed.stderr}`);
    }
  } finally {
    await removeAll(tmpParent);
  }
});

test.skipIf(!SANDBOX_OS)("fixture: created entries are never removed through a restored symlink", async () => {
  // The workspace symlink and the entries behind it are out of scope, so the
  // rollback restores the symlink and must not follow it to remove what the
  // command created in its place.
  const task = { ...requiredTask("fail-002"), allowed_write_scope: ["**", "!link", "!link/**"] };
  const tmpParent = tempRunsDir();
  const outside = tempRunsDir();
  writeFileSync(`${outside}/b`, "HOST_CONTENT\n");
  const workspace = new FixtureWorkspace({
    fixtureDir: `${FIXTURES_DIR}/${task.fixture}`,
    runId: "restored-symlink",
    tmpParent,
    task,
  });
  try {
    await workspace.prepare();
    await symlink(outside, `${workspace.root}/link`);
    const violation = await expectWriteScopeViolation(() => workspace.execShell("rm link && mkdir link && printf 'x\\n' > link/b", 20_000));
    if (violation.path !== "link/b") throw new Error(`expected the violation to name the created file, got ${violation.path}`);
    if ((await readFile(`${outside}/b`, "utf8")) !== "HOST_CONTENT\n") {
      throw new Error("created-entry rollback followed a restored symlink out of the workspace");
    }
    if (!(await lstat(`${workspace.root}/link`)).isSymbolicLink()) throw new Error("the snapshot symlink was not restored");
  } finally {
    await removeAll(tmpParent, outside);
  }
});

test.skipIf(!SANDBOX_OS)("fixture: write-scope rollback never writes through a workspace symlink", async () => {
  const task = requiredTask("fail-002");
  const tmpParent = tempRunsDir();
  const outside = tempRunsDir();
  writeFileSync(`${outside}/keep.txt`, "HOST_CONTENT\n");
  const workspace = new FixtureWorkspace({
    fixtureDir: `${FIXTURES_DIR}/${task.fixture}`,
    runId: "symlink-rollback",
    tmpParent,
    task,
  });
  try {
    await workspace.prepare();
    // Replace the protected directory with a symlink to a host directory;
    // the rollback of protected/keep.txt must recreate the real directory
    // instead of following the link out of the workspace.
    const violation = await expectWriteScopeViolation(() => workspace.execShell(`rm -rf protected && ln -s ${outside} protected`, 20_000));
    if (violation.path !== "protected/keep.txt") throw new Error(`expected the violation to name the deleted file, got ${violation.path}`);
    if ((await readFile(`${outside}/keep.txt`, "utf8")) !== "HOST_CONTENT\n") {
      throw new Error("write-scope rollback wrote through a symlink into a host directory");
    }
    if (workspace.read("protected/keep.txt") !== "ORIGINAL\n") throw new Error("the protected file was not restored inside the workspace");
  } finally {
    await removeAll(tmpParent, outside);
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFsError(error, "ENOENT")) return false;
    throw error;
  }
}

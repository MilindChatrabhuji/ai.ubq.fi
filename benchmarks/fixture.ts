import { readdirSync, readFileSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, realpathSync, readlinkSync, lstatSync, rmSync, statSync } from "node:fs";
import { mkdir, rm, copyFile } from "node:fs/promises";
import { isFsError } from "./fs-errors.ts";
/**
 * Disposable fixture workspaces.
 *
 * Every run executes against a private copy of a checked-in fixture snapshot
 * under the git-ignored runs root (see DEFAULT_RUNS_ROOT). The adapter's
 * writes are confined to that copy; write-scope globs declared in the task
 * manifest are enforced at the tool layer, and paths are always resolved
 * inside the workspace root. The canonical repository checkout is never
 * touched by benchmark runs.
 */

import type { Stats } from "node:fs";
import { runCommand } from "./process.ts";
import type { TaskManifest } from "./schemas.ts";

/** Thrown when the declared fixture_revision does not match the snapshot. */
export class FixtureRevisionMismatchError extends Error {
  constructor(
    readonly taskId: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(`fixture revision mismatch for ${taskId}: manifest declares ${expected}, snapshot is ${actual}` + ` (regenerate fixtures or update the manifest)`);
    this.name = "FixtureRevisionMismatchError";
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Content-addressed revision of a fixture snapshot directory. */
export async function computeFixtureRevision(fixtureDir: string): Promise<string> {
  const files: { rel: string; abspath: string }[] = [];
  const walk = (dir: string, rel: string) => {
    const entries = [...readdirSync(dir, { withFileTypes: true })].filter((e) => e.isFile() || e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, childRel);
      else files.push({ rel: childRel, abspath: `${dir}/${entry.name}` });
    }
  };
  walk(fixtureDir, "");
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [encoder.encode("fixture-v1\0")];
  for (const f of files) {
    parts.push(encoder.encode(f.rel + "\0"));
    parts.push(readFileSync(f.abspath));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return `sha256:${await sha256Hex(buf)}`;
}

/** Glob matcher: `*` (segment), `**` (across segments), `?` (single char). */
export function globMatch(pattern: string, path: string): boolean {
  const rx = patternToRegExp(pattern);
  return rx.test(path);
}

function patternToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` matches across slashes; collapse `**/` or trailing `**`.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "/") {
      re += "/";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** Removes every trailing `/`, equivalent to `value.replace(/\/+$/, "")` via an explicit linear scan. */
const stripTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
};

/** True when the joined path lexically stays inside the root. */
export function pathInside(root: string, rel: string): boolean {
  const rootAbs = normalizeLexically(stripTrailingSlashes(root));
  const joined = normalizeLexically(`${rootAbs}/${rel}`);
  return joined === rootAbs || joined.startsWith(rootAbs + "/");
}

function normalizeLexically(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return (p.startsWith("/") ? "/" : "") + out.join("/");
}

export class WriteScopeViolationError extends Error {
  constructor(
    readonly path: string,
    readonly scope: string[]
  ) {
    super(`write scope violation: ${path} is not writable (scope: ${scope.join(", ")})`);
    this.name = "WriteScopeViolationError";
  }
}

export type FixtureWorkspaceOptions = {
  fixtureDir: string;
  runId: string;
  /** Parent directory for disposable workspaces (must be writable, git-ignored). */
  tmpParent: string;
  task: TaskManifest;
};

export class FixtureWorkspace {
  readonly root: string;
  readonly fixtureDir: string;
  readonly task: TaskManifest;
  private _prepared = false;

  constructor(opts: FixtureWorkspaceOptions) {
    this.fixtureDir = opts.fixtureDir;
    this.task = opts.task;
    this.root = `${opts.tmpParent}/${opts.runId}`;
  }

  /** True when the path matches the task's allowed_write_scope. */
  isAllowedWrite(rel: string): boolean {
    let allowed = false;
    for (const pattern of this.task.allowed_write_scope) {
      if (globMatch(pattern.replace(/^!/, ""), rel)) allowed = !pattern.startsWith("!");
    }
    return allowed;
  }

  /**
   * True when the last scope pattern matching the path is a negation, i.e.
   * the task explicitly names the path as unwritable. Unlike
   * {@link isAllowedWrite}, this distinguishes a path the scope never
   * describes from one a negation excludes by name.
   */
  private _isExplicitlyDeniedWrite(rel: string): boolean {
    let denied = false;
    for (const pattern of this.task.allowed_write_scope) {
      if (!globMatch(pattern.replace(/^!/, ""), rel)) continue;
      denied = pattern.startsWith("!");
    }
    return denied;
  }

  private _assertRoot(): void {
    if (!this._prepared) throw new Error("fixture workspace not prepared");
  }

  private _assertPath(rel: string): string {
    if (rel === "" || rel.startsWith("/") || rel.split("/").includes("..")) {
      throw new Error(`path escapes workspace root: ${rel}`);
    }
    const abs = `${this.root}/${rel}`;
    if (!pathInside(this.root, rel)) throw new Error(`path escapes workspace root: ${rel}`);
    return abs;
  }

  /** Assemble the disposable working tree and optional git history. */
  async prepare(): Promise<void> {
    if (this._prepared) throw new Error("prepare called twice");
    await mkdir(this.root, { recursive: true });

    const git = this.task.git;
    if (git?.history && git.history.length > 0) {
      // Initialize a repository rooted at the disposable workspace so git
      // never walks up into the enclosing repository checkout.
      await gitCommand(this.root, ["init", "-q"]);
      for (const snapshot of git.history) {
        const snapDir = `${this.fixtureDir}/${snapshot}`;
        for (const entry of readdirSync(this.root, { withFileTypes: true })) {
          if (entry.name === ".git") continue; // keep the disposable repository
          await rm(`${this.root}/${entry.name}`, { recursive: true });
        }
        await copyTree(snapDir, this.root);
        await gitCommand(this.root, ["add", "-A"]);
        await gitCommand(this.root, [
          "-c",
          "user.email=benchmark@invalid.invalid",
          "-c",
          "user.name=benchmark",
          "commit",
          "-qm",
          snapshot.split("/").pop() ?? snapshot,
        ]);
      }
    } else {
      await copyTree(this.fixtureDir, this.root);
      if (git?.init) {
        await gitCommand(this.root, ["init", "-q"]);
        await gitCommand(this.root, ["add", "-A"]);
        await gitCommand(this.root, ["-c", "user.email=benchmark@invalid.invalid", "-c", "user.name=benchmark", "commit", "-qm", "base"]);
      }
    }
    this._prepared = true;
  }

  /** Delete the disposable working tree. */
  async remove(): Promise<void> {
    try {
      await rm(this.root, { recursive: true });
    } catch (err) {
      if (!(isFsError(err, "EACCES") || isFsError(err, "EPERM"))) throw err;
      // An allowed command may intentionally leave a directory read-only.
      // Recover owner access for cleanup without following workspace links.
      makeWorkspaceRemovable(this.root);
      await rm(this.root, { recursive: true });
    }
  }

  read(rel: string): string {
    this._assertRoot();
    return readFileSync(this._assertPath(rel), "utf8");
  }

  /** Write a file relative to the workspace root; enforces write scope. */
  write(rel: string, content: string): void {
    this._assertRoot();
    if (!this.isAllowedWrite(rel)) throw new WriteScopeViolationError(rel, this.task.allowed_write_scope);
    const abs = this._assertPath(rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    writeFileSync(abs, content);
  }

  /**
   * Minimal deterministic patch: replace the first (and only) occurrence of
   * `old` with `new`, or create the file when `add` is true.
   */
  applyPatch(rel: string, old: string, next: string, add: boolean): { applied: boolean; detail: string } {
    this._assertRoot();
    if (!this.isAllowedWrite(rel)) throw new WriteScopeViolationError(rel, this.task.allowed_write_scope);
    const abs = this._assertPath(rel);
    if (add) {
      if (existsSync(abs)) throw new Error(`patch add refused: ${rel} already exists`);
      mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      writeFileSync(abs, next);
      return { applied: true, detail: `created ${rel}` };
    }
    const absStat = statIfExists(abs);
    if (!absStat?.isFile()) throw new Error(`patch failed: ${rel} does not exist`);
    const content = readFileSync(abs, "utf8");
    const first = content.indexOf(old);
    if (first === -1) throw new Error(`patch failed: ${rel} does not contain the expected old text`);
    if (content.includes(old, first + 1)) {
      throw new Error(`patch failed: old text occurs more than once in ${rel}`);
    }
    const patched = content.slice(0, first) + next + content.slice(first + old.length);
    writeFileSync(abs, patched);
    return { applied: true, detail: `patched ${rel}` };
  }

  /** Relative paths of files under the workspace root (sorted). */
  listFiles(rel = ""): string[] {
    this._assertRoot();
    const out: string[] = [];
    const start = rel === "" ? this.root : this._assertPath(rel);
    const walk = (dir: string, prefix: string) => {
      const entries = [...readdirSync(dir, { withFileTypes: true })].filter((e) => e.isFile() || e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const child = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`, child);
        else out.push(child);
      }
    };
    walk(start, rel);
    return out.sort(compareCodeUnits);
  }

  /** Run a command in the workspace; used by oracles and verification. */
  async exec(
    cmd: string[],
    opts: { timeoutMs: number; capture: boolean; signal?: AbortSignal }
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    const signal = opts.signal === undefined ? AbortSignal.timeout(opts.timeoutMs) : AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), opts.signal]);
    try {
      const out = await runCommand(cmd, { cwd: this.root, capture: opts.capture, signal });
      // When the signal fired, Bun may surface the child's kill exit code
      // instead of an AbortError; classify by signal state rather than code.
      if (signal.aborted) {
        return { code: -1, stdout: "", stderr: "", timedOut: true };
      }
      return {
        code: out.code,
        stdout: out.stdout,
        stderr: out.stderr,
        timedOut: false,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError" || (err as { cause?: { name?: string } }).cause?.name === "AbortError") {
        return { code: -1, stdout: "", stderr: "", timedOut: true };
      }
      throw err;
    }
  }

  /**
   * Run a shell command in the workspace and enforce the task's
   * `allowed_write_scope` on what it changed.
   *
   * The sandbox confines the command to the disposable workspace, but
   * `allowed_write_scope` is a task contract the sandbox cannot express, so
   * the workspace is snapshotted before the command and unauthorized
   * creations, modifications and deletions are restored afterwards. Only
   * paths under this workspace root are ever read or written here, and no
   * snapshot or restore ever follows a symlink out of the workspace.
   */
  async execShell(command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    this._assertRoot();
    const before = snapshotWorkspace(this.root);
    let result: { code: number; stdout: string; stderr: string; timedOut: boolean };
    try {
      result = await this._runShellSandboxed(command, timeoutMs, signal);
    } catch (err) {
      // A sandbox that failed to start must not hide mutations a shell made
      // before it died, so the scope is still enforced before rethrowing.
      this._enforceWriteScope(before);
      throw err;
    }
    this._enforceWriteScope(before);
    return result;
  }

  /**
   * Restore every unauthorized change the command made inside the disposable
   * workspace, then throw {@link WriteScopeViolationError}. Paths are walked
   * with `lstat` semantics, so a symlink is recorded (never followed) and a
   * symlinked ancestor is rebuilt as a real directory before any write.
   */
  private _enforceWriteScope(before: WorkspaceSnapshot): void {
    const after = snapshotWorkspace(this.root, before);
    const changed = changedWorkspacePaths(before, after);
    const unauthorized = changed.filter((rel) => !this._isAllowedShellChange(rel, changed, before, after));
    if (unauthorized.length === 0) return;

    const directoryModes: { abs: string; mode: number | null }[] = [];
    const unauthorizedSet = new Set(unauthorized);
    // Restore descendants first. Removing a directory recursively requires
    // write access to every nested directory, not just the top-level entry.
    // Each descendant restoration grants access to its own ancestors before
    // it is removed, so a non-root runner can unwind a read-only created tree.
    const restoreOrder = [...unauthorized].sort((a, b) => {
      const depth = (path: string): number => path.split("/").length;
      return depth(b) - depth(a) || compareCodeUnits(a, b);
    });
    for (const rel of restoreOrder) this._restoreWorkspaceEntry(rel, before, directoryModes, unauthorizedSet);
    // Directory modes are applied last, deepest first, so a read-only restored
    // directory cannot block the restoration of the entries inside it. A null
    // mode means the platform does not report permission bits for the entry.
    for (const entry of [...directoryModes].reverse()) {
      if (entry.mode !== null) chmodSync(entry.abs, entry.mode);
    }

    const reported = unauthorized.find((rel) => after.get(rel)?.kind !== "directory") ?? unauthorized[0];
    throw new WriteScopeViolationError(reported, this.task.allowed_write_scope);
  }

  /**
   * A changed path is allowed when it matches the task scope. A directory the
   * command had to create is allowed when every changed entry below it is
   * allowed, so `mkdir -p` for an in-scope file does not fail on a directory
   * path the scope globs never describe; a path a negation pattern excludes by
   * name is never allowed that way. A directory that already existed is
   * judged by the scope alone: its own mode or type change must not hide
   * behind allowed descendants.
   */
  private _isAllowedShellChange(rel: string, changed: readonly string[], before: WorkspaceSnapshot, after: WorkspaceSnapshot): boolean {
    if (this.isAllowedWrite(rel)) return true;
    // A path a negation pattern excludes by name stays unauthorized even when
    // the command created allowed descendants below it: the created-directory
    // compensation below only covers directories no scope pattern describes.
    if (this._isExplicitlyDeniedWrite(rel)) return false;
    if (before.get(rel) !== undefined) return false;
    if (after.get(rel)?.kind !== "directory") return false;
    const descendants = changed.filter((path) => path.startsWith(`${rel}/`));
    return descendants.length > 0 && descendants.every((path) => this._isAllowedShellChange(path, changed, before, after));
  }

  private _restoreWorkspaceEntry(
    rel: string,
    before: WorkspaceSnapshot,
    directoryModes: { abs: string; mode: number | null }[],
    unauthorized: ReadonlySet<string>
  ): void {
    const abs = this._assertPath(rel);
    const expected = before.get(rel);
    this._restoreDirectoryAccess(rel, before, directoryModes, unauthorized);
    if (expected === undefined) {
      // An unauthorized creation is removed only while every ancestor is a
      // real directory inside the workspace: recreating missing ancestors here
      // would leave an empty directory shell behind, and a symlinked ancestor
      // (for example one a previous restore put back) would redirect the
      // removal outside the workspace.
      if (this._hasRealDirectoryAncestors(rel)) removeWorkspaceEntry(abs);
      return;
    }
    this._restoreRealAncestors(rel, before, directoryModes);
    if (expected.kind === "directory") {
      const current = lstatIfExists(abs);
      if (current?.isDirectory() !== true) {
        removeWorkspaceEntry(abs);
        mkdirSync(abs, { recursive: true });
      }
      directoryModes.push({ abs, mode: expected.mode });
      return;
    }
    removeWorkspaceEntry(abs);
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    if (expected.kind === "file") {
      writeFileSync(abs, expected.content);
      if (expected.mode !== null) chmodSync(abs, expected.mode);
    } else if (expected.kind === "symlink") {
      symlinkSync(expected.target, abs);
    }
    // Sockets and fifos ("other") cannot be recreated portably; the violation
    // is still reported and the rest of the workspace is restored.
  }

  /** Make directory ancestors writable while restoring an entry. */
  private _restoreDirectoryAccess(
    rel: string,
    before: WorkspaceSnapshot,
    directoryModes: { abs: string; mode: number | null }[],
    unauthorized: ReadonlySet<string>
  ): void {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      this._restoreAncestorMode(ancestor, before, directoryModes, unauthorized);
    }
  }

  private _restoreAncestorMode(
    ancestor: string,
    before: WorkspaceSnapshot,
    directoryModes: { abs: string; mode: number | null }[],
    unauthorized: ReadonlySet<string>
  ): void {
    const expected = before.get(ancestor);
    const abs = this._assertPath(ancestor);
    const current = lstatIfExists(abs);
    if (current?.isDirectory() !== true) return;
    const currentMode = snapshotMode(current);
    if (currentMode === null) return;
    // A directory being removed has no saved directory metadata (or is
    // replacing a non-directory), but it may have been made read-only after
    // its children were written. Make it removable before rolling it back.
    if (expected?.kind !== "directory") {
      const accessMode = currentMode | 0o700;
      if (currentMode !== accessMode) {
        chmodSync(abs, accessMode);
        // This ancestor is not being rolled back itself, so retain the
        // command's mode after granting temporary access to its children.
        if (!unauthorized.has(ancestor)) directoryModes.push({ abs, mode: currentMode });
      }
      return;
    }
    if (expected.mode === null) return;
    const accessMode = expected.mode | 0o700;
    if (currentMode === accessMode) return;
    chmodSync(abs, accessMode);
    directoryModes.push({ abs, mode: unauthorized.has(ancestor) ? expected.mode : currentMode });
  }

  /** True when every ancestor of `rel` is a real directory inside the workspace. */
  private _hasRealDirectoryAncestors(rel: string): boolean {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const abs = this._assertPath(parts.slice(0, i).join("/"));
      if (lstatIfExists(abs)?.isDirectory() !== true) return false;
    }
    return true;
  }

  /**
   * Rebuild any ancestor that is no longer a real directory before restoring a
   * path below it. Writing through a symlinked (or file) ancestor would leave
   * the workspace and mutate the link's target, so the snapshot's real
   * directory is recreated first.
   */
  private _restoreRealAncestors(rel: string, before: WorkspaceSnapshot, directoryModes: { abs: string; mode: number | null }[]): void {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      const abs = this._assertPath(ancestor);
      if (lstatIfExists(abs)?.isDirectory() === true) continue;
      removeWorkspaceEntry(abs);
      mkdirSync(abs, { recursive: true });
      const expected = before.get(ancestor);
      if (expected?.kind === "directory") directoryModes.push({ abs, mode: expected.mode });
    }
  }

  /**
   * Run one command inside the platform sandbox. Sandbox absence or failure is
   * a non-zero exit, never a fallback to unsandboxed execution.
   */
  private async _runShellSandboxed(
    command: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    if (process.platform === "linux") {
      const root = realpathSync(this.root);
      return await this.exec(
        [
          "sh",
          "-c",
          [
            'sandbox="$(command -v bwrap)" || { echo "shell execution sandbox requires bwrap" >&2; exit 126; }',
            'root="$1"; cmd="$2"',
            "set -- --die-with-parent --unshare-all --new-session",
            'for d in /usr /etc; do [ -d "$d" ] && set -- "$@" --ro-bind "$d" "$d"; done',
            "for l in bin lib lib64; do",
            '  if [ -L "/$l" ]; then set -- "$@" --symlink "usr/$l" "/$l"',
            '  elif [ -d "/$l" ]; then set -- "$@" --ro-bind "/$l" "/$l"; fi',
            "done",
            'set -- "$@" --dev /dev --proc /proc --tmpfs /tmp --bind "$root" "$root" --chdir "$root" --clearenv --setenv PATH "/usr/bin:/bin:/usr/local/bin" --setenv HOME "$root" --setenv GIT_CONFIG_GLOBAL /dev/null --setenv USER benchmark',
            'exec "$sandbox" "$@" sh -c "$cmd"',
          ].join("\n"),
          "fixture-sandbox",
          root,
          command,
        ],
        { timeoutMs, capture: true, signal }
      );
    }
    if (process.platform !== "darwin") {
      return {
        code: 126,
        stdout: "",
        stderr: `shell execution sandbox is unavailable on ${process.platform}`,
        timedOut: false,
      };
    }

    // A working directory is not a security boundary: an arbitrary shell can
    // use absolute paths, `..`, or symlinks to mutate the host checkout. Seatbelt
    // resolves filesystem objects before applying the subpath rule, so all
    // writes remain inside this disposable fixture even through a symlink, and
    // reads are limited to system locations plus the workspace root instead of
    // the whole host (no user home, credentials or dotfiles).
    const root = realpathSync(this.root);
    const profile = [
      "(version 1)",
      "(deny default)",
      '(import "system.sb")',
      "(allow process-exec)",
      "(allow process-fork)",
      '(allow file-read* (subpath "/System"))',
      '(allow file-read* (subpath "/usr"))',
      '(allow file-read* (subpath "/bin"))',
      '(allow file-read* (subpath "/sbin"))',
      '(allow file-read* (subpath "/Library"))',
      '(allow file-read* (subpath "/dev"))',
      '(allow file-read* (subpath "/private/etc"))',
      '(allow file-read* (subpath "/etc"))',
      '(allow file-read* (subpath "/private/tmp"))',
      '(allow file-read* (subpath "/tmp"))',
      '(allow file-read* (subpath "/private/var"))',
      `(allow file-read* (subpath ${sandboxString(root)}))`,
      '(allow file-write* (literal "/dev/null"))',
      `(allow file-write* (subpath ${sandboxString(root)}))`,
      "(deny network*)",
    ].join("\n");
    return await this.exec(
      [
        "sh",
        "-c",
        'exec env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin" HOME="$3" GIT_CONFIG_GLOBAL=/dev/null USER=benchmark /usr/bin/sandbox-exec -p "$1" sh -c "$2"',
        "fixture-sandbox",
        profile,
        command,
        root,
      ],
      { timeoutMs, capture: true, signal }
    );
  }
}

/**
 * Snapshot entry recorded with `lstat` semantics; symlinks are never followed.
 * A null `mode` means the platform reports no permission bits for the entry,
 * so mode changes are neither compared nor restored there.
 */
type WorkspaceSnapshotEntry =
  | { kind: "file"; content: Uint8Array; mode: number | null }
  | { kind: "directory"; mode: number | null }
  | { kind: "symlink"; target: string }
  | { kind: "other"; mode: number | null };

type WorkspaceSnapshot = Map<string, WorkspaceSnapshotEntry>;

/**
 * Records every entry under `root` without following symlinks: links are
 * stored as links and the walk never descends through them, so the snapshot
 * only ever describes objects physically inside the disposable workspace.
 */
function snapshotWorkspace(root: string, saved?: WorkspaceSnapshot): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = new Map();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of [...readdirSync(dir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = `${dir}/${entry.name}`;
      recordSnapshotEntry(
        snapshot,
        rel,
        abs,
        () => {
          walk(abs, rel);
        },
        saved
      );
    }
  };
  walk(root, "");
  return snapshot;
}

/**
 * Records one entry, walking below it when it is a directory. An entry that
 * disappeared between `readDir` and its own read is skipped rather than
 * reported as a change.
 */
function recordSnapshotEntry(snapshot: WorkspaceSnapshot, rel: string, abs: string, walkBelow: () => void, saved?: WorkspaceSnapshot): void {
  const info = lstatIfExists(abs);
  if (info === null) return; // the entry vanished while the snapshot was taken
  if (info.isSymbolicLink()) {
    const target = snapshotSymlinkTarget(abs);
    if (target !== null) snapshot.set(rel, { kind: "symlink", target });
    return;
  }
  if (info.isDirectory()) {
    const mode = snapshotMode(info);
    snapshot.set(rel, { kind: "directory", mode });
    const grantedMode = grantSnapshotAccess(abs, mode, saved?.get(rel), "directory");
    try {
      walkBelow();
    } finally {
      restoreSnapshotAccess(abs, mode, grantedMode);
    }
    return;
  }
  if (info.isFile()) {
    const mode = snapshotMode(info);
    const grantedMode = grantSnapshotAccess(abs, mode, saved?.get(rel), "file");
    try {
      const content = snapshotFileContent(abs);
      if (content !== null) snapshot.set(rel, { kind: "file", content, mode });
    } finally {
      restoreSnapshotAccess(abs, mode, grantedMode);
    }
    return;
  }
  snapshot.set(rel, { kind: "other", mode: snapshotMode(info) });
}

function changedWorkspacePaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((rel) => !snapshotEntriesEqual(before.get(rel), after.get(rel))).sort(compareCodeUnits);
}

function snapshotEntriesEqual(before: WorkspaceSnapshotEntry | undefined, after: WorkspaceSnapshotEntry | undefined): boolean {
  if (before === undefined || after === undefined) return before === after;
  if (before.kind !== after.kind) return false;
  if (before.kind === "symlink") return after.kind === "symlink" && before.target === after.target;
  if (before.kind === "file") return after.kind === "file" && before.mode === after.mode && bytesEqual(before.content, after.content);
  if (before.kind === "directory") return after.kind === "directory" && before.mode === after.mode;
  // Opaque entries (sockets, fifos) compare equal unless created, deleted or
  // replaced by a different kind, which the checks above already handled.
  return true;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Permission bits when the platform reports them; `null` means the host has no
 * POSIX mode for this entry, so mode changes are neither compared nor restored.
 */
function snapshotMode(info: Stats): number | null {
  return process.platform === "win32" ? null : info.mode & 0o7777;
}

/** Temporarily grant owner access while reading a post-command snapshot. */
function grantSnapshotAccess(abs: string, mode: number | null, saved: WorkspaceSnapshotEntry | undefined, kind: "directory" | "file"): number | null {
  if (mode === null) return null;
  const savedMode = saved?.kind === kind && saved.mode !== null ? saved.mode : mode;
  const accessMode = savedMode | (kind === "directory" ? 0o700 : 0o600);
  if (accessMode === mode) return null;
  chmodSync(abs, accessMode);
  return accessMode;
}

/** Restore the mode captured before temporary snapshot access was granted. */
function restoreSnapshotAccess(abs: string, mode: number | null, grantedMode: number | null): void {
  if (mode === null || grantedMode === null) return;
  try {
    chmodSync(abs, mode);
  } catch (err) {
    if (!isFsError(err, "ENOENT")) throw err;
  }
}

/** File bytes, or `null` only when the file genuinely vanished mid-walk. */
function snapshotFileContent(p: string): Uint8Array | null {
  try {
    return readFileSync(p);
  } catch (err) {
    if (isFsError(err, "ENOENT")) return null;
    throw err;
  }
}

/** Symlink target, or `null` only when the link genuinely vanished mid-walk. */
function snapshotSymlinkTarget(p: string): string | null {
  try {
    return readlinkSync(p);
  } catch (err) {
    if (isFsError(err, "ENOENT")) return null;
    throw err;
  }
}

/**
 * `null` only when the path genuinely does not exist. Any other failure
 * (permissions, I/O, symlink loops) propagates so enforcement fails closed
 * instead of silently treating the entry as absent.
 */
function lstatIfExists(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (err) {
    if (isFsError(err, "ENOENT")) return null;
    throw err;
  }
}

/** Removes one workspace entry without following a symlink at the path. */
function removeWorkspaceEntry(abs: string): void {
  try {
    rmSync(abs, { recursive: true });
  } catch (err) {
    if (isFsError(err, "EACCES") || isFsError(err, "EPERM")) {
      // A removable tree can contain allowed descendants with restrictive
      // modes; make the whole tree accessible before retrying the removal.
      makeWorkspaceRemovable(abs);
      try {
        rmSync(abs, { recursive: true });
      } catch (retryErr) {
        if (!isFsError(retryErr, "ENOENT")) throw retryErr;
      }
      return;
    }
    if (!isFsError(err, "ENOENT")) throw err;
  }
}

/** Grant owner directory access needed to remove a disposable workspace. */
function makeWorkspaceRemovable(abs: string): void {
  const info = lstatIfExists(abs);
  if (info?.isDirectory() !== true) return;
  const mode = snapshotMode(info);
  if (mode !== null) chmodSync(abs, mode | 0o700);
  for (const entry of readdirSync(abs, { withFileTypes: true })) makeWorkspaceRemovable(`${abs}/${entry.name}`);
}

function sandboxString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Compares two strings by UTF-16 code unit. This reproduces the default
 * `Array#sort` ordering exactly, which matters because callers render the
 * result and truncate it (`filesystem.find` / `filesystem.search`).
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function existsSync(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function statIfExists(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

async function copyTree(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = `${src}/${entry.name}`;
    const d = `${dst}/${entry.name}`;
    if (entry.isDirectory()) {
      await copyTree(s, d);
    } else if (entry.isFile()) {
      await copyFile(s, d);
    }
  }
}

async function gitCommand(cwd: string, args: string[]): Promise<void> {
  const out = await runCommand(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (out.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${out.code}): ${out.stderr.trim()}`);
  }
}

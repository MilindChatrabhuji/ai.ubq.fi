import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export const fileDigest = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
export const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
};
/** Deno's FileInfo fields the deploy lock checks. */
export type DenoFileInfo = Readonly<{ isFile: boolean; isSymlink: boolean; mode: number | null; uid: number | null; dev: number; ino: number | null }>;
type DenoLockFile = Readonly<{ stat(): Promise<DenoFileInfo>; tryLockSync(exclusive: boolean): boolean; unlockSync(): void; close(): void }>;
export type DenoLockHost = Readonly<{
  open(path: string, options: Readonly<{ write: true; create: true; mode: number }>): Promise<DenoLockFile>;
  lstat(path: string): Promise<DenoFileInfo>;
  uid(): number | null;
}>;
type DenoChildProcess = Readonly<{
  kill(signal: "SIGKILL"): void;
  output(): Promise<Readonly<{ code: number; stdout: Uint8Array; stderr: Uint8Array }>>;
}>;
type DenoCommandOptions = Readonly<{
  args: string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  clearEnv?: true;
  stdin: "null";
  stdout: "piped";
  stderr: "piped";
}>;
export type DenoCommandHost = Readonly<{ Command: new (program: string, options: DenoCommandOptions) => Readonly<{ spawn(): DenoChildProcess }> }>;
/**
 * Every first-party entrypoint runs on pinned Bun, but Sentinel's VPS release bridge evaluates the
 * pinned driver under Deno. This is a structural view of the few Deno APIs that host needs, not a
 * Deno global shim; host-specific capabilities select their implementation when called.
 */
type HostRuntime = Readonly<{ kind: "bun" }> | Readonly<{ kind: "deno"; deno: DenoLockHost & DenoCommandHost }>;
export const hostRuntime = (): HostRuntime => {
  const globals = globalThis as unknown as Readonly<{ Bun?: unknown; Deno?: DenoLockHost & DenoCommandHost }>;
  if (globals.Bun !== undefined) return { kind: "bun" };
  if (globals.Deno !== undefined) return { kind: "deno", deno: globals.Deno };
  throw new Error("VPS operations require the pinned Bun runtime or the Deno release bridge");
};
type CommandEnvironment = Readonly<{ PATH: string; TMPDIR: string }>;
type SpawnedCommand = Readonly<{ kill(): void; result: Promise<Readonly<{ code: number; stdout: Uint8Array; stderr: string }>> }>;
const spawnBun = (program: string, args: readonly string[], cwd: string | undefined, env: CommandEnvironment | undefined): SpawnedCommand => {
  const child = Bun.spawn([program, ...args], { cwd, env: env ?? process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return {
    kill: () => {
      child.kill("SIGKILL");
    },
    result: Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]).then(([code, stdout, stderr]) => ({
      code,
      stdout: new Uint8Array(stdout),
      stderr,
    })),
  };
};
/** Like the pre-Bun runner, Deno.Command inherits the environment without reading it. */
export const spawnDeno = (
  deno: DenoCommandHost,
  program: string,
  args: readonly string[],
  cwd: string | undefined,
  env: CommandEnvironment | undefined
): SpawnedCommand => {
  const child = new deno.Command(program, {
    args: [...args],
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env, clearEnv: true }),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return {
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Deno refuses to signal a child that already exited.
      }
    },
    result: child.output().then((output) => ({ code: output.code, stdout: output.stdout, stderr: new TextDecoder().decode(output.stderr) })),
  };
};
export const runOutput = async (program: string, args: readonly string[], options: { cwd?: string; sparse?: boolean } = {}): Promise<Uint8Array> => {
  // TMPDIR must remain absolute when the child also changes to a relative cwd.
  const temporary = options.sparse ? await mkdtemp(join(resolve(options.cwd ?? process.cwd()), ".uos-command-")) : undefined;
  try {
    const env = temporary === undefined ? undefined : { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: temporary };
    const host = hostRuntime();
    const child = host.kind === "bun" ? spawnBun(program, args, options.cwd, env) : spawnDeno(host.deno, program, args, options.cwd, env);
    const timer = setTimeout(() => {
      child.kill();
    }, 240_000);
    try {
      const { code, stdout, stderr } = await child.result;
      if (code !== 0) throw new Error(`${program} failed (${code}): ${stderr}`);
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (temporary) await rm(temporary, { recursive: true });
  }
};
export const command = async (program: string, args: readonly string[], options: { cwd?: string; sparse?: boolean } = {}): Promise<string> =>
  new TextDecoder().decode(await runOutput(program, args, options)).trim();

/** Hash every entry, including mode and literal link destination, without following links. */
export const treeDigest = async (root: string, excluded: ReadonlySet<string> = new Set()): Promise<string> => {
  const entries: string[] = [];
  const walk = async (path: string): Promise<void> => {
    const names = (await readdir(`${root}/${path}`)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const relative = path ? `${path}/${name}` : name;
      if (excluded.has(relative)) continue;
      const absolute = `${root}/${relative}`;
      const stat = await lstat(absolute);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) entries.push(JSON.stringify([relative, "link", mode, await readlink(absolute)]));
      else if (stat.isFile()) entries.push(JSON.stringify([relative, "file", mode, digest(await readFile(absolute))]));
      else if (stat.isDirectory()) {
        entries.push(JSON.stringify([relative, "directory", mode]));
        await walk(relative);
      } else throw new Error(`Unsupported immutable release entry: ${relative}`);
    }
  };
  await walk("");
  return digest(entries.join("\n"));
};

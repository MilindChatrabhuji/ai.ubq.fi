import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { join } from "node:path";

export const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
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
export const runOutput = async (program: string, args: readonly string[], options: { cwd?: string; sparse?: boolean } = {}): Promise<Uint8Array> => {
  const temporary = options.sparse ? await mkdtemp(join(options.cwd ?? process.cwd(), ".uos-command-")) : undefined;
  try {
    const child = Bun.spawn([program, ...args], {
      cwd: options.cwd,
      env: options.sparse ? { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: temporary } : process.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 240_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`${program} failed (${code}): ${stderr}`);
      return new Uint8Array(stdout);
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

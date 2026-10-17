import type { Subprocess } from "bun";

export type FixtureChild = Subprocess<"pipe", "pipe", "pipe">;
export type FixtureOutput = { code: number; success: boolean; stdout: Uint8Array<ArrayBuffer>; stderr: Uint8Array<ArrayBuffer> };
type Options = {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "piped";
  stdout?: "piped" | "null";
  stderr?: "piped" | "null";
  clearEnv?: boolean;
};
const outputs = new WeakMap<FixtureChild, Promise<FixtureOutput>>();

/** Sparse native Bun children; no host credentials or dotenv discovery. */
export const spawnFixture = (program: string, options: Options = {}): FixtureChild => {
  const selected = {
    cwd: options.cwd,
    env: options.env ?? { PATH: "/usr/bin:/bin" },
    stdin: "pipe" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  };
  const child = Bun.spawn([program, ...(options.args ?? [])], selected);
  if (options.stdin !== "piped")
    Promise.resolve(child.stdin.end()).catch(() => {
      child.kill("SIGKILL");
    });
  return child;
};
export const outputFixture = (child: FixtureChild): Promise<FixtureOutput> => {
  const cached = outputs.get(child);
  if (cached) return cached;
  const pending = Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()]).then(
    ([code, stdout, stderr]) => ({ code, success: code === 0, stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) })
  );
  outputs.set(child, pending);
  return pending;
};
export const runFixture = (program: string, options: Options = {}): Promise<FixtureOutput> => outputFixture(spawnFixture(program, options));
export const fsError =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof Error && "code" in error && error.code === code;
export const denied = (error: unknown): boolean => fsError("EACCES")(error) || fsError("EPERM")(error) || fsError("EROFS")(error);

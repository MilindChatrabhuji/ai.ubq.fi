import type { BigIntStats } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const sameDirectory = (left: BigIntStats, right: BigIntStats): boolean =>
  right.isDirectory() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;

/** The callback must settle its child before returning; never adopt or clean an older launch's directory. */
export const withMacSqliteTemp = async <T>(root: string, run: (directory: string) => Promise<T>): Promise<T> => {
  if (root !== resolve(root) || (await realpath(root)) !== root) throw new Error("Mac SQLite temp root must be a physical absolute path");
  const data = join(root, ".data");
  const anchor = await lstat(data, { bigint: true });
  if (
    !anchor.isDirectory() ||
    anchor.isSymbolicLink() ||
    anchor.uid !== BigInt(process.getuid?.() ?? -1) ||
    (anchor.mode & 0o022n) !== 0n ||
    (await realpath(data)) !== data
  )
    throw new Error("Mac SQLite temp data anchor must be an owned physical directory without shared write access");
  const directory = await mkdtemp(join(data, "sqlite-tmp-"));
  const identity = await lstat(directory, { bigint: true });
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    if (!identity.isDirectory() || identity.uid !== anchor.uid || (identity.mode & 0o777n) !== 0o700n || (await realpath(directory)) !== directory)
      throw new Error("Mac SQLite temp directory is not private and physical");
    outcome = { ok: true, value: await run(directory) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    if (
      !sameDirectory(anchor, await lstat(data, { bigint: true })) ||
      !sameDirectory(identity, await lstat(directory, { bigint: true })) ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Mac SQLite temp directory lifetime identity changed");
    await rm(directory, { recursive: true });
  } catch (error) {
    throw new AggregateError(outcome.ok ? [error] : [outcome.error, error], `Mac SQLite temp cleanup refused; preserved ${directory}`, { cause: error });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};

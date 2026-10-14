import { readdir, realpath, rm, stat } from "node:fs/promises";
import { missing } from "./io.ts";
/**
 * Release retention for the immutable deploy paths.
 *
 * Every deployment unpacks a fresh `git archive` of the released revision into
 * `.data/releases/<sha>`, so a checkout that has deployed repeatedly carries a
 * complete copy of `src`, `tests`, `docs` and `static` per revision — tens of
 * thousands of duplicate files that every recursive search and editor walk
 * pays for. Only rollback needs them, so both deploy scripts prune after the
 * new release is verified live: the running release and the newest few stay.
 */

export const RELEASE_RETENTION_KEEP = 5;

// `git rev-parse HEAD` output. Anything else in the store (a crashed deploy's
// `.staging-*` directory, tooling scratch) is never a deletion candidate.
const RELEASE_NAME = /^[0-9a-f]{40}$/;

export type ReleasePruneReport = Readonly<{
  removed: readonly string[];
  kept: readonly string[];
}>;

export type ReleasePruneOptions = Readonly<{
  /** Store holding one directory per released revision. */
  releasesDir?: string;
  /** Symlink that always names the running release. */
  currentLink?: string;
  /** How many of the newest releases to keep besides the running one. */
  keep?: number;
  /** Report candidates without deleting them. */
  dryRun?: boolean;
}>;

const realPathOrNull = async (path: string): Promise<string | null> => {
  try {
    return await realpath(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
};

/**
 * Delete release directories beyond the retention window.
 *
 * A candidate is deleted only when its name is a full Git revision and it
 * resolves to a path directly inside the store, so a symlink planted there
 * cannot redirect the delete. The release named by `currentLink` is always
 * kept, even when it is the oldest directory present, because the launchd and
 * systemd units resolve it when they start and rollback repoints it.
 */
export const pruneReleases = async (options: ReleasePruneOptions = {}): Promise<ReleasePruneReport> => {
  const releasesDir = options.releasesDir ?? ".data/releases";
  const currentLink = options.currentLink ?? ".data/current";
  const keep = options.keep ?? RELEASE_RETENTION_KEEP;
  if (!Number.isInteger(keep) || keep < 0) throw new Error("The release retention keep count must be a non-negative integer");

  const store = await realPathOrNull(releasesDir);
  if (store === null) return { removed: [], kept: [] };
  const current = await realPathOrNull(currentLink);

  const releases: { name: string; path: string; modifiedAt: number }[] = [];
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RELEASE_NAME.test(entry.name)) continue;
    const path = `${store}/${entry.name}`;
    // A name that resolves elsewhere was replaced by a link; leave it alone.
    if ((await realPathOrNull(path)) !== path) continue;
    const info = await stat(path);
    releases.push({ name: entry.name, path, modifiedAt: info.mtime.getTime() });
  }

  releases.sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name));
  const retained = new Set(releases.slice(0, keep).map((release) => release.path));

  const removed: string[] = [];
  const kept: string[] = [];
  for (const release of releases) {
    if (retained.has(release.path) || release.path === current) {
      kept.push(release.name);
      continue;
    }
    if (!options.dryRun) await rm(release.path, { recursive: true });
    removed.push(release.name);
  }
  return { removed, kept };
};

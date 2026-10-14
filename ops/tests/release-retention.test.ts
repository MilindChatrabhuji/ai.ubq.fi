import { afterEach, test } from "bun:test";
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { runFixture, fsError } from "./fixture-process.ts";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { pruneReleases } from "../release-retention.ts";

const FIXTURE_PARENT = fileURLToPath(new URL("../../.cleanup-evidence/release-retention-fixtures", import.meta.url));

const liveFixtures = new Set<string>();
afterEach(async () => {
  for (const root of liveFixtures) {
    await rm(root, { recursive: true, force: true });
    liveFixtures.delete(root);
  }
});

type Fixture = { root: string; releasesDir: string; currentLink: string };

const revision = (digit: string): string => digit.repeat(40);

const makeFixture = async (name: string): Promise<Fixture> => {
  const root = `${FIXTURE_PARENT}/${name}-${crypto.randomUUID()}`;
  await mkdir(`${root}/releases`, { recursive: true });
  liveFixtures.add(root);
  return { root, releasesDir: `${root}/releases`, currentLink: `${root}/current` };
};

/** Create a release directory whose mtime is `ageSeconds` in the past. */
const addRelease = async (fixture: Fixture, sha: string, ageSeconds: number): Promise<string> => {
  const path = `${fixture.releasesDir}/${sha}`;
  await mkdir(path, { recursive: true });
  await writeFile(`${path}/src.ts`, `// ${sha}\n`);
  const timestamp = new Date(Date.now() - ageSeconds * 1000);
  await utimes(path, timestamp, timestamp);
  return path;
};

/** Native links remain confined to task-owned fixture paths. */
const link = async (target: string, path: string): Promise<void> => {
  const result = await runFixture("/bin/ln", { args: ["-s", target, path] });
  if (!result.success) throw new Error(`ln -s failed: ${new TextDecoder().decode(result.stderr)}`);
};

const pointCurrentAt = async (fixture: Fixture, sha: string): Promise<void> => {
  await link(`releases/${sha}`, fixture.currentLink);
};

/** Sort a copy for comparison; the lint rule requires an explicit comparator. */
const sorted = (values: readonly string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (fsError("ENOENT")(error)) return false;
    throw error;
  }
};

test("retention keeps the newest releases and the running one", async () => {
  const fixture = await makeFixture("window");
  const shas = ["1", "2", "3", "4", "5", "6"].map(revision);
  // Oldest first, so the running release is also the oldest directory here.
  for (const [index, sha] of shas.entries()) await addRelease(fixture, sha, 600 - index * 60);
  await pointCurrentAt(fixture, shas[0]);

  const report = await pruneReleases({ releasesDir: fixture.releasesDir, currentLink: fixture.currentLink, keep: 2 });

  assert.deepEqual(sorted(report.removed), sorted([shas[1], shas[2], shas[3]]), "releases outside the window are removed");
  assert.deepEqual(sorted(report.kept), sorted([shas[0], shas[4], shas[5]]), "the running release and the newest two are kept");
  assert.equal(await exists(`${fixture.releasesDir}/${shas[0]}`), true, "the running release survives even as the oldest");
  assert.equal(await exists(`${fixture.releasesDir}/${shas[5]}`), true, "the newest release survives");
  assert.equal(await exists(`${fixture.releasesDir}/${shas[1]}`), false, "an expired release is gone");
});

test("retention ignores entries that are not full revisions", async () => {
  const fixture = await makeFixture("skips");
  const kept = revision("a");
  await addRelease(fixture, kept, 10);
  await addRelease(fixture, revision("b"), 20);
  await mkdir(`${fixture.releasesDir}/.staging-crashed`, { recursive: true });
  await writeFile(`${fixture.releasesDir}/notes.txt`, "scratch");
  await pointCurrentAt(fixture, kept);

  const report = await pruneReleases({ releasesDir: fixture.releasesDir, currentLink: fixture.currentLink, keep: 0 });

  assert.deepEqual(report.removed, [revision("b")], "only the expired revision is removed");
  assert.equal(await exists(`${fixture.releasesDir}/.staging-crashed`), true, "a staging directory is never a candidate");
  assert.equal(await exists(`${fixture.releasesDir}/notes.txt`), true, "a plain file is never a candidate");
});

test("retention refuses to follow a revision-shaped symlink out of the store", async () => {
  const fixture = await makeFixture("symlink");
  const outside = `${fixture.root}/outside`;
  await mkdir(outside, { recursive: true });
  await writeFile(`${outside}/keep.txt`, "outside the store");
  const planted = revision("c");
  await link(outside, `${fixture.releasesDir}/${planted}`);
  const current = revision("d");
  await addRelease(fixture, current, 5);
  await pointCurrentAt(fixture, current);

  const report = await pruneReleases({ releasesDir: fixture.releasesDir, currentLink: fixture.currentLink, keep: 0 });

  assert.deepEqual(report.removed, [], "a link pointing elsewhere is not deleted through");
  assert.equal(await exists(`${outside}/keep.txt`), true, "the symlink target is untouched");
  assert.equal(await exists(`${fixture.releasesDir}/${planted}`), true, "the planted link itself is left in place");
});

test("a dry run reports the same candidates without deleting them", async () => {
  const fixture = await makeFixture("dry-run");
  const current = revision("e");
  const expired = revision("f");
  await addRelease(fixture, current, 5);
  await addRelease(fixture, expired, 300);
  await pointCurrentAt(fixture, current);

  const report = await pruneReleases({ releasesDir: fixture.releasesDir, currentLink: fixture.currentLink, keep: 0, dryRun: true });

  assert.deepEqual(report.removed, [expired], "the dry run reports the expired release");
  assert.equal(await exists(`${fixture.releasesDir}/${expired}`), true, "nothing is deleted by a dry run");
});

test("retention preserves a pending VPS operation's exact older prior", async () => {
  const fixture = await makeFixture("vps-prior-pin");
  const prior = revision("1");
  const candidate = revision("2");
  await addRelease(fixture, prior, 600);
  await addRelease(fixture, candidate, 1);
  await pointCurrentAt(fixture, candidate);
  await writeFile(
    `${fixture.root}/vps-release-pins.json`,
    JSON.stringify({ schema: 1, pins: [{ operationId: "a".repeat(64), requestDigest: "b".repeat(64), candidate, prior }] }),
    { mode: 0o600 }
  );
  await pruneReleases({ releasesDir: fixture.releasesDir, currentLink: fixture.currentLink, keep: 0 });
  assert.equal(await exists(`${fixture.releasesDir}/${prior}`), true, "a pending operation must retain its exact rollback prior");
});

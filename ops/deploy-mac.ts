import { acquireDeployLock } from "./deploy-lock.ts";
import { assertBunConvertedStore } from "./assert-bun-store.ts";
import { prepareReleasePayload } from "./release-artifact.ts";
import { digest } from "./io.ts";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { missing, command as runCommand } from "./io.ts";
const command = runCommand;
// Run from the canonical Mac checkout after committing the candidate.
import { pruneReleases } from "./release-retention.ts";
import { prepareMacRuntime } from "./mac-runtime.ts";
if (process.platform !== "darwin") throw new Error("This deployment requires macOS");
const root = await realpath(".");
if (root !== "/Users/nv/repos/ubiquity/ai.ubq.fi") throw new Error("Run from the canonical Mac repository root");
await assertBunConvertedStore(root);
for (const directory of [".data", ".data/releases"]) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== root + "/" + directory)
      throw new Error("Mac deployment data directory is unsafe");
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
await mkdir(".data/releases", { recursive: true, mode: 0o700 });
const releaseLock = await acquireDeployLock();

try {
  if (await command("git", ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("Preserve tracked changes before deployment");
  }
  const sha = await command("git", ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("A full Git revision is required");
  await prepareMacRuntime(root);
  const release = `.data/releases/${sha}`;
  try {
    await stat(release);
    throw new Error("This release already exists; use launchctl to restart the current service");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const staging = await mkdtemp(".data/releases/.staging-");
  const archive = `${staging}.tar`;
  await command("git", ["archive", "--format=tar", `--output=${archive}`, sha]);
  await command("tar", ["-xf", archive, "-C", staging]);
  await writeFile(`${staging}/src/release.ts`, `export const RELEASE_GIT_SHA = "${sha}";\n`);
  await prepareReleasePayload(staging, sha, digest(await readFile(archive)));
  await rename(staging, release);
  await rm(archive);
  const next = `.data/current-${crypto.randomUUID()}`;
  await symlink(`releases/${sha}`, next);
  await rename(next, ".data/current");
  const domain = `gui/${await command("id", ["-u"])}`;
  const service = `${domain}/com.ubiquity.ai.local`;
  const link = "/Users/nv/Library/LaunchAgents/com.ubiquity.ai.local.plist";
  try {
    const target = await readlink(link);
    if (target !== `${root}/ops/com.ubiquity.ai.local.plist`) {
      throw new Error("An unrelated launch agent owns this path");
    }
  } catch (error) {
    if (!missing(error)) throw error;
    await symlink(`${root}/ops/com.ubiquity.ai.local.plist`, link);
  }
  const registration = await command("launchctl", ["print", service]).catch(() => "");
  if (registration) {
    const oldPid = /\n[^\S\n]*pid = (\d+)/.exec(registration)?.[1];
    await command("launchctl", ["bootout", service]);
    // bootout returns before a draining process exits. Wait before registering its replacement.
    if (oldPid) {
      const deadline = Date.now() + 185_000;
      while (
        await command("ps", ["-p", oldPid, "-o", "pid="]).then(
          () => true,
          () => false
        )
      ) {
        if (Date.now() >= deadline) throw new Error(`The previous Mac service process ${oldPid} did not exit`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  await command("launchctl", ["bootstrap", domain, link]);
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:7999/health", { signal: AbortSignal.timeout(2000) });
      const body = await response.json();
      if (
        response.status === 200 &&
        body.release?.git_sha === sha &&
        body.release?.deployment_id === `mac-${sha}` &&
        response.headers.get("x-uos-git-sha") === sha &&
        response.headers.get("x-uos-deployment-id") === `mac-${sha}`
      ) {
        // Retention runs only after the release is proven live, and a pruning fault must not
        // turn a verified deployment into a failed one: the next deployment retries it.
        let releasesPruned: number | "failed" = "failed";
        try {
          releasesPruned = (await pruneReleases()).removed.length;
        } catch (error) {
          console.error(`[deploy-mac] Release retention was not applied: ${error instanceof Error ? error.message : String(error)}`);
        }
        console.log(JSON.stringify({ git_sha: sha, deployment_id: `mac-${sha}`, health_verified: true, releases_pruned: releasesPruned }));
        healthy = true;
        break;
      }
    } catch {
      /* The listener is starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!healthy) throw new Error("The Mac service did not serve the expected release; inspect .data/mac.stderr.log");
} finally {
  releaseLock();
}

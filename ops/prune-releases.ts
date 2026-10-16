// Retention writers share the deployment's POSIX lock. Never prune runtime stores.
import { pruneReleases, RELEASE_RETENTION_KEEP } from "./release-retention.ts";
import { withVpsDeployLock } from "./vps-release-journal.ts";
import { realpath } from "node:fs/promises";
const report = await withVpsDeployLock(await realpath("."), () => pruneReleases());
{
  console.log(
    JSON.stringify(
      {
        releases_dir: ".data/releases",
        keep: RELEASE_RETENTION_KEEP,
        removed: report.removed.length,
        kept: report.kept.length,
        removed_releases: report.removed,
        kept_releases: report.kept,
      },
      null,
      2
    )
  );
}

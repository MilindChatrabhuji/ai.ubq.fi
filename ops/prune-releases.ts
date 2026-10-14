// Retention writers share the deployment's POSIX lock. Never prune runtime stores.
import { pruneReleases, RELEASE_RETENTION_KEEP } from "./release-retention.ts";
import { acquireDeployLock } from "./deploy-lock.ts";
const releaseLock = await acquireDeployLock();
try {
  const report = await pruneReleases();
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
} finally {
  releaseLock();
}

// Manual and scheduled entry point for release retention.
//
// `deno task deploy:mac` and `deno task deploy:vps` prune after a verified
// deploy; this exists for a checkout that accumulated releases before
// retention existed, and for a launchd agent or systemd timer that enforces the
// bound without deploying. Run it from the repository root.
import { pruneReleases, RELEASE_RETENTION_KEEP } from "./release-retention.ts";
import { withVpsDeployLock } from "./vps-release-journal.ts";

const report = await withVpsDeployLock(await Deno.realPath("."), () => pruneReleases());
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

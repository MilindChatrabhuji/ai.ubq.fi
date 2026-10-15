import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { convertKvDatabase } from "../src/kv-conversion/convert.ts";
import type { CutoverHost } from "./cutover-host.ts";
import { checkpointCutoverStore, proveCutoverRoundtrip, retainedCutoverCopy } from "./cutover-storage.ts";
import type { CutoverPhase } from "./cutover-transition.ts";
import { exists, fileDigest } from "./io.ts";
import type { ImmutableVpsReleaseStore, StoredVpsPrior } from "./vps-release-store.ts";
import { verifyLegacyRollback } from "./verify-legacy-rollback.ts";

export type CutoverRecovery = {
  root: string;
  workspace: string;
  host: CutoverHost;
  store: ImmutableVpsReleaseStore;
  prior: StoredVpsPrior;
  denoBinary: string;
  denoSha256: string;
  priorSourceSha256: string | null;
  legacyStartupAttempted: boolean;
  record: (phase: CutoverPhase) => Promise<void>;
};

async function restoreLatestBun(input: CutoverRecovery, data: string, legacy: string, bun: string): Promise<void> {
  const adoption = join(data, "legacy-rollback-active.json");
  const rollbackReceipt = join(data, "bun-rollback-receipt.json");
  if (input.legacyStartupAttempted && !(await exists(adoption))) throw new Error("Legacy adoption changed after a possible Deno write");
  // Once legacy adoption is published, Deno may have newer writes. Never overwrite it from Bun again.
  if (!(await exists(adoption))) {
    await checkpointCutoverStore(bun, "bun-jsc-v1");
    const latest = join(input.workspace, "bun-latest.sqlite3");
    if (!(await exists(latest))) await retainedCutoverCopy(bun, latest);
    const retained = join(input.workspace, "legacy-retained.sqlite3");
    if (!(await exists(retained))) await rename(legacy, retained);
    if (!(await exists(rollbackReceipt))) {
      // A killed converter may have linked its new destination before linking its receipt. Preserve it, then retry from latest Bun.
      if (await exists(legacy)) await rename(legacy, join(input.workspace, `rollback-unreceipted-${crypto.randomUUID()}.sqlite3`));
      await convertKvDatabase({
        direction: "bun-to-deno",
        source: bun,
        destination: legacy,
        receipt: rollbackReceipt,
        deno: input.denoBinary,
        denoSha256: input.denoSha256,
        signal: AbortSignal.timeout(45 * 60_000),
      });
    }
    await proveCutoverRoundtrip(bun, legacy, input.denoBinary, input.denoSha256, input.workspace, AbortSignal.timeout(45 * 60_000), "bun-jsc-v1");
  }
  await verifyLegacyRollback(input.root);
}

/** May run in the original supervisor or its pinned ExecStopPost recovery process. */
export async function recoverCutoverLatest(input: CutoverRecovery, startupAttempted: boolean): Promise<void> {
  const data = join(input.root, ".data"),
    legacy = join(data, "kv.sqlite3"),
    bun = join(data, "kv-bun.sqlite3");
  await input.host.stop();
  await input.host.assertStopped((await exists(bun)) ? [legacy, bun] : [legacy]);
  if (startupAttempted) await restoreLatestBun(input, data, legacy, bun);
  else if (await exists(bun)) {
    const receipt = JSON.parse(await readFile(join(input.workspace, "forward.json"), "utf8")) as {
      source: { file: { sha256: string } };
      destination: { file: { sha256: string } };
    };
    if (receipt.source.file.sha256 !== input.priorSourceSha256 || (await fileDigest(bun)) !== receipt.destination.file.sha256)
      throw new Error("The unstarted Bun destination is not owned by this conversion");
    await rename(bun, join(input.workspace, "bun-unstarted.sqlite3"));
  }
  await input.store.checkedPreviousRelease(input.prior.sha, input.prior.selector);
  await input.record("legacy_starting");
  await input.store.selectRelease(input.prior.selector);
  await input.host.start();
  await input.host.health(input.prior.sha, input.prior.port, true);
  await input.host.reloadIngress();
  await input.host.publicHealth(input.prior.sha);
}

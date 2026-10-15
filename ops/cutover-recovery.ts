import { lstat, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { convertKvDatabase } from "../src/kv-conversion/convert.ts";
import type { CutoverHost } from "./cutover-host.ts";
import type { CapturedCutoverArtifact } from "./cutover-artifact.ts";
import { checkpointCutoverStore, proveCutoverRoundtrip, retainedCutoverCopy, type CutoverBudgets } from "./cutover-storage.ts";
import type { CutoverPhase } from "./cutover-transition.ts";
import { exists, fileDigest } from "./io.ts";
import type { ImmutableVpsReleaseStore, StoredVpsPrior } from "./vps-release-store.ts";
import { verifyLegacyRollback } from "./verify-legacy-rollback.ts";
import { canonicalVps } from "./vps-release-contract.ts";

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
  artifact: CapturedCutoverArtifact;
  supervisorMemoryBytes: number;
  bootstrapSha256: string;
  budgets: CutoverBudgets;
  record: (phase: CutoverPhase) => Promise<void>;
};

/** A prepared receipt contains no stopping intent. ExecStopPost must leave the live writer running. */
export async function verifyPreparedCutover(input: {
  root: string;
  workspace: string;
  prior: StoredVpsPrior;
  denoBinary: string;
  denoSha256: string;
  state: {
    bunStartupAttempted: boolean;
    legacyStartupAttempted: boolean;
    priorSourceSha256: string | null;
    conversion: unknown;
    loadedPriorUnit: Awaited<ReturnType<CutoverHost["loadedUnit"]>>;
  };
  store: Pick<ImmutableVpsReleaseStore, "selector">;
  host: Pick<CutoverHost, "assertPriorUnchanged" | "loadedUnit" | "verifyLegacyProcess" | "health" | "publicHealth">;
}): Promise<void> {
  if (
    input.state.bunStartupAttempted ||
    input.state.legacyStartupAttempted ||
    input.state.priorSourceSha256 !== null ||
    input.state.conversion !== null ||
    (await input.store.selector()) !== input.prior.selector ||
    (await exists(join(input.root, ".data/kv-bun.sqlite3")))
  )
    throw new Error("Prepared-only cutover no longer proves the original live baseline");
  await input.host.assertPriorUnchanged(input.prior);
  if (canonicalVps(await input.host.loadedUnit()) !== canonicalVps(input.state.loadedPriorUnit)) throw new Error("Prepared-only prior unit identity changed");
  await input.host.verifyLegacyProcess(input.denoBinary, input.denoSha256, input.workspace, input.prior.sha);
  await input.host.health(input.prior.sha, input.prior.port);
  await input.host.publicHealth(input.prior.sha);
}

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
        signal: AbortSignal.timeout(input.budgets.recoveryConversionMs),
      });
    }
    await proveCutoverRoundtrip(
      bun,
      legacy,
      input.denoBinary,
      input.denoSha256,
      input.workspace,
      AbortSignal.timeout(input.budgets.recoveryProofMs),
      "bun-jsc-v1"
    );
  }
  await verifyLegacyRollback(input.root);
}

/** Only before any possible Bun startup, with the durable stopped legacy hash as the authority. */
export async function preserveUnstartedCutover(legacy: string, bun: string, workspace: string, expectedLegacySha256: string | null): Promise<string> {
  if (!expectedLegacySha256 || (await fileDigest(legacy)) !== expectedLegacySha256)
    throw new Error("Authoritative stopped legacy source changed before recovery");
  const info = await lstat(bun);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("Unsafe unstarted destination");
  const forward = join(workspace, "forward.json");
  let label = "bun-unreceipted-" + crypto.randomUUID();
  if (await exists(forward)) {
    const receipt = JSON.parse(await readFile(forward, "utf8")) as {
      source?: { path?: string; codec?: string; file?: { sha256?: string } };
      destination?: { path?: string; codec?: string; file?: { sha256?: string } };
    };
    if (
      receipt.source?.path !== legacy ||
      receipt.source.codec !== "deno-v8" ||
      receipt.source.file?.sha256 !== expectedLegacySha256 ||
      receipt.destination?.path !== bun ||
      receipt.destination.codec !== "bun-jsc-v1" ||
      (await fileDigest(bun)) !== receipt.destination.file?.sha256
    )
      throw new Error("The unstarted Bun destination is not owned by this conversion");
    label = "bun-unstarted";
  }
  const retained = join(workspace, label + ".sqlite3");
  if (await exists(retained)) throw new Error("Retained unstarted output already exists");
  await rename(bun, retained);
  return retained;
}

/** May run in the original supervisor or its pinned ExecStopPost recovery process. */
export async function recoverCutoverLatest(input: CutoverRecovery, startupAttempted: boolean): Promise<void> {
  const data = join(input.root, ".data"),
    legacy = join(data, "kv.sqlite3"),
    bun = join(data, "kv-bun.sqlite3");
  const selected = await input.store.selector();
  if (selected !== input.prior.selector && selected !== `releases/${input.artifact.revision}`)
    throw new Error("Recovery selector belongs to another operation");
  await input.host.reassertSupervisorMemory(input.supervisorMemoryBytes);
  if ((await input.host.verifyBootstrap(input.artifact)) !== input.bootstrapSha256) throw new Error("Recovery bootstrap changed");
  await input.host.stop();
  await input.host.assertStopped((await exists(bun)) ? [legacy, bun] : [legacy]);
  if (startupAttempted || selected === `releases/${input.artifact.revision}`) await restoreLatestBun(input, data, legacy, bun);
  else if (await exists(bun)) await preserveUnstartedCutover(legacy, bun, input.workspace, input.priorSourceSha256);
  await input.store.checkedPreviousRelease(input.prior.sha, input.prior.selector);
  await input.record("legacy_starting");
  await input.store.selectRelease(input.prior.selector);
  await input.host.start(input.artifact, input.supervisorMemoryBytes, input.bootstrapSha256);
  await input.host.health(input.prior.sha, input.prior.port, true);
  await input.host.reloadIngress();
  await input.host.publicHealth(input.prior.sha);
}

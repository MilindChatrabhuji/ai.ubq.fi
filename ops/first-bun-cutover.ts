import { chmod, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBunConvertedStore } from "./assert-bun-store.ts";
import {
  type CapturedCutoverArtifact,
  recheckCutoverArtifact,
  restoreCutoverArtifact,
  reuseCutoverPayload,
  verifyCutoverCandidate,
} from "./cutover-artifact.ts";
import { CutoverHost } from "./cutover-host.ts";
import {
  assertCutoverCapacity,
  checkedCutoverBudgets,
  checkpointCutoverStore,
  convertAndProveCutover,
  cutoverSourceBytes,
  privateCutoverDirectory,
  retainedCutoverCopy,
  withCutoverCodecProbe,
  type CutoverBudgets,
} from "./cutover-storage.ts";
import { recoverCutoverLatest, verifyPreparedCutover } from "./cutover-recovery.ts";
import { executeCutoverTransition, type CutoverPhase } from "./cutover-transition.ts";
import { digest, exists, fileDigest } from "./io.ts";
import { readVpsPins, withVpsDeployLock, writeVpsAtomic } from "./vps-release-journal.ts";
import { ImmutableVpsReleaseStore, VPS_LAUNCHER_PROFILE_SHA256, VPS_UNIT_SHA256 } from "./vps-release-store.ts";
import { cutoverReaderGateBinding, verifyCutoverReaderGate, type CutoverReaderGate } from "./cutover-reader-gate.ts";
import { canonicalVps } from "./vps-release-contract.ts";

const canonicalRoot = "/home/codex/repos/ubiquity/ai.ubq.fi";
export type FirstBunCutoverInput = Readonly<{
  artifact: CapturedCutoverArtifact;
  priorRevision: string;
  denoBinary: string;
  denoSha256: string;
  supervisorMemoryBytes: number;
  budgets: CutoverBudgets;
  authorization: { path: string; sha256: string };
  offlineArtifact: { path: string; sha256: string };
  reader: CutoverReaderGate;
  signal?: AbortSignal;
}>;
type CutoverJournal = {
  schema: "uos-first-bun-cutover-v1";
  operationId: string;
  requestDigest: string;
  phase: CutoverPhase;
  candidate: string;
  prior: string;
  artifactSha256: string;
  manifestSha256: string;
  loadedPriorUnit: Awaited<ReturnType<CutoverHost["loadedUnit"]>>;
  bootstrapSha256: string;
  budgets: CutoverBudgets;
  supervisorMemoryBytes: number;
  authorizationSha256: string;
  readerReceiptSha256: string;
  readerGateKind: CutoverReaderGate["kind"];
  priorSourceSha256: string | null;
  bunStartupAttempted: boolean;
  legacyStartupAttempted: boolean;
  conversion: Awaited<ReturnType<typeof convertAndProveCutover>> | null;
  clientAcceptance: "pending";
  updatedAt: string;
};

async function authorization(input: FirstBunCutoverInput, recovery = false): Promise<void> {
  const reader = cutoverReaderGateBinding(input.reader);
  const info = await lstat(input.authorization.path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    !/^[a-f0-9]{64}$/.test(input.authorization.sha256) ||
    (await fileDigest(input.authorization.path)) !== input.authorization.sha256
  )
    throw new Error("A private pinned operator authorization is required");
  const value = JSON.parse(await readFile(input.authorization.path, "utf8")) as Record<string, unknown>;
  if (
    value.schema !== "uos-first-bun-cutover-authorization-v1" ||
    value.revision !== input.artifact.revision ||
    value.artifact_sha256 !== input.artifact.archiveSha256 ||
    value.prior_revision !== input.priorRevision ||
    value.deno_sha256 !== input.denoSha256 ||
    value.reader_receipt_sha256 !== reader.sha256 ||
    value.reader_gate_kind !== reader.kind ||
    value.offline_artifact_sha256 !== input.offlineArtifact.sha256 ||
    value.supervisor_memory_bytes !== input.supervisorMemoryBytes ||
    value.budgets_sha256 !== digest(JSON.stringify(input.budgets)) ||
    typeof value.expires_at !== "string" ||
    !Number.isFinite(Date.parse(value.expires_at)) ||
    (!recovery && Date.parse(value.expires_at) <= Date.now())
  )
    throw new Error("Operator authorization does not bind this exact cutover");
}

/** Private operator capability. No public CLI or environment switch enables this path. */
async function performFirstBunCutover(input: FirstBunCutoverInput): Promise<{ phase: CutoverPhase; receipt: string; sha256: string }> {
  if ((await realpath(fileURLToPath(new URL("../", import.meta.url)))) !== input.artifact.directory)
    throw new Error("Execute the cutover implementation from the accepted immutable artifact");
  await recheckCutoverArtifact(input.artifact);
  await authorization(input);
  const offline = await restoreCutoverArtifact(input.offlineArtifact.path, input.offlineArtifact.sha256);
  if (offline.archiveSha256 !== input.artifact.archiveSha256 || offline.manifestSha256 !== input.artifact.manifestSha256)
    throw new Error("Offline recovery inputs belong to another artifact");
  await verifyCutoverReaderGate(input.reader, input.artifact);
  if (!/^[a-f0-9]{40}$/.test(input.priorRevision) || !/^[a-f0-9]{64}$/.test(input.denoSha256))
    throw new Error("Exact prior and legacy codec pins are required");
  const host = new CutoverHost(canonicalRoot);
  await host.reassertSupervisorMemory(input.supervisorMemoryBytes);
  const bootstrapSha256 = await host.verifyBootstrap(input.artifact);
  const requestDigest = cutoverRequestDigest(input);
  const operationId = digest("uos-first-bun-cutover-v1:" + requestDigest);
  return await withVpsDeployLock(canonicalRoot, async () => {
    const data = join(canonicalRoot, ".data"),
      legacy = join(data, "kv.sqlite3"),
      bun = join(data, "kv-bun.sqlite3");
    for (const name of [
      "deploy-recovery.json",
      "kv-bun.sqlite3",
      "kv-bun.sqlite3-wal",
      "kv-bun.sqlite3-shm",
      "bun-rollback-receipt.json",
      "legacy-rollback-active.json",
    ])
      if (await exists(join(data, name))) throw new Error("An existing database or recovery operation requires reconciliation");
    const pinsPath = join(data, "vps-release-pins.json");
    if ((await readVpsPins(pinsPath)).length) throw new Error("Another bound operation owns VPS promotion");
    const store = new ImmutableVpsReleaseStore(canonicalRoot, host.system.run, reuseCutoverPayload(input.artifact));
    await store.assertDirectories();
    const selector = await store.selector();
    if (!selector) throw new Error("A verified legacy recovery release is required");
    const prior = await store.checkedPrevious(selector);
    if (
      prior.sha !== input.priorRevision ||
      prior.profile !== VPS_LAUNCHER_PROFILE_SHA256 ||
      (await store.unitDigest(prior.sha)) !== VPS_UNIT_SHA256 ||
      prior.port !== 7999
    )
      throw new Error("Unsupported legacy cutover recovery profile");
    await host.health(prior.sha, prior.port);
    await host.publicHealth(prior.sha);
    const loadedPriorUnit = await host.loadedUnit();
    const parent = join(data, "cutovers");
    await mkdir(parent, { mode: 0o700, recursive: true });
    await privateCutoverDirectory(parent);
    const workspace = join(parent, operationId);
    await mkdir(workspace, { mode: 0o700 });
    await privateCutoverDirectory(workspace);
    const workspaceParent = await open(parent, "r");
    try {
      await workspaceParent.sync();
    } finally {
      await workspaceParent.close();
    }
    await assertCutoverCapacity(workspace, await cutoverSourceBytes(legacy));
    await host.verifyLegacyProcess(input.denoBinary, input.denoSha256, workspace, input.priorRevision);
    const candidate = await store.checkedRelease(input.artifact.revision, true);
    await verifyCutoverCandidate(input.artifact, join(canonicalRoot, candidate.path));
    const receiptPath = join(workspace, "operation.json"),
      forwardReceipt = join(workspace, "forward.json");
    const journal: CutoverJournal = {
      schema: "uos-first-bun-cutover-v1",
      operationId,
      requestDigest,
      phase: "prepared",
      candidate: candidate.sha,
      prior: prior.sha,
      artifactSha256: input.artifact.archiveSha256,
      manifestSha256: input.artifact.manifestSha256,
      loadedPriorUnit,
      bootstrapSha256,
      budgets: input.budgets,
      supervisorMemoryBytes: input.supervisorMemoryBytes,
      authorizationSha256: input.authorization.sha256,
      readerReceiptSha256: cutoverReaderGateBinding(input.reader).sha256,
      readerGateKind: input.reader.kind,
      priorSourceSha256: null,
      bunStartupAttempted: false,
      legacyStartupAttempted: false,
      conversion: null,
      clientAcceptance: "pending",
      updatedAt: new Date().toISOString(),
    };
    await writeVpsAtomic(pinsPath, { schema: 1, pins: [{ operationId, requestDigest, candidate: candidate.sha, prior: prior.sha }] });
    const dataDirectory = await open(data, "r");
    try {
      await dataDirectory.sync();
    } finally {
      await dataDirectory.close();
    }
    const record = async (phase: CutoverPhase) => {
      journal.phase = phase;
      if (phase === "starting") journal.bunStartupAttempted = true;
      if (phase === "legacy_starting") journal.legacyStartupAttempted = true;
      journal.updatedAt = new Date().toISOString();
      await writeVpsAtomic(receiptPath, journal);
      const directory = await open(workspace, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    const assertPrior = async () => {
      const actual = await store.checkedPreviousRelease(prior.sha, prior.selector);
      if (JSON.stringify(actual) !== JSON.stringify(prior)) throw new Error("Captured legacy release changed");
      await host.assertPriorUnchanged(prior);
    };
    const phase = await executeCutoverTransition(
      {
        record,
        preflight: async () => {
          await host.reassertSupervisorMemory(input.supervisorMemoryBytes);
          if ((await host.verifyBootstrap(input.artifact)) !== bootstrapSha256) throw new Error("Bootstrap changed while waiting for cutover custody");
          await recheckCutoverArtifact(input.artifact);
          await authorization(input);
          await verifyCutoverReaderGate(input.reader, input.artifact);
          await assertPrior();
          if (canonicalVps(await host.loadedUnit()) !== canonicalVps(loadedPriorUnit)) throw new Error("The loaded prior service definition changed");
          await host.verifyLegacyProcess(input.denoBinary, input.denoSha256, workspace, input.priorRevision);
          await host.health(prior.sha, prior.port);
          await host.publicHealth(prior.sha);
        },
        stop: async () => {
          await host.stop();
          await host.assertStopped([legacy]);
        },
        preserve: async () => {
          await assertPrior();
          const source = await checkpointCutoverStore(legacy, "deno-v8");
          await assertCutoverCapacity(workspace, source.bytes);
          await host.assertStopped([legacy]);
          journal.priorSourceSha256 = await retainedCutoverCopy(legacy, join(workspace, "legacy-before.sqlite3"));
          if (journal.priorSourceSha256 !== source.sha256) throw new Error("Legacy source changed at the stopped boundary");
          await retainedCutoverCopy(join(canonicalRoot, ".env"), join(workspace, "root.env"));
        },
        convert: async () => {
          await host.assertStopped([legacy]);
          await host.reassertSupervisorMemory(input.supervisorMemoryBytes);
          const signal = AbortSignal.any([AbortSignal.timeout(input.budgets.conversionAndProofMs), ...(input.signal ? [input.signal] : [])]);
          journal.conversion = await convertAndProveCutover(
            {
              source: legacy,
              destination: bun,
              receipt: forwardReceipt,
              deno: input.denoBinary,
              denoSha256: input.denoSha256,
              signal,
            },
            workspace
          );
          if (journal.conversion.forward.source.file.sha256 !== journal.priorSourceSha256)
            throw new Error("Conversion adopted a different stopped legacy source");
          await assertBunConvertedStore(canonicalRoot);
        },
        start: async () => {
          await host.assertStopped([legacy, bun]);
          await assertPrior();
          await recheckCutoverArtifact(input.artifact);
          if (
            (await fileDigest(legacy)) !== journal.priorSourceSha256 ||
            (await fileDigest(bun)) !== journal.conversion?.forward.destination.file.sha256 ||
            (await fileDigest(join(canonicalRoot, ".env"))) !== (await fileDigest(join(workspace, "root.env")))
          )
            throw new Error("Stopped source, candidate database or credentials changed before startup");
          await store.checkedRelease(candidate.sha);
          await verifyCutoverCandidate(input.artifact, join(canonicalRoot, candidate.path));
          await store.selectRelease(`releases/${candidate.sha}`);
          await host.start(input.artifact, input.supervisorMemoryBytes, bootstrapSha256);
          await host.health(candidate.sha, 7999, true);
        },
        verify: async () => {
          await host.reloadIngress();
          await host.health(candidate.sha);
          await host.publicHealth(candidate.sha);
        },
        recover: (startupAttempted) =>
          recoverCutoverLatest(
            {
              root: canonicalRoot,
              workspace,
              host,
              store,
              prior,
              denoBinary: input.denoBinary,
              denoSha256: input.denoSha256,
              priorSourceSha256: journal.priorSourceSha256,
              legacyStartupAttempted: journal.legacyStartupAttempted,
              artifact: input.artifact,
              supervisorMemoryBytes: input.supervisorMemoryBytes,
              bootstrapSha256,
              budgets: input.budgets,
              record,
            },
            startupAttempted
          ),
      },
      input.signal
    );
    await chmod(receiptPath, 0o600);
    return { phase, receipt: receiptPath, sha256: await fileDigest(receiptPath) };
  });
}

export function cutoverRequestDigest(input: FirstBunCutoverInput): string {
  const reader = cutoverReaderGateBinding(input.reader);
  return digest(
    JSON.stringify({
      artifact: input.artifact.archiveSha256,
      manifest: input.artifact.manifestSha256,
      prior: input.priorRevision,
      deno: input.denoSha256,
      authorization: input.authorization.sha256,
      reader: { kind: reader.kind, sha256: reader.sha256 },
      offline: input.offlineArtifact.sha256,
      memory: input.supervisorMemoryBytes,
      budgets: input.budgets,
    })
  );
}

/** @public Private supervisor: SIGTERM cancels conversion and completes latest-state recovery before exit. */
export async function runFirstBunCutover(input: FirstBunCutoverInput) {
  const controller = new AbortController();
  const terminate = () => {
    controller.abort(new Error("Cutover supervisor interrupted"));
  };
  process.on("SIGINT", terminate);
  process.on("SIGTERM", terminate);
  try {
    return await performFirstBunCutover({
      ...input,
      budgets: checkedCutoverBudgets(input.budgets),
      signal: AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]),
    });
  } finally {
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
  }
}

/** @public Pinned supervisor ExecStopPost recovery; no GitHub/model/download request. */
export async function recoverFirstBunCutover(input: Omit<FirstBunCutoverInput, "artifact" | "signal">) {
  const artifact = await restoreCutoverArtifact(input.offlineArtifact.path, input.offlineArtifact.sha256);
  const bound = { ...input, artifact, budgets: checkedCutoverBudgets(input.budgets) };
  if ((await realpath(fileURLToPath(new URL("../", import.meta.url)))) !== artifact.directory)
    throw new Error("Recovery code is outside the accepted artifact");
  await authorization(bound, true);
  const host = new CutoverHost(canonicalRoot);
  await host.reassertSupervisorMemory(input.supervisorMemoryBytes);
  const bootstrapSha256 = await host.verifyBootstrap(artifact);
  const requestDigest = cutoverRequestDigest(bound),
    operationId = digest("uos-first-bun-cutover-v1:" + requestDigest);
  const workspace = join(canonicalRoot, ".data/cutovers", operationId),
    receipt = join(workspace, "operation.json");
  return await withVpsDeployLock(canonicalRoot, async () => {
    if (!(await exists(receipt))) {
      await withCutoverCodecProbe(canonicalRoot, (probe) => host.verifyLegacyProcess(input.denoBinary, input.denoSha256, probe, input.priorRevision));
      await host.health(input.priorRevision);
      await host.publicHealth(input.priorRevision);
      return { phase: "not_started", receipt: null };
    }
    await privateCutoverDirectory(workspace);
    const info = await lstat(receipt);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > 65_536) throw new Error("Unsafe cutover recovery journal");
    const journal = JSON.parse(await readFile(receipt, "utf8")) as Omit<CutoverJournal, "schema"> & { schema: string };
    const pins = await readVpsPins(join(canonicalRoot, ".data/vps-release-pins.json"));
    if (
      journal.schema !== "uos-first-bun-cutover-v1" ||
      journal.operationId !== operationId ||
      journal.requestDigest !== requestDigest ||
      journal.candidate !== artifact.revision ||
      journal.prior !== input.priorRevision ||
      journal.artifactSha256 !== artifact.archiveSha256 ||
      journal.manifestSha256 !== artifact.manifestSha256 ||
      journal.readerGateKind !== input.reader.kind ||
      journal.readerReceiptSha256 !== cutoverReaderGateBinding(input.reader).sha256 ||
      journal.bootstrapSha256 !== bootstrapSha256 ||
      JSON.stringify(journal.budgets) !== JSON.stringify(bound.budgets) ||
      typeof journal.bunStartupAttempted !== "boolean" ||
      typeof journal.legacyStartupAttempted !== "boolean" ||
      pins.length !== 1 ||
      pins[0].operationId !== operationId ||
      pins[0].requestDigest !== requestDigest
    )
      throw new Error("Cutover recovery ownership changed");
    if (journal.phase === "accepted" || journal.phase === "rolled_back") {
      const selected = journal.phase === "accepted" ? journal.candidate : journal.prior;
      if (journal.phase === "accepted") await verifyCutoverCandidate(artifact, join(canonicalRoot, ".data/releases", selected));
      await host.health(selected, 7999, true);
      await host.publicHealth(selected);
      return { phase: journal.phase, receipt };
    }
    const store = new ImmutableVpsReleaseStore(canonicalRoot, host.system.run, reuseCutoverPayload(artifact));
    const prior = await store.checkedPreviousRelease(input.priorRevision, `releases/${input.priorRevision}`);
    if (prior.profile !== VPS_LAUNCHER_PROFILE_SHA256 || (await store.unitDigest(prior.sha)) !== VPS_UNIT_SHA256)
      throw new Error("Unsupported retained recovery profile");
    if (journal.phase === "prepared") {
      await verifyPreparedCutover({
        root: canonicalRoot,
        workspace,
        prior,
        denoBinary: input.denoBinary,
        denoSha256: input.denoSha256,
        state: journal,
        store,
        host,
      });
      return { phase: "not_started", receipt };
    }
    const record = async (phase: CutoverPhase) => {
      journal.phase = phase;
      if (phase === "legacy_starting") journal.legacyStartupAttempted = true;
      journal.updatedAt = new Date().toISOString();
      await writeVpsAtomic(receipt, journal);
      const directory = await open(workspace, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    await record("recovering");
    try {
      await recoverCutoverLatest(
        {
          root: canonicalRoot,
          workspace,
          host,
          store,
          prior,
          denoBinary: input.denoBinary,
          denoSha256: input.denoSha256,
          priorSourceSha256: journal.priorSourceSha256,
          legacyStartupAttempted: journal.legacyStartupAttempted,
          artifact,
          supervisorMemoryBytes: input.supervisorMemoryBytes,
          bootstrapSha256,
          budgets: bound.budgets,
          record,
        },
        journal.bunStartupAttempted
      );
      await record("rolled_back");
      return { phase: "rolled_back", receipt };
    } catch {
      await record("recovery_unproved");
      throw new Error("Latest-state cutover recovery remains unproved; retain all copies and reconcile service identity");
    }
  });
}

import { command } from "./io.ts";
import { mkdir } from "node:fs/promises";
import { ensureCaddyIngressReady, healthServesRelease, reloadCaddyIngress } from "./vps-ingress.ts";
import {
  canonicalVps,
  isHealthyVps,
  parseVpsBinding,
  parseVpsHealth,
  parseVpsReceipt,
  parseVpsSelector,
  sameVps,
  sha256,
  vpsDigest,
  vpsOperationId,
  VPS_RELEASE_ABI,
  type VpsBinding,
  type VpsHealthProof,
  type VpsIdentity,
  type VpsMutation,
  type VpsOperation,
  type VpsPrepare,
  type VpsReceipt,
  type VpsSelector,
  type VpsSettlement,
} from "./vps-release-contract.ts";
import { VpsOperationJournal, withVpsDeployLock } from "./vps-release-journal.ts";
import { ImmutableVpsReleaseStore, type StoredVpsRelease, type VpsCommand, type VpsPayloadPreparation } from "./vps-release-store.ts";

export type VpsDriverDependencies = {
  root: string;
  installationId: number;
  environment: "production" | "isolated";
  driverSha256: string;
  run: VpsCommand;
  preparePayload?: VpsPayloadPreparation;
  fetch: typeof fetch;
  now: () => number;
  /** Real trusted review/CI/native merge observer; never a model boolean. */
  verifySource: (binding: VpsBinding) => Promise<boolean>;
  /** Read back the exact committed release-state terminal before releasing pins. */
  verifySettlement: (receipt: VpsReceipt, settlement: VpsSettlement) => Promise<boolean>;
};
/** @public Standalone Sentinel's pinned VPS bridge uses this native command capability. */
export async function runVpsCommand(program: string, args: string[], cwd: string): Promise<string> {
  return command(program, args, { cwd });
}
const identity = (release: StoredVpsRelease): VpsIdentity => ({
  runtime: "vps",
  gitSha: release.sha,
  deploymentId: `vps-${release.sha}`,
  sourceArchiveSha256: release.archive,
  immutableTreeSha256: release.tree,
});
const refusal = (code: string): never => {
  throw new Error(`VPS deployment refused: ${code}`);
};

/** Constructor capabilities are trusted. Importing the driver performs no effects. */
export function createVpsDeploymentDriver(deps: VpsDriverDependencies): VpsDeploymentDriver {
  sha256(deps.driverSha256);
  if (
    !Number.isSafeInteger(deps.installationId) ||
    deps.installationId < 1 ||
    !["production", "isolated"].includes(deps.environment) ||
    typeof deps.verifySource !== "function" ||
    typeof deps.verifySettlement !== "function"
  )
    return refusal("invalid_capabilities");
  return new VpsDeploymentDriver(deps);
}
export class VpsDeploymentDriver {
  private readonly _store: ImmutableVpsReleaseStore;
  private readonly _journal: VpsOperationJournal;
  constructor(private readonly _deps: VpsDriverDependencies) {
    this._store = new ImmutableVpsReleaseStore(this._deps.root, this._deps.run, this._deps.preparePayload);
    this._journal = new VpsOperationJournal(this._deps.root);
  }
  private _lock<T>(work: () => Promise<T>): Promise<T> {
    return withVpsDeployLock(this._deps.root, work);
  }
  private _command(program: string, args: string[]): Promise<string> {
    return this._deps.run(program, args, this._deps.root);
  }
  private async _checkout(binding: VpsBinding): Promise<void> {
    await this._store.assertDirectories();
    if (binding.installationId !== this._deps.installationId || binding.environment !== this._deps.environment) return refusal("scope_mismatch");
    if (await this._command("git", ["status", "--porcelain", "--untracked-files=no"])) return refusal("dirty_checkout");
    if ((await this._command("git", ["branch", "--show-current"])) !== "development") return refusal("branch_mismatch");
    const head = await this._command("git", ["rev-parse", "HEAD"]);
    if (head !== (await this._command("git", ["rev-parse", "--verify", "refs/remotes/origin/development"]))) return refusal("origin_mismatch");
    await this._command("git", ["merge-base", "--is-ancestor", binding.revision, head]);
    if (!(await this._deps.verifySource(binding))) return refusal("source_proof_unavailable");
  }
  inspectPrior(): Promise<VpsSelector> {
    return this._lock(async () => {
      const selected = await this._store.selector();
      if (selected === null) return refusal("prior_missing");
      const previous = await this._store.checkedPrevious(selected);
      return parseVpsSelector({
        target: selected,
        identity: identity(previous),
        listenerPort: previous.port,
        launcherProfileSha256: previous.profile,
        unitSha256: await this._store.unitDigest(previous.sha),
      });
    });
  }
  sampleHealth(expected: VpsIdentity, surface: "loopback" | "public", port = 7999): Promise<VpsHealthProof> {
    return this._sampleHealth(expected, surface, port, 5000);
  }
  private async _sampleHealth(expected: VpsIdentity, surface: "loopback" | "public", port: number, timeout: number): Promise<VpsHealthProof> {
    const url = surface === "public" ? "https://ai.ubq.fi/health" : `http://127.0.0.1:${port}/health`;
    const response = await this._deps.fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "error" });
    const body: unknown = await response.json().catch(() => null);
    const exact = healthServesRelease(response, body, expected.gitSha);
    return parseVpsHealth({
      identity: expected,
      surface,
      observedAt: this._deps.now(),
      httpStatus: response.status,
      bodyMatches: exact,
      headersMatch: exact,
      originMatches: surface === "loopback" || response.headers.get("x-uos-router-origin") === "vps",
    });
  }
  private async _ready(expected: VpsIdentity, port = 7999): Promise<VpsHealthProof> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const proof = await this._sampleHealth(expected, "loopback", port, 2000);
        if (isHealthyVps(proof)) return proof;
      } catch {
        // Type=simple returns before the immutable release opens its listener.
      }
      if (attempt + 1 < 30) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return refusal("identity_unavailable");
  }
  private async _proof(expected: VpsIdentity, port = 7999, ready?: VpsHealthProof): Promise<{ loopback: VpsHealthProof; public: VpsHealthProof }> {
    const loopback = ready ?? (await this.sampleHealth(expected, "loopback", port)),
      publicHealth = await this.sampleHealth(expected, "public");
    if (!isHealthyVps(loopback) || !isHealthyVps(publicHealth)) return refusal("identity_unavailable");
    return { loopback, public: publicHealth };
  }
  async prepare(input: VpsPrepare): Promise<VpsReceipt> {
    const binding = parseVpsBinding(input.binding),
      expectedPrior = parseVpsSelector(input.expectedPrior);
    if (input.expectedDriverSha256 !== this._deps.driverSha256) return refusal("driver_mismatch");
    const operationId = await vpsOperationId(binding);
    return this._lock(async () => {
      await this._checkout(binding);
      const existing = await this._journal.read(operationId);
      if (existing) {
        if (
          canonicalVps(existing.binding) !== canonicalVps(binding) ||
          canonicalVps(existing.prior) !== canonicalVps(expectedPrior) ||
          existing.controllerSha !== input.controllerSha ||
          existing.driverSha256 !== this._deps.driverSha256
        )
          return refusal("request_mismatch");
        return existing;
      }
      if (await this._store.exists(".data/deploy-recovery.json")) return refusal("unbound_recovery_pending");
      if ((await this._store.selector()) !== expectedPrior.target) return refusal("unrelated_current");
      const actualPrior = await this._store.checkedPrevious(expectedPrior.target);
      if (
        !sameVps(identity(actualPrior), expectedPrior.identity) ||
        actualPrior.profile !== expectedPrior.launcherProfileSha256 ||
        actualPrior.port !== expectedPrior.listenerPort ||
        (await this._store.unitDigest(actualPrior.sha)) !== expectedPrior.unitSha256
      )
        return refusal("prior_changed");
      for (const surface of ["loopback", "public"] as const) {
        const proof = parseVpsHealth(input.priorHealth[surface]);
        if (
          proof.surface !== surface ||
          !sameVps(proof.identity, expectedPrior.identity) ||
          !isHealthyVps(proof) ||
          this._deps.now() - proof.observedAt > 30_000 ||
          proof.observedAt > this._deps.now()
        )
          return refusal("stale_prior_proof");
      }
      await this._proof(expectedPrior.identity, expectedPrior.listenerPort);
      await this._command("git", ["merge-base", "--is-ancestor", expectedPrior.identity.gitSha, binding.revision]);
      if (binding.revision === expectedPrior.identity.gitSha) return refusal("candidate_equals_prior");
      await ensureCaddyIngressReady((program, args) => this._command(program, args), this._deps.root);
      await mkdir(this._store.absolute(".data/releases"), { recursive: true, mode: 0o700 });
      const candidate = identity(await this._store.checkedRelease(binding.revision, true));
      const now = this._deps.now();
      return this._journal.write({
        schema: 1,
        kind: "vps_driver_receipt",
        abi: VPS_RELEASE_ABI,
        operationId,
        binding,
        controllerSha: input.controllerSha,
        driverSha256: this._deps.driverSha256,
        candidate,
        prior: expectedPrior,
        phase: "prepared",
        sequence: 1,
        createdAt: now,
        updatedAt: now,
        intent: null,
        loopback: null,
        public: null,
        restoration: null,
        settlement: null,
        error: null,
      });
    });
  }
  private async _bound(operation: VpsOperation): Promise<VpsReceipt> {
    const receipt = await this._journal.read(operation.operationId);
    if (receipt?.binding.requestDigest !== operation.requestDigest || receipt.driverSha256 !== this._deps.driverSha256) return refusal("receipt_unavailable");
    return receipt;
  }
  private async _mutation(operation: VpsMutation): Promise<VpsReceipt> {
    const receipt = await this._bound(operation);
    if (receipt.sequence !== operation.expectedSequence || (await vpsDigest(receipt)) !== operation.expectedDigest) return refusal("receipt_conflict");
    return receipt;
  }
  private _write(receipt: VpsReceipt, patch: Partial<VpsReceipt>): Promise<VpsReceipt> {
    return this._journal.write(parseVpsReceipt({ ...receipt, ...patch, sequence: receipt.sequence + 1, updatedAt: this._deps.now() }));
  }
  observe(operation: VpsOperation): Promise<VpsReceipt> {
    return this._lock(() => this._bound(operation));
  }
  activate(operation: VpsMutation): Promise<VpsReceipt> {
    return this._lock(async () => {
      let receipt = await this._mutation(operation);
      if (["accepted", "failed", "rolled_back", "rollback_pending"].includes(receipt.phase)) return refusal("terminal_or_rollback");
      await this._checkout(receipt.binding);
      if (!sameVps(identity(await this._store.checkedRelease(receipt.candidate.gitSha)), receipt.candidate)) return refusal("candidate_changed");
      if (!sameVps(identity(await this._store.checkedPreviousRelease(receipt.prior.identity.gitSha, receipt.prior.target)), receipt.prior.identity))
        return refusal("prior_changed");
      const selected = await this._store.selector();
      if (selected !== receipt.prior.target && selected !== `releases/${receipt.candidate.gitSha}`) return refusal("unrelated_current");
      if (receipt.phase === "prepared") {
        if (selected !== receipt.prior.target) return refusal("ambiguous_prepared_selector");
        await this._proof(receipt.prior.identity, receipt.prior.listenerPort);
        receipt = await this._write(receipt, { intent: { action: "promote", persistedAt: this._deps.now() } });
        await this._store.selectRelease(`releases/${receipt.candidate.gitSha}`);
        receipt = await this._write(receipt, { phase: "selected" });
      }
      let restartAttempted = false;
      try {
        if (receipt.phase === "selected") {
          await this._command("sudo", ["-n", "systemctl", "daemon-reload"]);
          restartAttempted = true;
          await this._command("sudo", ["-n", "systemctl", "restart", "ai-ubq-fi.service"]);
          const loopback = await this._ready(receipt.candidate);
          receipt = await this._write(receipt, { phase: "candidate_ready", loopback });
        }
        if (receipt.phase === "candidate_ready") {
          await reloadCaddyIngress((program, args) => this._command(program, args));
          receipt = await this._write(receipt, { phase: "ingress_applied" });
        }
        const health = await this._proof(receipt.candidate);
        return await this._write(receipt, health);
      } catch {
        if (receipt.phase !== "ingress_applied") {
          receipt = await this._write(receipt, { phase: "rollback_pending", intent: { action: "rollback", persistedAt: this._deps.now() } });
          return await this._restoreOwned(receipt, restartAttempted);
        }
        // Ambiguous post-ingress proof is retained for nondestructive observation.
        return await this._write(receipt, { error: "public_identity_pending" });
      }
    });
  }
  private async _restoreOwned(receipt: VpsReceipt, restart = true): Promise<VpsReceipt> {
    const selected = await this._store.selector();
    if (selected !== receipt.prior.target && selected !== `releases/${receipt.candidate.gitSha}`) return refusal("unrelated_current");
    const prior = await this._store.checkedPreviousRelease(receipt.prior.identity.gitSha, receipt.prior.target);
    if (restart) await this._store.assertRollbackAllowed(prior, receipt.candidate.gitSha);
    if (selected !== receipt.prior.target) await this._store.selectRelease(receipt.prior.target);
    const priorReady = await this.sampleHealth(receipt.prior.identity, "loopback", receipt.prior.listenerPort)
      .then(isHealthyVps)
      .catch(() => false);
    if (restart && !priorReady) await this._command("sudo", ["-n", "systemctl", "restart", "ai-ubq-fi.service"]);
    const loopback = await this._ready(receipt.prior.identity, receipt.prior.listenerPort);
    const restoration = await this._proof(receipt.prior.identity, receipt.prior.listenerPort, loopback);
    return this._write(receipt, { phase: "rolled_back", restoration });
  }
  restore(operation: VpsMutation): Promise<VpsReceipt> {
    return this._lock(async () => {
      let receipt = await this._mutation(operation);
      if (["accepted", "failed"].includes(receipt.phase)) return refusal("terminal_receipt");
      if (receipt.phase === "rolled_back") return receipt;
      if (receipt.phase !== "rollback_pending")
        receipt = await this._write(receipt, { phase: "rollback_pending", intent: { action: "rollback", persistedAt: this._deps.now() } });
      return this._restoreOwned(receipt);
    });
  }
  settle(input: VpsSettlement): Promise<VpsReceipt> {
    return this._lock(async () => {
      const receipt = await this._mutation(input);
      if (receipt.settlement !== null) {
        if (
          receipt.phase !== input.disposition ||
          canonicalVps(receipt.settlement) !== canonicalVps({ stateRevision: input.stateRevision, disposition: input.disposition, digest: input.digest })
        )
          return refusal("settlement_unavailable");
        if (!(await this._deps.verifySettlement(receipt, input))) return refusal("settlement_unavailable");
        await this._journal.releasePin(receipt);
        return receipt;
      }
      if (!(await this._deps.verifySettlement(receipt, input))) return refusal("settlement_unavailable");
      if (
        input.disposition === "failed" &&
        receipt.intent === null &&
        (receipt.phase !== "prepared" ||
          receipt.sequence !== 1 ||
          receipt.loopback !== null ||
          receipt.public !== null ||
          receipt.restoration !== null ||
          receipt.error !== null)
      )
        return refusal("deployment_not_verified");
      if (input.disposition === "rolled_back" && receipt.phase !== "rolled_back") return refusal("restoration_missing");
      if (input.disposition === "accepted") {
        if (receipt.phase !== "ingress_applied" || !receipt.loopback || !receipt.public || !isHealthyVps(receipt.loopback) || !isHealthyVps(receipt.public))
          return refusal("deployment_not_verified");
        await this._proof(receipt.candidate);
      }
      const terminal = await this._write(receipt, {
        phase: input.disposition,
        settlement: { stateRevision: input.stateRevision, disposition: input.disposition, digest: input.digest },
        error: input.disposition === "failed" ? "acceptance_insufficient" : receipt.error,
      });
      await this._journal.releasePin(terminal);
      return terminal;
    });
  }
}

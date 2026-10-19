import { routingStateChangedByNormalization } from "./native-codex-evaluation.ts";
import { activeSelectionForAccount, planCodexResetElection, selectCodex } from "./native-codex.ts";
import * as mutation from "./native-codex-mutations.ts";
import { normalizeRoutingState, probeLeaseMatchesCodexRoutingAccount, quotaClass, slotFor, slotMatchesCodexRoutingAccount } from "./native-codex-capacity.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  CODEX_HALF_OPEN_LEASE_MS,
  codexActiveAccountSelectionCurrent,
  parseCodexAccountRoutingState,
  parseCodexActiveAccountSelection,
  type CodexRoutingAccount,
} from "./native-codex-contracts.ts";
import { quotaBlockTransition, releaseNonBlockingQuotaProbe, type Codex429Classification } from "./native-codex-429.ts";
import {
  NativeAuthorityError,
  type NativeArguments,
  type NativeCapability,
  type NativeCodexAuthorization,
  type NativeOwner,
  type NativePool,
  type NativeReply,
} from "./native-authority-contracts.ts";
import { NativeAuthoritySql } from "./native-authority-sql.ts";
import { NativeAuthorityApi } from "./native-authority-api.ts";

export class NativeAuthorityCodex {
  constructor(
    private readonly _sql: NativeAuthoritySql,
    private readonly _api: NativeAuthorityApi
  ) {}
  private _policies(pool: NativePool, model: string) {
    return new Map(Object.entries(pool.modelPolicies?.[model] ?? pool.policies));
  }
  private _rows(now: number) {
    const pool = this._sql.read("codex_pool", CODEX_AUTH_POOL_KV_KEY, now),
      active = this._sql.read("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, now),
      routing = this._sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now),
      capacity = this._sql.read("codex_capacity", CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, now);
    if (!pool.value || !pool.revision) throw new NativeAuthorityError("codex_pool_unavailable", 503);
    const parsed = routing.value === null ? null : parseCodexAccountRoutingState(routing.value);
    if (routing.value !== null && !parsed) throw new NativeAuthorityError("codex_routing_malformed", 503);
    return {
      pool: { ...pool, value: pool.value, revision: pool.revision },
      active,
      routing,
      parsed,
      capacity,
      normalized: normalizeRoutingState(parsed, pool.value.identities, now, true),
      revisions: { pool: pool.revision, active: active.revision, routing: routing.revision, capacity: capacity.revision },
    };
  }
  private _owner(account: CodexRoutingAccount, now: number): NativeOwner {
    const owner = this._sql.read("codex_owner", [account.accountIdHash], now).value;
    if (
      !owner ||
      owner.revoked ||
      owner.routingAccountIdHash !== account.accountIdHash ||
      owner.credentialVersion !== account.credentialVersion ||
      owner.expiresAtMs <= now
    )
      throw new NativeAuthorityError("codex_owner_unavailable", 503);
    return owner;
  }
  /** Current owner metadata is distinct from native generation and source routing fingerprint. */
  authorization(cap: NativeCapability, handle: string, now: number): NativeCodexAuthorization {
    const request = this._api.request(cap, handle, now);
    if (!request.codex || !request.ownerFence) throw new NativeAuthorityError("codex_admission_missing");
    return { account: request.codex, owner: request.ownerFence };
  }
  fence(cap: NativeCapability, handle: string, now: number, authorization?: NativeCodexAuthorization): void {
    const request = this._api.request(cap, handle, now),
      account = authorization?.account ?? request.codex;
    if (account?.activeGeneration === undefined) throw new NativeAuthorityError("codex_admission_missing");
    const rows = this._rows(now),
      identity = rows.pool.value.identities.find((candidate) => candidate.slot === account.slot);
    if (
      identity?.accountIdHash !== account.accountIdHash ||
      identity.credentialVersion !== account.credentialVersion ||
      !rows.pool.value.selectedAccountHashes.includes(account.accountIdHash) ||
      !codexActiveAccountSelectionCurrent(rows.active.value, account, account.activeGeneration) ||
      rows.pool.revision !== account.activePoolVersionstamp
    )
      throw new NativeAuthorityError("codex_dispatch_fence_stale");
    const slot = slotFor(rows.normalized, account);
    if (mutation.admissionRefreshRoutingGeneration(rows.normalized, account) === null) throw new NativeAuthorityError("codex_credential_invalid");
    if (
      !slotMatchesCodexRoutingAccount(slot, account) ||
      slot.generation !== account.routingGeneration ||
      (account.probeGeneration !== null && !probeLeaseMatchesCodexRoutingAccount(slot, account))
    )
      throw new NativeAuthorityError("codex_routing_fence_stale");
    const owner = this._owner(account, now),
      prior = authorization?.owner ?? request.ownerFence;
    if (
      prior?.ownerId !== owner.ownerId ||
      prior.ownerEpoch !== owner.ownerEpoch ||
      prior.publicationRevision !== owner.publicationRevision ||
      prior.nativeGenerationHash !== owner.nativeGenerationHash
    )
      throw new NativeAuthorityError("codex_owner_fence_stale");
  }
  select(cap: NativeCapability, handle: string, now: number): NativeReply {
    const request = this._api.request(cap, handle, now),
      rows = this._rows(now);
    const plan = selectCodex(
      {
        active: rows.active.value,
        routing: rows.routing.value,
        capacity: rows.capacity.value,
        poolIdentities: rows.pool.value.identities,
        selectedAccountHashes: rows.pool.value.selectedAccountHashes,
        accountPolicies: this._policies(rows.pool.value, request.model),
        revisions: rows.revisions,
      },
      now,
      request.model
    );
    if (!plan) return { kind: "routing_unavailable" };
    if (plan.writes.routing) this._sql.write("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, plan.writes.routing);
    if (plan.writes.active) this._sql.write("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, plan.writes.active);
    const selection = plan.selection;
    if (selection.kind !== "eligible") {
      this._api.save({ ...request, selection, codexProof: this._rows(now).revisions, codex: null, ownerFence: null });
      return { kind: selection.kind, detail: selection };
    }
    let account = selection.accounts.at(0);
    if (!account) throw new NativeAuthorityError("codex_selection_empty", 503);
    if (account.probeRequired) {
      const current = this._rows(now),
        claim = mutation.buildExpiredProbeClaim(current.normalized, account, now, crypto.randomUUID(), now);
      if (!claim) return { kind: "routing_unavailable" };
      this._sql.write("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, claim.next);
      account = { ...account, probeRequired: false, probeGeneration: claim.lease.generation, probeToken: claim.lease.token, probeCircuit: claim.lease.circuit };
    }
    const owner = this._owner(account, now);
    this._api.save({ ...request, selection, codexProof: null, codex: account, ownerFence: owner });
    return { kind: "eligible", detail: account };
  }
  signal(cap: NativeCapability, args: NativeArguments["recordCodexAttemptSignal"], parsed: Codex429Classification | null, now: number): NativeReply {
    const request = this._api.request(cap, args.handle, now),
      account = request.codex;
    if (!account) throw new NativeAuthorityError("codex_admission_missing");
    this._api.save({
      ...request,
      providerObserved: true,
      ...(args.signal === "success" && request.semantic === null ? { responding: { provider: "chatgpt_codex", attemptHandle: null } } : {}),
    });
    const rows = this._rows(now),
      identity = rows.pool.value.identities.find((candidate) => candidate.slot === account.slot);
    if (identity?.accountIdHash !== account.accountIdHash || identity.credentialVersion !== account.credentialVersion) return { kind: "stale" };
    let next;
    switch (args.signal) {
      case "success":
        next = mutation.markCodexSuccess(rows.normalized, account, now);
        break;
      case "credential_invalid":
        next = mutation.markCodexCredentialInvalid(rows.normalized, account, now, now);
        break;
      case "upstream_timeout":
        next = mutation.markCodexUpstreamTimeout(rows.normalized, account, now, now);
        break;
      case "quota":
        if (!parsed) throw new NativeAuthorityError("codex_quota_response_missing", 400);
        next = parsed.usageLimitReached
          ? quotaBlockTransition(rows.normalized, account, parsed, now, args.recoveryProbe === true, now)
          : releaseNonBlockingQuotaProbe(rows.normalized, account, now);
        break;
      default:
        throw new NativeAuthorityError("invalid_codex_signal", 400);
    }
    if (next) this._sql.write("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, next);
    return {
      kind: next ? "recorded" : "unchanged",
      detail: parsed
        ? {
            usageLimitReached: parsed.usageLimitReached,
            retryAtMs: parsed.retryAtMs,
            quotaBlockSource: parsed.quotaBlockSource,
            resetDeadlineIsStable: parsed.resetDeadlineIsStable,
            resetDeadlineConflict: parsed.resetDeadlineConflict,
          }
        : undefined,
    };
  }
  release(cap: NativeCapability, handle: string, now: number): NativeReply {
    const request = this._api.request(cap, handle, now);
    if (!request.codex) return { kind: "missing" };
    const next = mutation.releaseCodexRoutingProbe(this._rows(now).normalized, request.codex, now);
    if (next) this._sql.write("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, next);
    return { kind: next ? "released" : "stale" };
  }
  refresh(cap: NativeCapability, handle: string, now: number): NativeReply {
    const request = this._api.request(cap, handle, now),
      account = request.codex;
    if (!account) return { kind: "stale" };
    const rows = this._rows(now),
      active = parseCodexActiveAccountSelection(rows.active.value),
      identity = rows.pool.value.identities.find((candidate) => candidate.slot === account.slot);
    // Native refresh is allowed to update fences for this same identity only, never elect a sibling.
    if (
      !active ||
      active.generation !== account.activeGeneration ||
      active.account_id_hash !== account.accountIdHash ||
      active.slot !== account.slot ||
      identity?.accountIdHash !== account.accountIdHash
    )
      return { kind: "stale" };
    const changed = account.credentialVersion !== identity.credentialVersion;
    const slot = rows.normalized.slots.at(account.slot);
    const lease = slot?.probe_lease;
    const retained =
      changed &&
      account.probeGeneration !== null &&
      account.probeToken !== null &&
      lease?.token === account.probeToken &&
      lease.circuit === (account.probeCircuit ?? "quota") &&
      lease.generation === slot?.generation;
    const resetProbe = changed ? { probeRequired: false, probeGeneration: null, probeToken: null, probeCircuit: null } : {};
    const transferred = retained ? { probeGeneration: slot.generation, probeToken: lease.token, probeCircuit: lease.circuit } : {};
    const currentAccount: CodexRoutingAccount = { ...account, ...resetProbe, ...transferred, credentialVersion: identity.credentialVersion };
    const generation = mutation.admissionRefreshRoutingGeneration(rows.routing.value === null ? null : rows.normalized, currentAccount);
    if (generation === null) return { kind: "stale" };
    if (routingStateChangedByNormalization(rows.parsed, rows.normalized)) this._sql.write("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, rows.normalized);
    const prepared = mutation.prepareCodexAdmissionRefresh(active, currentAccount, rows.pool.revision, generation);
    if (prepared.kind === "refresh") this._sql.write("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, { ...prepared.next, updated_at_ms: now });
    const owner = this._owner(currentAccount, now);
    if (owner.expiresAtMs - now < 120_000) throw new NativeAuthorityError("codex_native_owner_renewal_required", 503);
    if (request.ownerFence && (request.ownerFence.ownerId !== owner.ownerId || request.ownerFence.ownerEpoch !== owner.ownerEpoch))
      throw new NativeAuthorityError("codex_owner_fence_stale");
    const refreshed = { ...currentAccount, routingGeneration: generation, activePoolVersionstamp: rows.pool.revision };
    this._api.save({ ...request, codex: refreshed, ownerFence: owner });
    return { kind: "current", detail: refreshed };
  }
  elect(cap: NativeCapability, args: NativeArguments["electCodexResetProbe"], now: number): NativeReply {
    const request = this._api.request(cap, args.handle, now),
      proof = this._sql.read("codex_reset", [args.proofId], now).value;
    if (!proof?.verified) return { kind: "refused", detail: "reset_proof_unavailable" };
    if (quotaClass(proof.account.requestedModel) !== quotaClass(request.model)) return { kind: "refused", detail: "reset_model_class_mismatch" };
    const rows = this._rows(now),
      account = { ...proof.account, requestedModel: request.model },
      slot = rows.normalized.slots.at(account.slot);
    const selected = rows.pool.value.selectedAccountHashes,
      identity = rows.pool.value.identities.find((candidate) => candidate.slot === account.slot);
    if (
      rows.pool.revision !== proof.poolRevision ||
      rows.capacity.revision !== proof.capacityRevision ||
      !mutation.isCodexActiveAccountSnapshotCurrent(rows.active.value, { selection: proof.activeSnapshot }) ||
      identity?.accountIdHash !== account.accountIdHash ||
      identity.credentialVersion !== account.credentialVersion ||
      !selected.includes(account.accountIdHash) ||
      !slot ||
      !mutation.resetCandidateSlotMatches(
        slot,
        account,
        mutation.isCodexQuotaBlockFenceCurrent(rows.routing.value, account, proof.quotaResetAtMs, proof.routingGeneration)
      )
    )
      return { kind: "refused", detail: "reset_fence_stale" };
    const cohort = selectCodex(
      {
        active: rows.active.value,
        routing: rows.routing.value,
        capacity: rows.capacity.value,
        poolIdentities: rows.pool.value.identities,
        selectedAccountHashes: selected,
        accountPolicies: this._policies(rows.pool.value, account.requestedModel),
        revisions: rows.revisions,
      },
      now,
      account.requestedModel
    );
    if (cohort?.selection.kind !== "quota_blocked" || !cohort.selection.fullCohortExhausted) return { kind: "refused", detail: "cohort_not_quota_exhausted" };
    const active = parseCodexActiveAccountSelection(rows.active.value),
      next = activeSelectionForAccount(account, rows.pool.revision, mutation.nextResetElectionGeneration(active, account), now, "quota_exhausted");
    if (!next) return { kind: "refused" };
    const election = planCodexResetElection(rows.revisions, rows.routing.value, rows.normalized, next);
    if (election.writes.routing) this._sql.write("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, election.writes.routing);
    this._sql.write("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, election.writes.active);
    const lease = {
      token: crypto.randomUUID(),
      expires_at_ms: now + CODEX_HALF_OPEN_LEASE_MS,
      generation: slot.generation + 1,
      circuit: "quota" as const,
      quota_class: quotaClass(account.requestedModel),
    };
    const recovered = mutation.recoveryProbeTransition(rows.normalized, account, lease, now);
    this._sql.write("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, recovered);
    const admitted: CodexRoutingAccount = {
      ...account,
      routingGeneration: lease.generation,
      activeGeneration: next.generation,
      activePoolVersionstamp: next.pool_versionstamp,
      activeTransitionReason: next.transition_reason,
      probeRequired: false,
      probeGeneration: lease.generation,
      probeToken: lease.token,
      probeCircuit: lease.circuit,
    };
    const owner = this._owner(admitted, now);
    this._api.save({ ...request, codex: admitted, ownerFence: owner });
    this._sql.write("codex_reset", [proof.id], { ...proof, verified: false });
    return { kind: "probe_elected", detail: admitted };
  }
}

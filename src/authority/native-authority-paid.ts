import { selectCodex } from "./native-codex.ts";
import {
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
} from "./native-codex-contracts.ts";
import { apiKeyHashKey } from "../api-keys.ts";
import * as paid from "./native-paid.ts";
import { currentApiKeyUsageWindow } from "./native-api-key.ts";
import type { NativePaidReleasePlan, PaidFallbackRequestV3 } from "./native-paid-contracts.ts";
import {
  NativeAuthorityError,
  type NativeArguments,
  type NativeAttempt,
  type NativeCapability,
  type NativeKey,
  type NativeReply,
  type NativeRequest,
} from "./native-authority-contracts.ts";
import { NativeAuthoritySql } from "./native-authority-sql.ts";
import { NativeAuthorityApi } from "./native-authority-api.ts";

export class NativeAuthorityPaid {
  constructor(
    private readonly _sql: NativeAuthoritySql,
    private readonly _api: NativeAuthorityApi
  ) {}
  private _hop(id: string) {
    const hop = this._sql.read("authority_config", ["config"], 0).value?.providerHops.find((candidate) => candidate.id === id);
    if (!hop) throw new NativeAuthorityError("provider_hop_not_configured", 403);
    return hop;
  }
  attempt(cap: NativeCapability, handle: string, now: number): NativeAttempt {
    const row = this._sql.read("attempt_lifetime", [handle], now).value;
    if (row?.principalId !== cap.principalId || row.keyId !== cap.keyId) throw new NativeAuthorityError("attempt_ownership_mismatch", 403);
    this._api.request(cap, row.requestHandle, now);
    return row;
  }
  private _saveAttempt(row: NativeAttempt) {
    this._sql.write("attempt_lifetime", [row.handle], row, null, { scope: row.keyId, parent: row.requestHandle });
  }
  private _request(attempt: NativeAttempt, now: number) {
    return this._sql.read("paid_request", paid.paidFallbackRequestV3Key(attempt.keyId, attempt.billingRequestId), now);
  }
  private _gate(now: number) {
    return this._sql.read("paid_gate", paid.paidFallbackReconciliationGateV3Key(), now);
  }
  private _writeRequest(key: NativeKey, row: PaidFallbackRequestV3, expiry: number) {
    this._sql.write("paid_request", key, row, expiry, { scope: row.key_id });
  }
  private _arm(now: number) {
    const entry = this._gate(now);
    this._sql.write("paid_gate", paid.paidFallbackReconciliationGateV3Key(), paid.paidFallbackReconciliationGateDueNow(entry, now));
  }
  private _policy(cap: NativeCapability, now: number) {
    const source = this._sql.read("api_policy", apiKeyHashKey(cap.tokenHash), now);
    if (
      !source.value ||
      source.value.revoked ||
      source.value.api.key_id !== cap.keyId ||
      !source.value.api.paid_fallback_enabled ||
      (source.value.api.expires_at_ms !== -1 && source.value.api.expires_at_ms <= now)
    )
      return null;
    return { ...source, value: source.value };
  }
  private _existing(requestHandle: string, hopId: string, now: number): string {
    let after = "";
    for (;;) {
      const page = this._sql.page("attempt_lifetime", now, after, 100, { parent: requestHandle });
      const existing = page.find((candidate) => candidate.row.value?.hopId === hopId)?.row.value;
      if (existing) return existing.handle;
      if (page.length < 100) break;
      after = page[page.length - 1].encoded;
    }
    throw new NativeAuthorityError("paid_attempt_lifetime_missing", 503);
  }
  private _fallbackCurrent(request: NativeRequest, now: number): boolean {
    if (!request.codexProof) return false;
    const proof = request.codexProof;
    const rows = {
      pool: this._sql.read("codex_pool", CODEX_AUTH_POOL_KV_KEY, now),
      active: this._sql.read("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, now),
      routing: this._sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now),
      capacity: this._sql.read("codex_capacity", CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, now),
    };
    if (Object.entries(proof).some(([key, revision]) => rows[key as keyof typeof rows].revision !== revision)) return false;
    const pool = rows.pool.value;
    if (!pool || !rows.pool.revision) return false;
    const decision = selectCodex(
      {
        active: rows.active.value,
        routing: rows.routing.value,
        capacity: rows.capacity.value,
        poolIdentities: pool.identities,
        selectedAccountHashes: pool.selectedAccountHashes,
        accountPolicies: new Map(Object.entries(pool.modelPolicies?.[request.model] ?? pool.policies)),
        revisions: { active: rows.active.revision, pool: rows.pool.revision, routing: rows.routing.revision, capacity: rows.capacity.revision },
      },
      now,
      request.model
    );
    const selection = decision?.selection;
    return (selection?.kind === "quota_blocked" || selection?.kind === "credentials_invalid") && selection.fullCohortUnavailable === true;
  }
  reserve(cap: NativeCapability, args: NativeArguments["reservePaidAttempt"], now: number): NativeReply {
    const request = this._api.request(cap, args.handle, now),
      hop = this._hop(args.hopId);
    if (
      hop.authorization === "codex_unavailable" &&
      !(
        request.selection &&
        (request.selection.kind === "quota_blocked" || request.selection.kind === "credentials_invalid") &&
        request.selection.fullCohortUnavailable === true &&
        this._fallbackCurrent(request, now)
      )
    )
      return { kind: "blocked", detail: "subscriptions_not_authoritatively_unavailable" };
    const source = this._policy(cap, now);
    if (!source) return { kind: "blocked", detail: "invalid_policy" };
    const policy = source.value,
      unlimited = policy.api.paid_fallback_limit_microcredits === -1;
    if (!policy.paid.eligibleModels.includes(request.model) && !(unlimited && policy.paid.allowUnrosteredUnlimited))
      return { kind: "skip", detail: "model_not_priced" };
    const billingRequestId = `${request.requestId}:${hop.billingSuffix}`;
    const reset = currentApiKeyUsageWindow(policy.api.usage_reset_at_ms, policy.api.window_ms, request.createdAtMs).reset;
    const input = {
      keyId: cap.keyId,
      requestId: billingRequestId,
      createdAtMs: request.createdAtMs,
      policyVersion: policy.paid.policyVersion,
      limitMicrocredits: policy.api.paid_fallback_limit_microcredits,
      maximumExposureMicrocredits: policy.paid.modelExposure[request.model] ?? null,
      initialSettledMicrocredits: 0,
      quotaPerCredit: policy.paid.quotaPerCredit,
      windowResetAtMs: reset,
      model: request.model,
      route: request.route,
      path: request.route,
      stream: request.stream,
      reasoning: request.reasoning,
      dispatchIntent: true,
    };
    if (paid.isInvalidAdmissionPolicy(input, unlimited, input.maximumExposureMicrocredits)) return { kind: "blocked", detail: "invalid_policy" };
    const requestKey = paid.paidFallbackRequestV3Key(cap.keyId, billingRequestId),
      windowKey = paid.paidFallbackWindowV3Key(cap.keyId, reset);
    const plan = paid.planPaidFallbackAdmissionV3(
      input,
      {
        request: this._sql.read("paid_request", requestKey, now),
        window: this._sql.read("paid_window", windowKey, now),
        deletionGuard: this._sql.read("paid_deletion_guard", paid.paidFallbackDeletionGuardV3Key(cap.keyId), now),
        policyFence: { versionstamp: source.revision },
      },
      { unlimited, maximumExposure: input.maximumExposureMicrocredits },
      now
    );
    if (plan.kind === "exhausted_policy") {
      this._sql.write("paid_window", windowKey, plan.window, now + plan.windowExpireIn, { scope: cap.keyId });
      return { kind: "blocked", detail: "limit_exceeded" };
    }
    if (plan.kind === "blocked") return { kind: plan.kind, detail: plan.reason };
    if (plan.kind === "reserved") {
      return { kind: "reserved", attemptHandle: this._existing(request.handle, hop.id, now), detail: plan.reservation };
    }
    this._writeRequest(requestKey, plan.request, now + plan.requestExpireIn);
    this._sql.write("paid_pending", paid.paidFallbackPendingV3Key(cap.keyId, billingRequestId), plan.pending, null, {
      scope: cap.keyId,
      due: plan.pending.next_reconciliation_at_ms,
    });
    if (plan.checkGate) this._arm(now);
    if (plan.window && plan.windowExpireIn !== null) this._sql.write("paid_window", windowKey, plan.window, now + plan.windowExpireIn, { scope: cap.keyId });
    const handle = crypto.randomUUID();
    this._saveAttempt({
      handle,
      requestHandle: request.handle,
      principalId: cap.principalId,
      keyId: cap.keyId,
      hopId: hop.id,
      billingRequestId,
      windowResetAtMs: reset,
      fetchStarted: false,
    });
    return { kind: "reserved", attemptHandle: handle, detail: plan.reservation };
  }
  lifecycle(cap: NativeCapability, args: NativeArguments["recordPaidAttemptLifecycle"], now: number): NativeReply {
    const attempt = this.attempt(cap, args.attemptHandle, now),
      hop = this._hop(attempt.hopId),
      entry = this._request(attempt, now);
    if (!entry.value) return { kind: "missing" };
    const plan = paid.planPaidFallbackLifecycleV3(
      entry.value,
      { ...args.patch, ...(args.patch.terminal_state === undefined ? {} : { increment_reconciliation_attempts: true }), provider: hop.ledgerProvider },
      now
    );
    if (plan) {
      this._writeRequest(paid.paidFallbackRequestV3Key(cap.keyId, attempt.billingRequestId), plan.request, now + plan.requestExpireIn);
      if (plan.readGate && (plan.dispatchBoundary || paid.paidFallbackReconciliationGateNeedsArm(this._gate(now), now))) this._arm(now);
    }
    if (args.fetchStarted) {
      this._saveAttempt({ ...attempt, fetchStarted: true });
      const original = this._api.request(cap, attempt.requestHandle, now);
      if (original.dispatch) this._api.save({ ...original, dispatch: { ...original.dispatch, fetchStarted: true } });
    }
    return { kind: plan ? "updated" : "unchanged", detail: plan?.request ?? entry.value };
  }
  private _applyRelease(attempt: NativeAttempt, plan: Omit<NativePaidReleasePlan, "checks">, now: number): void {
    this._writeRequest(paid.paidFallbackRequestV3Key(attempt.keyId, attempt.billingRequestId), plan.request, now + plan.requestExpireIn);
    this._sql.delete("paid_pending", paid.paidFallbackPendingV3Key(attempt.keyId, attempt.billingRequestId));
    this._sql.write("paid_gate", paid.paidFallbackReconciliationGateV3Key(), plan.gate);
    if (plan.window && plan.windowExpireIn !== null)
      this._sql.write("paid_window", paid.paidFallbackWindowV3Key(attempt.keyId, attempt.windowResetAtMs), plan.window, now + plan.windowExpireIn, {
        scope: attempt.keyId,
      });
  }
  release(cap: NativeCapability, handle: string, now: number): NativeReply {
    const attempt = this.attempt(cap, handle, now);
    if (attempt.fetchStarted) throw new NativeAuthorityError("paid_fetch_may_have_started");
    const plan = paid.planPaidFallbackReleaseV3(
      {
        request: this._request(attempt, now),
        window: this._sql.read("paid_window", paid.paidFallbackWindowV3Key(cap.keyId, attempt.windowResetAtMs), now),
        gate: this._gate(now),
      },
      true,
      now
    );
    if (!plan) return { kind: "unchanged" };
    this._applyRelease(attempt, plan, now);
    return { kind: "released", detail: plan.request };
  }
  private _cleanup(attempt: NativeAttempt, now: number) {
    this._sql.delete("paid_pending", paid.paidFallbackPendingV3Key(attempt.keyId, attempt.billingRequestId));
    this._arm(now);
  }
  defer(cap: NativeCapability, handle: string, now: number): NativeReply {
    const attempt = this.attempt(cap, handle, now),
      pendingKey = paid.paidFallbackPendingV3Key(cap.keyId, attempt.billingRequestId);
    const plan = paid.planPaidFallbackDeferralV3(this._request(attempt, now).value, this._sql.read("paid_pending", pendingKey, now).value, now);
    if (plan.kind === "cleanup") this._cleanup(attempt, now);
    if (plan.kind === "write") {
      this._writeRequest(paid.paidFallbackRequestV3Key(cap.keyId, attempt.billingRequestId), plan.request, now + plan.requestExpireIn);
      this._sql.write("paid_pending", pendingKey, plan.pending, null, { scope: cap.keyId, due: plan.pending.next_reconciliation_at_ms });
    }
    return { kind: plan.kind, detail: plan };
  }
  billing(cap: NativeCapability, args: NativeArguments["recordVerifiedPaidBilling"], now: number): NativeReply {
    const attempt = this.attempt(cap, args.attemptHandle, now),
      hop = this._hop(attempt.hopId),
      request = this._request(attempt, now),
      pending = this._sql.read("paid_pending", paid.paidFallbackPendingV3Key(cap.keyId, attempt.billingRequestId), now);
    const evaluation = paid.evaluatePaidFallbackSettlementV3(request.value, pending.value, args.log, {
      correlation: hop.billingCorrelation,
      microcreditsPerCredit: hop.microcreditsPerCredit,
      ...(args.surplusBuyerCostMicro === undefined ? {} : { surplusBuyerCostMicro: args.surplusBuyerCostMicro }),
    });
    if (evaluation.kind === "cleanup") {
      this._cleanup(attempt, now);
      return { kind: "cleanup" };
    }
    if (evaluation.kind === "defer") return this.defer(cap, args.attemptHandle, now);
    if (evaluation.kind !== "settle") return { kind: evaluation.kind };
    if (!request.value) throw new NativeAuthorityError("paid_request_missing", 503);
    const identity = paid.paidFallbackRequestRollupIdentity(request.value, hop.billingCorrelation),
      rollupKey = paid.paidFallbackUsageRollupKey(identity.bucketStartAtMs, identity.model, identity.provider, identity.shard);
    const rollup = this._sql.read("paid_rollup", rollupKey, now);
    const folded = paid.paidFallbackSettlementRollupV3(
      request.value,
      args.log,
      evaluation.spend,
      hop.billingCorrelation,
      paid.isPaidFallbackUsageRollup(rollup.value) ? rollup.value : null,
      now
    );
    const plan = paid.planPaidFallbackSettlementRowsV3(
      {
        request,
        pending,
        gate: this._gate(now),
        window: this._sql.read("paid_window", paid.paidFallbackWindowV3Key(cap.keyId, attempt.windowResetAtMs), now),
        rollup,
      },
      args.log,
      evaluation.spend,
      folded.foldIntoRollup,
      now
    );
    this._applyRelease(attempt, plan, now);
    if (folded.foldIntoRollup) this._sql.write("paid_rollup", rollupKey, folded.rollup, null);
    return { kind: "settled", detail: plan.request };
  }
  private _resume(cap: NativeCapability, cursor: string | undefined, family: string, now: number): string {
    if (!cursor) return "";
    const row = this._sql.read("cursor", [cursor], now).value;
    if (row?.capabilityId !== cap.id || row.family !== family || row.parent !== cap.keyId) throw new NativeAuthorityError("cursor_ownership_mismatch", 403);
    return row.after;
  }
  private _cursor(cap: NativeCapability, family: string, after: string, lease: string | null): string {
    const id = crypto.randomUUID();
    this._sql.write("cursor", [id], { id, capabilityId: cap.id, family, after, parent: cap.keyId, lease });
    return id;
  }
  claim(cap: NativeCapability, args: NativeArguments["claimPaidReconciliation"], now: number): NativeReply {
    const leaseKey = paid.paidFallbackReconciliationLeaseV3Key(cap.keyId),
      prior = this._sql.read("paid_lease", leaseKey, now).value;
    if (paid.paidFallbackLeaseActiveV3(prior, now)) return { kind: "leased" };
    const token = crypto.randomUUID(),
      lease = paid.paidFallbackReconciliationLeaseV3(token, now);
    this._sql.write("paid_lease", leaseKey, lease, lease.expires_at_ms, { scope: cap.keyId });
    this._sql.write("cursor", [token], { id: token, capabilityId: cap.id, family: "paid_lease", after: "", parent: cap.keyId, lease: token });
    const page = this._sql.page("paid_pending", now, this._resume(cap, args.cursor, "paid_pending", now), args.limit, { scope: cap.keyId });
    const due = [];
    for (const item of page) {
      if (item.row.value && item.row.value.next_reconciliation_at_ms <= now) {
        const billingId = item.key.at(-1);
        if (typeof billingId !== "string") throw new NativeAuthorityError("paid_pending_key_malformed", 503);
        const request = this._sql.read("paid_request", paid.paidFallbackRequestV3Key(cap.keyId, billingId), now).value;
        if (!request || request.billing_state === "settled" || request.billing_state === "not_billed") {
          this._sql.delete("paid_pending", item.key);
          this._arm(now);
        } else due.push({ requestId: billingId, provider: request.provider, providerRequestId: request.provider_request_id });
      }
    }
    return {
      kind: "claimed",
      lease: token,
      cursor: page.length === args.limit ? this._cursor(cap, "paid_pending", page[page.length - 1].encoded, token) : null,
      detail: due,
    };
  }
  finish(cap: NativeCapability, token: string, now: number): NativeReply {
    const owner = this._sql.read("cursor", [token], now).value,
      leaseKey = paid.paidFallbackReconciliationLeaseV3Key(cap.keyId),
      lease = this._sql.read("paid_lease", leaseKey, now).value;
    if (
      owner?.capabilityId !== cap.id ||
      owner.family !== "paid_lease" ||
      !paid.paidFallbackLeaseOwnedV3(lease, token) ||
      !paid.paidFallbackLeaseActiveV3(lease, now)
    )
      throw new NativeAuthorityError("reconciliation_lease_stale");
    const plan = paid.planPaidFallbackGateAfterScanV3(this._gate(now), this._sql.earliestPaidDue(now));
    this._sql.write("paid_gate", paid.paidFallbackReconciliationGateV3Key(), plan.gate);
    this._sql.delete("paid_lease", leaseKey);
    return { kind: "finished" };
  }
  private _backfillRow(key: NativeKey, request: PaidFallbackRequestV3, now: number): number {
    if (paid.paidFallbackRequestBackfillStateV3(request) === "retention") {
      this._writeRequest(key, request, now + paid.requestRowExpireIn(request, now));
      return 0;
    }
    const id = paid.paidFallbackRequestRollupIdentity(request),
      rollupKey = paid.paidFallbackUsageRollupKey(id.bucketStartAtMs, id.model, id.provider, id.shard),
      old = this._sql.read("paid_rollup", rollupKey, now).value;
    const plan = paid.planPaidFallbackBackfillFoldV3(request, paid.isPaidFallbackUsageRollup(old) ? old : null, now);
    this._writeRequest(key, plan.request, now + plan.requestExpireIn);
    if (!plan.rollup) return 0;
    this._sql.write("paid_rollup", rollupKey, plan.rollup, null);
    return 1;
  }
  backfill(cap: NativeCapability, args: NativeArguments["foldPaidBackfillPage"], now: number): NativeReply {
    const leaseKey = paid.paidFallbackBackfillLeaseV3Key();
    if (paid.paidFallbackLeaseActiveV3(this._sql.read("paid_backfill_lease", leaseKey, now).value, now)) return { kind: "leased" };
    const lease = paid.paidFallbackBackfillLeaseV3(crypto.randomUUID(), now);
    this._sql.write("paid_backfill_lease", leaseKey, lease, lease.expires_at_ms);
    const page = this._sql.page("paid_request", now, this._resume(cap, args.cursor, "paid_backfill", now), args.limit, { scope: cap.keyId });
    let folds = 0;
    for (const item of page) {
      if (item.row.value) folds += this._backfillRow(item.key, item.row.value, now);
    }
    this._sql.delete("paid_backfill_lease", leaseKey);
    return {
      kind: "backfilled",
      cursor: page.length === args.limit ? this._cursor(cap, "paid_backfill", page[page.length - 1].encoded, null) : null,
      detail: { scanned: page.length, folds },
    };
  }
  private _outstanding(keyId: string, now: number) {
    let pendingRequests = 0,
      unresolvedRequests = 0,
      markers = 0,
      after = "";
    for (;;) {
      const page = this._sql.page("paid_request", now, after, 100, { scope: keyId });
      for (const item of page) {
        if (item.row.value?.billing_state === "pending") pendingRequests++;
        if (item.row.value?.billing_state === "unresolved") unresolvedRequests++;
      }
      if (page.length < 100) break;
      after = page[page.length - 1].encoded;
    }
    after = "";
    for (;;) {
      const page = this._sql.page("paid_pending", now, after, 100, { scope: keyId });
      markers += page.length;
      if (page.length < 100) break;
      after = page[page.length - 1].encoded;
    }
    return {
      pending_requests: pendingRequests,
      unresolved_requests: unresolvedRequests,
      pending_markers: markers,
      has_outstanding: pendingRequests + unresolvedRequests + markers > 0,
    };
  }
  deletion(cap: NativeCapability, now: number): NativeReply {
    const guardKey = paid.paidFallbackDeletionGuardV3Key(cap.keyId),
      guard = paid.planPaidFallbackDeletionGuardV3(this._sql.read("paid_deletion_guard", guardKey, now).value, now);
    if (guard) this._sql.write("paid_deletion_guard", guardKey, guard, null, { scope: cap.keyId });
    const outstanding = this._outstanding(cap.keyId, now);
    const decision = paid.planPaidFallbackDeletionV3(outstanding);
    if (decision.kind !== "delete") return { kind: decision.kind, detail: outstanding };
    const deleted: Record<string, number> = {};
    for (const table of ["paid_request", "paid_window", "paid_pending"] as const) {
      let count = 0;
      for (;;) {
        const page = this._sql.page(table, now, "", 100, { scope: cap.keyId });
        for (const item of page) {
          this._sql.delete(table, item.key);
          count++;
        }
        if (page.length < 100) break;
      }
      deleted[table] = count;
    }
    this._sql.delete("paid_lease", paid.paidFallbackReconciliationLeaseV3Key(cap.keyId));
    return { kind: "deleted", detail: deleted };
  }
}

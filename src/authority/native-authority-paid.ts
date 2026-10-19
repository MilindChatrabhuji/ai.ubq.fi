import { selectCodex } from "./native-codex.ts";
import {
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
} from "./native-codex-contracts.ts";
import * as paid from "./native-paid.ts";
import { currentApiKeyUsageWindow } from "./native-api-key.ts";
import type { NativePaidReleasePlan, PaidFallbackRequestV3 } from "./native-paid-contracts.ts";
import {
  NativeAuthorityError,
  nativeApiKeyId,
  type NativeArguments,
  type NativeAttempt,
  type NativeCapability,
  type NativeCursor,
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
    if (row?.principalId !== cap.principalId || row.keyId !== nativeApiKeyId(cap) || row.runtimeBindingId !== cap.id)
      throw new NativeAuthorityError("attempt_ownership_mismatch", 403);
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
    if (cap.keyId === null || cap.tokenHash === null) return null;
    const source = this._sql.currentKeyPolicy(cap.tokenHash, nativeApiKeyId(cap), now);
    if (
      !source?.value ||
      source.value.revoked ||
      source.value.api.key_id !== nativeApiKeyId(cap) ||
      !source.value.api.paid_fallback_enabled ||
      (source.value.api.expires_at_ms !== -1 && source.value.api.expires_at_ms <= now)
    )
      return null;
    return { ...source, value: source.value };
  }
  private _fallbackCurrent(request: NativeRequest, now: number): boolean {
    if (!request.codexProof || request.model === null) return false;
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
  private _fallbackAllowed(request: NativeRequest, now: number): boolean {
    const selection = request.selection;
    return (
      (selection?.kind === "quota_blocked" || selection?.kind === "credentials_invalid") &&
      selection.fullCohortUnavailable === true &&
      this._fallbackCurrent(request, now)
    );
  }
  private _prior(request: NativeRequest, hopId: string, billingId: string, now: number) {
    const prior = this._sql.paidAttempt(nativeApiKeyId(request), billingId, now);
    let blocked: NativeReply | null = null;
    if (prior && (prior.requestHandle !== request.handle || prior.hopId !== hopId)) blocked = { kind: "blocked", detail: "attempt_identity_conflict" };
    else if (prior && !this._request(prior, now).value) blocked = { kind: "blocked", detail: "attempt_retention_expired" };
    return { prior, blocked };
  }
  private _requireAttempt(prior: NativeAttempt | null): NativeAttempt {
    if (!prior) throw new NativeAuthorityError("paid_attempt_lifetime_missing", 503);
    return prior;
  }
  reserve(cap: NativeCapability, args: NativeArguments["reservePaidAttempt"], now: number): NativeReply {
    const request = this._api.validated(cap, args.handle, now),
      hop = this._hop(args.hopId);
    const routingHop = request.routingDecision?.hops.find((candidate) => candidate.hopId === hop.id && candidate.authorization === hop.authorization);
    if (!routingHop) return { kind: "blocked", detail: "request_hop_not_authorized" };
    if (hop.authorization === "codex_unavailable" && !this._fallbackAllowed(request, now))
      return { kind: "blocked", detail: "subscriptions_not_authoritatively_unavailable" };
    const source = this._policy(cap, now);
    if (!source) return { kind: "blocked", detail: "invalid_policy" };
    const policy = source.value,
      unlimited = policy.api.paid_fallback_limit_microcredits === -1;
    if (
      !policy.paid.eligibleModels.includes(routingHop.billingModel) &&
      !(unlimited && policy.paid.allowUnrosteredUnlimited && request.routingDecision?.allowUnrosteredModel === true)
    )
      return { kind: "skip", detail: "model_not_priced" };
    const billingRequestId = `${request.requestId}:${hop.billingSuffix}`;
    const { prior, blocked } = this._prior(request, hop.id, billingRequestId, now);
    if (blocked) return blocked;
    const reset = currentApiKeyUsageWindow(policy.api.usage_reset_at_ms, policy.api.window_ms, request.createdAtMs).reset;
    const input = {
      keyId: nativeApiKeyId(cap),
      requestId: billingRequestId,
      createdAtMs: request.createdAtMs,
      policyVersion: policy.paid.policyVersion,
      limitMicrocredits: policy.api.paid_fallback_limit_microcredits,
      maximumExposureMicrocredits: policy.paid.modelExposure[routingHop.billingModel] ?? null,
      initialSettledMicrocredits: 0,
      quotaPerCredit: policy.paid.quotaPerCredit,
      windowResetAtMs: reset,
      model: routingHop.billingModel,
      route: request.route,
      path: request.path,
      stream: request.stream,
      reasoning: request.reasoning,
      dispatchIntent: true,
    };
    if (paid.isInvalidAdmissionPolicy(input, unlimited, input.maximumExposureMicrocredits)) return { kind: "blocked", detail: "invalid_policy" };
    const requestKey = paid.paidFallbackRequestV3Key(nativeApiKeyId(cap), billingRequestId),
      windowKey = paid.paidFallbackWindowV3Key(nativeApiKeyId(cap), reset);
    const plan = paid.planPaidFallbackAdmissionV3(
      input,
      {
        request: this._sql.read("paid_request", requestKey, now),
        window: this._sql.read("paid_window", windowKey, now),
        deletionGuard: this._sql.read("paid_deletion_guard", paid.paidFallbackDeletionGuardV3Key(nativeApiKeyId(cap)), now),
        policyFence: { versionstamp: source.revision },
      },
      { unlimited, maximumExposure: input.maximumExposureMicrocredits },
      now
    );
    if (plan.kind === "exhausted_policy") {
      this._sql.write("paid_window", windowKey, plan.window, now + plan.windowExpireIn, { scope: nativeApiKeyId(cap) });
      return { kind: "blocked", detail: "limit_exceeded" };
    }
    if (plan.kind === "blocked") return { kind: plan.kind, detail: plan.reason };
    if (plan.kind === "reserved") {
      return { kind: "reserved", attemptHandle: this._requireAttempt(prior).handle, detail: plan.reservation };
    }
    this._writeRequest(requestKey, plan.request, now + plan.requestExpireIn);
    this._sql.write("paid_pending", paid.paidFallbackPendingV3Key(nativeApiKeyId(cap), billingRequestId), plan.pending, null, {
      scope: nativeApiKeyId(cap),
      due: plan.pending.next_reconciliation_at_ms,
    });
    if (plan.checkGate) this._arm(now);
    if (plan.window && plan.windowExpireIn !== null)
      this._sql.write("paid_window", windowKey, plan.window, now + plan.windowExpireIn, { scope: nativeApiKeyId(cap) });
    const handle = crypto.randomUUID();
    this._saveAttempt({
      handle,
      requestHandle: request.handle,
      principalId: cap.principalId,
      runtimeBindingId: cap.id,
      keyId: nativeApiKeyId(cap),
      hopId: hop.id,
      billingRequestId,
      windowResetAtMs: reset,
      fetchStarted: false,
    });
    return { kind: "reserved", attemptHandle: handle, detail: plan.reservation };
  }
  private _expedite(attempt: NativeAttempt, now: number): void {
    const key = paid.paidFallbackPendingV3Key(attempt.keyId, attempt.billingRequestId);
    const pending = this._sql.read("paid_pending", key, now).value;
    if (!pending) return;
    const markerNeedsExpedite = pending.next_reconciliation_at_ms > now;
    if (!markerNeedsExpedite && !paid.paidFallbackReconciliationGateNeedsArm(this._gate(now), now)) return;
    if (markerNeedsExpedite) this._sql.write("paid_pending", key, { ...pending, next_reconciliation_at_ms: now }, null, { scope: attempt.keyId, due: now });
    this._arm(now);
  }
  response(cap: NativeCapability, attemptHandle: string, now: number) {
    const attempt = this.attempt(cap, attemptHandle, now);
    return { attempt, provider: this._hop(attempt.hopId).ledgerProvider };
  }
  assertStart(cap: NativeCapability, args: NativeArguments["recordTransportStarted"], now: number): NativeAttempt | null {
    if (!args.attemptHandle) {
      if (args.provider === "metered" || args.provider === "surplus") throw new NativeAuthorityError("paid_transport_attempt_required", 403);
      return null;
    }
    const { attempt, provider } = this.response(cap, args.attemptHandle, now);
    if (attempt.requestHandle !== args.handle || provider !== args.provider) throw new NativeAuthorityError("transport_attempt_mismatch", 403);
    const row = this._request(attempt, now).value;
    if (row?.billing_state !== "pending" || row.terminal_state !== "pending") throw new NativeAuthorityError("paid_attempt_not_dispatchable");
    return attempt;
  }
  start(cap: NativeCapability, args: NativeArguments["recordTransportStarted"], now: number): void {
    const attempt = this.assertStart(cap, args, now);
    if (!attempt) return;
    this.lifecycle(cap, { attemptHandle: attempt.handle, patch: {}, fetchStarted: true }, now);
  }
  private _assertFetchStart(cap: NativeCapability, attempt: NativeAttempt, fetchStarted: boolean | undefined, now: number): void {
    if (fetchStarted && !attempt.fetchStarted && !this._policy(cap, now)) throw new NativeAuthorityError("api_policy_revoked", 403);
  }
  lifecycle(cap: NativeCapability, args: NativeArguments["recordPaidAttemptLifecycle"], now: number): NativeReply {
    const attempt = this.attempt(cap, args.attemptHandle, now),
      hop = this._hop(attempt.hopId),
      entry = this._request(attempt, now);
    this._assertFetchStart(cap, attempt, args.fetchStarted, now);
    if (!entry.value) return { kind: "missing" };
    const plan = paid.planPaidFallbackLifecycleV3(
      entry.value,
      { ...args.patch, ...(args.patch.terminal_state === undefined ? {} : { increment_reconciliation_attempts: true }), provider: hop.ledgerProvider },
      now
    );
    if (plan) {
      this._writeRequest(paid.paidFallbackRequestV3Key(nativeApiKeyId(cap), attempt.billingRequestId), plan.request, now + plan.requestExpireIn);
      if (plan.readGate && (plan.dispatchBoundary || paid.paidFallbackReconciliationGateNeedsArm(this._gate(now), now))) this._arm(now);
    }
    if (args.fetchStarted) {
      this._saveAttempt({ ...attempt, fetchStarted: true });
      const original = this._api.request(cap, attempt.requestHandle, now);
      if (original.dispatch) this._api.save({ ...original, dispatch: { ...original.dispatch, fetchStarted: true } });
    }
    const observed = plan?.request ?? entry.value;
    if (observed.terminal_state !== "pending") this._expedite(attempt, now);
    const providerTerminal = args.patch.terminal_state !== undefined && args.patch.terminal_state !== "pending";
    if (observed.provider_request_id !== null || providerTerminal || args.fetchStarted) {
      const original = this._api.request(cap, attempt.requestHandle, now);
      if (original.semantic === null)
        this._api.save({ ...original, providerObserved: true, responding: { provider: hop.ledgerProvider, attemptHandle: attempt.handle } });
    }
    return { kind: plan ? "updated" : "unchanged", detail: observed };
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
    const original = this._api.request(cap, attempt.requestHandle, now);
    const current = this._request(attempt, now).value;
    const stillBillable = current?.billing_state === "pending" || current?.billing_state === "unresolved";
    if (
      stillBillable &&
      (attempt.fetchStarted ||
        current.terminal_state !== "pending" ||
        original.semantic !== null ||
        (original.delivery !== null && original.delivery !== "unobserved"))
    )
      throw new NativeAuthorityError("paid_fetch_may_have_started");
    const plan = paid.planPaidFallbackReleaseV3(
      {
        request: this._request(attempt, now),
        window: this._sql.read("paid_window", paid.paidFallbackWindowV3Key(nativeApiKeyId(cap), attempt.windowResetAtMs), now),
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
      pendingKey = paid.paidFallbackPendingV3Key(nativeApiKeyId(cap), attempt.billingRequestId);
    const plan = paid.planPaidFallbackDeferralV3(this._request(attempt, now).value, this._sql.read("paid_pending", pendingKey, now).value, now);
    if (plan.kind === "cleanup") this._cleanup(attempt, now);
    if (plan.kind === "write") {
      this._writeRequest(paid.paidFallbackRequestV3Key(nativeApiKeyId(cap), attempt.billingRequestId), plan.request, now + plan.requestExpireIn);
      this._sql.write("paid_pending", pendingKey, plan.pending, null, { scope: nativeApiKeyId(cap), due: plan.pending.next_reconciliation_at_ms });
    }
    return { kind: plan.kind, detail: plan };
  }
  billing(cap: NativeCapability, args: NativeArguments["recordVerifiedPaidBilling"], now: number): NativeReply {
    const attempt = this.attempt(cap, args.attemptHandle, now),
      hop = this._hop(attempt.hopId),
      request = this._request(attempt, now),
      pending = this._sql.read("paid_pending", paid.paidFallbackPendingV3Key(nativeApiKeyId(cap), attempt.billingRequestId), now);
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
        window: this._sql.read("paid_window", paid.paidFallbackWindowV3Key(nativeApiKeyId(cap), attempt.windowResetAtMs), now),
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
    if (!this._ownsCursor(cap, row) || row.family !== family) throw new NativeAuthorityError("cursor_ownership_mismatch", 403);
    return row.after;
  }
  private _ownsCursor(cap: NativeCapability, row: NativeCursor | null): row is NativeCursor {
    if (row?.capabilityId !== cap.id || row.parent !== nativeApiKeyId(cap)) return false;
    if (cap.retainedRequestHandles === null) return row.retainedGrantId === undefined && row.retainedHandles === undefined;
    return (
      row.retainedGrantId === cap.runtimeGrantId &&
      row.retainedHandles?.length === cap.retainedRequestHandles.length &&
      row.retainedHandles.every((handle, index) => handle === cap.retainedRequestHandles?.[index])
    );
  }
  private _cursorScope(cap: NativeCapability): Pick<NativeCursor, "retainedGrantId" | "retainedHandles"> {
    return cap.retainedRequestHandles === null ? {} : { retainedGrantId: cap.runtimeGrantId, retainedHandles: cap.retainedRequestHandles };
  }
  private _cursor(cap: NativeCapability, family: string, after: string, lease: string | null): string {
    const id = crypto.randomUUID();
    this._sql.write("cursor", [id], { id, capabilityId: cap.id, family, after, parent: nativeApiKeyId(cap), lease, ...this._cursorScope(cap) });
    return id;
  }
  private _dueAttempt(cap: NativeCapability, billingId: string, now: number) {
    const attempt = this._sql.paidAttempt(nativeApiKeyId(cap), billingId, now);
    if (
      cap.retainedRequestHandles !== null &&
      (attempt?.principalId !== cap.principalId || attempt.runtimeBindingId !== cap.id || !cap.retainedRequestHandles.includes(attempt.requestHandle))
    )
      return null;
    const request = this._sql.read("paid_request", paid.paidFallbackRequestV3Key(nativeApiKeyId(cap), billingId), now).value;
    if (!request || request.billing_state === "settled" || request.billing_state === "not_billed") {
      this._sql.delete("paid_pending", paid.paidFallbackPendingV3Key(nativeApiKeyId(cap), billingId));
      this._arm(now);
      return null;
    }
    if (!attempt) throw new NativeAuthorityError("paid_attempt_lifetime_missing", 503);
    if (attempt.principalId !== cap.principalId || attempt.runtimeBindingId !== cap.id) return null;
    if (cap.retainedRequestHandles !== null && !cap.retainedRequestHandles.includes(attempt.requestHandle)) return null;
    this.attempt(cap, attempt.handle, now);
    return {
      attemptHandle: attempt.handle,
      requestHandle: attempt.requestHandle,
      requestId: billingId,
      provider: request.provider,
      providerRequestId: request.provider_request_id,
    };
  }
  claim(cap: NativeCapability, args: NativeArguments["claimPaidReconciliation"], now: number): NativeReply {
    const leaseKey = paid.paidFallbackReconciliationLeaseV3Key(nativeApiKeyId(cap)),
      prior = this._sql.read("paid_lease", leaseKey, now).value;
    if (paid.paidFallbackLeaseActiveV3(prior, now)) return { kind: "leased" };
    const token = crypto.randomUUID(),
      lease = paid.paidFallbackReconciliationLeaseV3(token, now);
    this._sql.write("paid_lease", leaseKey, lease, lease.expires_at_ms, { scope: nativeApiKeyId(cap) });
    this._sql.write("cursor", [token], {
      id: token,
      capabilityId: cap.id,
      family: "paid_lease",
      after: "",
      parent: nativeApiKeyId(cap),
      lease: token,
      ...this._cursorScope(cap),
    });
    const page = this._sql.page("paid_pending", now, this._resume(cap, args.cursor, "paid_pending", now), args.limit, { scope: nativeApiKeyId(cap) });
    const due = [];
    for (const item of page) {
      if (item.row.value && item.row.value.next_reconciliation_at_ms <= now) {
        const billingId = item.key.at(-1);
        if (typeof billingId !== "string") throw new NativeAuthorityError("paid_pending_key_malformed", 503);
        const entry = this._dueAttempt(cap, billingId, now);
        if (entry) due.push(entry);
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
      leaseKey = paid.paidFallbackReconciliationLeaseV3Key(nativeApiKeyId(cap)),
      lease = this._sql.read("paid_lease", leaseKey, now).value;
    if (
      !this._ownsCursor(cap, owner) ||
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
    const page = this._sql.page("paid_request", now, this._resume(cap, args.cursor, "paid_backfill", now), args.limit, { scope: nativeApiKeyId(cap) });
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
  deleteForKey(keyId: string, now: number) {
    const guardKey = paid.paidFallbackDeletionGuardV3Key(keyId),
      guard = paid.planPaidFallbackDeletionGuardV3(this._sql.read("paid_deletion_guard", guardKey, now).value, now);
    if (guard) this._sql.write("paid_deletion_guard", guardKey, guard, null, { scope: keyId });
    const outstanding = this._outstanding(keyId, now);
    const decision = paid.planPaidFallbackDeletionV3(outstanding);
    if (decision.kind !== "delete") return { kind: "blocked" as const, outstanding };
    const deleted: Record<string, number> = {};
    for (const table of ["paid_request", "paid_window", "paid_pending"] as const) {
      let count = 0;
      for (;;) {
        const page = this._sql.page(table, now, "", 100, { scope: keyId });
        for (const item of page) {
          this._sql.delete(table, item.key);
          count++;
        }
        if (page.length < 100) break;
      }
      deleted[table] = count;
    }
    this._sql.delete("paid_lease", paid.paidFallbackReconciliationLeaseV3Key(keyId));
    return { kind: "deleted" as const, deleted };
  }
  deletion(cap: NativeCapability, now: number): NativeReply {
    const result = this.deleteForKey(nativeApiKeyId(cap), now);
    return { kind: result.kind, detail: result.kind === "blocked" ? result.outstanding : result.deleted };
  }
}

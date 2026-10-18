import {
  lookup,
  AuthorityError,
  assertAmount,
  sameEvidence,
  sameScope,
  type AccountBinding,
  type AccountProof,
  type AdmissionHandle,
  type AdmissionRecord,
  type AdmitInput,
  type AttemptInput,
  type AuthorityScope,
  type AuthorityState,
  type AuthorityStore,
  type DeliveryOutcome,
  type PrincipalPolicy,
  type PrincipalWindow,
  type TerminalEvidence,
} from "./contracts.ts";

const emptyWindow = (): PrincipalWindow => ({
  reserved: 0,
  dispatched: 0,
  kernelReserved: 0,
  kernelCompleted: 0,
  active: 0,
  paidReservedMicrocredits: 0,
  paidSettledMicrocredits: 0,
});
export const createAuthorityState = (scope: AuthorityScope, accounts: readonly AccountBinding[], policies: readonly PrincipalPolicy[]): AuthorityState => ({
  scope,
  accounts: structuredClone([...accounts]),
  policies: Object.fromEntries(policies.map((policy) => [policy.principalId, policy])),
  sequence: 0,
  active: null,
  windows: {},
  admissions: {},
  publications: {},
});
const applicableProof = (account: AccountBinding, model: string, now: number): AccountProof | null => {
  const proof = account.proof;
  return proof?.fingerprint === account.fingerprint && proof.model === model && proof.observedAtMs <= now && proof.validUntilMs > now ? proof : null;
};
const cohort = (state: AuthorityState, model: string): AccountBinding[] =>
  state.accounts.filter((account) => account.enabled && account.models.includes(model));
const unavailable = (account: AccountBinding, model: string, now: number): boolean => {
  const proof = applicableProof(account, model, now);
  return proof?.kind === "quota_exhausted" || proof?.kind === "credential_invalid";
};
const selectAccount = (state: AuthorityState, model: string, now: number): AccountBinding | null => {
  const selected = cohort(state, model);
  const current = state.accounts.find((account) => account.enabled && account.accountId === state.active?.accountId);
  if (current) {
    // Missing model support or a transient circuit never retires the global account.
    if (!current.models.includes(model)) throw new AuthorityError("active_model_unavailable", 503);
    const proof = applicableProof(current, model, now);
    if (proof?.kind === "transient") throw new AuthorityError("routing_unavailable", 503);
    if (!unavailable(current, model, now)) {
      state.active = { accountId: current.accountId, fingerprint: current.fingerprint, generation: state.active?.generation ?? 1 };
      return current;
    }
  }
  const next = selected.find((account) => applicableProof(account, model, now) === null);
  if (next) {
    state.active = { accountId: next.accountId, fingerprint: next.fingerprint, generation: (state.active?.generation ?? 0) + 1 };
    return next;
  }
  if (selected.length === 0 || !selected.every((account) => unavailable(account, model, now))) throw new AuthorityError("routing_unavailable", 503);
  return null;
};

const reserveSubscription = (state: AuthorityState, request: AdmissionRecord, input: AttemptInput, nowMs: number): void => {
  if (!input.account || !sameEvidence(input.account, request.account) || input.maximumExposureMicrocredits !== 0)
    throw new AuthorityError("account_fence_mismatch");
  const current = state.accounts.find((account) => account.accountId === input.account?.accountId);
  if (
    !current ||
    !state.active ||
    !sameEvidence(current, input.account) ||
    state.active.generation !== (request.activeGeneration ?? undefined) ||
    state.active.accountId !== current.accountId
  )
    throw new AuthorityError("account_fence_mismatch");
  if (applicableProof(current, request.model, nowMs) !== null) throw new AuthorityError("routing_unavailable", 503);
};

const reservePaid = (state: AuthorityState, request: AdmissionRecord, input: AttemptInput, policy: PrincipalPolicy, nowMs: number): void => {
  if (input.account !== null) throw new AuthorityError("paid_account_binding_forbidden");
  const selected = cohort(state, request.model);
  if (selected.length === 0 || !selected.every((account) => unavailable(account, request.model, nowMs)))
    throw new AuthorityError("paid_pool_proof_required", 503);
  const paid = Object.values(request.attempts).filter((attempt) => attempt.input.provider !== "codex");
  if (input.provider === "surplus" && paid.length !== 0) throw new AuthorityError("provider_order_conflict");
  if (input.provider === "openlux" && (paid.length !== 1 || paid[0].input.provider !== "surplus" || !paid[0].terminal?.fallback))
    throw new AuthorityError("paid_capacity_proof_required", 503);
  const window = state.windows[request.windowKey];
  if (window.paidReservedMicrocredits + window.paidSettledMicrocredits + input.maximumExposureMicrocredits > policy.paidLimitMicrocredits)
    throw new AuthorityError("paid_limit_exceeded", 429);
  window.paidReservedMicrocredits += input.maximumExposureMicrocredits;
};

/** A transaction protocol, not a live storage adapter or an independent Worker ledger. */
export class PortableAuthority {
  constructor(
    private readonly _store: AuthorityStore,
    private readonly _scope: AuthorityScope
  ) {}

  private async _transact<T>(scope: AuthorityScope, action: (state: AuthorityState) => T): Promise<T> {
    if (!sameScope(scope, this._scope)) throw new AuthorityError("namespace_or_epoch_mismatch", 403);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await this._store.read();
      if (!sameScope(snapshot.state.scope, scope)) throw new AuthorityError("namespace_or_epoch_mismatch", 403);
      const state = structuredClone(snapshot.state);
      const result = action(state);
      // Even unchanged admissions linearize against the entire strong snapshot.
      if (await this._store.compareAndSwap(snapshot.revision, state)) return result;
    }
    throw new AuthorityError("concurrent_update", 503);
  }

  private _request(state: AuthorityState, handle: AdmissionHandle): AdmissionRecord {
    const request = lookup(state.admissions, handle.requestId);
    if (request?.handle.fence !== handle.fence) throw new AuthorityError("admission_fence_mismatch");
    return request;
  }

  async admit(input: AdmitInput): Promise<AdmissionHandle> {
    return await this._transact(input.scope, (state) => {
      const previous = lookup(state.admissions, input.requestId);
      if (previous) {
        if (
          previous.digest !== input.digest ||
          previous.principalId !== input.principalId ||
          previous.model !== input.model ||
          previous.route !== input.route ||
          previous.policyVersion !== input.policyVersion
        )
          throw new AuthorityError("request_identity_conflict");
        return previous.handle;
      }
      const policy = lookup(state.policies, input.principalId);
      if (!policy || policy.deleted || policy.version !== input.policyVersion) throw new AuthorityError("principal_policy_changed", 403);
      if (policy.windowResetAtMs <= input.nowMs) throw new AuthorityError("quota_window_requires_refresh", 503);
      for (const amount of [policy.requestLimit, policy.kernelLimit, policy.concurrencyLimit, policy.paidLimitMicrocredits]) assertAmount(amount);
      const windowKey = JSON.stringify([input.principalId, policy.windowResetAtMs]);
      const window = (state.windows[windowKey] ??= emptyWindow());
      const active = Object.values(state.admissions).filter((request) => request.principalId === input.principalId && !request.settled).length;
      if (
        window.reserved + window.dispatched >= policy.requestLimit ||
        window.kernelReserved + window.kernelCompleted >= policy.kernelLimit ||
        active >= policy.concurrencyLimit
      )
        throw new AuthorityError("principal_quota_exceeded", 429);
      const account = selectAccount(state, input.model, input.nowMs);
      const handle: AdmissionHandle = { scope: input.scope, requestId: input.requestId, fence: ++state.sequence };
      state.admissions[input.requestId] = {
        handle,
        principalId: input.principalId,
        policyVersion: input.policyVersion,
        windowKey,
        digest: input.digest,
        route: input.route,
        model: input.model,
        account,
        activeGeneration: state.active?.generation ?? null,
        attempts: {},
        dispatched: false,
        semantic: null,
        kernelSettled: false,
        delivery: null,
        settled: false,
      };
      window.reserved += 1;
      window.kernelReserved += 1;
      window.active += 1;
      return handle;
    });
  }

  async reserveAttempt(handle: AdmissionHandle, input: AttemptInput, nowMs: number): Promise<void> {
    assertAmount(input.maximumExposureMicrocredits);
    await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      if (request.settled || request.semantic !== null) throw new AuthorityError("admission_closed");
      const existing = lookup(request.attempts, input.attemptId);
      if (existing) {
        if (!sameEvidence(existing.input, input)) throw new AuthorityError("attempt_identity_conflict");
        return;
      }
      if (Object.values(request.attempts).some((attempt) => attempt.state !== "not_dispatched" && attempt.terminal === null))
        throw new AuthorityError("attempt_outcome_pending");
      const policy = lookup(state.policies, request.principalId);
      if (!policy || policy.deleted || policy.version !== request.policyVersion) throw new AuthorityError("principal_policy_changed", 403);
      if (policy.windowResetAtMs <= nowMs || request.windowKey !== JSON.stringify([request.principalId, policy.windowResetAtMs]))
        throw new AuthorityError("quota_window_changed", 409);
      if (input.provider === "codex") reserveSubscription(state, request, input, nowMs);
      else reservePaid(state, request, input, policy, nowMs);
      request.attempts[input.attemptId] = { input, state: "reserved", terminal: null, billingSettled: false, settledSpendMicrocredits: null };
    });
  }

  async beginDispatch(handle: AdmissionHandle, attemptId: string, nowMs: number): Promise<boolean> {
    return await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      const attempt = lookup(request.attempts, attemptId);
      if (!attempt) throw new AuthorityError("attempt_missing");
      if (attempt.state !== "reserved") return false;
      const policy = lookup(state.policies, request.principalId);
      if (!policy || policy.deleted || policy.version !== request.policyVersion || request.settled) throw new AuthorityError("principal_policy_changed", 403);
      if (policy.windowResetAtMs <= nowMs || request.windowKey !== JSON.stringify([request.principalId, policy.windowResetAtMs]))
        throw new AuthorityError("quota_window_changed", 409);
      if (attempt.input.account) {
        const current = state.accounts.find((account) => account.accountId === attempt.input.account?.accountId);
        if (!sameEvidence(current, attempt.input.account) || state.active?.generation !== (request.activeGeneration ?? undefined))
          throw new AuthorityError("account_fence_mismatch");
      } else {
        const selected = cohort(state, request.model);
        if (selected.length === 0 || !selected.every((account) => unavailable(account, request.model, nowMs)))
          throw new AuthorityError("paid_pool_proof_required", 503);
      }
      // Persist intent first. A crash after this point remains indeterminate, never replayable/refundable.
      attempt.state = "dispatch_intent";
      return true;
    });
  }

  async selection(handle: AdmissionHandle): Promise<Readonly<{ account: AccountBinding | null; model: string; route: AdmissionRecord["route"] }>> {
    return await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      return { account: request.account, model: request.model, route: request.route };
    });
  }

  /** Move a completed subscription hop without opening another principal admission. */
  async reselectSubscription(handle: AdmissionHandle, nowMs: number): Promise<AccountBinding | null> {
    return await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      if (request.settled || request.semantic !== null) throw new AuthorityError("admission_closed");
      const attempts = Object.values(request.attempts);
      if (attempts.some((attempt) => attempt.input.provider !== "codex")) throw new AuthorityError("provider_order_conflict");
      if (
        !attempts.some((attempt) => attempt.state === "dispatched" && sameEvidence(attempt.input.account, request.account)) ||
        attempts.some((attempt) => attempt.state !== "not_dispatched" && (attempt.state !== "dispatched" || attempt.terminal === null))
      )
        throw new AuthorityError("attempt_outcome_pending");
      const policy = lookup(state.policies, request.principalId);
      if (!policy || policy.deleted || policy.version !== request.policyVersion) throw new AuthorityError("principal_policy_changed", 403);
      if (policy.windowResetAtMs <= nowMs || request.windowKey !== JSON.stringify([request.principalId, policy.windowResetAtMs]))
        throw new AuthorityError("quota_window_changed");
      const binding = request.account;
      const current = state.accounts.find((account) => account.accountId === binding?.accountId);
      // Proof is the only captured field that an observation may change before reselection.
      if (!binding || !current || !sameEvidence({ ...current, proof: binding.proof }, binding)) throw new AuthorityError("account_fence_mismatch");
      if (!unavailable(current, request.model, nowMs)) throw new AuthorityError("subscription_proof_required", 503);
      request.account = selectAccount(state, request.model, nowMs);
      request.activeGeneration = state.active?.generation ?? null;
      return request.account;
    });
  }

  async confirmDispatched(handle: AdmissionHandle, attemptId: string): Promise<void> {
    await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      const attempt = lookup(request.attempts, attemptId);
      if (!attempt || (attempt.state !== "dispatch_intent" && attempt.state !== "dispatched")) throw new AuthorityError("dispatch_state_conflict");
      attempt.state = "dispatched";
      if (!request.dispatched) {
        request.dispatched = true;
        state.windows[request.windowKey].reserved -= 1;
        state.windows[request.windowKey].dispatched += 1;
      }
    });
  }

  async releaseBeforeDispatch(handle: AdmissionHandle, attemptId: string): Promise<void> {
    await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      const attempt = lookup(request.attempts, attemptId);
      if (!attempt || attempt.state === "not_dispatched") return;
      if (attempt.state !== "reserved") throw new AuthorityError("dispatch_indeterminate");
      attempt.state = "not_dispatched";
      state.windows[request.windowKey].paidReservedMicrocredits -= attempt.input.maximumExposureMicrocredits;
    });
  }

  async observeProof(handle: AdmissionHandle, attemptId: string, proof: AccountProof): Promise<void> {
    if (!Number.isSafeInteger(proof.observedAtMs) || !Number.isSafeInteger(proof.validUntilMs) || proof.validUntilMs <= proof.observedAtMs)
      throw new AuthorityError("invalid_proof", 400);
    await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      if (lookup(request.attempts, attemptId)?.state !== "dispatched") throw new AuthorityError("proof_without_dispatch");
      const binding = lookup(request.attempts, attemptId)?.input.account;
      const index = state.accounts.findIndex((account) => account.accountId === binding?.accountId);
      const current = state.accounts.find((account) => account.accountId === binding?.accountId);
      if (
        !binding ||
        current?.fingerprint !== binding.fingerprint ||
        current.credentialGeneration !== binding.credentialGeneration ||
        current.routingGeneration !== binding.routingGeneration ||
        current.resetGeneration !== binding.resetGeneration ||
        current.overageVersion !== binding.overageVersion ||
        proof.fingerprint !== current.fingerprint ||
        proof.model !== request.model
      )
        throw new AuthorityError("proof_fence_mismatch");
      if (current.proof && proof.observedAtMs < current.proof.observedAtMs) throw new AuthorityError("stale_proof");
      state.accounts[index] = { ...current, proof };
    });
  }

  async observeTerminal(handle: AdmissionHandle, attemptId: string, evidence: TerminalEvidence, finalAttempt = true): Promise<void> {
    if (evidence.spendMicrocredits !== null) assertAmount(evidence.spendMicrocredits);
    await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      const attempt = lookup(request.attempts, attemptId);
      if (attempt?.state !== "dispatched") throw new AuthorityError("terminal_without_dispatch");
      if (attempt.terminal && !sameEvidence(attempt.terminal, evidence)) throw new AuthorityError("terminal_evidence_conflict");
      if (finalAttempt && request.semantic && request.semantic !== evidence.outcome) throw new AuthorityError("terminal_evidence_conflict");
      attempt.terminal = evidence;
      if (finalAttempt) {
        request.semantic = evidence.outcome;
        if (!request.kernelSettled) {
          state.windows[request.windowKey].kernelReserved -= 1;
          if (evidence.outcome === "completed") state.windows[request.windowKey].kernelCompleted += 1;
          request.kernelSettled = true;
        }
      }
      if (!attempt.billingSettled && evidence.spendMicrocredits !== null) {
        const window = state.windows[request.windowKey];
        window.paidReservedMicrocredits -= attempt.input.maximumExposureMicrocredits;
        // Preserve authoritative actual spend even when it exceeds admitted exposure.
        if (attempt.input.provider !== "codex") window.paidSettledMicrocredits += evidence.spendMicrocredits;
        attempt.billingSettled = true;
        attempt.settledSpendMicrocredits = evidence.spendMicrocredits;
      }
    });
  }

  async observeDelivery(handle: AdmissionHandle, outcome: DeliveryOutcome): Promise<void> {
    await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      if (request.delivery && request.delivery !== "unobserved" && request.delivery !== outcome) throw new AuthorityError("delivery_evidence_conflict");
      if (outcome !== "unobserved" || request.delivery === null) request.delivery = outcome;
    });
  }

  async observeUsage(handle: AdmissionHandle, attemptId: string, usage: Readonly<{ providerRequestId: string; spendMicrocredits: number }>): Promise<void> {
    assertAmount(usage.spendMicrocredits);
    await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      const attempt = lookup(request.attempts, attemptId);
      if (
        attempt?.state !== "dispatched" ||
        !attempt.terminal ||
        attempt.input.provider === "codex" ||
        attempt.terminal.providerRequestId !== usage.providerRequestId
      )
        throw new AuthorityError("usage_correlation_mismatch");
      if (attempt.billingSettled) {
        if (attempt.settledSpendMicrocredits !== usage.spendMicrocredits) throw new AuthorityError("usage_evidence_conflict");
        return;
      }
      attempt.billingSettled = true;
      attempt.settledSpendMicrocredits = usage.spendMicrocredits;
      const window = state.windows[request.windowKey];
      window.paidReservedMicrocredits -= attempt.input.maximumExposureMicrocredits;
      window.paidSettledMicrocredits += usage.spendMicrocredits;
    });
  }

  async resetEligible(handle: AdmissionHandle, nowMs: number): Promise<boolean> {
    return await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      const selected = cohort(state, request.model);
      return selected.length > 0 && selected.every((account) => applicableProof(account, request.model, nowMs)?.kind === "quota_exhausted");
    });
  }

  async settle(handle: AdmissionHandle): Promise<"settled" | "pending"> {
    return await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      if (request.settled) return "settled";
      // Worker EOF records unobserved delivery. It never fabricates a native finish receipt.
      if (request.semantic === null || request.delivery === null) return "pending";
      const attempts = Object.values(request.attempts);
      if (
        attempts.some((attempt) => attempt.state === "reserved" || attempt.state === "dispatch_intent" || (attempt.state === "dispatched" && !attempt.terminal))
      )
        return "pending";
      const window = state.windows[request.windowKey];
      if (!request.dispatched) window.reserved -= 1;
      if (!request.kernelSettled) {
        window.kernelReserved -= 1;
        if (request.semantic === "completed") window.kernelCompleted += 1;
        request.kernelSettled = true;
      }
      window.active -= 1;
      request.settled = true;
      return "settled";
    });
  }

  async cancelUndispatched(handle: AdmissionHandle): Promise<void> {
    await this._transact(handle.scope, (state) => {
      const request = this._request(state, handle);
      if (Object.values(request.attempts).some((attempt) => attempt.state === "dispatch_intent" || attempt.state === "dispatched"))
        throw new AuthorityError("dispatch_indeterminate");
      for (const attempt of Object.values(request.attempts)) {
        if (attempt.state === "reserved") state.windows[request.windowKey].paidReservedMicrocredits -= attempt.input.maximumExposureMicrocredits;
        attempt.state = "not_dispatched";
      }
      request.semantic ??= "cancelled";
      request.delivery ??= "interrupted";
    });
    await this.settle(handle);
  }
}

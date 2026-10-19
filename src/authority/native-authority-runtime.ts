import { apiKeyHashKey, apiKeyIdKey } from "../api-keys.ts";
import { apiKeyHashRecordFor } from "./native-api-key-policy.ts";
import {
  NativeAuthorityError,
  nativeObject,
  type NativeCapability,
  type NativeCommand,
  type NativeReply,
  type NativeRequest,
} from "./native-authority-contracts.ts";
import { NativeAuthorityApi } from "./native-authority-api.ts";
import { NativeAuthoritySql } from "./native-authority-sql.ts";
import { NATIVE_METHOD_ROLES, nativeCommandBytes } from "./native-authority-rpc.ts";
import {
  NATIVE_RUNTIME_REVISION,
  NATIVE_RETAINED_METHODS,
  type NativeRetainedHistoryBinding,
  type NativeRetainedHistoryGrant,
  type VerifiedNativeRetainedHistory,
  type NativeRuntimeAuthorization,
  type NativeRuntimeBinding,
  type NativeRuntimeInitial,
  type NativeRuntimeIdentity,
  type NativeRuntimeGrant,
  type NativeTrustedRoutingDecision,
  type NativeValidatedRequest,
} from "./native-runtime-contracts.ts";

const principal = (identity: NativeRuntimeIdentity): string => {
  switch (identity.kind) {
    case "kv_api_key":
    case "local_development_key":
      return "api-key:" + identity.keyId;
    case "github_token":
      return "github-repo:" + identity.owner.toLowerCase() + "/" + identity.repo.toLowerCase();
    case "passkey_session":
      return "passkey-user:" + identity.userId;
    case "disabled_local":
      return identity.bearerDigest ?? "local-auth-disabled";
    case "auth_tokens_allowlist":
    case "admin_allowlist":
    case "deno_deploy_token":
      return "auth-method:" + identity.kind;
    default:
      throw new NativeAuthorityError("runtime_identity_invalid", 403);
  }
};
const validRuntimeGrant = (value: unknown): value is NativeRuntimeGrant =>
  nativeObject(value) &&
  value.revision === NATIVE_RUNTIME_REVISION &&
  typeof value.id === "string" &&
  typeof value.epoch === "string" &&
  typeof value.subjectId === "string" &&
  typeof value.contextBinding === "string" &&
  typeof value.revoked === "boolean" &&
  Number.isSafeInteger(value.expiresAtMs) &&
  Array.isArray(value.roles) &&
  value.roles.length > 0 &&
  value.roles.every((role: unknown) => typeof role === "string" && Object.values(NATIVE_METHOD_ROLES).some((known) => known === role));
const validRetainedGrant = (value: unknown): value is NativeRetainedHistoryGrant => {
  if (!nativeObject(value)) return false;
  const scope = value;
  return (
    validRuntimeGrant(value) &&
    value.roles.every((role) => ["transport", "billing", "reconcile"].includes(role)) &&
    [scope.namespace, scope.originalBindingId, scope.originalPrincipalId, scope.keyId].every((field) => typeof field === "string" && field.length > 0) &&
    Array.isArray(scope.requestHandles) &&
    scope.requestHandles.length > 0 &&
    scope.requestHandles.length <= 100 &&
    scope.requestHandles.every((handle: unknown) => typeof handle === "string" && handle.length > 0) &&
    new Set(scope.requestHandles).size === scope.requestHandles.length
  );
};
/** Only the constructor-private source verifier constructs authenticated runtime bindings. */
export class NativeAuthorityRuntime {
  constructor(
    private readonly _sql: NativeAuthoritySql,
    private readonly _api: NativeAuthorityApi,
    private readonly _initial: NativeRuntimeInitial
  ) {}
  initialize(): void {
    for (const grant of this._initial.retainedHistory?.grants ?? []) {
      if (!validRetainedGrant(grant) || grant.epoch !== this._sql.epoch || grant.namespace !== this._sql.namespace)
        throw new NativeAuthorityError("invalid_retained_history_grant", 500);
      this._sql.write("retained_history_grant", [grant.id], grant);
    }
    for (const grant of this._initial.grants) {
      if (!validRuntimeGrant(grant) || grant.epoch !== this._sql.epoch) throw new NativeAuthorityError("invalid_runtime_grant", 500);
      this._sql.write("runtime_grant", [grant.id], grant);
    }
    for (const { record, hashRecord } of this._initial.records) {
      if (nativeCommandBytes(apiKeyHashRecordFor(record)) !== nativeCommandBytes(hashRecord))
        throw new NativeAuthorityError("runtime_source_record_mismatch", 500);
      this._sql.write("api_key_id", apiKeyIdKey(record.id), record);
      this._sql.write("api_key_hash", apiKeyHashKey(record.hash), hashRecord);
      const projection = this._sql.read("api_policy", apiKeyHashKey(record.hash), 0).value;
      if (projection?.api.key_id !== record.id) throw new NativeAuthorityError("runtime_source_projection_missing", 500);
      this._sql.write("api_policy", apiKeyHashKey(record.hash), { ...projection, rawSource: true });
    }
  }
  async verify(binding: NativeRuntimeBinding, intent: string, now: number): Promise<NativeRuntimeAuthorization> {
    const verified = await this._initial.verifier.verify(binding.privateContext, intent, now);
    if (verified.intentDigest !== intent || verified.contextBinding !== binding.contextBinding)
      throw new NativeAuthorityError("runtime_context_or_intent_mismatch", 403);
    return { binding, verified };
  }
  authorize(auth: NativeRuntimeAuthorization, now: number): NativeCapability {
    const { binding, verified } = auth;
    const grant = this._sql.read("runtime_grant", [binding.grantId], now).value;
    if (!validRuntimeGrant(grant) || grant.id !== binding.grantId || grant.epoch !== this._sql.epoch || grant.revoked || grant.expiresAtMs <= now)
      throw new NativeAuthorityError("runtime_grant_revoked_or_expired", 403);
    if (grant.contextBinding !== binding.contextBinding || grant.subjectId !== verified.subjectId)
      throw new NativeAuthorityError("runtime_grant_context_mismatch", 403);
    const identity = verified.identity;
    const keyIdentity = identity.kind === "kv_api_key" || identity.kind === "local_development_key";
    if (keyIdentity !== (verified.api !== null) || (keyIdentity && verified.api?.principalRef.keyId !== identity.keyId))
      throw new NativeAuthorityError("runtime_api_scope_mismatch", 403);
    if (typeof verified.bindingId !== "string" || !verified.bindingId) throw new NativeAuthorityError("runtime_binding_identity_missing", 403);
    const existing = this._sql.read("capability", [verified.bindingId], now).value;
    if (verified.api) {
      const ref = verified.api.principalRef;
      const resolution = this._sql.principalReference(ref.id, ref.keyId, now);
      if (
        (!resolution && existing?.principalRefId !== ref.id) ||
        (resolution &&
          (resolution.epoch !== this._sql.epoch ||
            resolution.keyId !== ref.keyId ||
            resolution.principalId !== ref.principalId ||
            resolution.tokenHash !== verified.api.tokenHash))
      )
        throw new NativeAuthorityError("runtime_principal_reference_mismatch", 403);
    }
    const next: NativeCapability = {
      id: verified.bindingId,
      epoch: grant.epoch,
      principalId: principal(identity),
      keyId: verified.api?.principalRef.keyId ?? null,
      tokenHash: verified.api?.tokenHash ?? null,
      kernel: verified.kernel,
      roles: grant.roles,
      revoked: false,
      runtimeRevision: 3,
      runtimeGrantId: grant.id,
      contextBinding: grant.contextBinding,
      subjectId: grant.subjectId,
      principalRefId: verified.api?.principalRef.id ?? null,
      retainedRequestHandles: null,
    };
    if (existing?.revoked || (existing && existing.epoch !== next.epoch)) throw new NativeAuthorityError("capability_revoked_or_wrong_epoch", 403);
    if (existing && nativeCommandBytes(existing) !== nativeCommandBytes(next)) throw new NativeAuthorityError("runtime_binding_scope_changed", 403);
    if (!existing) this._sql.write("capability", [next.id], next);
    return next;
  }
  assertCurrentApi(cap: NativeCapability, now: number): void {
    if (cap.keyId === null) return;
    const policy = this._sql.currentKeyPolicy(cap.tokenHash, cap.keyId, now)?.value;
    if (!policy || policy.revoked || (policy.api.expires_at_ms !== -1 && policy.api.expires_at_ms <= now))
      throw new NativeAuthorityError("api_policy_revoked", 403);
  }
  open(cap: NativeCapability, args: NativeCommand<"openAuthenticatedRequest">["args"], now: number): NativeReply {
    if (cap.keyId !== null) {
      const source = this._sql.currentKeyPolicy(cap.tokenHash, cap.keyId, now)?.value;
      if (!source || source.revoked || (source.api.expires_at_ms !== -1 && source.api.expires_at_ms <= now)) return { kind: "unauthorized" };
    }
    const key = [this._sql.epoch, cap.principalId, args.requestId];
    const prior = this._sql.read("runtime_request", key, now).value;
    if (prior) {
      if (prior.runtimeBindingId !== cap.id || prior.route !== args.route || prior.path !== args.path)
        throw new NativeAuthorityError("request_intent_conflict");
      return { kind: "reuse", handle: prior.handle };
    }
    const handle = crypto.randomUUID();
    const request: NativeRequest = {
      handle,
      runtimeBindingId: cap.id,
      principalId: cap.principalId,
      keyId: cap.keyId,
      requestId: args.requestId,
      route: args.route,
      path: args.path,
      model: null,
      stream: null,
      reasoning: null,
      metadataBound: false,
      apiApplicable: cap.keyId !== null,
      kernelApplicable: cap.kernel !== null,
      createdAtMs: now,
      api: null,
      kernel: null,
      routingDecision: null,
      codex: null,
      selection: null,
      codexProof: null,
      ownerFence: null,
      semantic: null,
      providerObserved: false,
      delivery: null,
      transport: null,
      responding: null,
      dispatch: null,
    };
    this._api.save(request);
    this._sql.write("runtime_request", key, { handle, runtimeBindingId: cap.id, ...args });
    return { kind: "opened", handle };
  }
  metadata(cap: NativeCapability, args: NativeCommand<"bindValidatedRequestMetadata">["args"], now: number): NativeReply {
    this.assertCurrentApi(cap, now);
    const row = this._sql.read("request_lifetime", [args.handle], now).value;
    if (row?.runtimeBindingId !== cap.id) throw new NativeAuthorityError("request_ownership_mismatch", 403);
    if ((row.apiApplicable && !row.api) || (row.kernelApplicable && !row.kernel)) throw new NativeAuthorityError("request_admission_phase_incomplete");
    if (row.metadataBound) {
      if (row.model !== args.model || row.stream !== args.stream || row.reasoning !== args.reasoning)
        throw new NativeAuthorityError("validated_metadata_conflict");
      return { kind: "unchanged", handle: row.handle };
    }
    this._api.save({ ...row, model: args.model, stream: args.stream, reasoning: args.reasoning, metadataBound: true });
    return { kind: "bound", handle: row.handle };
  }
  async routing(binding: NativeRuntimeBinding, request: NativeValidatedRequest, intent: string, now: number): Promise<NativeTrustedRoutingDecision> {
    const decision = await this._initial.verifier.verifyRouting(binding.privateContext, request, intent, now);
    if (
      !nativeObject(decision) ||
      typeof decision.allowUnrosteredModel !== "boolean" ||
      !["eligible", "not_applicable"].includes(decision.codex) ||
      !Array.isArray(decision.providers) ||
      !Array.isArray(decision.hops) ||
      decision.hops.length > 32 ||
      decision.hops.some(
        (hop) =>
          !nativeObject(hop) ||
          typeof hop.hopId !== "string" ||
          typeof hop.authorization !== "string" ||
          !["direct", "codex_unavailable"].includes(hop.authorization) ||
          typeof hop.upstreamModel !== "string" ||
          typeof hop.billingModel !== "string"
      )
    )
      throw new NativeAuthorityError("routing_verification_malformed", 403);
    if (decision.intentDigest !== intent || decision.contextBinding !== binding.contextBinding || !decision.sourceRevision || !decision.cohort)
      throw new NativeAuthorityError("routing_context_or_intent_mismatch", 403);
    const config = this._sql.read("authority_config", ["config"], now).value;
    if (
      !config ||
      decision.hops.some(
        (hop) =>
          !hop.upstreamModel ||
          !hop.billingModel ||
          !config.providerHops.some((configured) => configured.id === hop.hopId && configured.authorization === hop.authorization)
      )
    )
      throw new NativeAuthorityError("routing_hop_not_configured", 403);
    return structuredClone(decision);
  }
  assertRouting(cap: NativeCapability, request: NativeValidatedRequest, decision: NativeTrustedRoutingDecision, now: number): void {
    const bound = {
      subjectId: decision.subjectId,
      contextBinding: decision.contextBinding,
      sourceRevision: decision.sourceRevision,
      cohort: decision.cohort,
      codex: decision.codex,
      providers: decision.providers,
      allowUnrosteredModel: decision.allowUnrosteredModel,
      hops: decision.hops,
    };
    if (decision.subjectId !== cap.subjectId || !request.routingDecision || nativeCommandBytes(request.routingDecision) !== nativeCommandBytes(bound))
      throw new NativeAuthorityError("trusted_routing_stale", 403);
    const config = this._sql.read("authority_config", ["config"], now).value;
    if (
      !config ||
      decision.hops.some((hop) => !config.providerHops.some((configured) => configured.id === hop.hopId && configured.authorization === hop.authorization))
    )
      throw new NativeAuthorityError("routing_hop_not_configured", 403);
  }
  bindRouting(cap: NativeCapability, request: NativeValidatedRequest, decision: NativeTrustedRoutingDecision, now: number): NativeReply {
    this.assertCurrentApi(cap, now);
    if (decision.subjectId !== cap.subjectId) throw new NativeAuthorityError("routing_subject_mismatch", 403);
    const config = this._sql.read("authority_config", ["config"], now).value;
    if (
      !config ||
      decision.hops.some((hop) => !config.providerHops.some((configured) => configured.id === hop.hopId && configured.authorization === hop.authorization))
    )
      throw new NativeAuthorityError("routing_hop_not_configured", 403);
    const bound = {
      subjectId: decision.subjectId,
      contextBinding: decision.contextBinding,
      sourceRevision: decision.sourceRevision,
      cohort: decision.cohort,
      codex: decision.codex,
      providers: decision.providers,
      allowUnrosteredModel: decision.allowUnrosteredModel,
      hops: decision.hops,
    };
    if (request.routingDecision && nativeCommandBytes(request.routingDecision) !== nativeCommandBytes(bound))
      throw new NativeAuthorityError("trusted_routing_conflict");
    if (request.routingDecision) return { kind: "unchanged", handle: request.handle };
    this._api.save({ ...request, routingDecision: bound });
    return { kind: "bound", handle: request.handle };
  }
  async verifyRetained(binding: NativeRetainedHistoryBinding, intent: string, now: number): Promise<VerifiedNativeRetainedHistory> {
    if (!this._initial.retainedHistory) throw new NativeAuthorityError("retained_history_unavailable", 503);
    const verified = await this._initial.retainedHistory.verifier.verify(binding.privateContext, intent, now);
    if (
      !nativeObject(verified) ||
      verified.intentDigest !== intent ||
      verified.contextBinding !== binding.contextBinding ||
      verified.grantId !== binding.grantId
    )
      throw new NativeAuthorityError("retained_context_or_intent_mismatch", 403);
    return verified;
  }
  authorizeRetained(binding: NativeRetainedHistoryBinding, verified: VerifiedNativeRetainedHistory, command: NativeCommand, now: number): NativeCapability {
    this._sql.assertEpoch();
    if (command.epoch !== this._sql.epoch) throw new NativeAuthorityError("authority_epoch_mismatch", 403);
    if (!NATIVE_RETAINED_METHODS.some((method) => method === command.method)) throw new NativeAuthorityError("retained_operation_denied", 403);
    if (command.method === "recordPaidAttemptLifecycle" && (command.args.fetchStarted || command.args.patch.dispatch_state !== undefined))
      throw new NativeAuthorityError("retained_dispatch_denied", 403);
    const grant = this._sql.read("retained_history_grant", [binding.grantId], now).value;
    if (
      !validRetainedGrant(grant) ||
      grant.id !== binding.grantId ||
      grant.revoked ||
      grant.expiresAtMs <= now ||
      grant.epoch !== this._sql.epoch ||
      grant.namespace !== this._sql.namespace
    )
      throw new NativeAuthorityError("retained_grant_denied", 403);
    const expected = {
      grantId: grant.id,
      epoch: grant.epoch,
      subjectId: grant.subjectId,
      contextBinding: grant.contextBinding,
      namespace: grant.namespace,
      originalBindingId: grant.originalBindingId,
      originalPrincipalId: grant.originalPrincipalId,
      keyId: grant.keyId,
      requestHandles: grant.requestHandles,
      intentDigest: verified.intentDigest,
    };
    if (nativeCommandBytes(verified) !== nativeCommandBytes(expected) || binding.contextBinding !== grant.contextBinding)
      throw new NativeAuthorityError("retained_scope_mismatch", 403);
    for (const handle of grant.requestHandles) {
      const row = this._sql.read("request_lifetime", [handle], now).value;
      if (row?.runtimeBindingId !== grant.originalBindingId || row.principalId !== grant.originalPrincipalId || row.keyId !== grant.keyId)
        throw new NativeAuthorityError("retained_history_target_mismatch", 403);
    }
    if ("handle" in command.args && !grant.requestHandles.includes(command.args.handle))
      throw new NativeAuthorityError("retained_history_target_mismatch", 403);
    if ("attemptHandle" in command.args && command.args.attemptHandle !== undefined) {
      const handle = command.args.attemptHandle;
      const attempt = this._sql.read("attempt_lifetime", [handle], now).value;
      if (
        attempt?.runtimeBindingId !== grant.originalBindingId ||
        attempt.principalId !== grant.originalPrincipalId ||
        attempt.keyId !== grant.keyId ||
        !grant.requestHandles.includes(attempt.requestHandle)
      )
        throw new NativeAuthorityError("retained_history_target_mismatch", 403);
    }
    return {
      id: grant.originalBindingId,
      epoch: grant.epoch,
      principalId: grant.originalPrincipalId,
      keyId: grant.keyId,
      tokenHash: null,
      kernel: null,
      roles: grant.roles,
      revoked: false,
      runtimeRevision: 3,
      runtimeGrantId: grant.id,
      contextBinding: grant.contextBinding,
      subjectId: grant.subjectId,
      principalRefId: null,
      retainedRequestHandles: grant.requestHandles,
    };
  }
}

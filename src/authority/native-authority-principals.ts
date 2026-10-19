import { apiKeyHashKey, apiKeyIdKey, coerceApiKeyExpiresAtMs, coerceApiKeyWindowMs, paidFallbackMicrocreditsToCredits } from "../api-keys.ts";
import type { ApiKeyRecord } from "../types.ts";
import * as policy from "./native-api-key-policy.ts";
import { hasStrictPaidFallbackKeyPolicy, hasStrictPaidFallbackPolicy } from "./native-paid-policy.ts";
import { apiKeyChangeEventKey, API_KEY_CHANGE_RETENTION_MS, buildApiKeyChangeEvent, type ApiKeyChangeAction } from "./native-api-key-audit.ts";
import { paidFallbackDeletionGuardV3Key } from "./native-paid.ts";
import { NativeAuthorityError, nativeObject, type NativeKeyPolicy, type NativeRead } from "./native-authority-contracts.ts";
import { NativeAuthoritySql } from "./native-authority-sql.ts";
import { NativeAuthorityApi } from "./native-authority-api.ts";
import { NativeAuthorityPaid } from "./native-authority-paid.ts";
import { nativeCommandBytes, parseNativeControlCommand } from "./native-authority-rpc.ts";
import type {
  NativeControlBinding,
  NativeControlCommand,
  NativeControlReceipt,
  NativeControlReply,
  NativePrincipalControlInitial,
  VerifiedKeyAdmin,
  VerifiedKeyAuth,
  NativeKeyCreatePreparation,
  NativeKeyControlGrant,
} from "./native-principal-contracts.ts";

type Outcome = Exclude<NativeControlReply, { kind: "historical_ack" }>;
type Target = Readonly<{ record: ApiKeyRecord; id: NativeRead<ApiKeyRecord>; hashRevision: string | null; projection: NativeRead<NativeKeyPolicy> }>;
type Commit = (() => Readonly<{ reply: Outcome; cleanup?: NativeControlReceipt["cleanup"] }>) & { onFailure?: () => void; prepare?: () => void };
type CreateFlight = {
  intent: string;
  work?: Promise<Commit>;
  token?: string;
  now?: number;
  defaults?: ReturnType<NativePrincipalControlInitial["sources"]["defaults"]>;
  hash?: string;
  pricing?: ReturnType<NativePrincipalControlInitial["sources"]["defaultPaidPolicy"]>;
  pricingReady?: boolean;
  id?: string;
  prepared?: NativeKeyCreatePreparation;
};
const refusal = (status: number, message: string, code = "invalid_request_error"): Outcome => ({ kind: "refused", status, code, message });
const conflict = () => refusal(409, "API key was modified concurrently; retry");
const activeGrant = (value: unknown): value is NativeKeyControlGrant =>
  nativeObject(value) &&
  value.revoked === false &&
  typeof value.id === "string" &&
  typeof value.epoch === "string" &&
  typeof value.subjectId === "string" &&
  typeof value.contextBinding === "string" &&
  Number.isSafeInteger(value.expiresAtMs) &&
  Array.isArray(value.roles) &&
  value.roles.every((role) => role === "key_admin" || role === "principal_resolver") &&
  (value.targetKeyIds === null || (Array.isArray(value.targetKeyIds) && value.targetKeyIds.every((id) => typeof id === "string" && id.length > 0)));
const digest = async (value: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Private source-control SPI. Every effect and historical acknowledgment rechecks its durable grant. */
export class NativeAuthorityPrincipals {
  private readonly _creating = new Map<string, CreateFlight>();
  private readonly _cleaning = new Map<string, Promise<void>>();
  constructor(
    private readonly _sql: NativeAuthoritySql,
    private readonly _api: NativeAuthorityApi,
    private readonly _paid: NativeAuthorityPaid,
    private readonly _initial: NativePrincipalControlInitial,
    private readonly _clock: () => number
  ) {}
  initialize(): void {
    for (const grant of this._initial.grants) {
      if (grant.epoch !== this._sql.epoch) throw new NativeAuthorityError("control_initial_grant_epoch_mismatch", 500);
      this._sql.write("key_control_grant", [grant.id], grant);
    }
    for (const { record, hashRecord } of this._initial.records) {
      if (nativeCommandBytes(hashRecord) !== nativeCommandBytes(policy.apiKeyHashRecordFor(record)))
        throw new NativeAuthorityError("control_initial_source_mismatch", 500);
      const old = this._sql.read("api_policy", apiKeyHashKey(record.hash), this._clock()).value;
      if (old?.api.key_id !== record.id) throw new NativeAuthorityError("control_initial_binding_missing", 500);
      this._sql.write("api_key_id", apiKeyIdKey(record.id), record);
      this._sql.write("api_key_hash", apiKeyHashKey(record.hash), hashRecord);
      this._sql.write("api_policy", apiKeyHashKey(record.hash), this._projection(record, null, old, this._clock()));
    }
  }
  private _authorize(binding: NativeControlBinding, command: NativeControlCommand, verified: VerifiedKeyAdmin | VerifiedKeyAuth, intentDigest: string): void {
    const now = this._clock();
    this._sql.assertEpoch();
    const grant = this._sql.read("key_control_grant", [binding.grantId], now).value;
    const role = command.method === "resolvePrincipal" ? "principal_resolver" : "key_admin";
    if (
      command.epoch !== this._sql.epoch ||
      !activeGrant(grant) ||
      grant.id !== binding.grantId ||
      grant.epoch !== this._sql.epoch ||
      grant.expiresAtMs <= now ||
      grant.subjectId !== verified.subjectId ||
      grant.contextBinding !== binding.contextBinding ||
      verified.contextBinding !== binding.contextBinding ||
      verified.intentDigest !== intentDigest ||
      verified.kind !== role ||
      !grant.roles.includes(role)
    )
      throw new NativeAuthorityError("control_grant_denied", 403);
    if (verified.kind === "key_admin") {
      if (command.method !== "createKey" && (!verified.targetKeyId || (grant.targetKeyIds !== null && !grant.targetKeyIds.includes(verified.targetKeyId))))
        throw new NativeAuthorityError("control_target_denied", 403);
      if (command.method === "createKey" && (verified.targetKeyId !== null || grant.targetKeyIds !== null))
        throw new NativeAuthorityError("control_target_denied", 403);
    }
  }
  private _resolve(auth: VerifiedKeyAuth, binding: NativeControlBinding, now: number): Outcome {
    const source = this._sql.read("api_key_hash", apiKeyHashKey(auth.tokenHash), now);
    const record = source.value;
    // Native H authentication deliberately does not require the ID index.
    if (record?.revoked_at_ms !== null) return refusal(401, "Unauthorized", "invalid_api_key");
    const api = hasStrictPaidFallbackPolicy(record) ? policy.apiKeyPolicyFromHashRecord(auth.tokenHash, record, now) : null;
    if (!api) return refusal(503, "API key quota migration is incomplete", "server_error");
    if (api.expires_at_ms !== -1 && api.expires_at_ms <= now) return refusal(401, "Unauthorized", "invalid_api_key");
    if (!auth.principalId || !source.revision) throw new NativeAuthorityError("verified_principal_missing", 503);
    const key = [this._sql.epoch, binding.grantId, auth.principalId, record.id] as const;
    const prior = this._sql.read("principal_resolution", key, now).value;
    const principalRef = { id: prior?.id ?? this._initial.sources.randomUUID(), principalId: auth.principalId, keyId: record.id, epoch: this._sql.epoch };
    this._sql.write(
      "principal_resolution",
      key,
      { ...principalRef, tokenHash: auth.tokenHash, hashRevision: source.revision, grantId: binding.grantId },
      null,
      { scope: record.id }
    );
    return { kind: "principal", principalRef };
  }
  private _target(admin: VerifiedKeyAdmin, now: number): Target | null {
    if (!admin.targetKeyId) throw new NativeAuthorityError("control_target_denied", 403);
    const id = this._sql.read("api_key_id", apiKeyIdKey(admin.targetKeyId), now);
    if (!id.value) return null;
    const record = id.value;
    if (record.id !== admin.targetKeyId) throw new NativeAuthorityError("control_source_identity_mismatch", 503);
    return {
      record,
      id,
      hashRevision: this._sql.read("api_key_hash", apiKeyHashKey(record.hash), now).revision,
      projection: this._sql.read("api_policy", apiKeyHashKey(record.hash), now),
    };
  }
  private _current(target: Target, now: number): boolean {
    return (
      this._sql.read("api_key_id", apiKeyIdKey(target.record.id), now).revision === target.id.revision &&
      this._sql.read("api_key_hash", apiKeyHashKey(target.record.hash), now).revision === target.hashRevision &&
      this._sql.read("api_policy", apiKeyHashKey(target.record.hash), now).revision === target.projection.revision
    );
  }
  private _projection(record: ApiKeyRecord, admin: VerifiedKeyAdmin | null, old: NativeKeyPolicy | null, now: number): NativeKeyPolicy {
    const api = policy.apiKeyPolicyFromHashRecord(record.hash, policy.apiKeyHashRecordFor(record), now);
    if (!api || !hasStrictPaidFallbackKeyPolicy(record)) throw new NativeAuthorityError("API key quota migration is incomplete", 503);
    const allow = old?.paid.allowUnrosteredUnlimited ?? (admin ? this._initial.sources.allowUnrosteredUnlimited?.(admin, record) : null);
    if (typeof allow !== "boolean") throw new NativeAuthorityError("trusted_unrostered_binding_unavailable", 503);
    return {
      api,
      rawSource: true,
      revoked: record.revoked_at_ms !== null,
      paid: {
        policyVersion: `${record.window_ms}:${record.paid_fallback_pricing_checked_at_ms ?? 0}`,
        quotaPerCredit: record.paid_fallback_quota_per_credit,
        modelExposure: record.paid_fallback_max_exposure_microcredits ?? {},
        eligibleModels: [...record.paid_fallback_model_ids],
        allowUnrosteredUnlimited: allow,
      },
    };
  }
  private _audit(action: ApiKeyChangeAction, record: ApiKeyRecord, changed: Record<string, unknown>, admin: VerifiedKeyAdmin, now: number): void {
    const event = buildApiKeyChangeEvent(
      { action, targetKeyId: record.id, targetKeyName: record.name, changed, context: admin.auditContext, nowMs: now },
      this._initial.sources.audit
    );
    this._sql.write("api_key_audit", apiKeyChangeEventKey(event), event, this._clock() + API_KEY_CHANGE_RETENTION_MS, { scope: record.id });
  }
  private _writeRecord(record: ApiKeyRecord, projection: NativeKeyPolicy | null): void {
    this._sql.write("api_key_id", apiKeyIdKey(record.id), record);
    this._sql.write("api_key_hash", apiKeyHashKey(record.hash), policy.apiKeyHashRecordFor(record));
    if (projection) this._sql.write("api_policy", apiKeyHashKey(record.hash), projection);
    else this._sql.delete("api_policy", apiKeyHashKey(record.hash));
  }
  private _public(record: ApiKeyRecord, now: number): Readonly<Record<string, unknown>> {
    const api = policy.apiKeyPolicyFromHashRecord(record.hash, policy.apiKeyHashRecordFor(record), now);
    return {
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      created_at_ms: record.created_at_ms,
      expires_at_ms: coerceApiKeyExpiresAtMs(record),
      revoked_at_ms: record.revoked_at_ms,
      usage_limit_requests: record.usage_limit_requests,
      usage_requests: api ? this._api.usage(api, now) : 0,
      usage_reset_at_ms: record.usage_reset_at_ms,
      window_ms: coerceApiKeyWindowMs(record),
    };
  }
  private _createCommit(prepared: NativeKeyCreatePreparation, admin: VerifiedKeyAdmin): Commit {
    const { record, projection, atMs: now, hashRevision } = prepared,
      { id, name, hash } = record;
    return () => {
      if (
        this._sql.read("api_key_hash", apiKeyHashKey(hash), this._clock()).revision !== hashRevision ||
        this._sql.read("api_key_id", apiKeyIdKey(id), this._clock()).value
      )
        return { reply: refusal(500, "Failed to persist API key", "server_error") };
      this._writeRecord(record, projection);
      this._api.createWindow(projection.api, now);
      this._audit(
        "create",
        record,
        {
          name,
          expires_at_ms: record.expires_at_ms,
          usage_limit_requests: record.usage_limit_requests,
          window_ms: record.window_ms,
          paid_fallback_enabled: record.paid_fallback_enabled,
          paid_fallback_limit_credits: paidFallbackMicrocreditsToCredits(record.paid_fallback_limit_microcredits),
        },
        admin,
        now
      );
      return { reply: { kind: "applied", keyId: id, detail: this._public(record, now) } };
    };
  }
  private async _create(
    command: Extract<NativeControlCommand, { method: "createKey" }>,
    admin: VerifiedKeyAdmin,
    persist: (prepared: NativeKeyCreatePreparation) => NativeKeyCreatePreparation,
    flight: CreateFlight
  ): Promise<Commit> {
    const raw = command.args.input;
    const name = policy.normalizeApiKeyName(raw.name);
    if (!name) return () => ({ reply: refusal(400, "name must be a non-empty string (<=80 chars)") });
    const provided = policy.normalizeOptionalApiKeyToken(admin.createToken);
    if (admin.createToken !== undefined && admin.createToken !== null && provided === null)
      return () => ({ reply: refusal(400, "token must use the u_ prefix followed by 64 lowercase hexadecimal characters") });
    const token = (flight.token ??= provided ?? this._initial.sources.generateToken());
    const now = (flight.now ??= this._initial.sources.audit.now());
    const defaults = (flight.defaults ??= this._initial.sources.defaults(now));
    const fields = policy.resolveApiKeyCreateFields(raw, now, defaults);
    if (!fields.ok) return () => ({ reply: refusal(400, fields.error) });
    const hash = (flight.hash ??= await this._initial.sources.hashToken(token));
    const original = this._sql.transaction(() => this._sql.read("api_key_hash", apiKeyHashKey(hash), this._clock()));
    if (original.value) return () => ({ reply: refusal(409, "API key already exists") });
    let pricing = (flight.pricing ??= this._initial.sources.defaultPaidPolicy());
    if (fields.fields.paidFallbackEnabled && !flight.pricingReady) {
      try {
        pricing = { ...pricing, ...(await this._initial.sources.initializePricing()) };
        flight.pricing = pricing;
        flight.pricingReady = true;
      } catch (error) {
        return () => ({ reply: this._initial.sources.pricingFailure(error) });
      }
    }
    const id = (flight.id ??= this._initial.sources.randomUUID());
    const { record } = policy.buildApiKeyCreateRecords(
      { id, name, prefix: token.slice(0, 12), hash },
      fields.fields,
      { ...pricing, paid_fallback_enabled: fields.fields.paidFallbackEnabled, paid_fallback_limit_microcredits: fields.fields.paidFallbackLimitMicrocredits },
      now
    );
    const projection = this._projection(record, admin, null, now);
    const prepared = (flight.prepared ??= { record, projection, atMs: now, hashRevision: original.revision });
    let accepted = prepared;
    const commit: Commit = () => this._createCommit(accepted, admin)();
    // Keep the completed in-memory preparation when its separate durable write
    // fails. Retrying persistence must not mint token, pricing, time or ID again.
    commit.prepare = () => {
      accepted = persist(prepared);
    };
    return commit;
  }
  private async _update(command: Extract<NativeControlCommand, { method: "updateKey" }>, admin: VerifiedKeyAdmin, target: Target): Promise<Commit> {
    const record = target.record,
      raw = command.args.input,
      now = this._initial.sources.audit.now();
    const expiry = coerceApiKeyExpiresAtMs(record),
      windowMs = coerceApiKeyWindowMs(record),
      defaults = this._initial.sources.defaults(now);
    const identity = policy.resolveApiKeyUpdateIdentity(raw, record, expiry, now, defaults.expiryMs);
    if (!identity.ok) return () => ({ reply: refusal(400, identity.error) });
    const quota = policy.resolveApiKeyUpdateQuota(raw, record, defaults.usageLimitRequests);
    if (!quota.ok) return () => ({ reply: refusal(400, quota.error) });
    const paid = policy.resolveApiKeyUpdatePaidFallback(raw, record);
    if (!paid.ok) return () => ({ reply: refusal(400, paid.error) });
    let paidFields = paid.paidFallback;
    if (paid.needsInitialization) {
      try {
        const pricing = await this._initial.sources.initializePricing();
        paidFields = {
          ...paidFields,
          paidFallbackModelIds: [...pricing.paid_fallback_model_ids],
          paidFallbackQuotaPerCredit: pricing.paid_fallback_quota_per_credit,
          paidFallbackMaxExposureMicrocredits: pricing.paid_fallback_max_exposure_microcredits ?? {},
          paidFallbackPricingCheckedAtMs: pricing.paid_fallback_pricing_checked_at_ms,
        };
      } catch (error) {
        return () => ({ reply: this._initial.sources.pricingFailure(error) });
      }
    }
    const reset = policy.resolveApiKeyResetUsage(raw);
    if (!reset.ok) return () => ({ reply: refusal(400, reset.error) });
    const built = policy.buildApiKeyUpdateRecord(record, { ...identity.identity, ...quota.quota, ...paidFields, resetUsage: reset.resetUsage }, now, windowMs);
    const changed = policy.apiKeyUpdateChanged(record, built.updated, expiry, windowMs, built.resetUsage);
    const projection = changed ? this._projection(built.updated, admin, target.projection.value, now) : null;
    return () => {
      const current = this._current(target, this._clock());
      if (built.replaceQuotaWindow && this._api.inspectKeyReset(record.id, this._clock()))
        return { reply: refusal(409, "Cannot reset API key quota while requests are reserved; retry after their five-minute lease expires") };
      if (!current) return { reply: conflict() };
      if (!changed) return { reply: { kind: "unchanged", keyId: record.id, detail: this._public(record, this._clock()) } };
      if (!projection) throw new NativeAuthorityError("control_projection_missing", 503);
      if (built.replaceQuotaWindow) this._api.createWindow(projection.api, now);
      this._writeRecord(built.updated, projection);
      this._audit("update", built.updated, policy.apiKeyUpdateAuditChanges(record, built.updated, expiry, windowMs, built.resetUsage), admin, now);
      return { reply: { kind: "applied", keyId: record.id, detail: this._public(built.updated, this._clock()) } };
    };
  }
  private _revocationProjection(record: ApiKeyRecord, admin: VerifiedKeyAdmin, old: NativeKeyPolicy | null, now: number): NativeKeyPolicy | null {
    if (policy.apiKeyPolicyFromHashRecord(record.hash, policy.apiKeyHashRecordFor(record), now)) return this._projection(record, admin, old, now);
    // Native administration may revoke/unrevoke a key whose quota migration is incomplete.
    // Retain only its previously trusted binding; rawSource still refuses every fresh admission.
    return old ? { ...old, rawSource: true, revoked: record.revoked_at_ms !== null } : null;
  }
  private _revocation(command: NativeControlCommand, admin: VerifiedKeyAdmin, target: Target): Commit {
    const record = target.record;
    if (command.method === "unrevokeKey") {
      const decision = policy.apiKeyUnrevokeDecision(
        record,
        this._sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key(record.id), this._clock()).value
      );
      if (decision === "blocked")
        return () => ({ reply: refusal(409, "API key deletion is in progress and cannot be reversed", "paid_fallback_deletion_in_progress") });
      if (decision === "unchanged")
        return () => {
          if (this._sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key(record.id), this._clock()).value)
            return { reply: refusal(409, "API key deletion is in progress and cannot be reversed", "paid_fallback_deletion_in_progress") };
          return {
            reply: this._current(target, this._clock()) ? { kind: "unchanged", keyId: record.id, detail: { id: record.id, revoked_at_ms: null } } : conflict(),
          };
        };
    }
    const now = this._initial.sources.audit.now(),
      expiry = coerceApiKeyExpiresAtMs(record);
    const updated =
      command.method === "revokeKey" ? policy.buildApiKeyRevocationRecord(record, expiry, now) : policy.buildApiKeyUnrevocationRecord(record, expiry);
    const projection = this._revocationProjection(updated, admin, target.projection.value, now);
    return () => {
      if (!this._current(target, this._clock())) return { reply: conflict() };
      if (command.method === "unrevokeKey" && this._sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key(record.id), this._clock()).value)
        return { reply: refusal(409, "API key deletion is in progress and cannot be reversed", "paid_fallback_deletion_in_progress") };
      this._writeRecord(updated, projection);
      this._audit(
        command.method === "revokeKey" ? "revoke" : "unrevoke",
        updated,
        command.method === "revokeKey" ? policy.apiKeyRevokeAuditChanges(record, updated) : { revoked_at_ms: null },
        admin,
        now
      );
      return { reply: { kind: "applied", keyId: record.id, detail: { id: record.id, revoked_at_ms: updated.revoked_at_ms } } };
    };
  }
  private _releaseLocal(target: Target, owner: string | null): void {
    if (owner === null) return;
    const key = paidFallbackDeletionGuardV3Key(target.record.id),
      guard = this._sql.read("paid_deletion_guard", key, this._clock()).value;
    if (
      guard &&
      "local_deletion" in guard &&
      guard.local_deletion.owner === owner &&
      this._sql.read("api_key_id", apiKeyIdKey(target.record.id), this._clock()).value?.revoked_at_ms
    )
      this._sql.write("paid_deletion_guard", key, { ...guard, local_deletion: { owner: null, completed_at_ms: null } }, null, { scope: target.record.id });
  }
  private _delete(admin: VerifiedKeyAdmin, target: Target, authorize: () => void): Commit {
    const record = target.record;
    if (policy.apiKeyDeleteDecision(record) === "requires_revocation") return () => ({ reply: refusal(400, "Only revoked keys can be deleted") });
    let owner: string | null = null;
    const guardResult = this._sql.transaction(() => {
      authorize();
      if (!this._current(target, this._clock())) return conflict();
      const guardKey = paidFallbackDeletionGuardV3Key(record.id),
        guard = this._sql.read("paid_deletion_guard", guardKey, this._clock()).value;
      if (record.id === this._initial.sources.localDevelopmentKeyId) {
        const retryable = policy.retryableLocalDeletionGuard(guard);
        if (guard && !retryable) return refusal(409, "Local API key deletion already has an owner", "paid_fallback_deletion_in_progress");
        const createdAtMs = retryable?.created_at_ms ?? this._initial.sources.audit.now();
        owner = this._initial.sources.randomUUID();
        this._sql.write("paid_deletion_guard", guardKey, { created_at_ms: createdAtMs, local_deletion: { owner, completed_at_ms: null } }, null, {
          scope: record.id,
        });
      } else if (!guard) this._sql.write("paid_deletion_guard", guardKey, { created_at_ms: this._initial.sources.audit.now() }, null, { scope: record.id });
      return null;
    });
    if (guardResult) return () => ({ reply: guardResult });
    let deletion;
    try {
      deletion = this._sql.transaction(() => {
        authorize();
        return this._paid.deleteForKey(record.id, this._clock());
      });
    } catch {
      this._sql.transaction(() => {
        authorize();
        this._releaseLocal(target, owner);
      });
      return () => ({ reply: refusal(500, "Failed to prepare paid fallback state for API key deletion", "server_error") });
    }
    if (deletion.kind !== "deleted") {
      this._sql.transaction(() => {
        authorize();
        this._releaseLocal(target, owner);
      });
      return () => ({
        reply: refusal(
          409,
          `Cannot delete API key while metered billing is pending or unresolved (pending=${deletion.outstanding.pending_requests}, unresolved=${deletion.outstanding.unresolved_requests}, markers=${deletion.outstanding.pending_markers})`,
          "paid_fallback_billing_outstanding"
        ),
      });
    }
    const commit: Commit = () => {
      if (!this._current(target, this._clock())) {
        this._releaseLocal(target, owner);
        return { reply: conflict() };
      }
      const guard = this._sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key(record.id), this._clock()).value;
      if (!guard || (owner !== null && (!("local_deletion" in guard) || guard.local_deletion.owner !== owner)))
        throw new NativeAuthorityError("local_deletion_ownership_changed");
      this._sql.delete("api_key_id", apiKeyIdKey(record.id));
      this._sql.delete("api_key_hash", apiKeyHashKey(record.hash));
      this._sql.delete("api_policy", apiKeyHashKey(record.hash));
      this._audit("delete", record, {}, admin, this._initial.sources.audit.now());
      return { reply: { kind: "applied", keyId: record.id, detail: { id: record.id } }, cleanup: { keyId: record.id, localOwner: owner } };
    };
    commit.onFailure = () => {
      this._sql.transaction(() => {
        authorize();
        this._releaseLocal(target, owner);
      });
    };
    return commit;
  }
  private async _prepare(
    command: NativeControlCommand,
    admin: VerifiedKeyAdmin,
    persist: (prepared: NativeKeyCreatePreparation) => NativeKeyCreatePreparation,
    authorize: () => void,
    flight: CreateFlight | undefined
  ): Promise<Commit> {
    if (command.method === "createKey" || command.method === "updateKey") {
      const retired = policy.rejectRetiredApiKeyResetSetting(command.args.input);
      if (retired) return () => ({ reply: refusal(400, retired) });
    }
    if (command.method === "createKey") {
      if (!flight) throw new NativeAuthorityError("control_create_state_missing", 503);
      return await this._create(command, admin, persist, flight);
    }
    const target = this._sql.transaction(() => this._target(admin, this._clock()));
    if (!target) return () => ({ reply: refusal(404, "Not found", "not_found") });
    if (command.method === "deleteKey") return this._delete(admin, target, authorize);
    if (!hasStrictPaidFallbackKeyPolicy(target.record)) return () => ({ reply: refusal(503, "API key paid fallback migration is incomplete", "server_error") });
    if (command.method === "updateKey") return await this._update(command, admin, target);
    return this._revocation(command, admin, target);
  }
  private async _cleanupOwned(
    binding: NativeControlBinding,
    command: NativeControlCommand,
    verified: VerifiedKeyAdmin | VerifiedKeyAuth,
    intentDigest: string,
    key: readonly string[],
    receipt: NativeControlReceipt
  ): Promise<void> {
    if (!receipt.cleanup) return;
    await this._initial.sources.cleanupApiLogs(receipt.cleanup.keyId);
    this._sql.transaction(() => {
      this._authorize(binding, command, verified, intentDigest);
      const current = this._sql.read("key_control_receipt", key, this._clock()).value;
      if (current?.intent !== receipt.intent) throw new NativeAuthorityError("control_receipt_conflict");
      if (!current.cleanup) return;
      const cleanup = current.cleanup;
      if (this._sql.read("api_key_id", apiKeyIdKey(cleanup.keyId), this._clock()).value) throw new NativeAuthorityError("local_deletion_ownership_changed");
      this._api.deleteForKey(cleanup.keyId, this._clock());
      if (cleanup.localOwner !== null) {
        const guardKey = paidFallbackDeletionGuardV3Key(cleanup.keyId),
          guard = this._sql.read("paid_deletion_guard", guardKey, this._clock()).value;
        if (!guard || !("local_deletion" in guard) || guard.local_deletion.owner !== cleanup.localOwner)
          throw new NativeAuthorityError("local_deletion_ownership_changed");
        this._sql.write(
          "paid_deletion_guard",
          guardKey,
          { ...guard, local_deletion: { ...guard.local_deletion, completed_at_ms: this._initial.sources.audit.now() } },
          null,
          { scope: cleanup.keyId }
        );
      }
      this._sql.write("key_control_receipt", key, { ...current, cleanup: null });
    });
  }
  private async _cleanup(
    binding: NativeControlBinding,
    command: NativeControlCommand,
    verified: VerifiedKeyAdmin | VerifiedKeyAuth,
    intentDigest: string,
    key: readonly string[],
    receipt: NativeControlReceipt
  ): Promise<void> {
    if (!receipt.cleanup) return;
    const ownerKey = nativeCommandBytes({ key, cleanup: receipt.cleanup });
    let work = this._cleaning.get(ownerKey);
    if (!work) {
      work = this._cleanupOwned(binding, command, verified, intentDigest, key, receipt);
      this._cleaning.set(ownerKey, work);
    }
    try {
      await work;
    } finally {
      if (this._cleaning.get(ownerKey) === work) this._cleaning.delete(ownerKey);
    }
    // Every waiting caller needs current authority before its own acknowledgment.
    this._sql.transaction(() => {
      this._authorize(binding, command, verified, intentDigest);
    });
  }
  private async _preparedCommit(
    command: NativeControlCommand,
    admin: VerifiedKeyAdmin,
    preparation: Readonly<{
      operationKey: string;
      intent: string;
      prior?: NativeKeyCreatePreparation;
      persist: (prepared: NativeKeyCreatePreparation) => NativeKeyCreatePreparation;
      authorize: () => void;
    }>
  ): Promise<Commit> {
    let active = this._creating.get(preparation.operationKey);
    if (active && active.intent !== preparation.intent) throw new NativeAuthorityError("control_operation_replay_conflict");
    if (command.method === "createKey" && !active) {
      active = { intent: preparation.intent };
      this._creating.set(preparation.operationKey, active);
    }
    let work = active?.work;
    if (!work) {
      work = preparation.prior
        ? Promise.resolve(this._createCommit(preparation.prior, admin))
        : this._prepare(command, admin, preparation.persist, preparation.authorize, active);
      if (active) active.work = work;
    }
    try {
      return await work;
    } catch (error) {
      if (active?.work === work) active.work = undefined;
      throw error;
    }
  }
  async control(binding: NativeControlBinding, input: NativeControlCommand): Promise<NativeControlReply> {
    const command = parseNativeControlCommand(input),
      intentDigest = await digest(nativeCommandBytes(command));
    const verified = await this._initial.verifier.verify(binding.privateContext, intentDigest, this._clock());
    const targetKeyId = verified.kind === "key_admin" ? verified.targetKeyId : null;
    const intent = await digest(
      nativeCommandBytes({
        command,
        targetKeyId,
        contextBinding: binding.contextBinding,
        createToken: verified.kind === "key_admin" ? (verified.createToken ?? null) : null,
      })
    );
    const key = [this._sql.epoch, verified.subjectId, binding.grantId, command.operationId];
    const prior = this._sql.transaction(() => {
      this._authorize(binding, command, verified, intentDigest);
      if (verified.kind === "principal_resolver") return { resolution: this._resolve(verified, binding, this._clock()), receipt: null };
      const receipt = this._sql.read("key_control_receipt", key, this._clock()).value;
      if (receipt && (receipt.intent !== intent || receipt.targetKeyId !== targetKeyId)) throw new NativeAuthorityError("control_operation_replay_conflict");
      return { resolution: null, receipt };
    });
    if (prior.resolution) return prior.resolution;
    if (prior.receipt?.reply) {
      await this._cleanup(binding, command, verified, intentDigest, key, prior.receipt);
      return { kind: "historical_ack", outcome: prior.receipt.reply };
    }
    if (verified.kind !== "key_admin") throw new NativeAuthorityError("control_grant_denied", 403);
    const persist = (prepared: NativeKeyCreatePreparation): NativeKeyCreatePreparation =>
      this._sql.transaction(() => {
        this._authorize(binding, command, verified, intentDigest);
        const existing = this._sql.read("key_control_receipt", key, this._clock()).value;
        if (existing && existing.intent !== intent) throw new NativeAuthorityError("control_operation_replay_conflict");
        if (existing?.prepared) return existing.prepared;
        if (existing?.reply) return prepared;
        this._sql.write("key_control_receipt", key, { intent, targetKeyId, reply: null, cleanup: null, prepared });
        return prepared;
      });
    const operationKey = nativeCommandBytes(key);
    const commit = await this._preparedCommit(command, verified, {
      operationKey,
      intent,
      prior: prior.receipt?.prepared,
      persist,
      authorize: () => {
        this._authorize(binding, command, verified, intentDigest);
      },
    });
    commit.prepare?.();
    const apply = () =>
      this._sql.transaction(() => {
        this._authorize(binding, command, verified, intentDigest);
        const existing = this._sql.read("key_control_receipt", key, this._clock()).value;
        if (existing && (existing.intent !== intent || existing.targetKeyId !== targetKeyId))
          throw new NativeAuthorityError("control_operation_replay_conflict");
        if (existing?.reply) {
          if (existing.intent !== intent || existing.targetKeyId !== targetKeyId) throw new NativeAuthorityError("control_operation_replay_conflict");
          return { receipt: existing, replay: true };
        }
        const applied = commit(),
          receipt: NativeControlReceipt = { intent, targetKeyId, reply: applied.reply, cleanup: applied.cleanup ?? null };
        this._sql.write("key_control_receipt", key, receipt);
        return { receipt, replay: false };
      });
    let result;
    try {
      result = apply();
    } catch (error) {
      commit.onFailure?.();
      throw error;
    }
    await this._cleanup(binding, command, verified, intentDigest, key, result.receipt);
    this._creating.delete(operationKey);
    if (!result.receipt.reply) throw new NativeAuthorityError("control_preparation_incomplete", 503);
    return result.replay ? { kind: "historical_ack", outcome: result.receipt.reply } : result.receipt.reply;
  }
}

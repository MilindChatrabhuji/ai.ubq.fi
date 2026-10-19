import type { ApiKeyHashRecord, ApiKeyRecord } from "../types.ts";
import type { ApiKeyAuditContext, ApiKeyAuditSources } from "./native-api-key-audit.ts";
import type { NativeKeyPolicy, NativePaidPolicy } from "./native-authority-contracts.ts";
import type { PaidFallbackPolicyFields } from "../paid-fallback/index.ts";

export type NativeControlRole = "principal_resolver" | "key_admin";
export type NativeKeyIntent = Readonly<{
  name?: unknown;
  expires_at_ms?: unknown;
  usage_limit_requests?: unknown;
  window_ms?: unknown;
  paid_fallback_enabled?: unknown;
  paid_fallback_limit_credits?: unknown;
  banked_resets_enabled?: unknown;
}>;
export type NativeControlArguments = {
  resolvePrincipal: Readonly<Record<string, never>>;
  createKey: Readonly<{ input: NativeKeyIntent }>;
  updateKey: Readonly<{ input: NativeKeyIntent & Readonly<{ reset_usage?: unknown }> }>;
  revokeKey: Readonly<Record<string, never>>;
  unrevokeKey: Readonly<Record<string, never>>;
  deleteKey: Readonly<Record<string, never>>;
};
export type NativeControlMethod = keyof NativeControlArguments;
export type NativeControlCommand<TMethod extends NativeControlMethod = NativeControlMethod> = TMethod extends NativeControlMethod
  ? Readonly<{ epoch: string; operationId: string; method: TMethod; args: NativeControlArguments[TMethod] }>
  : never;
/** This grant is installed by the private constructor, never by a command. */
export type NativeKeyControlGrant = Readonly<{
  id: string;
  epoch: string;
  subjectId: string;
  contextBinding: string;
  roles: readonly NativeControlRole[];
  expiresAtMs: number;
  revoked: boolean;
  targetKeyIds: readonly string[] | null;
}>;
type VerifiedControlIdentity = Readonly<{
  subjectId: string;
  contextBinding: string;
  intentDigest: string;
}>;
export type VerifiedKeyAuth = VerifiedControlIdentity & Readonly<{ kind: "principal_resolver"; principalId: string; tokenHash: string }>;
export type VerifiedKeyAdmin = VerifiedControlIdentity &
  Readonly<{ kind: "key_admin"; targetKeyId: string | null; auditContext: ApiKeyAuditContext; createToken?: string | null }>;
export type TrustedPrincipalVerifier = Readonly<{
  verify(privateContext: unknown, canonicalIntentDigest: string, authorityNow: number): Promise<VerifiedKeyAuth | VerifiedKeyAdmin>;
}>;
export type NativePrincipalReference = Readonly<{ id: string; principalId: string; keyId: string; epoch: string }>;
export type NativePrincipalResolution = NativePrincipalReference & Readonly<{ tokenHash: string; hashRevision: string; grantId: string }>;
export type NativeControlOutcome =
  | Readonly<{ kind: "principal"; principalRef: NativePrincipalReference }>
  | Readonly<{ kind: "applied" | "unchanged"; keyId: string; detail?: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "refused"; status: number; code: string; message: string }>;
export type NativeControlReply = NativeControlOutcome | Readonly<{ kind: "historical_ack"; outcome: NativeControlOutcome }>;
export type NativeKeyCreatePreparation = Readonly<{ record: ApiKeyRecord; projection: NativeKeyPolicy; atMs: number; hashRevision: string | null }>;
export type NativeControlReceipt = Readonly<{
  intent: string;
  targetKeyId: string | null;
  reply: NativeControlOutcome | null;
  prepared?: NativeKeyCreatePreparation;
  cleanup: Readonly<{ keyId: string; localOwner: string | null }> | null;
}>;
/** Constructor-only sources are synthetic acceptance bindings until the native owner activates them. */
export type NativePrincipalControlInitial = Readonly<{
  grants: readonly NativeKeyControlGrant[];
  records: readonly Readonly<{ record: ApiKeyRecord; hashRecord: ApiKeyHashRecord }>[];
  verifier: TrustedPrincipalVerifier;
  sources: Readonly<{
    localDevelopmentKeyId: string;
    defaults(nowMs: number): Readonly<{ expiryMs: number; usageLimitRequests: number }>;
    defaultPaidPolicy(): PaidFallbackPolicyFields;
    generateToken(): string;
    hashToken(token: string): Promise<string>;
    randomUUID(): string;
    audit: ApiKeyAuditSources;
    initializePricing(): Promise<
      Pick<
        ApiKeyRecord,
        "paid_fallback_model_ids" | "paid_fallback_quota_per_credit" | "paid_fallback_max_exposure_microcredits" | "paid_fallback_pricing_checked_at_ms"
      >
    >;
    pricingFailure(error: unknown): Extract<NativeControlOutcome, { kind: "refused" }>;
    allowUnrosteredUnlimited?: (admin: VerifiedKeyAdmin, record: ApiKeyRecord) => NativePaidPolicy["allowUnrosteredUnlimited"] | null;
    cleanupApiLogs(keyId: string): Promise<void>;
  }>;
}>;
export type NativeControlBinding = Readonly<{ grantId: string; contextBinding: string; privateContext: unknown }>;
export type NativePrincipalControlRunner = Readonly<{
  control(binding: NativeControlBinding, command: NativeControlCommand): Promise<NativeControlReply>;
}>;

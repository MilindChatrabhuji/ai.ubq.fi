import type { ApiKeyHashRecord, ApiKeyRecord } from "../types.ts";
import type { NativeProviderHop, NativeRequest, NativeRole } from "./native-authority-contracts.ts";
import type { NativePrincipalReference } from "./native-principal-contracts.ts";
import type { ApiKeyUsageProvider } from "./native-contracts.ts";

/** Private schema/constructor revision, not an extra field on the four-field wire envelope. */
export const NATIVE_RUNTIME_REVISION = 3;
export type NativeRuntimeIdentity =
  | Readonly<{ kind: "kv_api_key" | "local_development_key"; keyId: string }>
  | Readonly<{ kind: "github_token"; owner: string; repo: string }>
  | Readonly<{ kind: "passkey_session"; userId: string }>
  | Readonly<{ kind: "auth_tokens_allowlist" | "admin_allowlist" | "deno_deploy_token" }>
  | Readonly<{ kind: "disabled_local"; bearerDigest: string | null }>;
export type NativeRuntimeGrant = Readonly<{
  id: string;
  revision: 3;
  epoch: string;
  subjectId: string;
  contextBinding: string;
  roles: readonly NativeRole[];
  expiresAtMs: number;
  revoked: boolean;
}>;
export type NativeRuntimeBinding = Readonly<{ grantId: string; contextBinding: string; privateContext: unknown }>;
export type NativeRuntimeApiScope = Readonly<{ principalRef: NativePrincipalReference; tokenHash: string }>;
export type VerifiedNativeRuntime = Readonly<{
  bindingId: string;
  subjectId: string;
  contextBinding: string;
  intentDigest: string;
  identity: NativeRuntimeIdentity;
  api: NativeRuntimeApiScope | null;
  kernel: Readonly<{ owner: string; repo: string }> | null;
}>;
export type NativeValidatedMetadata = Readonly<{ model: string; stream: boolean; reasoning: string | null }>;
export type NativeTrustedRoutingDecision = Readonly<{
  subjectId: string;
  contextBinding: string;
  intentDigest: string;
  sourceRevision: string;
  cohort: string;
  codex: "eligible" | "not_applicable";
  providers: readonly ApiKeyUsageProvider[];
  allowUnrosteredModel: boolean;
  hops: readonly Readonly<{
    hopId: string;
    authorization: NativeProviderHop["authorization"];
    upstreamModel: string;
    billingModel: string;
  }>[];
}>;
export type TrustedNativeRuntimeVerifier = Readonly<{
  verify(privateContext: unknown, canonicalIntentDigest: string, authorityNow: number): Promise<VerifiedNativeRuntime>;
  verifyRouting(
    privateContext: unknown,
    request: NativeRequest & NativeValidatedMetadata,
    canonicalIntentDigest: string,
    authorityNow: number
  ): Promise<NativeTrustedRoutingDecision>;
}>;
export type NativeRuntimeInitial = Readonly<{
  grants: readonly NativeRuntimeGrant[];
  verifier: TrustedNativeRuntimeVerifier;
  /** Synthetic/native-source construction supplies complete source records, never inference capabilities. */
  records: readonly Readonly<{ record: ApiKeyRecord; hashRecord: ApiKeyHashRecord }>[];
  retainedHistory?: NativeRetainedHistoryInitial;
}>;
export type NativeRuntimeAuthorization = Readonly<{ binding: NativeRuntimeBinding; verified: VerifiedNativeRuntime }>;
export type NativeRuntimeRequestBinding = Readonly<{ handle: string; runtimeBindingId: string; requestId: string; route: string; path: string }>;
export type NativeValidatedRequest = NativeRequest & NativeValidatedMetadata;
export const NATIVE_RETAINED_METHODS = [
  "releaseApiUndispatched",
  "releasePaidBeforeFetch",
  "recordPaidAttemptLifecycle",
  "recordVerifiedPaidBilling",
  "deferPaidReconciliation",
  "claimPaidReconciliation",
  "finishPaidReconciliation",
] as const;
export type NativeRetainedHistoryBinding = Readonly<{
  kind: "retained_history";
  grantId: string;
  contextBinding: string;
  privateContext: unknown;
}>;
export type NativeRetainedHistoryScope = Readonly<{
  namespace: string;
  originalBindingId: string;
  originalPrincipalId: string;
  keyId: string;
  requestHandles: readonly string[];
}>;
export type NativeRetainedHistoryGrant = NativeRuntimeGrant & NativeRetainedHistoryScope;
export type VerifiedNativeRetainedHistory = NativeRetainedHistoryScope &
  Readonly<{ grantId: string; epoch: string; subjectId: string; contextBinding: string; intentDigest: string }>;
export type NativeRetainedHistoryInitial = Readonly<{
  grants: readonly NativeRetainedHistoryGrant[];
  verifier: Readonly<{
    verify(privateContext: unknown, canonicalIntentDigest: string, authorityNow: number): Promise<VerifiedNativeRetainedHistory>;
  }>;
}>;

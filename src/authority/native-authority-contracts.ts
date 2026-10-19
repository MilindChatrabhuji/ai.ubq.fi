import type { ApiKeyPolicy, ApiKeyUsageProvider, ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "./native-contracts.ts";
import type { ApiKeyHashRecord, ApiKeyRecord } from "../types.ts";
import type { ApiKeyChangeEvent } from "./native-api-key-audit.ts";
import type { LocalDevelopmentDeletionGuard } from "../auth/local-development-key.ts";
import type { NativeControlReceipt, NativeKeyControlGrant, NativePrincipalResolution } from "./native-principal-contracts.ts";
import type {
  KernelDefaultWindowCutoverV2,
  KernelQuotaConstants,
  KernelQuotaDefaults,
  KernelQuotaIdentity,
  KernelQuotaPolicySetOptions,
  KernelQuotaPolicyV2,
  KernelQuotaReservationIdentity,
  KernelQuotaReservationRowV2,
  KernelQuotaScope,
  KernelQuotaWindowV2,
} from "./native-kernel-contracts.ts";
import type {
  CodexAccountRoutingState,
  CodexActiveAccountSelection,
  CodexCapacityRoutingObservation,
  CodexRoutingAccount,
  CodexRoutingAccountPolicy,
  CodexRoutingIdentity,
  CodexRouteSelection,
  CodexRoutingRowRevisions,
} from "./native-codex-contracts.ts";
import type {
  NativePaidProviderLog,
  PaidFallbackBackfillLeaseV3,
  PaidFallbackDeletionGuardV3,
  PaidFallbackPendingV3,
  PaidFallbackReconciliationGateV3,
  PaidFallbackReconciliationLeaseV3,
  PaidFallbackRequestLifecyclePatchV3,
  PaidFallbackRequestV3,
  PaidFallbackUsageRollup,
  PaidFallbackWindowV3,
  TerminalUsageRollupInput,
} from "./native-paid-contracts.ts";

export type NativeRole = "inference" | "transport" | "terminal" | "billing" | "reconcile" | "quota_admin" | "reset" | "observer";
export type NativeCapability = Readonly<{
  id: string;
  epoch: string;
  principalId: string;
  keyId: string;
  tokenHash: string;
  kernel: Readonly<{ owner: string; repo: string }>;
  roles: readonly NativeRole[];
  revoked: boolean;
}>;
/** Already verified by the native policy owner. No public command may construct this projection. */
export type NativePaidPolicy = Readonly<{
  policyVersion: string;
  quotaPerCredit: number;
  modelExposure: Readonly<Record<string, number | null>>;
  eligibleModels: readonly string[];
  allowUnrosteredUnlimited: boolean;
}>;
export type NativeKeyPolicy = Readonly<{ api: ApiKeyPolicy; paid: NativePaidPolicy; revoked: boolean; rawSource?: true }>;
export type NativeOwner = Readonly<{
  administrativeAccountLabelHash: string;
  routingAccountIdHash: string;
  credentialVersion: string;
  nativeGenerationHash: string | null;
  publicationRevision: string;
  ownerId: string;
  ownerEpoch: string;
  revoked: boolean;
  issuedAtMs: number;
  expiresAtMs: number;
  nativeRefreshedAt: string | null;
}>;
export type NativePool = Readonly<{
  identities: readonly CodexRoutingIdentity[];
  selectedAccountHashes: readonly string[];
  policies: Readonly<Record<string, CodexRoutingAccountPolicy>>;
  modelPolicies?: Readonly<Record<string, Readonly<Record<string, CodexRoutingAccountPolicy>>>>;
}>;
export type NativeProviderHop = Readonly<{
  id: string;
  publicProvider: ApiKeyUsageProvider | "openlux";
  ledgerProvider: "metered" | "surplus";
  billingCorrelation: "provider_request_id" | "surplus_reservation";
  microcreditsPerCredit: number;
  billingSuffix: string;
  authorization: "direct" | "codex_unavailable";
}>;
export type NativeResetProof = Readonly<{
  id: string;
  account: CodexRoutingAccount;
  quotaResetAtMs: number;
  routingGeneration: number;
  activeSnapshot: CodexActiveAccountSelection | null;
  poolRevision: string;
  capacityRevision: string | null;
  verified: boolean;
}>;
export type NativeAuthorityInitial = Readonly<{
  namespace: string;
  epoch: string;
  capabilities: readonly NativeCapability[];
  keys: readonly NativeKeyPolicy[];
  kernelPolicies: readonly KernelQuotaPolicyV2[];
  kernelDefaults: KernelQuotaDefaults;
  kernelConstants: KernelQuotaConstants;
  pool: NativePool;
  routing: CodexAccountRoutingState | null;
  active: CodexActiveAccountSelection | null;
  capacity: Readonly<{ v: 1; observations: readonly CodexCapacityRoutingObservation[] }>;
  owners: readonly NativeOwner[];
  providerHops: readonly NativeProviderHop[];
  resetProofs: readonly NativeResetProof[];
}>;
export type NativeSemantic = "completed" | "incomplete" | "failed" | "cancelled";
export type NativeCodexAuthorization = Readonly<{ account: CodexRoutingAccount; owner: NativeOwner }>;
export type NativeRequest = Readonly<{
  handle: string;
  principalId: string;
  keyId: string;
  requestId: string;
  route: string;
  model: string;
  stream: boolean;
  reasoning: string | null;
  createdAtMs: number;
  api: ApiKeyPolicy;
  kernel: KernelQuotaReservationIdentity | null;
  codex: CodexRoutingAccount | null;
  selection: CodexRouteSelection | null;
  codexProof: CodexRoutingRowRevisions | null;
  ownerFence: NativeOwner | null;
  semantic: NativeSemantic | null;
  providerObserved: boolean;
  delivery: "delivered" | "interrupted" | "unobserved" | null;
  transport: Readonly<{ provider: ApiKeyUsageProvider; attemptHandle: string | null; operationId: string; startedAtMs: number }> | null;
  responding: Readonly<{ provider: ApiKeyUsageProvider; attemptHandle: string | null }> | null;
  dispatch: Readonly<{ provider: ApiKeyUsageProvider; cancellationOwned: boolean; fetchStarted: boolean }> | null;
}>;
export type NativeAttempt = Readonly<{
  handle: string;
  requestHandle: string;
  principalId: string;
  keyId: string;
  hopId: string;
  billingRequestId: string;
  windowResetAtMs: number;
  fetchStarted: boolean;
}>;
export type NativeCursor = Readonly<{ id: string; capabilityId: string; family: string; after: string; parent: string | null; lease: string | null }>;
export type NativeReply = Readonly<{ kind: string; handle?: string; attemptHandle?: string; cursor?: string | null; lease?: string; detail?: unknown }>;
export type NativeRows = {
  key_control_grant: NativeKeyControlGrant;
  principal_resolution: NativePrincipalResolution;
  api_key_id: ApiKeyRecord;
  api_key_hash: ApiKeyHashRecord;
  api_key_audit: ApiKeyChangeEvent;
  key_control_receipt: NativeControlReceipt;
  kernel_default: number;
  authority_config: Readonly<{ providerHops: readonly NativeProviderHop[] }>;
  capability: NativeCapability;
  api_policy: NativeKeyPolicy;
  api_window: ApiKeyUsageWindowV3;
  api_request: ApiKeyUsageRequestV3;
  kernel_policy: KernelQuotaPolicyV2;
  kernel_window: KernelQuotaWindowV2;
  kernel_reservation: KernelQuotaReservationRowV2;
  kernel_cutover: KernelDefaultWindowCutoverV2;
  codex_pool: NativePool;
  codex_routing: CodexAccountRoutingState;
  codex_active: CodexActiveAccountSelection;
  codex_capacity: NativeAuthorityInitial["capacity"];
  codex_owner: NativeOwner;
  codex_reset: NativeResetProof;
  paid_request: PaidFallbackRequestV3;
  paid_window: PaidFallbackWindowV3;
  paid_pending: PaidFallbackPendingV3;
  paid_gate: PaidFallbackReconciliationGateV3;
  paid_lease: PaidFallbackReconciliationLeaseV3;
  paid_backfill_lease: PaidFallbackBackfillLeaseV3;
  paid_rollup: PaidFallbackUsageRollup;
  paid_deletion_guard: PaidFallbackDeletionGuardV3 | LocalDevelopmentDeletionGuard;
  request_lifetime: NativeRequest;
  attempt_lifetime: NativeAttempt;
  cursor: NativeCursor;
  operation_receipt: Readonly<{ command: string; reply: NativeReply; codexAuthorization?: NativeCodexAuthorization }>;
};
export type NativeTable = keyof NativeRows;
export type NativeKey = readonly (Uint8Array | string | number | bigint | boolean)[];
export type NativeRead<T> = Readonly<{ value: T | null; revision: string | null; versionstamp: string | null; expiresAtMs: number | null }>;
export type NativeArguments = {
  reserveApiUsage: Readonly<{ requestId: string; route: string; model: string; stream: boolean; reasoning?: string | null }>;
  recordTransportStarted: Readonly<{ handle: string; provider: ApiKeyUsageProvider; attemptHandle?: string }>;
  markApiDispatch: Readonly<{ handle: string; provider: ApiKeyUsageProvider }>;
  releaseApiUndispatched: Readonly<{ handle: string; reason: string }>;
  recordApiDispatchCancellation: Readonly<{ handle: string }>;
  reserveKernelUsage: Readonly<{ handle: string }>;
  recordKernelTerminalIntent: Readonly<{ handle: string; terminalState: "committed" | "released" }>;
  settleKernelUsage: Readonly<{ handle: string; terminalState: "committed" | "released"; reason: string }>;
  renewKernelReservation: Readonly<{ handle: string }>;
  reclaimExpiredKernelReservations: Readonly<{ cursor?: string; limit: number }>;
  setKernelQuota: Readonly<{ scope: KernelQuotaScope; usageLimitRequests: number; options: KernelQuotaPolicySetOptions }>;
  deleteKernelQuota: Readonly<{ scope: KernelQuotaScope }>;
  acquireKernelDefaultCutover: Readonly<Record<string, never>>;
  selectCodexAccount: Readonly<{ handle: string }>;
  recordCodexAttemptSignal: Readonly<{
    handle: string;
    signal: "success" | "credential_invalid" | "upstream_timeout" | "quota";
    response?: Readonly<{ status: number; headers: readonly (readonly [string, string])[]; body: string }>;
    recoveryProbe?: boolean;
  }>;
  releaseCodexProbe: Readonly<{ handle: string }>;
  electCodexResetProbe: Readonly<{ handle: string; proofId: string }>;
  refreshCodexAdmission: Readonly<{ handle: string }>;
  reservePaidAttempt: Readonly<{ handle: string; hopId: string }>;
  recordPaidAttemptLifecycle: Readonly<{
    attemptHandle: string;
    patch: Pick<PaidFallbackRequestLifecyclePatchV3, "provider_request_id" | "dispatch_state" | "terminal_state">;
    fetchStarted?: boolean;
  }>;
  releasePaidBeforeFetch: Readonly<{ attemptHandle: string }>;
  recordVerifiedPaidBilling: Readonly<{ attemptHandle: string; log: NativePaidProviderLog; surplusBuyerCostMicro?: number }>;
  deferPaidReconciliation: Readonly<{ attemptHandle: string }>;
  claimPaidReconciliation: Readonly<{ cursor?: string; limit: number }>;
  finishPaidReconciliation: Readonly<{ lease: string }>;
  foldPaidBackfillPage: Readonly<{ cursor?: string; limit: number }>;
  beginPaidKeyDeletion: Readonly<Record<string, never>>;
  recordSemanticTerminal: Readonly<{
    handle: string;
    attemptHandle?: string;
    outcome: NativeSemantic;
    usage?: Pick<TerminalUsageRollupInput, "input_tokens" | "cached_input_tokens" | "output_tokens">;
  }>;
  recordDeliveryObservation: Readonly<{ handle: string; observation: "delivered" | "interrupted" | "unobserved" }>;
  readRequestStatus: Readonly<{ handle: string; cursor?: string; limit: number }>;
};
export type NativeMethod = keyof NativeArguments;
export type NativeCommand<TMethod extends NativeMethod = NativeMethod> = TMethod extends NativeMethod
  ? Readonly<{ epoch: string; operationId: string; method: TMethod; args: NativeArguments[TMethod] }>
  : never;
export type NativeSqlStorage = Readonly<{
  sql: { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(callback: () => T): T;
}>;
export class NativeAuthorityError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409
  ) {
    super(code);
  }
}
export const nativeObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const nativeIdentity = (scope: KernelQuotaScope, capability: NativeCapability): KernelQuotaIdentity => ({
  scope,
  owner: capability.kernel.owner,
  repo: scope === "repo" ? capability.kernel.repo : undefined,
});

/** Private constructor capabilities. These are not public HTTP/admin operations. */
export type AuthorityScope = Readonly<{ namespace: string; epoch: number }>;
export type GatewayRoute = "/v1/responses" | "/v1/chat/completions";
export type DispatchProvider = "codex" | "surplus" | "openlux";
export type DeliveryOutcome = "delivered" | "interrupted" | "unobserved";
export type SemanticTerminal = "completed" | "incomplete" | "failed" | "cancelled";
export type AccountProof = Readonly<{
  kind: "quota_exhausted" | "credential_invalid" | "transient";
  model: string;
  fingerprint: string;
  observedAtMs: number;
  validUntilMs: number;
}>;
export type AccountBinding = Readonly<{
  accountId: string;
  fingerprint: string;
  credentialGeneration: number;
  routingGeneration: number;
  resetGeneration: number;
  overageVersion: number;
  overageEnabled: boolean;
  enabled: boolean;
  models: readonly string[];
  proof: AccountProof | null;
}>;
export type ActiveAccount = Readonly<{ accountId: string; fingerprint: string; generation: number }>;
export type PrincipalPolicy = Readonly<{
  principalId: string;
  version: number;
  deleted: boolean;
  windowResetAtMs: number;
  requestLimit: number;
  kernelLimit: number;
  concurrencyLimit: number;
  paidLimitMicrocredits: number;
}>;
export type PrincipalWindow = {
  reserved: number;
  dispatched: number;
  kernelReserved: number;
  kernelCompleted: number;
  active: number;
  paidReservedMicrocredits: number;
  paidSettledMicrocredits: number;
};
export type AdmissionHandle = Readonly<{ scope: AuthorityScope; requestId: string; fence: number }>;
export type AttemptInput = Readonly<{
  attemptId: string;
  provider: DispatchProvider;
  maximumExposureMicrocredits: number;
  account: AccountBinding | null;
}>;
export type TerminalEvidence = Readonly<{
  outcome: SemanticTerminal;
  providerRequestId: string | null;
  /** Null means billing remains pending; zero is authoritative zero usage. */
  spendMicrocredits: number | null;
  fallback: "quota_exhausted" | "capacity_exhausted" | null;
}>;
export type AccessAuthorization = Readonly<{
  ownerId: string;
  ownerEpoch: number;
  accountId: string;
  workspaceId: string;
  generation: number;
  nativeRefreshedAtNs: string;
  fingerprint: string;
  accessToken: string;
  idToken: string;
  issuedAtMs: number;
  expiresAtMs: number;
}>;
export type AttemptRecord = {
  input: AttemptInput;
  state: "reserved" | "dispatch_intent" | "dispatched" | "not_dispatched";
  terminal: TerminalEvidence | null;
  billingSettled: boolean;
  settledSpendMicrocredits: number | null;
};
export type AdmissionRecord = {
  handle: AdmissionHandle;
  principalId: string;
  policyVersion: number;
  windowKey: string;
  digest: string;
  route: GatewayRoute;
  model: string;
  account: AccountBinding | null;
  activeGeneration: number | null;
  attempts: Record<string, AttemptRecord>;
  dispatched: boolean;
  semantic: SemanticTerminal | null;
  kernelSettled: boolean;
  delivery: DeliveryOutcome | null;
  settled: boolean;
};
export type AuthorityState = {
  scope: AuthorityScope;
  sequence: number;
  accounts: AccountBinding[];
  active: ActiveAccount | null;
  policies: Record<string, PrincipalPolicy>;
  windows: Record<string, PrincipalWindow>;
  admissions: Record<string, AdmissionRecord>;
  publications: Record<string, AccessAuthorization>;
};
export type AuthoritySnapshot = Readonly<{ revision: number; state: AuthorityState }>;
/** The adapter must provide a coherent strong snapshot and atomic CAS over ALL state. */
export type AuthorityStore = {
  read(): Promise<AuthoritySnapshot>;
  compareAndSwap(revision: number, state: AuthorityState): Promise<boolean>;
};
export type AdmitInput = Readonly<{
  scope: AuthorityScope;
  requestId: string;
  principalId: string;
  policyVersion: number;
  digest: string;
  route: GatewayRoute;
  model: string;
  nowMs: number;
}>;
export class AuthorityError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409
  ) {
    super(code);
    this.name = "AuthorityError";
  }
}
export const sameScope = (left: AuthorityScope, right: AuthorityScope): boolean => left.namespace === right.namespace && left.epoch === right.epoch;
export const assertAmount = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new AuthorityError("invalid_amount", 400);
};
export const sameEvidence = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export const lookup = <T>(values: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(values, key) ? values[key] : undefined);

/** Credential-free producer ABI. Changes require reciprocal standalone Sentinel fixtures. */
export const VPS_RELEASE_ABI = "uos-vps-deployment-v1";
export const VPS_RECEIPT_MAX_BYTES = 64 * 1024;
export const VPS_PHASES = ["prepared", "selected", "candidate_ready", "ingress_applied", "rollback_pending", "rolled_back", "accepted", "failed"] as const;
export type VpsPhase = (typeof VPS_PHASES)[number];
export type VpsIdentity = {
  runtime: "vps";
  gitSha: string;
  deploymentId: string;
  sourceArchiveSha256: string;
  immutableTreeSha256: string;
};
export type VpsSelector = {
  target: string;
  identity: VpsIdentity;
  listenerPort: number;
  launcherProfileSha256: string;
  unitSha256: string;
};
export type VpsBinding = {
  requestId: string;
  requestDigest: string;
  repository: string;
  installationId: number;
  environment: "production" | "isolated";
  revision: string;
  source: { pullRequest: number; head: string; base: string; reviewRequestId: string; reviewReceiptId: string | null };
};
export type VpsHealthProof = {
  identity: VpsIdentity;
  surface: "loopback" | "public";
  observedAt: number;
  httpStatus: number;
  bodyMatches: boolean;
  headersMatch: boolean;
  originMatches: boolean;
};
export type VpsMetricsSample = {
  identity: VpsIdentity;
  windowStart: number;
  windowEnd: number;
  sampledAt: number;
  requestCount: number | null;
  fiveXxCount: number | null;
  timeoutCount: number | null;
  streamFailureCount: number | null;
  upstreamWideFault: boolean | null;
  coverage: "complete" | "incomplete";
  coverageDigest: string | null;
};
export type VpsReceipt = {
  schema: 1;
  kind: "vps_driver_receipt";
  abi: typeof VPS_RELEASE_ABI;
  operationId: string;
  binding: VpsBinding;
  controllerSha: string;
  driverSha256: string;
  candidate: VpsIdentity;
  prior: VpsSelector;
  phase: VpsPhase;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  intent: { action: "promote" | "rollback"; persistedAt: number } | null;
  loopback: VpsHealthProof | null;
  public: VpsHealthProof | null;
  restoration: { loopback: VpsHealthProof; public: VpsHealthProof } | null;
  settlement: { stateRevision: string; disposition: "accepted" | "rolled_back" | "failed"; digest: string } | null;
  error: string | null;
};
export type VpsOperation = { operationId: string; requestDigest: string };
export type VpsMutation = VpsOperation & { expectedSequence: number; expectedDigest: string };
export type VpsPrepare = {
  binding: VpsBinding;
  controllerSha: string;
  expectedDriverSha256: string;
  expectedPrior: VpsSelector;
  priorHealth: { loopback: VpsHealthProof; public: VpsHealthProof };
};
export type VpsSettlement = VpsMutation & { stateRevision: string; disposition: "accepted" | "rolled_back" | "failed"; digest: string };

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
export const invalidVps = (): never => {
  throw new TypeError("VPS release contract is invalid");
};
export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidVps();
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return invalidVps();
  return object;
}
export function boundedText(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /\p{Cc}/u.test(value)) return invalidVps();
  return value;
}
export function gitSha(value: unknown): string {
  const result = boundedText(value, 40);
  if (!SHA.test(result)) return invalidVps();
  return result;
}
export function sha256(value: unknown): string {
  const result = boundedText(value, 64);
  if (!DIGEST.test(result)) return invalidVps();
  return result;
}
export function count(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) return invalidVps();
  return value as number;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalidVps();
  return value;
}
export function parseVpsIdentity(value: unknown): VpsIdentity {
  const object = exactObject(value, ["runtime", "gitSha", "deploymentId", "sourceArchiveSha256", "immutableTreeSha256"]);
  const revision = gitSha(object.gitSha);
  if (object.runtime !== "vps" || object.deploymentId !== `vps-${revision}`) return invalidVps();
  return {
    runtime: "vps",
    gitSha: revision,
    deploymentId: `vps-${revision}`,
    sourceArchiveSha256: sha256(object.sourceArchiveSha256),
    immutableTreeSha256: sha256(object.immutableTreeSha256),
  };
}
export function parseVpsSelector(value: unknown): VpsSelector {
  const object = exactObject(value, ["target", "identity", "listenerPort", "launcherProfileSha256", "unitSha256"]);
  const identity = parseVpsIdentity(object.identity);
  const port = count(object.listenerPort, 1);
  if (object.target !== `releases/${identity.gitSha}` || port > 65535) return invalidVps();
  return {
    target: `releases/${identity.gitSha}`,
    identity,
    listenerPort: port,
    launcherProfileSha256: sha256(object.launcherProfileSha256),
    unitSha256: sha256(object.unitSha256),
  };
}
export function parseVpsBinding(value: unknown): VpsBinding {
  const object = exactObject(value, ["requestId", "requestDigest", "repository", "installationId", "environment", "revision", "source"]);
  const source = exactObject(object.source, ["pullRequest", "head", "base", "reviewRequestId", "reviewReceiptId"]);
  if (object.repository !== "ubiquity/ai.ubq.fi" || !["production", "isolated"].includes(String(object.environment))) return invalidVps();
  return {
    requestId: boundedText(object.requestId),
    requestDigest: sha256(object.requestDigest),
    repository: "ubiquity/ai.ubq.fi",
    installationId: count(object.installationId, 1),
    environment: object.environment as VpsBinding["environment"],
    revision: gitSha(object.revision),
    source: {
      pullRequest: count(source.pullRequest, 1),
      head: gitSha(source.head),
      base: gitSha(source.base),
      reviewRequestId: boundedText(source.reviewRequestId),
      reviewReceiptId: source.reviewReceiptId === null ? null : boundedText(source.reviewReceiptId),
    },
  };
}
export function parseVpsHealth(value: unknown): VpsHealthProof {
  const object = exactObject(value, ["identity", "surface", "observedAt", "httpStatus", "bodyMatches", "headersMatch", "originMatches"]);
  if (object.surface !== "loopback" && object.surface !== "public") return invalidVps();
  const status = count(object.httpStatus, 100);
  if (status > 599) return invalidVps();
  return {
    identity: parseVpsIdentity(object.identity),
    surface: object.surface,
    observedAt: count(object.observedAt),
    httpStatus: status,
    bodyMatches: boolean(object.bodyMatches),
    headersMatch: boolean(object.headersMatch),
    originMatches: boolean(object.originMatches),
  };
}
export function isHealthyVps(proof: VpsHealthProof): boolean {
  return proof.httpStatus === 200 && proof.bodyMatches && proof.headersMatch && proof.originMatches;
}
export function sameVps(left: VpsIdentity, right: VpsIdentity): boolean {
  return canonicalVps(left) === canonicalVps(right);
}
export function parseVpsSample(value: unknown): VpsMetricsSample {
  const object = exactObject(value, [
    "identity",
    "windowStart",
    "windowEnd",
    "sampledAt",
    "requestCount",
    "fiveXxCount",
    "timeoutCount",
    "streamFailureCount",
    "upstreamWideFault",
    "coverage",
    "coverageDigest",
  ]);
  const start = count(object.windowStart),
    end = count(object.windowEnd),
    sampledAt = count(object.sampledAt);
  if (start >= end || end > sampledAt || (object.coverage !== "complete" && object.coverage !== "incomplete")) return invalidVps();
  const requests = object.requestCount === null ? null : count(object.requestCount);
  const failures = [object.fiveXxCount, object.timeoutCount, object.streamFailureCount].map((item) => (item === null ? null : count(item)));
  if (failures.some((item) => item !== null && (requests === null || item > requests))) return invalidVps();
  if (requests === null && object.upstreamWideFault !== null) return invalidVps();
  const coverageDigest = object.coverageDigest === null ? null : sha256(object.coverageDigest);
  if (object.coverage === "complete" && (requests === null || failures.includes(null) || coverageDigest === null || object.upstreamWideFault === null))
    return invalidVps();
  return {
    identity: parseVpsIdentity(object.identity),
    windowStart: start,
    windowEnd: end,
    sampledAt,
    requestCount: requests,
    fiveXxCount: failures[0],
    timeoutCount: failures[1],
    streamFailureCount: failures[2],
    upstreamWideFault: object.upstreamWideFault === null ? null : boolean(object.upstreamWideFault),
    coverage: object.coverage,
    coverageDigest,
  };
}
function parseReceiptIntent(value: unknown, createdAt: number, updatedAt: number): VpsReceipt["intent"] {
  if (value === null) return null;
  const item = exactObject(value, ["action", "persistedAt"]);
  if (item.action !== "promote" && item.action !== "rollback") return invalidVps();
  const persistedAt = count(item.persistedAt);
  if (persistedAt < createdAt || persistedAt > updatedAt) return invalidVps();
  return { action: item.action, persistedAt };
}
function parseReceiptRestoration(value: unknown, prior: VpsIdentity, createdAt: number): VpsReceipt["restoration"] {
  if (value === null) return null;
  const item = exactObject(value, ["loopback", "public"]);
  const restoration = { loopback: parseVpsHealth(item.loopback), public: parseVpsHealth(item.public) };
  for (const surface of ["loopback", "public"] as const) {
    const proof = restoration[surface];
    if (proof.surface !== surface || !sameVps(proof.identity, prior) || !isHealthyVps(proof) || proof.observedAt < createdAt) return invalidVps();
  }
  return restoration;
}
function parseReceiptHealth(value: unknown, surface: "loopback" | "public", identity: VpsIdentity): VpsHealthProof | null {
  if (value === null) return null;
  const proof = parseVpsHealth(value);
  if (proof.surface !== surface || !sameVps(proof.identity, identity)) return invalidVps();
  return proof;
}
export function parseVpsReceipt(value: unknown): VpsReceipt {
  const object = exactObject(value, [
    "schema",
    "kind",
    "abi",
    "operationId",
    "binding",
    "controllerSha",
    "driverSha256",
    "candidate",
    "prior",
    "phase",
    "sequence",
    "createdAt",
    "updatedAt",
    "intent",
    "loopback",
    "public",
    "restoration",
    "settlement",
    "error",
  ]);
  if (object.schema !== 1 || object.kind !== "vps_driver_receipt" || object.abi !== VPS_RELEASE_ABI || !VPS_PHASES.includes(object.phase as VpsPhase))
    return invalidVps();
  const candidate = parseVpsIdentity(object.candidate),
    prior = parseVpsSelector(object.prior),
    binding = parseVpsBinding(object.binding);
  if (candidate.gitSha !== binding.revision || sameVps(candidate, prior.identity)) return invalidVps();
  const createdAt = count(object.createdAt),
    updatedAt = count(object.updatedAt);
  if (updatedAt < createdAt) return invalidVps();
  const intent = parseReceiptIntent(object.intent, createdAt, updatedAt);
  const loopback = parseReceiptHealth(object.loopback, "loopback", candidate);
  const publicHealth = parseReceiptHealth(object.public, "public", candidate);
  const restoration = parseReceiptRestoration(object.restoration, prior.identity, createdAt);
  let settlement: VpsReceipt["settlement"] = null;
  if (object.settlement !== null) {
    const item = exactObject(object.settlement, ["stateRevision", "disposition", "digest"]);
    if (!["accepted", "rolled_back", "failed"].includes(String(item.disposition))) return invalidVps();
    settlement = {
      stateRevision: gitSha(item.stateRevision),
      disposition: item.disposition as NonNullable<VpsReceipt["settlement"]>["disposition"],
      digest: sha256(item.digest),
    };
  }
  const phase = object.phase as VpsPhase,
    sequence = count(object.sequence, 1),
    error = object.error === null ? null : boundedText(object.error, 128);
  const failedBeforePromotion =
    phase === "failed" &&
    sequence === 2 &&
    settlement?.disposition === "failed" &&
    error === "acceptance_insufficient" &&
    loopback === null &&
    publicHealth === null &&
    restoration === null;
  if (phase !== "prepared" && intent === null && !failedBeforePromotion) return invalidVps();
  if (phase === "accepted" && (!loopback || !publicHealth || !isHealthyVps(loopback) || !isHealthyVps(publicHealth) || settlement?.disposition !== "accepted"))
    return invalidVps();
  if (phase === "rolled_back" && restoration === null) return invalidVps();
  if (phase === "failed" && error === null) return invalidVps();
  return {
    schema: 1,
    kind: "vps_driver_receipt",
    abi: VPS_RELEASE_ABI,
    operationId: sha256(object.operationId),
    binding,
    controllerSha: gitSha(object.controllerSha),
    driverSha256: sha256(object.driverSha256),
    candidate,
    prior,
    phase,
    sequence,
    createdAt,
    updatedAt,
    intent,
    loopback,
    public: publicHealth,
    restoration,
    settlement,
    error,
  };
}
export function canonicalVps(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalVps).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalVps(object[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) return invalidVps();
  return JSON.stringify(value);
}
export async function vpsDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalVps(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function vpsOperationId(binding: VpsBinding): Promise<string> {
  return vpsDigest({ domain: VPS_RELEASE_ABI, binding: parseVpsBinding(binding) });
}

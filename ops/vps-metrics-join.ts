import { canonicalVps, exactObject, parseVpsIdentity, sha256, vpsDigest } from "./vps-release-contract.ts";
import {
  VPS_METRICS_MAX_ENTRIES,
  type VpsJoinCheckpoint,
  type VpsJoinCohort,
  type VpsMetricsOptions,
  type VpsMetricsRetention,
  type VpsMetricsScope,
} from "./vps-metrics-types.ts";

const refusal = (): never => {
  throw new Error("VPS telemetry checkpoint unavailable");
};
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return refusal();
  }
  return Number(value);
};
export function checkedRetention(value: unknown): VpsMetricsRetention {
  const object = exactObject(value, ["evidenceMaxAgeMs", "evidenceMaxBytes"]);
  if (count(object.evidenceMaxAgeMs) === 0 || count(object.evidenceMaxBytes) === 0) return refusal();
  return { evidenceMaxAgeMs: count(object.evidenceMaxAgeMs), evidenceMaxBytes: count(object.evidenceMaxBytes) };
}
export function checkedScope(scope: VpsMetricsScope): VpsMetricsScope {
  for (const key of ["operationId", "requestDigest", "driverSha256"] as const) sha256(scope[key]);
  if (!/^[0-9a-f]{40}$/.test(scope.controllerSha) || !/^[0-9a-f]{40}$/.test(scope.stateHead)) return refusal();
  parseVpsIdentity(scope.candidate);
  parseVpsIdentity(scope.prior);
  for (const key of ["monitoringStartedAt", "baselineStart", "baselineEnd", "stateSequence"] as const) count(scope[key]);
  if (scope.baselineStart >= scope.baselineEnd) return refusal();
  return scope;
}
export async function joinBinding(scope: VpsMetricsScope, retention: VpsMetricsRetention): Promise<string> {
  checkedScope(scope);
  checkedRetention(retention);
  return vpsDigest({
    schema: 1,
    operationId: scope.operationId,
    requestDigest: scope.requestDigest,
    controllerSha: scope.controllerSha,
    driverSha256: scope.driverSha256,
    candidate: scope.candidate,
    prior: scope.prior,
    retention,
  });
}
function checkedEvent(value: unknown, start: number, end: number, bootId: unknown): void {
  const event = exactObject(value, ["id", "at", "accepted", "status", "stream", "failure", "admissionStage", "cursor", "bootId", "digest"]);
  if (
    typeof event.id !== "string" ||
    !event.id ||
    event.id.length > 512 ||
    typeof event.at !== "number" ||
    !Number.isFinite(event.at) ||
    event.at < start ||
    event.at >= end ||
    typeof event.accepted !== "boolean" ||
    typeof event.stream !== "boolean" ||
    (event.failure !== null && typeof event.failure !== "string") ||
    ![null, "accepted", "pre_admission"].includes(event.admissionStage as string | null) ||
    typeof event.cursor !== "string" ||
    !event.cursor ||
    event.bootId !== bootId
  )
    return refusal();
  if (event.accepted ? event.status !== 0 : !Number.isInteger(event.status) || Number(event.status) < 100 || Number(event.status) > 599) return refusal();
  sha256(event.digest);
}
function parseCohort(value: unknown): VpsJoinCohort {
  const item = exactObject(value, ["identity", "windowStart", "windowEnd", "scanEnd", "scanStart", "events", "coverage", "bootId", "complete"]);
  const identity = parseVpsIdentity(item.identity);
  for (const key of ["windowStart", "windowEnd", "scanStart", "scanEnd"] as const) count(item[key]);
  if (
    Number(item.windowStart) >= Number(item.windowEnd) ||
    Number(item.scanStart) > Number(item.windowStart) ||
    Number(item.scanEnd) < Number(item.windowStart) ||
    typeof item.complete !== "boolean" ||
    (item.bootId !== null && (typeof item.bootId !== "string" || !item.bootId)) ||
    !Array.isArray(item.events) ||
    !Array.isArray(item.coverage)
  )
    return refusal();
  if (item.events.length > VPS_METRICS_MAX_ENTRIES * 2 || item.coverage.length > VPS_METRICS_MAX_ENTRIES) return refusal();
  for (const raw of item.events) checkedEvent(raw, Number(item.scanStart), Number(item.scanEnd), item.bootId);
  let chainStart = Number(item.scanStart);
  for (const raw of item.coverage) {
    const proof = exactObject(raw, ["complete", "unit", "windowStart", "windowEnd", "bootId", "firstCursor", "lastCursor", "digest"]);
    if (
      proof.complete !== true ||
      proof.unit !== "ai-ubq-fi.service" ||
      proof.bootId !== item.bootId ||
      typeof proof.firstCursor !== "string" ||
      !proof.firstCursor ||
      typeof proof.lastCursor !== "string" ||
      !proof.lastCursor ||
      count(proof.windowStart) !== chainStart ||
      count(proof.windowEnd) <= chainStart ||
      count(proof.windowEnd) - chainStart > 30_000
    )
      return refusal();
    sha256(proof.digest);
    chainStart = Number(proof.windowEnd);
  }
  if (chainStart !== item.scanEnd) return refusal();
  return { ...item, identity } as VpsJoinCohort;
}
export function parseJoinCheckpoint(value: unknown, binding: string, now: number, policy: VpsMetricsRetention): VpsJoinCheckpoint {
  const item = exactObject(value, [
    "schema",
    "binding",
    "sequence",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "monitoringStartedAt",
    "stateHead",
    "stateSequence",
    "cohorts",
  ]);
  if (
    item.schema !== 1 ||
    item.binding !== binding ||
    count(item.sequence) < 1 ||
    count(item.updatedAt) < count(item.createdAt) ||
    count(item.updatedAt) > now ||
    count(item.expiresAt) !== count(item.createdAt) + policy.evidenceMaxAgeMs ||
    now >= count(item.expiresAt) ||
    !Array.isArray(item.cohorts) ||
    item.cohorts.length > VPS_METRICS_MAX_ENTRIES
  )
    return refusal();
  count(item.monitoringStartedAt);
  if (typeof item.stateHead !== "string" || !/^[0-9a-f]{40}$/.test(item.stateHead)) return refusal();
  count(item.stateSequence);
  const cohorts = item.cohorts.map(parseCohort);
  if (new Set(cohorts.map((c) => `${c.identity.gitSha}:${c.windowStart}:${c.windowEnd}`)).size !== cohorts.length) return refusal();
  const unresolved = cohorts.reduce((total, cohort) => {
    const done = new Set(cohort.events.filter((e) => !e.accepted).map((e) => e.id));
    return total + cohort.events.filter((e) => e.accepted && !done.has(e.id)).length;
  }, 0);
  if (unresolved > VPS_METRICS_MAX_ENTRIES) return refusal();
  return { ...item, cohorts } as VpsJoinCheckpoint;
}
export class VpsJoinCheckpoints {
  constructor(
    private readonly _options: VpsMetricsOptions,
    private readonly _now: () => number
  ) {}
  async load(scope: VpsMetricsScope): Promise<{ checkpoint: VpsJoinCheckpoint; expected: number | null }> {
    const binding = await joinBinding(scope, this._options.retention),
      bytes = await this._options.storage.load(scope),
      now = this._now();
    if (bytes === null)
      return {
        expected: null,
        checkpoint: {
          schema: 1,
          binding,
          sequence: 0,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + this._options.retention.evidenceMaxAgeMs,
          monitoringStartedAt: scope.monitoringStartedAt,
          stateHead: scope.stateHead,
          stateSequence: scope.stateSequence,
          cohorts: [],
        },
      };
    if (bytes.byteLength > this._options.retention.evidenceMaxBytes) return refusal();
    const plain = await this._options.cipher.open(bytes, new TextEncoder().encode(binding));
    try {
      if (plain.byteLength > this._options.retention.evidenceMaxBytes) return refusal();
      const checkpoint = parseJoinCheckpoint(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)), binding, now, this._options.retention);
      const historical = await this._options.context(
        { identity: scope.candidate, windowStart: checkpoint.monitoringStartedAt, windowEnd: checkpoint.monitoringStartedAt + 30_000 },
        { stateHead: checkpoint.stateHead, stateSequence: checkpoint.stateSequence }
      );
      if (
        (await joinBinding(historical, this._options.retention)) !== binding ||
        historical.monitoringStartedAt !== checkpoint.monitoringStartedAt ||
        historical.stateHead !== checkpoint.stateHead ||
        historical.stateSequence !== checkpoint.stateSequence
      )
        return refusal();
      if (checkpoint.monitoringStartedAt !== scope.monitoringStartedAt) {
        checkpoint.monitoringStartedAt = scope.monitoringStartedAt;
        checkpoint.cohorts = [];
      }
      return { checkpoint, expected: checkpoint.sequence };
    } finally {
      plain.fill(0);
    }
  }
  async save(scope: VpsMetricsScope, checkpoint: VpsJoinCheckpoint, expected: number | null): Promise<void> {
    const next = parseJoinCheckpoint(
      { ...checkpoint, sequence: (expected ?? 0) + 1, updatedAt: this._now(), stateHead: scope.stateHead, stateSequence: scope.stateSequence },
      checkpoint.binding,
      this._now(),
      this._options.retention
    );
    const plain = new TextEncoder().encode(canonicalVps(next));
    try {
      if (plain.byteLength > this._options.retention.evidenceMaxBytes) return refusal();
      const cipher = await this._options.cipher.seal(plain, new TextEncoder().encode(next.binding));
      if (cipher.byteLength > this._options.retention.evidenceMaxBytes || !(await this._options.storage.save(scope, expected, cipher))) return refusal();
    } finally {
      plain.fill(0);
    }
  }
}

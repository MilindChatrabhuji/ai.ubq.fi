import { canonicalVps, exactObject, parseVpsIdentity, sameVps, sha256, vpsDigest, type VpsIdentity } from "./vps-release-contract.ts";
import {
  VPS_METRICS_MAX_ENTRIES,
  VPS_METRICS_SLICE_MS,
  type VpsJoinCheckpoint,
  type VpsJoinCohort,
  type VpsJoinLedger,
  type VpsJoinSlice,
  type VpsJoinSummary,
  type VpsJournalCoverage,
  type VpsMetricEvent,
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
const sliceStart = (slice: VpsJoinSlice) => slice.coverage.windowStart;
const sliceEnd = (slice: VpsJoinSlice) => slice.coverage.windowEnd;
/** The ledger slices that exactly tile `[start, end)`, or null when a gap or a straddling slice breaks the chain. */
export function tiledSlices(ledger: VpsJoinLedger, start: number, end: number): VpsJoinSlice[] | null {
  const tiles: VpsJoinSlice[] = [];
  let next = start;
  for (const slice of ledger.slices) {
    if (next >= end) break;
    if (sliceEnd(slice) <= next) continue;
    if (sliceStart(slice) !== next) return null;
    tiles.push(slice);
    next = sliceEnd(slice);
  }
  return next === end ? tiles : null;
}
/** The ledger of one identity, created empty on first use. */
export function joinLedger(checkpoint: VpsJoinCheckpoint, identity: VpsIdentity, retainFrom: number): VpsJoinLedger {
  const found = checkpoint.ledgers.find((ledger) => sameVps(ledger.identity, identity));
  if (found) return found;
  const created: VpsJoinLedger = { identity, retainFrom, slices: [] };
  checkpoint.ledgers.push(created);
  return created;
}
/** Adds a freshly read slice in order. Reads only ever fill gaps, so an overlap is an invariant failure. */
export function insertSlice(ledger: VpsJoinLedger, slice: VpsJoinSlice): void {
  const index = ledger.slices.findIndex((item) => sliceStart(item) >= sliceEnd(slice));
  const at = index < 0 ? ledger.slices.length : index;
  if (at > 0 && sliceEnd(ledger.slices[at - 1]) > sliceStart(slice)) return refusal();
  ledger.slices.splice(at, 0, slice);
}
/**
 * Drops slices no cohort can still adopt: those that end before every incomplete cohort of the identity and before the
 * most recently scanned one, whose reach the next window is expected to share. Pruning never changes a result; a later
 * cohort that needs a pruned slice reads it again.
 */
export function pruneJoinLedgers(checkpoint: VpsJoinCheckpoint): void {
  for (const ledger of checkpoint.ledgers) {
    let keepFrom = ledger.retainFrom;
    for (const cohort of checkpoint.cohorts)
      if (cohort.summary === null && sameVps(cohort.identity, ledger.identity)) keepFrom = Math.min(keepFrom, cohort.scanStart);
    ledger.slices = ledger.slices.filter((slice) => sliceEnd(slice) > keepFrom);
  }
  checkpoint.ledgers = checkpoint.ledgers.filter((ledger) => ledger.slices.length > 0);
}
function checkedEvent(value: unknown, start: number, end: number): VpsMetricEvent {
  const event = exactObject(value, ["id", "at", "accepted", "status", "stream", "failure", "admissionStage", "latencyMs", "digest"]);
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
    (event.latencyMs !== null && count(event.latencyMs) !== event.latencyMs)
  )
    return refusal();
  if (event.accepted ? event.status !== 0 : !Number.isInteger(event.status) || Number(event.status) < 100 || Number(event.status) > 599) return refusal();
  sha256(event.digest);
  return event as VpsMetricEvent;
}
function parseSlice(value: unknown): VpsJoinSlice {
  const item = exactObject(value, ["coverage", "events"]);
  const proof = exactObject(item.coverage, ["complete", "unit", "windowStart", "windowEnd", "bootId", "firstCursor", "lastCursor", "digest"]);
  const start = count(proof.windowStart),
    end = count(proof.windowEnd);
  if (
    proof.complete !== true ||
    proof.unit !== "ai-ubq-fi.service" ||
    end <= start ||
    end - start > VPS_METRICS_SLICE_MS ||
    typeof proof.bootId !== "string" ||
    !proof.bootId ||
    typeof proof.firstCursor !== "string" ||
    !proof.firstCursor ||
    typeof proof.lastCursor !== "string" ||
    !proof.lastCursor ||
    !Array.isArray(item.events) ||
    item.events.length > VPS_METRICS_MAX_ENTRIES
  )
    return refusal();
  sha256(proof.digest);
  return { coverage: proof as VpsJournalCoverage, events: item.events.map((event) => checkedEvent(event, start, end)) };
}
function parseLedger(value: unknown): VpsJoinLedger {
  const item = exactObject(value, ["identity", "retainFrom", "slices"]);
  if (!Array.isArray(item.slices) || item.slices.length > VPS_METRICS_MAX_ENTRIES) return refusal();
  const slices = item.slices.map(parseSlice);
  for (let index = 1; index < slices.length; index++) if (sliceStart(slices[index]) < sliceEnd(slices[index - 1])) return refusal();
  return { identity: parseVpsIdentity(item.identity), retainFrom: count(item.retainFrom), slices };
}
function parseSummary(value: unknown): VpsJoinSummary | null {
  if (value === null) return null;
  const item = exactObject(value, ["requests", "fiveXx", "streamFailures", "failures", "coverageDigest"]);
  const requests = count(item.requests);
  if (count(item.fiveXx) > requests || count(item.streamFailures) > requests || !Array.isArray(item.failures)) return refusal();
  let previous: string | null = null,
    total = 0;
  for (const entry of item.failures as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || (previous !== null && entry[0] <= previous) || count(entry[1]) < 1)
      return refusal();
    previous = entry[0];
    total += Number(entry[1]);
  }
  if (total > requests) return refusal();
  sha256(item.coverageDigest);
  return item as VpsJoinSummary;
}
function parseCohort(value: unknown, ledgers: readonly VpsJoinLedger[]): VpsJoinCohort {
  const item = exactObject(value, ["identity", "windowStart", "windowEnd", "scanStart", "scanEnd", "bootId", "summary"]);
  const identity = parseVpsIdentity(item.identity);
  for (const key of ["windowStart", "windowEnd", "scanStart", "scanEnd"] as const) count(item[key]);
  const cohort = { ...item, identity, summary: parseSummary(item.summary) } as VpsJoinCohort;
  if (
    cohort.windowEnd - cohort.windowStart !== VPS_METRICS_SLICE_MS ||
    cohort.scanStart > cohort.windowStart ||
    cohort.scanEnd < cohort.windowStart ||
    (cohort.bootId !== null && (typeof cohort.bootId !== "string" || !cohort.bootId)) ||
    (cohort.summary !== null && (cohort.scanEnd < cohort.windowEnd || cohort.bootId === null))
  )
    return refusal();
  if (cohort.summary === null) {
    // An incomplete cohort's range must still be proven by its ledger; a completed one keeps only its summary.
    const ledger = ledgers.find((entry) => sameVps(entry.identity, identity)) ?? { identity, retainFrom: 0, slices: [] };
    const tiles = tiledSlices(ledger, cohort.scanStart, cohort.scanEnd);
    if (tiles === null || (tiles.length === 0) !== (cohort.bootId === null) || tiles.some((slice) => slice.coverage.bootId !== cohort.bootId)) return refusal();
  }
  return cohort;
}
/** Validates structure, binding and bounds. Freshness is separate: a restarted monitoring period replaces an expired checkpoint. */
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
    "ledgers",
    "cohorts",
  ]);
  if (
    item.schema !== 2 ||
    item.binding !== binding ||
    count(item.sequence) < 1 ||
    count(item.updatedAt) < count(item.createdAt) ||
    count(item.updatedAt) > now ||
    count(item.expiresAt) !== count(item.createdAt) + policy.evidenceMaxAgeMs ||
    !Array.isArray(item.ledgers) ||
    item.ledgers.length > 2 ||
    !Array.isArray(item.cohorts) ||
    item.cohorts.length > VPS_METRICS_MAX_ENTRIES
  )
    return refusal();
  count(item.monitoringStartedAt);
  if (typeof item.stateHead !== "string" || !/^[0-9a-f]{40}$/.test(item.stateHead)) return refusal();
  count(item.stateSequence);
  const ledgers = item.ledgers.map(parseLedger);
  if (ledgers.length === 2 && sameVps(ledgers[0].identity, ledgers[1].identity)) return refusal();
  const cohorts = item.cohorts.map((cohort) => parseCohort(cohort, ledgers));
  if (new Set(cohorts.map((cohort) => `${canonicalVps(cohort.identity)}:${cohort.windowStart}`)).size !== cohorts.length) return refusal();
  const unresolved = ledgers.reduce((total, ledger) => {
    const events = ledger.slices.flatMap((slice) => slice.events);
    const done = new Set(events.filter((event) => !event.accepted).map((event) => event.id));
    return total + events.filter((event) => event.accepted && !done.has(event.id)).length;
  }, 0);
  if (unresolved > VPS_METRICS_MAX_ENTRIES) return refusal();
  return { ...item, ledgers, cohorts } as VpsJoinCheckpoint;
}
export function freshJoinCheckpoint(checkpoint: VpsJoinCheckpoint, now: number): VpsJoinCheckpoint {
  if (now >= checkpoint.expiresAt) return refusal();
  return checkpoint;
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
    const fresh = (sequence: number): VpsJoinCheckpoint => ({
      schema: 2,
      binding,
      sequence,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this._options.retention.evidenceMaxAgeMs,
      monitoringStartedAt: scope.monitoringStartedAt,
      stateHead: scope.stateHead,
      stateSequence: scope.stateSequence,
      ledgers: [],
      cohorts: [],
    });
    if (bytes === null) return { expected: null, checkpoint: fresh(0) };
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
      // A restarted monitoring period starts new evidence with a new expiry; only the storage sequence carries over.
      if (checkpoint.monitoringStartedAt !== scope.monitoringStartedAt) return { checkpoint: fresh(checkpoint.sequence), expected: checkpoint.sequence };
      return { checkpoint: freshJoinCheckpoint(checkpoint, now), expected: checkpoint.sequence };
    } finally {
      plain.fill(0);
    }
  }
  async save(scope: VpsMetricsScope, checkpoint: VpsJoinCheckpoint, expected: number | null): Promise<void> {
    const now = this._now();
    const next = freshJoinCheckpoint(
      parseJoinCheckpoint(
        { ...checkpoint, sequence: (expected ?? 0) + 1, updatedAt: now, stateHead: scope.stateHead, stateSequence: scope.stateSequence },
        checkpoint.binding,
        now,
        this._options.retention
      ),
      now
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

import {
  canonicalVps,
  exactObject,
  parseVpsIdentity,
  parseVpsSample,
  sameVps,
  sha256,
  vpsDigest,
  type VpsIdentity,
  type VpsMetricsSample,
} from "./vps-release-contract.ts";
import { VpsJoinCheckpoints, checkedRetention, checkedScope } from "./vps-metrics-join.ts";
import {
  VpsQueryBudgetError,
  VPS_METRICS_MAX_BYTES,
  VPS_METRICS_MAX_ENTRIES,
  VPS_METRICS_SLICE_MS,
  VPS_METRICS_TICK_MS,
  VPS_METRICS_TICK_SLICES,
  type VpsJournalCoverage,
  type VpsJournalReader,
  type VpsJournalRequest,
  type VpsJoinCohort,
  type VpsMetricEvent,
  type VpsMetricsOptions,
  type VpsMetricsProgress,
  type VpsQueryLimits,
} from "./vps-metrics-types.ts";
export { createVpsJournalReader, runVpsJournalCommand } from "./vps-journal-reader.ts";
export type { VpsJournalCoverage, VpsJournalReader, VpsJournalRequest, VpsMetricsOptions } from "./vps-metrics-types.ts";
const incomplete = (): never => {
  throw new Error("VPS journal coverage is incomplete");
};
function parseCoverage(value: unknown, start: number, end: number): VpsJournalCoverage {
  if (value === null || typeof value !== "object") return incomplete();
  const proof = value as Record<string, unknown>;
  if (proof.complete !== true || proof.unit !== "ai-ubq-fi.service" || proof.windowStart !== start || proof.windowEnd !== end) return incomplete();
  for (const key of ["bootId", "firstCursor", "lastCursor"] as const) if (typeof proof[key] !== "string" || !proof[key]) return incomplete();
  sha256(proof.digest);
  return proof as VpsJournalCoverage;
}
function checkedRow(line: string, proof: VpsJournalCoverage): { message: string; at: number; cursor: string } {
  const row = JSON.parse(line) as Record<string, unknown>;
  if (
    row._SYSTEMD_UNIT !== proof.unit ||
    row._BOOT_ID !== proof.bootId ||
    typeof row.__CURSOR !== "string" ||
    !row.__CURSOR ||
    typeof row.__REALTIME_TIMESTAMP !== "string" ||
    typeof row.MESSAGE !== "string"
  )
    return incomplete();
  if (/^(?:Suppressed \d+ messages from .+|Missed \d+ kernel messages)$/.test(row.MESSAGE)) return incomplete();
  const at = Number(row.__REALTIME_TIMESTAMP) / 1000;
  if (!Number.isFinite(at) || at < proof.windowStart || at >= proof.windowEnd) return incomplete();
  return { message: row.MESSAGE, at, cursor: row.__CURSOR };
}
function checkedTerminal(value: Record<string, unknown>, status: number): void {
  if (
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    (value.stream !== null && typeof value.stream !== "boolean") ||
    (value.failure_kind !== null && typeof value.failure_kind !== "string")
  )
    return incomplete();
}
async function projectedEvent(row: { message: string; at: number; cursor: string }, bootId: string, identity: VpsIdentity): Promise<VpsMetricEvent | null> {
  const match = /^\[ai\.ubq\.fi\] request_(accepted|terminal) (\{.*\})$/.exec(row.message);
  if (!match) return null;
  const value = JSON.parse(match[2]) as Record<string, unknown>;
  if (
    typeof value.request_id !== "string" ||
    !value.request_id ||
    value.request_id.length > 512 ||
    typeof value.git_sha !== "string" ||
    typeof value.deno_revision !== "string"
  )
    return incomplete();
  if (value.git_sha !== identity.gitSha || value.deno_revision !== identity.deploymentId) return null;
  const accepted = match[1] === "accepted",
    status = accepted ? 0 : Number(value.status);
  const stage = accepted ? "accepted" : (value.admission_stage ?? null);
  if (![null, "accepted", "pre_admission"].includes(stage as string | null)) return incomplete();
  if (!accepted) checkedTerminal(value, status);
  const projection = {
    id: value.request_id,
    at: row.at,
    accepted,
    status,
    stream: value.stream === true,
    failure: typeof value.failure_kind === "string" ? value.failure_kind : null,
    admissionStage: stage as VpsMetricEvent["admissionStage"],
    cursor: row.cursor,
    bootId,
  };
  return { ...projection, digest: await vpsDigest(projection) };
}
async function journalEvents(raw: string, proof: VpsJournalCoverage, identity: VpsIdentity): Promise<VpsMetricEvent[]> {
  if (new TextEncoder().encode(raw).byteLength > VPS_METRICS_MAX_BYTES) return incomplete();
  const lines = raw.split("\n").filter((line) => line.length > 0);
  if (lines.length > VPS_METRICS_MAX_ENTRIES) return incomplete();
  const events: VpsMetricEvent[] = [];
  for (const line of lines) {
    const event = await projectedEvent(checkedRow(line, proof), proof.bootId, identity);
    if (event) events.push(event);
  }
  return events;
}
function checkedOptions(value: unknown): VpsMetricsOptions {
  const object = exactObject(value, ["retention", "context", "storage", "cipher", "deadline"]);
  if (typeof object.context !== "function" || !Number.isSafeInteger(object.deadline)) throw new TypeError("VPS telemetry capabilities are invalid");
  for (const [name, methods] of [
    ["storage", ["load", "save"]],
    ["cipher", ["seal", "open"]],
  ] as const) {
    const capability = object[name];
    if (capability === null || typeof capability !== "object") throw new TypeError("VPS telemetry capability absent");
    for (const method of methods)
      if (typeof (capability as Record<string, unknown>)[method] !== "function") throw new TypeError("VPS telemetry capability absent");
  }
  checkedRetention(object.retention);
  return object as VpsMetricsOptions;
}
function joined(cohort: VpsJoinCohort): { results: VpsMetricEvent[]; pending: boolean; orphan: boolean } {
  const accepted = new Map<string, VpsMetricEvent>(),
    terminals = new Map<string, VpsMetricEvent>();
  for (const event of cohort.events) {
    const target = event.accepted ? accepted : terminals,
      previous = target.get(event.id);
    if (
      previous &&
      (previous.status !== event.status ||
        previous.failure !== event.failure ||
        previous.admissionStage !== event.admissionStage ||
        previous.at !== event.at ||
        previous.stream !== event.stream)
    )
      return incomplete();
    target.set(event.id, event);
  }
  for (const terminal of terminals.values()) if (terminal.admissionStage === "pre_admission" && accepted.has(terminal.id)) return incomplete();
  const members = [...accepted.values()].filter((event) => event.at >= cohort.windowStart && event.at < cohort.windowEnd);
  const results = members.flatMap((event) => {
    const terminal = terminals.get(event.id);
    return terminal ? [terminal] : [];
  });
  const orphan = [...terminals.values()].some((event) => !accepted.has(event.id) && event.admissionStage !== "pre_admission");
  return { results, pending: results.length !== members.length, orphan };
}
const sampleKey = (input: VpsJournalRequest) => `${canonicalVps(input.identity)}:${input.windowStart}:${input.windowEnd}`;
export class VpsJournalMetrics {
  private _deadline = 0;
  private _slices = 0;
  private readonly _states = new Map<string, VpsMetricsProgress>();
  private readonly _checkpoints: VpsJoinCheckpoints;
  private readonly _options: VpsMetricsOptions;
  constructor(
    private readonly _reader: VpsJournalReader,
    private readonly _now: () => number,
    private readonly _lagMs: number,
    private readonly _timeoutKinds: readonly string[],
    private readonly _upstreamWideKinds: readonly string[],
    options: unknown
  ) {
    if (!Number.isSafeInteger(this._lagMs) || this._lagMs < 0 || this._timeoutKinds.length > 32 || this._upstreamWideKinds.length > 32)
      throw new TypeError("VPS telemetry capabilities are invalid");
    this._options = checkedOptions(options);
    this._checkpoints = new VpsJoinCheckpoints(this._options, this._now);
  }
  beginTick(observedAt: number): void {
    if (!Number.isSafeInteger(observedAt) || observedAt > this._now()) throw new TypeError("VPS telemetry tick is invalid");
    this._deadline = Math.min(this._options.deadline, observedAt + VPS_METRICS_TICK_MS);
    this._slices = VPS_METRICS_TICK_SLICES;
    this._states.clear();
  }
  progress(input: VpsJournalRequest): Promise<VpsMetricsProgress> {
    return Promise.resolve(this._states.get(sampleKey(input)) ?? { state: "unavailable", reason: "sample_missing" });
  }
  private _limits(): VpsQueryLimits {
    return { deadline: this._deadline, maxBytes: VPS_METRICS_MAX_BYTES, maxEntries: VPS_METRICS_MAX_ENTRIES };
  }
  private async _read(cohort: VpsJoinCohort, start: number, end: number, backward: boolean): Promise<void> {
    this._slices--;
    const limits = this._limits();
    const proof = parseCoverage(await this._reader.coverage(start, end, limits), start, end);
    if (this._now() >= this._deadline) throw new VpsQueryBudgetError();
    if (cohort.bootId !== null && cohort.bootId !== proof.bootId) return incomplete();
    const events = await journalEvents(await this._reader.read(start, end, limits), proof, cohort.identity);
    if (this._now() >= this._deadline) throw new VpsQueryBudgetError();
    const cursors = new Map(cohort.events.map((event) => [event.cursor, event]));
    for (const event of events) {
      const previous = cursors.get(event.cursor);
      if (previous && canonicalVps(previous) !== canonicalVps(event)) return incomplete();
      if (!previous) {
        cohort.events.push(event);
        cursors.set(event.cursor, event);
      }
    }
    if (cohort.events.length > VPS_METRICS_MAX_ENTRIES * 2) return incomplete();
    cohort.bootId = proof.bootId;
    if (backward) {
      cohort.scanStart = start;
      cohort.coverage.unshift(proof);
    } else {
      cohort.scanEnd = end;
      cohort.coverage.push(proof);
    }
    joined(cohort);
  }
  private async _advance(cohort: VpsJoinCohort, floor: number, availableEnd: number, orphan: boolean): Promise<boolean> {
    if (cohort.scanEnd >= cohort.windowEnd && orphan) {
      if (cohort.scanStart <= floor) return incomplete();
      await this._read(cohort, Math.max(floor, cohort.scanStart - VPS_METRICS_SLICE_MS), cohort.scanStart, true);
      return true;
    }
    if (cohort.scanEnd >= availableEnd) return false;
    await this._read(cohort, cohort.scanEnd, Math.min(availableEnd, cohort.scanEnd + VPS_METRICS_SLICE_MS), false);
    return true;
  }
  private async _scan(cohort: VpsJoinCohort, floor: number, availableEnd: number) {
    let result = joined(cohort);
    while (!cohort.complete && this._slices > 0 && this._now() < this._deadline) {
      if (cohort.scanEnd >= cohort.windowEnd && !result.orphan && !result.pending) {
        cohort.complete = true;
        break;
      }
      try {
        if (!(await this._advance(cohort, floor, availableEnd, result.orphan))) break;
      } catch (error) {
        if (error instanceof VpsQueryBudgetError) break;
        throw error;
      }
      result = joined(cohort);
    }
    if (cohort.scanEnd >= cohort.windowEnd && !result.orphan && !result.pending) cohort.complete = true;

    return result;
  }
  private async _scope(input: VpsJournalRequest, identity: VpsIdentity, sampledAt: number) {
    const scope = checkedScope(await this._options.context(input));
    const candidate = sameVps(identity, scope.candidate),
      prior = sameVps(identity, scope.prior);
    if (
      (!candidate && !prior) ||
      (candidate && (input.windowStart < scope.monitoringStartedAt || input.windowEnd > scope.monitoringStartedAt + 60 * VPS_METRICS_SLICE_MS)) ||
      (prior && (input.windowStart < scope.baselineStart || input.windowEnd > scope.baselineEnd))
    )
      return incomplete();
    const floor = Math.max(0, sampledAt - this._options.retention.evidenceMaxAgeMs);
    if (input.windowStart < floor) return incomplete();

    return { scope, floor };
  }
  async sample(input: VpsJournalRequest): Promise<VpsMetricsSample> {
    const identity = parseVpsIdentity(input.identity),
      sampledAt = this._now(),
      key = sampleKey(input);
    if (
      !Number.isSafeInteger(input.windowStart) ||
      input.windowStart < 0 ||
      !Number.isSafeInteger(input.windowEnd) ||
      input.windowEnd - input.windowStart !== VPS_METRICS_SLICE_MS ||
      input.windowEnd > sampledAt
    )
      throw new TypeError("VPS telemetry window is invalid");
    const missing = (): VpsMetricsSample =>
      parseVpsSample({
        ...input,
        identity,
        sampledAt,
        requestCount: null,
        fiveXxCount: null,
        timeoutCount: null,
        streamFailureCount: null,
        upstreamWideFault: null,
        coverage: "incomplete",
        coverageDigest: null,
      });
    this._states.set(key, { state: "unavailable", reason: "coverage_missing" });
    try {
      const { scope, floor } = await this._scope(input, identity, sampledAt);
      const loaded = await this._checkpoints.load(scope),
        checkpoint = loaded.checkpoint;
      let cohort = checkpoint.cohorts.find(
        (item) => sameVps(item.identity, identity) && item.windowStart === input.windowStart && item.windowEnd === input.windowEnd
      );
      if (!cohort) {
        cohort = {
          identity,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          scanStart: input.windowStart,
          scanEnd: input.windowStart,
          events: [],
          coverage: [],
          bootId: null,
          complete: false,
        };
        checkpoint.cohorts.push(cohort);
      }
      const availableEnd = sampledAt - this._lagMs;
      const result = await this._scan(cohort, floor, availableEnd);
      if (canonicalVps(await this._options.context(input)) !== canonicalVps(scope)) return incomplete();
      await this._checkpoints.save(scope, checkpoint, loaded.expected);
      this._states.set(key, { state: cohort.complete ? "complete" : "collecting", reason: cohort.complete ? null : "terminal_or_slice_pending" });
      if (!cohort.complete) return missing();
      return parseVpsSample({
        ...input,
        identity,
        sampledAt,
        requestCount: result.results.length,
        fiveXxCount: result.results.filter((event) => event.status >= 500).length,
        timeoutCount: result.results.filter((event) => event.failure !== null && this._timeoutKinds.includes(event.failure)).length,
        streamFailureCount: result.results.filter((event) => event.stream && event.failure !== null).length,
        upstreamWideFault: result.results.some((event) => event.failure !== null && this._upstreamWideKinds.includes(event.failure)),
        coverage: "complete",
        coverageDigest: await vpsDigest({
          binding: checkpoint.binding,
          identity,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          coverage: cohort.coverage,
          events: cohort.events,
        }),
      });
    } catch {
      return missing();
    }
  }
}

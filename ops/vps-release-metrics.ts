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
import { VpsJoinCheckpoints, checkedRetention, checkedScope, insertSlice, joinLedger, pruneJoinLedgers, tiledSlices } from "./vps-metrics-join.ts";
import {
  VpsQueryBudgetError,
  VPS_METRICS_COHORT_TICK_SLICES,
  VPS_METRICS_MAX_BYTES,
  VPS_METRICS_MAX_ENTRIES,
  VPS_METRICS_SLICE_MS,
  VPS_METRICS_TICK_MS,
  VPS_METRICS_TICK_SLICES,
  type VpsJournalCoverage,
  type VpsJournalReader,
  type VpsJournalRequest,
  type VpsJoinCheckpoint,
  type VpsJoinCohort,
  type VpsJoinLedger,
  type VpsJoinSlice,
  type VpsJoinSummary,
  type VpsMetricEvent,
  type VpsMetricsOptions,
  type VpsMetricsProgress,
  type VpsQueryLimits,
} from "./vps-metrics-types.ts";
/** @public Standalone Sentinel's pinned VPS bridge composes its actual unit-scoped journal reader here. */
export { createVpsJournalReader, runVpsJournalCommand } from "./vps-journal-reader.ts";
/** @public The bridge's independent coverage proof and telemetry capabilities use these shapes. */
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
/** A row's MESSAGE as text, or null when it cannot be a request row. */
function journalMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  // journalctl writes a field holding unprintable or non-UTF-8 bytes as an array of byte values.
  if (Array.isArray(value) && value.length <= VPS_METRICS_MAX_BYTES && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(value as number[]));
    } catch {
      // A request row is JSON text written as UTF-8, so bytes that do not decode cannot be one.
      return null;
    }
  }
  // A null MESSAGE is a field journalctl did not print in full, which could hide a request row.
  return incomplete();
}
function checkedRow(line: string, proof: VpsJournalCoverage): { message: string; at: number; cursor: string } | null {
  const row = JSON.parse(line) as Record<string, unknown>;
  if (row._BOOT_ID !== proof.bootId || typeof row.__CURSOR !== "string" || !row.__CURSOR || typeof row.__REALTIME_TIMESTAMP !== "string") return incomplete();
  const at = Number(row.__REALTIME_TIMESTAMP) / 1000;
  if (!Number.isFinite(at) || at < proof.windowStart || at >= proof.windowEnd) return incomplete();
  if (row._SYSTEMD_UNIT !== proof.unit) {
    // `--unit` also returns PID 1's own messages about the unit, such as the driver's restart. They are never request rows.
    if (row._PID === "1" && row.UNIT === proof.unit) return null;
    return incomplete();
  }
  const message = journalMessage(row.MESSAGE);
  if (message === null) return null;
  if (/^(?:Suppressed \d+ messages from .+|Missed \d+ kernel messages)$/.test(message)) return incomplete();
  return { message, at, cursor: row.__CURSOR };
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
  const latency = accepted ? null : value.latency_ms;
  const projection = {
    id: value.request_id,
    at: row.at,
    accepted,
    status,
    stream: value.stream === true,
    failure: typeof value.failure_kind === "string" ? value.failure_kind : null,
    admissionStage: stage as VpsMetricEvent["admissionStage"],
    latencyMs: Number.isSafeInteger(latency) && Number(latency) >= 0 ? Number(latency) : null,
  };
  return { ...projection, digest: await vpsDigest({ ...projection, cursor: row.cursor, bootId }) };
}
async function journalEvents(raw: string, proof: VpsJournalCoverage, identity: VpsIdentity): Promise<VpsMetricEvent[]> {
  if (new TextEncoder().encode(raw).byteLength > VPS_METRICS_MAX_BYTES) return incomplete();
  const lines = raw.split("\n").filter((line) => line.length > 0);
  if (lines.length > VPS_METRICS_MAX_ENTRIES) return incomplete();
  const events: VpsMetricEvent[] = [];
  for (const line of lines) {
    const row = checkedRow(line, proof);
    const event = row ? await projectedEvent(row, proof.bootId, identity) : null;
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
const sameFacts = (left: VpsMetricEvent, right: VpsMetricEvent) =>
  left.status === right.status &&
  left.failure === right.failure &&
  left.admissionStage === right.admissionStage &&
  left.at === right.at &&
  left.stream === right.stream &&
  left.latencyMs === right.latencyMs;
type Joined = { members: [VpsMetricEvent, VpsMetricEvent][]; pending: boolean; orphanFloor: number | null };
/** Admissions and terminals by request id; a request id seen twice must carry the same facts both times. */
function indexed(slices: readonly VpsJoinSlice[]): { accepted: Map<string, VpsMetricEvent>; terminals: Map<string, VpsMetricEvent> } {
  const accepted = new Map<string, VpsMetricEvent>(),
    terminals = new Map<string, VpsMetricEvent>();
  const events = slices.flatMap((slice) => slice.events);
  if (events.length > VPS_METRICS_MAX_ENTRIES * 2) return incomplete();
  for (const event of events) {
    const target = event.accepted ? accepted : terminals,
      previous = target.get(event.id);
    if (previous && !sameFacts(previous, event)) return incomplete();
    target.set(event.id, event);
  }
  for (const terminal of terminals.values()) if (terminal.admissionStage === "pre_admission" && accepted.has(terminal.id)) return incomplete();
  return { accepted, terminals };
}
function joined(cohort: VpsJoinCohort, slices: readonly VpsJoinSlice[], floor: number): Joined {
  const { accepted, terminals } = indexed(slices);
  const admissions = [...accepted.values()].filter((event) => event.at >= cohort.windowStart && event.at < cohort.windowEnd);
  const members = admissions.flatMap((event): [VpsMetricEvent, VpsMetricEvent][] => {
    const terminal = terminals.get(event.id);
    return terminal ? [[event, terminal]] : [];
  });
  // Only a terminal at or after windowStart can hide a lost admission of this window; earlier ones belong to earlier
  // requests. Its admission lies within its own reported lifetime before it, plus one slice for journal and clock skew.
  // Once the scan has passed that point (or the retention floor) without finding it, the admission is lost.
  let orphanFloor: number | null = null;
  for (const terminal of terminals.values()) {
    if (terminal.at < cohort.windowStart || accepted.has(terminal.id) || terminal.admissionStage === "pre_admission") continue;
    if (terminal.latencyMs === null) return incomplete();
    orphanFloor = Math.max(orphanFloor ?? floor, terminal.at - terminal.latencyMs - VPS_METRICS_SLICE_MS);
  }
  return { members, pending: members.length !== admissions.length, orphanFloor };
}
async function summarized(
  binding: string,
  cohort: VpsJoinCohort,
  slices: readonly VpsJoinSlice[],
  members: readonly [VpsMetricEvent, VpsMetricEvent][]
): Promise<VpsJoinSummary> {
  const failures = new Map<string, number>();
  for (const [, terminal] of members) if (terminal.failure !== null) failures.set(terminal.failure, (failures.get(terminal.failure) ?? 0) + 1);
  return {
    requests: members.length,
    fiveXx: members.filter(([, terminal]) => terminal.status >= 500).length,
    streamFailures: members.filter(([, terminal]) => terminal.stream && terminal.failure !== null).length,
    failures: [...failures].sort(([left], [right]) => (left < right ? -1 : 1)),
    coverageDigest: await vpsDigest({
      binding,
      identity: cohort.identity,
      windowStart: cohort.windowStart,
      windowEnd: cohort.windowEnd,
      scanStart: cohort.scanStart,
      scanEnd: cohort.scanEnd,
      coverage: slices.map((slice) => slice.coverage),
      members: members.map(([admission, terminal]) => [admission.digest, terminal.digest]),
    }),
  };
}
/** A new window that starts inside a slice another cohort already proved begins from that whole slice. */
function anchored(ledger: VpsJoinLedger, cohort: VpsJoinCohort): void {
  if (cohort.scanStart !== cohort.scanEnd) return;
  const holding = ledger.slices.find((slice) => slice.coverage.windowStart < cohort.scanEnd && cohort.scanEnd < slice.coverage.windowEnd);
  if (!holding) return;
  cohort.scanStart = holding.coverage.windowStart;
  cohort.scanEnd = holding.coverage.windowEnd;
  cohort.bootId = holding.coverage.bootId;
}
function cohortFor(checkpoint: VpsJoinCheckpoint, input: VpsJournalRequest, identity: VpsIdentity): VpsJoinCohort {
  const found = checkpoint.cohorts.find((item) => sameVps(item.identity, identity) && item.windowStart === input.windowStart);
  if (found) return found;
  const created: VpsJoinCohort = {
    identity,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    scanStart: input.windowStart,
    scanEnd: input.windowStart,
    bootId: null,
    summary: null,
  };
  checkpoint.cohorts.push(created);
  return created;
}
const sampleKey = (input: VpsJournalRequest) => `${canonicalVps(input.identity)}:${input.windowStart}:${input.windowEnd}`;
export class VpsJournalMetrics {
  private _deadline = 0;
  private _slices = 0;
  private readonly _spent = new Map<string, number>();
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
    this._spent.clear();
    this._states.clear();
  }
  progress(input: VpsJournalRequest): Promise<VpsMetricsProgress> {
    return Promise.resolve(this._states.get(sampleKey(input)) ?? { state: "unavailable", reason: "sample_missing" });
  }
  private _limits(): VpsQueryLimits {
    return { deadline: this._deadline, maxBytes: VPS_METRICS_MAX_BYTES, maxEntries: VPS_METRICS_MAX_ENTRIES };
  }
  /** Whether the tick, and this cohort's share of it, can pay for another journal read. */
  private _affordable(key: string): boolean {
    return this._slices > 0 && (this._spent.get(key) ?? 0) < VPS_METRICS_COHORT_TICK_SLICES && this._now() < this._deadline;
  }
  private async _read(ledger: VpsJoinLedger, key: string, start: number, end: number): Promise<VpsJoinSlice> {
    this._slices--;
    this._spent.set(key, (this._spent.get(key) ?? 0) + 1);
    const limits = this._limits();
    const proof = parseCoverage(await this._reader.coverage(start, end, limits), start, end);
    if (this._now() >= this._deadline) throw new VpsQueryBudgetError();
    const events = await journalEvents(await this._reader.read(start, end, limits), proof, ledger.identity);
    if (this._now() >= this._deadline) throw new VpsQueryBudgetError();
    const slice = { coverage: proof, events };
    insertSlice(ledger, slice);
    return slice;
  }
  private _adopt(cohort: VpsJoinCohort, slice: VpsJoinSlice, backward: boolean): void {
    if (cohort.bootId !== null && cohort.bootId !== slice.coverage.bootId) return incomplete();
    cohort.bootId = slice.coverage.bootId;
    if (backward) cohort.scanStart = slice.coverage.windowStart;
    else cohort.scanEnd = slice.coverage.windowEnd;
  }
  /** Extends the cohort by one slice: free when another cohort already proved it, otherwise one read of the gap. */
  private async _extend(ledger: VpsJoinLedger, cohort: VpsJoinCohort, key: string, floor: number, availableEnd: number, backward: boolean): Promise<boolean> {
    const edge = backward ? cohort.scanStart : cohort.scanEnd;
    const shared = ledger.slices.find((slice) => (backward ? slice.coverage.windowEnd : slice.coverage.windowStart) === edge);
    if (shared) {
      this._adopt(cohort, shared, backward);
      return true;
    }
    if ((!backward && edge >= availableEnd) || !this._affordable(key)) return false;
    // A read stops at the nearest slice already proven, so ledger slices never overlap.
    const start = backward
      ? Math.max(floor, edge - VPS_METRICS_SLICE_MS, ...ledger.slices.map((slice) => slice.coverage.windowEnd).filter((end) => end < edge))
      : edge;
    const end = backward
      ? edge
      : Math.min(availableEnd, edge + VPS_METRICS_SLICE_MS, ...ledger.slices.map((slice) => slice.coverage.windowStart).filter((begin) => begin > edge));
    try {
      this._adopt(cohort, await this._read(ledger, key, start, end), backward);
    } catch (error) {
      // An elapsed tick keeps every slice already adopted; the cohort resumes on the next tick.
      if (error instanceof VpsQueryBudgetError) return false;
      throw error;
    }
    return true;
  }
  private async _scan(binding: string, ledger: VpsJoinLedger, cohort: VpsJoinCohort, key: string, floor: number, availableEnd: number): Promise<void> {
    anchored(ledger, cohort);
    for (;;) {
      const slices = tiledSlices(ledger, cohort.scanStart, cohort.scanEnd) ?? incomplete();
      const { members, pending, orphanFloor } = joined(cohort, slices, floor);
      const covered = cohort.scanEnd >= cohort.windowEnd;
      if (covered && orphanFloor === null && !pending) {
        cohort.summary = await summarized(binding, cohort, slices, members);
        return;
      }
      const backward = covered && orphanFloor !== null;
      if (backward && cohort.scanStart <= orphanFloor) return incomplete();
      if (!(await this._extend(ledger, cohort, key, floor, availableEnd, backward))) return;
    }
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
  private _progressOf(summary: VpsJoinSummary | null): VpsMetricsProgress {
    if (summary !== null) return { state: "complete", reason: null };
    // Past the operation deadline no tick can read again, so a pending window is final rather than still collecting.
    if (this._now() >= this._options.deadline) return { state: "unavailable", reason: "deadline_exceeded" };
    return { state: "collecting", reason: "terminal_or_slice_pending" };
  }
  private _counted(input: VpsJournalRequest, identity: VpsIdentity, sampledAt: number, summary: VpsJoinSummary): VpsMetricsSample {
    return parseVpsSample({
      ...input,
      identity,
      sampledAt,
      requestCount: summary.requests,
      fiveXxCount: summary.fiveXx,
      timeoutCount: summary.failures.reduce((total, [kind, count]) => total + (this._timeoutKinds.includes(kind) ? count : 0), 0),
      streamFailureCount: summary.streamFailures,
      upstreamWideFault: summary.failures.some(([kind]) => this._upstreamWideKinds.includes(kind)),
      coverage: "complete",
      coverageDigest: summary.coverageDigest,
    });
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
      const cohort = cohortFor(checkpoint, input, identity);
      if (cohort.summary === null) {
        const ledger = joinLedger(checkpoint, identity, input.windowStart);
        await this._scan(checkpoint.binding, ledger, cohort, key, floor, sampledAt - this._lagMs);
        // The window scanned last is the best estimate of how far back the next window will reach.
        ledger.retainFrom = cohort.scanStart;
      }
      const summary = cohort.summary;
      // A baseline window is sampled for its result alone; once complete, nothing of it is kept.
      if (summary !== null && !sameVps(identity, scope.candidate)) checkpoint.cohorts = checkpoint.cohorts.filter((item) => item !== cohort);
      pruneJoinLedgers(checkpoint);
      if (canonicalVps(await this._options.context(input)) !== canonicalVps(scope)) return incomplete();
      await this._checkpoints.save(scope, checkpoint, loaded.expected);
      this._states.set(key, this._progressOf(summary));
      return summary === null ? missing() : this._counted(input, identity, sampledAt, summary);
    } catch {
      return missing();
    }
  }
}

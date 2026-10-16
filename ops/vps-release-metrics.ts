import { parseVpsIdentity, parseVpsSample, sha256, vpsDigest, type VpsIdentity, type VpsMetricsSample } from "./vps-release-contract.ts";
import type { VpsCommand } from "./vps-release-store.ts";
import type { TerminalAdmissionStage } from "../src/handler/terminal-log.ts";

export type VpsJournalRequest = { identity: VpsIdentity; windowStart: number; windowEnd: number };
export type VpsJournalCoverage = {
  complete: true;
  unit: "ai-ubq-fi.service";
  windowStart: number;
  windowEnd: number;
  bootId: string;
  firstCursor: string;
  lastCursor: string;
  digest: string;
};
export type VpsJournalReader = { read(start: number, end: number): Promise<string>; coverage(start: number, end: number): Promise<VpsJournalCoverage | null> };
/** @public Standalone Sentinel's pinned VPS bridge composes its actual unit-scoped journal reader here. */
export function createVpsJournalReader(run: VpsCommand, root: string, coverage: VpsJournalReader["coverage"]): VpsJournalReader {
  return {
    coverage,
    read: (start, end) =>
      run("journalctl", ["--unit=ai-ubq-fi.service", `--since=@${start / 1000}`, `--until=@${end / 1000}`, "--output=json", "--no-pager"], root),
  };
}
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_ENTRIES = 8192;
type Event = {
  id: string;
  at: number;
  accepted: boolean;
  status: number;
  stream: boolean;
  failure: string | null;
  admissionStage: TerminalAdmissionStage | null;
};
const incomplete = (): never => {
  throw new Error("VPS journal coverage is incomplete");
};
function parseCoverage(value: unknown, start: number, end: number): VpsJournalCoverage {
  if (value === null || typeof value !== "object") return incomplete();
  const proof = value as Record<string, unknown>;
  if (proof.complete !== true || proof.unit !== "ai-ubq-fi.service" || proof.windowStart !== start || proof.windowEnd !== end) return incomplete();
  for (const key of ["bootId", "firstCursor", "lastCursor"] as const) if (typeof proof[key] !== "string" || proof[key].length === 0) return incomplete();
  sha256(proof.digest);
  return proof as VpsJournalCoverage;
}
function parseEvent(message: string, at: number, identity: VpsIdentity): Event | null {
  const match = /^\[ai\.ubq\.fi\] request_(accepted|terminal) (\{.*\})$/.exec(message);
  if (!match) return null;
  const value = JSON.parse(match[2]) as Record<string, unknown>;
  if (typeof value.request_id !== "string" || value.request_id.length > 512 || typeof value.git_sha !== "string" || typeof value.deno_revision !== "string")
    return incomplete();
  if (value.git_sha !== identity.gitSha || value.deno_revision !== identity.deploymentId) return null;
  const accepted = match[1] === "accepted",
    status = accepted ? 0 : Number(value.status);
  if (!accepted) validateTerminal(value, status);
  return {
    id: value.request_id,
    at,
    accepted,
    status,
    stream: value.stream === true,
    failure: typeof value.failure_kind === "string" ? value.failure_kind : null,
    admissionStage: accepted ? "accepted" : parseAdmissionStage(value.admission_stage),
  };
}
function parseAdmissionStage(value: unknown): TerminalAdmissionStage | null {
  if (value === undefined || value === null) return null;
  if (value === "pre_admission" || value === "accepted") return value;
  return incomplete();
}
function validateTerminal(value: Record<string, unknown>, status: number): void {
  if (!Number.isInteger(status) || status < 100 || status > 599) return incomplete();
  if (value.stream !== null && typeof value.stream !== "boolean") return incomplete();
  if (value.failure_kind !== null && typeof value.failure_kind !== "string") return incomplete();
}
function journalEvents(raw: string, proof: VpsJournalCoverage, identity: VpsIdentity, start: number, end: number): Event[] {
  if (new TextEncoder().encode(raw).byteLength > MAX_JOURNAL_BYTES) return incomplete();
  const lines = raw.split("\n").filter((line) => line.length > 0);
  if (lines.length > MAX_ENTRIES) return incomplete();
  const events: Event[] = [];
  for (const line of lines) {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (
      row._SYSTEMD_UNIT !== proof.unit ||
      row._BOOT_ID !== proof.bootId ||
      typeof row.__CURSOR !== "string" ||
      typeof row.__REALTIME_TIMESTAMP !== "string" ||
      typeof row.MESSAGE !== "string"
    )
      return incomplete();
    if (/^(?:Suppressed \d+ messages from .+|Missed \d+ kernel messages)$/.test(row.MESSAGE)) return incomplete();
    const at = Number(row.__REALTIME_TIMESTAMP) / 1000;
    if (!Number.isFinite(at) || at < start || at >= end) return incomplete();
    const event = parseEvent(row.MESSAGE, at, identity);
    if (event) events.push(event);
  }
  return events;
}
function cohortResults(events: readonly Event[], start: number, end: number): Event[] {
  const accepted = new Map<string, Event>(),
    terminals = new Map<string, Event>();
  for (const event of events) {
    const target = event.accepted ? accepted : terminals,
      existing = target.get(event.id);
    if (existing && (existing.status !== event.status || existing.failure !== event.failure || existing.admissionStage !== event.admissionStage))
      return incomplete();
    target.set(event.id, event);
  }
  for (const terminal of terminals.values()) if (terminal.admissionStage === "pre_admission" && accepted.has(terminal.id)) return incomplete();
  const cohort = [...accepted.values()].filter((event) => event.at >= start && event.at < end);
  const results = cohort.map((event) => {
    const terminal = terminals.get(event.id);
    if (!terminal) {
      return incomplete();
    }
    return terminal;
  });
  if ([...terminals.values()].some((event) => event.at >= start && event.at < end && !accepted.has(event.id) && event.admissionStage !== "pre_admission"))
    return incomplete();
  return results;
}
export class VpsJournalMetrics {
  constructor(
    private readonly _reader: VpsJournalReader,
    private readonly _now: () => number,
    private readonly _lagMs: number,
    private readonly _timeoutKinds: readonly string[],
    private readonly _upstreamWideKinds: readonly string[]
  ) {
    if (!Number.isSafeInteger(_lagMs) || _lagMs < 0 || _timeoutKinds.length > 32 || _upstreamWideKinds.length > 32)
      throw new TypeError("VPS telemetry configuration is invalid");
  }
  async sample(input: VpsJournalRequest): Promise<VpsMetricsSample> {
    const identity = parseVpsIdentity(input.identity),
      sampledAt = this._now();
    if (
      !Number.isSafeInteger(input.windowStart) ||
      input.windowStart < 0 ||
      !Number.isSafeInteger(input.windowEnd) ||
      input.windowEnd <= input.windowStart ||
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
    const interval = input.windowEnd - input.windowStart,
      start = Math.max(0, input.windowStart - interval),
      end = input.windowEnd + interval;
    if (end + this._lagMs > sampledAt) return missing();
    try {
      const proof = parseCoverage(await this._reader.coverage(start, end), start, end);
      const events = journalEvents(await this._reader.read(start, end), proof, identity, start, end);
      const results = cohortResults(events, input.windowStart, input.windowEnd);
      return parseVpsSample({
        ...input,
        identity,
        sampledAt,
        requestCount: results.length,
        fiveXxCount: results.filter((event) => event.status >= 500).length,
        timeoutCount: results.filter((event) => event.failure !== null && this._timeoutKinds.includes(event.failure)).length,
        streamFailureCount: results.filter((event) => event.stream && event.failure !== null).length,
        upstreamWideFault: results.some((event) => event.failure !== null && this._upstreamWideKinds.includes(event.failure)),
        coverage: "complete",
        coverageDigest: await vpsDigest({ source: proof.digest, identity, windowStart: input.windowStart, windowEnd: input.windowEnd }),
      });
    } catch {
      return missing();
    }
  }
}

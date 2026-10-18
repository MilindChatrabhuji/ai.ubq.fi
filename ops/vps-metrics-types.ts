import type { VpsIdentity } from "./vps-release-contract.ts";

export const VPS_METRICS_SLICE_MS = 30_000;
export const VPS_METRICS_MAX_BYTES = 1024 * 1024;
export const VPS_METRICS_MAX_ENTRIES = 8192;
export const VPS_METRICS_TICK_MS = 20_000;
export const VPS_METRICS_TICK_SLICES = 64;
/** One cohort's share of a tick, so a cohort chasing an old admission cannot starve the windows sampled after it. */
export const VPS_METRICS_COHORT_TICK_SLICES = 16;
/** Bound on the release-state read made while the deploy lock is held; a deploy waits on that lock. */
export const VPS_METRICS_STATE_READ_MS = 10_000;
/** Local query-budget exhaustion, never journal corruption or a sample success. */
export class VpsQueryBudgetError extends Error {
  constructor() {
    super("VPS journal query budget exhausted");
    this.name = "VpsQueryBudgetError";
  }
}
export type VpsJournalRequest = { identity: VpsIdentity; windowStart: number; windowEnd: number };
export type VpsQueryLimits = { deadline: number; maxBytes: number; maxEntries: number };
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
export type VpsJournalReader = {
  read(start: number, end: number, limits: VpsQueryLimits): Promise<string>;
  coverage(start: number, end: number, limits: VpsQueryLimits): Promise<VpsJournalCoverage | null>;
};
export type VpsBoundedJournalCommand = (args: readonly string[], limits: VpsQueryLimits, cwd: string) => Promise<string>;
export type VpsMetricsScope = {
  operationId: string;
  requestDigest: string;
  controllerSha: string;
  driverSha256: string;
  candidate: VpsIdentity;
  prior: VpsIdentity;
  monitoringStartedAt: number;
  baselineStart: number;
  baselineEnd: number;
  stateHead: string;
  stateSequence: number;
};
export type VpsMetricsRetention = { evidenceMaxAgeMs: number; evidenceMaxBytes: number };
export type VpsJoinStorage = {
  load(scope: VpsMetricsScope): Promise<Uint8Array | null>;
  save(scope: VpsMetricsScope, expectedSequence: number | null, ciphertext: Uint8Array): Promise<boolean>;
};
export type VpsJoinCipher = {
  seal(plaintext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>;
  open(ciphertext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>;
};
export type VpsMetricsProgress = { state: "collecting" | "complete" | "unavailable"; reason: string | null };
/** @public The standalone controller drives bounded ticks and reads collection progress through this port. */
export type VpsMetricsWork = { beginTick(observedAt: number): void; progress(input: VpsJournalRequest): Promise<VpsMetricsProgress> };
export type VpsMetricsOptions = {
  retention: VpsMetricsRetention;
  context(input: VpsJournalRequest, saved?: { stateHead: string; stateSequence: number }): Promise<VpsMetricsScope>;
  storage: VpsJoinStorage;
  cipher: VpsJoinCipher;
  deadline: number;
};
export type VpsMetricEvent = {
  id: string;
  at: number;
  accepted: boolean;
  status: number;
  stream: boolean;
  failure: string | null;
  admissionStage: "accepted" | "pre_admission" | null;
  /** The terminal's own `latency_ms`; it bounds the backward search for an admission the window has not seen. */
  latencyMs: number | null;
  /** Commits the projection together with its journal cursor and boot id, which are not stored again. */
  digest: string;
};
/** One proven journal slice, read once per operation and shared by every cohort that spans it. */
export type VpsJoinSlice = { coverage: VpsJournalCoverage; events: VpsMetricEvent[] };
/** Non-overlapping slices of one identity, ordered by start. Slices ending at or before `retainFrom` may be pruned. */
export type VpsJoinLedger = { identity: VpsIdentity; retainFrom: number; slices: VpsJoinSlice[] };
/** All a completed cohort keeps: its counts, failure kinds, and the digest over its coverage chain and member pairs. */
export type VpsJoinSummary = { requests: number; fiveXx: number; streamFailures: number; failures: [string, number][]; coverageDigest: string };
/** A window and the contiguous ledger range it has proven, `[scanStart, scanEnd)`. A summary marks it complete. */
export type VpsJoinCohort = {
  identity: VpsIdentity;
  windowStart: number;
  windowEnd: number;
  scanStart: number;
  scanEnd: number;
  bootId: string | null;
  summary: VpsJoinSummary | null;
};
export type VpsJoinCheckpoint = {
  schema: 2;
  binding: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  monitoringStartedAt: number;
  stateHead: string;
  stateSequence: number;
  ledgers: VpsJoinLedger[];
  cohorts: VpsJoinCohort[];
};

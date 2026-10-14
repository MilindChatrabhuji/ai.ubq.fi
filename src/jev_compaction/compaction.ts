/**
 * Gateway Jev compaction route, adapted from 0x4007/fast-jev-compaction (MIT),
 * commit c1eab5fdbd6bde7d67f2da070116496558836884, `codex/jev-compaction-proxy.ts`:
 * the Jev asker, per-call timeout transport, response payloads and fail-closed
 * validation. Mechanical changes: Deno `.ts` specifiers, repository formatting,
 * a parsed body instead of a raw string, caller abort propagation into the Jev
 * call, gateway `openaiError` responses, and no HTTP server or CLI entrypoint.
 * Selection and rendering stay in the ported library; this file only orchestrates
 * and validates. See ./LICENSE and ./README.md.
 *
 * Contract: only a request whose `x-codex-turn-metadata` marks
 * `request_kind: "compaction"` with `compaction.implementation: "responses"` is
 * handled here. Every failure returns a non-success response before any
 * successful completion is emitted, so Codex keeps its existing history; kept
 * content is never truncated to force a success and no usage is invented.
 *
 * Upstream: Jev calls ride the gateway's normal Jev route - the OpenRouter
 * System One transport (`OPENROUTER_SYSTEMONE_URL`) with the shared provider
 * credential - so compaction needs no standalone TypeSafe key.
 */
import { openaiError } from "../http.ts";
import { setResponseCompletionTelemetry } from "../openai-telemetry.ts";
import { readJsonBody } from "../request.ts";
import { parseStreamField } from "../request-policy.ts";
import { OPENROUTER_SYSTEMONE_URL, readOpenRouterApiKey } from "../provider/openrouter.ts";
import { SYSTEMONE_DEFAULT_MODEL } from "../systemone/handlers.ts";
import { JevClient } from "../../lib/jev_compaction/client.ts";
import { compact } from "../../lib/jev_compaction/compact.ts";
import { isResponsesCompaction, parseCodexInput, parseTurnMetadata, renderSummary } from "../../lib/jev_compaction/codex_items.ts";
import { collectToolCalls, estimateTokens } from "../../lib/jev_compaction/state.ts";
import { hybridResidueEnabled, runHybridResiduePass } from "./hybrid.ts";
import type { CallDecision, CompactResult, JevAsker, ToolCall } from "../../lib/jev_compaction/types.ts";

const TURN_METADATA_HEADER = "x-codex-turn-metadata";

/** Library defaults, minus the goal (the transcript itself carries the task). */
export const COMPACTION_OPTIONS = {
  preserveRecentMessages: 6,
  keepThreshold: 0.5,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
} as const;

/** Bound on one Jev HTTP call, headers and response body included. */
export const JEV_TIMEOUT_MS = 30_000;

/**
 * Hard bound on the rendered memory. The ported 400,000-character default can
 * be exceeded by text and pinned segments, which are never dropped or
 * truncated, so the gateway raises the bound for its own sessions. Fitting
 * first drops lowest-relevance unpinned results; above this ceiling the request
 * still fails closed. 1.5M chars is roughly 375k tokens, well inside the
 * 1,048,576-token session window.
 */
export const SUMMARY_CHAR_CAP = 1_500_000;

/**
 * A floor-bound summary (nothing left that may be dropped or truncated) is
 * accepted only when the token-estimated render is at least this much smaller
 * than the token-estimated request input it replaces. The fraction is relative,
 * so the bound scales with any session size: at a 1M-token input the accepted
 * floor may be several megabytes of characters, while a small window keeps a
 * correspondingly small bound. The reduction also leaves the client headroom
 * for the continuation that follows the adopted summary.
 */
export const SUMMARY_MIN_REDUCTION_RATIO = 0.15;

/** The largest token-estimated floor render accepted for a given input estimate. */
export function maxFloorSummaryTokens(inputTokens: number): number {
  return Math.floor(inputTokens * (1 - SUMMARY_MIN_REDUCTION_RATIO));
}

type FailureKind =
  | "unparsable-body"
  | "missing-input"
  | "empty-transcript"
  | "no-candidates"
  | "missing-key"
  | "jev-failed"
  | "no-reduction"
  | "render-failed"
  | "summary-too-large"
  | "empty-summary";

export class CompactionUnavailable extends Error {
  readonly kind: FailureKind;

  constructor(kind: FailureKind, detail: string) {
    super(detail);
    this.name = "CompactionUnavailable";
    this.kind = kind;
  }
}

/** Best-effort residue rewrite; null keeps the pure Jev summary. */
export type CompactionResidue = (summary: string) => Promise<string | null>;

export type CompactionOutcome = {
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Header-only predicate; absent, malformed or unknown markers stay on the normal route. */
export function isJevCompactionRequest(req: Request): boolean {
  // Operator escape hatch: bypass interception entirely and let the marked
  // request take the ordinary provider route. Unset by default; a denied
  // environment read keeps the interception enabled.
  try {
    if (process.env["JEV_COMPACTION_DISABLED"] === "1") return false;
  } catch {
    // keep interception enabled
  }
  return isResponsesCompaction(parseTurnMetadata(req.headers.get(TURN_METADATA_HEADER)));
}

function ssePayload(itemId: string, responseId: string, text: string): string {
  const item = {
    type: "message",
    role: "assistant",
    id: itemId,
    content: [{ type: "output_text", text }],
  };
  const done = JSON.stringify({ type: "response.output_item.done", item });
  const completed = JSON.stringify({
    type: "response.completed",
    response: { id: responseId, status: "completed" },
  });
  return `event: response.output_item.done\ndata: ${done}\n\nevent: response.completed\ndata: ${completed}\n\n`;
}

function jsonCompletionPayload(itemId: string, responseId: string, text: string): string {
  return JSON.stringify({
    id: responseId,
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        id: itemId,
        content: [{ type: "output_text", text }],
      },
    ],
  });
}

/** Structural only: counts and sizes, never transcript text. */
function structuralHeader(counts: {
  kept: number;
  resultsDropped: number;
  callsDropped: number;
  pinned: number;
  charsBefore: number;
  charsAfter: number;
  fitted?: number;
  floorBound?: boolean;
  hybrid?: boolean;
}): string {
  const parts = [
    "summary",
    `kept=${counts.kept}`,
    `results_dropped=${counts.resultsDropped}`,
    `calls_dropped=${counts.callsDropped}`,
    `pinned=${counts.pinned}`,
    `chars_before=${counts.charsBefore}`,
    `chars_after=${counts.charsAfter}`,
  ];
  if (counts.fitted !== undefined && counts.fitted > 0) parts.push(`fitted=${counts.fitted}`);
  if (counts.floorBound === true) parts.push("floor=1");
  if (counts.hybrid === true) parts.push("hybrid=1");
  return parts.join("; ");
}

/**
 * Nonsecret failure class for logs: the failure kind plus a bounded structural
 * token. Library error messages can embed provider response text, so only
 * status codes, counts, and fixed classifications are ever logged.
 */
function failureLogDetail(kind: FailureKind, message: string): string {
  const http = /Jev request failed \((\d{3})\)/.exec(message);
  if (http) return `http=${http[1]}`;
  if (message.startsWith("Jev request timed out")) return "timeout";
  if (message.startsWith("Jev request aborted")) return "aborted";
  if (message.includes("malformed JSON")) return "malformed-response";
  if (message.startsWith("Invalid Jev answer")) return "invalid-answer";
  if (message.includes("no room for questions")) return "state-over-budget";
  if (message.includes("history too large for Jev")) return "state-too-large";
  if (message.includes("OPENROUTER_API_KEY")) return "missing-key";
  const counts = /dropped=(\d+), before=(\d+), after=(\d+)/.exec(message);
  if (counts) return `dropped=${counts[1]} before=${counts[2]} after=${counts[3]}`;
  const chars = /summary is (\d+) chars/.exec(message);
  if (chars) {
    const composition = /unpinned_kept=(\d+) pinned=(\d+) results_dropped=(\d+)/.exec(message);
    return composition
      ? `summary-chars=${chars[1]} unpinned_kept=${composition[1]} pinned=${composition[2]} dropped=${composition[3]}`
      : `summary-chars=${chars[1]}`;
  }
  return kind;
}

function logCompaction(line: Record<string, unknown>): void {
  console.info("[ai.ubq.fi] jev_compaction", JSON.stringify(line));
}

function assertEveryCandidateDecided(result: CompactResult, candidates: readonly ToolCall[]): void {
  const decidedIds = new Set(result.decisions.map((decision) => decision.id));
  for (const candidate of candidates) {
    if (!decidedIds.has(candidate.id)) {
      throw new CompactionUnavailable("jev-failed", `missing decision for ${candidate.id}`);
    }
  }
}

function assertCompactionReduced(stats: CompactResult["stats"]): void {
  const dropped = stats.resultsDropped + stats.callsDropped;
  if (dropped === 0 || stats.charsAfter >= stats.charsBefore) {
    throw new CompactionUnavailable("no-reduction", `nothing was dropped (dropped=${dropped}, before=${stats.charsBefore}, after=${stats.charsAfter})`);
  }
}

function renderCompactedSummary(
  transcript: ReturnType<typeof parseCodexInput>,
  calls: readonly ToolCall[],
  result: CompactResult,
  decisions: readonly CallDecision[] = result.decisions
): string {
  if (transcript === null) throw new CompactionUnavailable("missing-input", "compaction request has no input items array");
  const callIds = new Map(calls.map((call) => [call.id, call.tool_use_id]));
  let summary: string;
  try {
    summary = renderSummary(transcript, {
      decisions,
      callIds,
      headChars: COMPACTION_OPTIONS.truncateHeadChars,
      stats: result.stats,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CompactionUnavailable("render-failed", `render failed: ${detail.slice(0, 200)}`);
  }
  if (summary.trim().length === 0) {
    throw new CompactionUnavailable("empty-summary", "renderer produced an empty summary");
  }
  return summary;
}

/**
 * Fits the rendered summary under `SUMMARY_CHAR_CAP` by dropping additional
 * unpinned kept results, lowest Jev `keepResult` first, and taking the minimal
 * fitting prefix across re-renders. Pinned data is never dropped or truncated;
 * dropping every unpinned kept result is the floor, and beyond it the request
 * still fails closed instead of shipping an oversized memory.
 */
function fitCompactedSummary(
  transcript: ReturnType<typeof parseCodexInput>,
  calls: readonly ToolCall[],
  result: CompactResult,
  inputTokens: number
): { summary: string; fittedDrops: number; stats: CompactResult["stats"]; floorBound?: boolean } {
  const acceptsFloor = (floor: string): boolean => inputTokens > 0 && estimateTokens(floor) <= maxFloorSummaryTokens(inputTokens);
  const summary = renderCompactedSummary(transcript, calls, result);
  if (summary.length <= SUMMARY_CHAR_CAP) return { summary, fittedDrops: 0, stats: result.stats };

  const fitIds = result.decisions
    .filter((decision) => decision.action === "keep" && decision.reason === "kept")
    .sort((a, b) => a.keepResult - b.keepResult)
    .map((decision) => decision.id);
  const renderWithDropped = (count: number): string => {
    const dropped = new Set(fitIds.slice(0, count));
    const decisions = result.decisions.map((decision) =>
      dropped.has(decision.id) ? { ...decision, action: "drop_result" as const, reason: "result_dropped" as const } : decision
    );
    return renderCompactedSummary(transcript, calls, result, decisions);
  };

  if (fitIds.length === 0) {
    // Only pinned, dropped or text content exceeds the fit target; nothing may
    // shrink. Ship the floor when it is token-measurably smaller than the input
    // it replaces; otherwise fail closed as before.
    if (acceptsFloor(summary)) return { summary, fittedDrops: 0, stats: result.stats, floorBound: true };
    throw new CompactionUnavailable(
      "summary-too-large",
      `summary is ${summary.length} chars (limit ${SUMMARY_CHAR_CAP}); unpinned_kept=0 pinned=${result.stats.pinned} results_dropped=${result.stats.resultsDropped}`
    );
  }
  const floor = renderWithDropped(fitIds.length);
  if (floor.length > SUMMARY_CHAR_CAP) {
    if (acceptsFloor(floor)) {
      const droppedIds = new Set(fitIds);
      const droppedChars = calls.filter((call) => droppedIds.has(call.id)).reduce((sum, call) => sum + call.resultChars, 0);
      return {
        summary: floor,
        fittedDrops: fitIds.length,
        floorBound: true,
        stats: {
          ...result.stats,
          kept: Math.max(0, result.stats.kept - fitIds.length),
          resultsDropped: result.stats.resultsDropped + fitIds.length,
          charsAfter: Math.max(0, result.stats.charsAfter - droppedChars),
        },
      };
    }
    throw new CompactionUnavailable(
      "summary-too-large",
      `summary is ${floor.length} chars (limit ${SUMMARY_CHAR_CAP}) with all ${fitIds.length} unpinned kept results dropped; unpinned_kept=${fitIds.length} pinned=${result.stats.pinned} results_dropped=${result.stats.resultsDropped + fitIds.length}`
    );
  }
  let low = 0;
  let high = fitIds.length;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (renderWithDropped(mid).length <= SUMMARY_CHAR_CAP) high = mid;
    else low = mid;
  }
  const fitted = renderWithDropped(high);
  if (fitted.length > SUMMARY_CHAR_CAP) {
    // Fail closed: a non-monotone render must never ship an oversized summary.
    throw new CompactionUnavailable("summary-too-large", `summary is ${fitted.length} chars (limit ${SUMMARY_CHAR_CAP})`);
  }
  const dropped = new Set(fitIds.slice(0, high));
  const droppedChars = calls.filter((call) => dropped.has(call.id)).reduce((sum, call) => sum + call.resultChars, 0);
  return {
    summary: fitted,
    fittedDrops: high,
    stats: {
      ...result.stats,
      kept: Math.max(0, result.stats.kept - high),
      resultsDropped: result.stats.resultsDropped + high,
      charsAfter: Math.max(0, result.stats.charsAfter - droppedChars),
    },
  };
}

/**
 * Turns one header-verified compaction request body into a completed response.
 * Throws `CompactionUnavailable` for every non-success path; the caller maps it
 * to an explicit error status so Codex keeps the original history.
 */
export async function buildCompactionResponse(
  body: unknown,
  asker: JevAsker,
  options: { stream: boolean; residue?: CompactionResidue }
): Promise<CompactionOutcome> {
  const requestBody: Record<string, unknown> = record(body) ?? {};
  const transcript = parseCodexInput(requestBody.input);
  if (!transcript) {
    throw new CompactionUnavailable("missing-input", "compaction request has no input items array");
  }
  if (transcript.entries.length === 0) {
    throw new CompactionUnavailable("empty-transcript", "compaction request has no conversation content");
  }
  const calls = collectToolCalls(transcript.messages, COMPACTION_OPTIONS.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  if (candidates.length === 0) {
    // A short or tool-free transcript has nothing Jev could usefully decide.
    // No Jev request is made and no summary is invented.
    throw new CompactionUnavailable("no-candidates", "no unpinned tool call/result pairs to decide");
  }

  let result: CompactResult;
  try {
    result = await compact(transcript.messages, asker, COMPACTION_OPTIONS);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The library validates every asked question, so a thrown error here means
    // no partial decision set was substituted.
    throw new CompactionUnavailable("jev-failed", detail.slice(0, 200));
  }

  assertEveryCandidateDecided(result, candidates);
  // Fit first: cap-forced drops count toward the reduction contract, so a
  // session whose kept render exceeds the cap can still compact.
  const inputTokens = estimateTokens(JSON.stringify(requestBody.input));
  const fitted = fitCompactedSummary(transcript, calls, result, inputTokens);
  let summary = fitted.summary;
  let hybridApplied = false;
  let hybridMs: number | null = null;
  if (options.residue) {
    const hybridStarted = Date.now();
    try {
      const rewritten = await options.residue(summary);
      // The residue pass is best-effort: a null, empty or non-shrinking result
      // keeps the pure Jev summary, so compaction never fails because of it.
      if (rewritten !== null && rewritten.trim().length > 0 && rewritten.length < summary.length) {
        summary = rewritten;
        hybridApplied = true;
      }
    } catch {
      // keep the pure Jev summary
    }
    hybridMs = Date.now() - hybridStarted;
  }
  // The rendered summary is what Codex adopts, and the renderer keeps dropped
  // calls as bounded provenance instead of erasing them, so the reduction
  // contract and the reported chars_after are measured on the rendered text
  // rather than on the decision projection.
  const renderedStats = { ...fitted.stats, charsAfter: summary.length };
  assertCompactionReduced(renderedStats);

  logCompaction({
    outcome: "ok",
    items: transcript.entries.length,
    candidates: candidates.length,
    kept: renderedStats.kept,
    results_dropped: renderedStats.resultsDropped,
    calls_dropped: renderedStats.callsDropped,
    pinned: renderedStats.pinned,
    chars_before: renderedStats.charsBefore,
    chars_after: renderedStats.charsAfter,
    fitted: fitted.fittedDrops,
    floor_bound: fitted.floorBound === true,
    hybrid: hybridApplied,
    hybrid_ms: hybridMs,
    input_estimate_tokens: inputTokens,
    floor_tokens: fitted.floorBound === true ? estimateTokens(summary) : null,
    jev_requests: renderedStats.requests,
    state_stage: renderedStats.stateStage || "none",
    windows: renderedStats.windows,
    total_ms: renderedStats.ms,
  });

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const headers = {
    "x-jev-compaction": structuralHeader({ ...renderedStats, fitted: fitted.fittedDrops, floorBound: fitted.floorBound, hybrid: hybridApplied }),
  };
  if (options.stream) {
    return {
      status: 200,
      contentType: "text/event-stream",
      headers,
      body: ssePayload(`msg_jev_${suffix}`, `resp_jev_${suffix}`, summary),
    };
  }
  return {
    status: 200,
    contentType: "application/json",
    headers,
    body: jsonCompletionPayload(`msg_jev_${suffix}`, `resp_jev_${suffix}`, summary),
  };
}

function timedOutError(timeoutMs: number): Error {
  return new Error(`Jev request timed out after ${timeoutMs}ms`);
}

/**
 * Adapter-owned Jev transport. One request is bounded by an `AbortSignal`
 * (30 s by default) that stays armed while the response body is consumed, any
 * caller signal is preserved, and the timer and listeners are released on
 * every path. Transport failures are re-thrown with a fixed, non-secret
 * message.
 */
type JevFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createJevTimeoutFetch(baseFetch: JevFetch, timeoutMs = JEV_TIMEOUT_MS): JevFetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const external = init?.signal ?? null;
    const forwardExternalAbort = (): void => {
      controller.abort(external?.reason);
    };
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener("abort", forwardExternalAbort, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(timedOutError(timeoutMs));
    }, timeoutMs);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      external?.removeEventListener("abort", forwardExternalAbort);
    };
    const sanitize = (error: unknown): Error => {
      const reason: unknown = controller.signal.reason;
      if (reason instanceof Error && reason.message.startsWith("Jev request timed out")) return reason;
      if (controller.signal.aborted) return new Error("Jev request aborted");
      const detail = error instanceof Error ? error.message : "unknown transport failure";
      return new Error(`Jev transport error: ${detail.slice(0, 120)}`);
    };
    const swallowCancellation = (): void => {
      return;
    };
    return baseFetch(input, { ...init, signal: controller.signal }).then(
      (response) => {
        const body = response.body;
        if (!body) {
          release();
          return response;
        }
        const reader = body.getReader();
        const cancelReader = (reason?: unknown): Promise<void> => reader.cancel(reason).catch(swallowCancellation);
        let aborted = false;
        controller.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            void cancelReader(controller.signal.reason);
          },
          { once: true }
        );
        const stream = new ReadableStream<Uint8Array>({
          async pull(streamController) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                release();
                // An abort that landed after the last chunk still fails the read.
                if (aborted) streamController.error(sanitize(controller.signal.reason));
                else streamController.close();
                return;
              }
              streamController.enqueue(value);
            } catch (error) {
              release();
              streamController.error(sanitize(error));
            }
          },
          cancel(reason) {
            release();
            return cancelReader(reason);
          },
        });
        return new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      (error: unknown) => {
        release();
        throw sanitize(error);
      }
    );
  };
}

export type JevCompactionDeps = {
  /** Caller-owned signal; a client cancellation stops the Jev calls and the operation. */
  signal?: AbortSignal;
  /** Test seam: replaces the HTTP asker entirely. */
  asker?: JevAsker;
  /** Test seam: replaces the Jev transport fetch. */
  fetch?: JevFetch;
  /** Resolved provider credential seam; `null` forces the explicit missing-key failure. */
  apiKey?: string | null;
  /** Test seam: replaces the hybrid residue pass entirely. */
  residue?: CompactionResidue;
};

let askerForTest: JevAsker | null = null;

/** Test seam: route every compaction through a fake asker; `null` restores the real one. */
export const setJevCompactionAskerForTest = (asker: JevAsker | null): void => {
  askerForTest = asker;
};

/**
 * Jev asks ride the gateway's normal Jev route: the OpenRouter System One
 * transport that serves `/v1/systemone`, with the same shared provider
 * credential and default model. Credential access stays lazy - read only when a
 * recognized compaction request needs it - and a missing value is an explicit
 * compaction failure, never a process-startup failure. Never logged or echoed.
 */
function defaultAsker(deps: JevCompactionDeps): JevAsker {
  const apiKey = deps.apiKey === undefined ? readOpenRouterApiKey() : deps.apiKey;
  if (!apiKey) throw new CompactionUnavailable("missing-key", "OPENROUTER_API_KEY is not configured");
  return new JevClient({
    apiKey,
    baseUrl: OPENROUTER_SYSTEMONE_URL,
    model: SYSTEMONE_DEFAULT_MODEL,
    fetch: createJevTimeoutFetch(deps.fetch ?? fetch, JEV_TIMEOUT_MS),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
}

function cancelledResponse(): Response {
  return openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error", param: null });
}

function failureResponse(kind: FailureKind): Response {
  const message = `Jev compaction unavailable (${kind})`;
  if (kind === "missing-key") {
    return openaiError(503, message, "jev_compaction_unavailable", { type: "server_error" });
  }
  if (kind === "jev-failed" || kind === "render-failed") {
    return openaiError(502, message, "jev_compaction_unavailable", { type: "server_error" });
  }
  return openaiError(400, message, "jev_compaction_unavailable");
}

/**
 * The hybrid residue pass runs by default (`JEV_COMPACTION_HYBRID=0` disables
 * it). An injected asker marks a test or diagnostic seam, so the default pass is
 * bypassed there unless the caller injects a residue explicitly. The pass never
 * throws: a failed pass returns null and the caller keeps the pure Jev summary.
 */
function resolveResidue(deps: JevCompactionDeps): CompactionResidue | undefined {
  if (deps.residue) return deps.residue;
  if (deps.asker || askerForTest) return undefined;
  return hybridResidueEnabled() ? runHybridResiduePass : undefined;
}

/**
 * Handles one recognized compaction request end to end. The body is read only
 * here (the normal route is never parsed), Jev work is bounded by the caller
 * signal and the per-call timeout, and every failure is a non-success response.
 */
export async function handleJevResponsesCompaction(req: Request, deps: JevCompactionDeps = {}): Promise<Response> {
  if (deps.signal?.aborted) return cancelledResponse();
  const body = await readJsonBody(req);
  if (body === null) {
    logCompaction({ outcome: "failed", kind: "unparsable-body" });
    return failureResponse("unparsable-body");
  }
  const parsedStream = parseStreamField(record(body)?.stream);
  if (!parsedStream.ok) return openaiError(400, parsedStream.message, "invalid_request_error", { param: "stream" });
  const stream = parsedStream.value;
  let asker: JevAsker;
  try {
    asker = deps.asker ?? askerForTest ?? defaultAsker(deps);
  } catch (error) {
    const kind = error instanceof CompactionUnavailable ? error.kind : "jev-failed";
    logCompaction({ outcome: "failed", kind, detail: failureLogDetail(kind, error instanceof Error ? error.message : "") });
    return failureResponse(kind);
  }
  let outcome: CompactionOutcome;
  try {
    outcome = await buildCompactionResponse(body, asker, { stream, residue: resolveResidue(deps) });
  } catch (error) {
    if (deps.signal?.aborted) {
      logCompaction({ outcome: "failed", kind: "cancelled" });
      return cancelledResponse();
    }
    const kind = error instanceof CompactionUnavailable ? error.kind : "jev-failed";
    const detail = error instanceof Error ? error.message : String(error);
    logCompaction({ outcome: "failed", kind, detail: failureLogDetail(kind, detail) });
    return failureResponse(kind);
  }
  if (deps.signal?.aborted) {
    logCompaction({ outcome: "failed", kind: "cancelled" });
    return cancelledResponse();
  }
  // Completion telemetry goes on the success path only: the terminal wrapper's
  // normal completion decision then detects this local answer and settles the
  // admitted request as completed, instead of releasing it as a stream that
  // ended without a completion. Failures above return unmarked responses and
  // still release through the same wrapper.
  return setResponseCompletionTelemetry(
    new Response(outcome.body, {
      status: outcome.status,
      headers: { "content-type": outcome.contentType, "cache-control": "no-store", ...outcome.headers },
    }),
    stream
  );
}

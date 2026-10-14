/**
 * Optional hybrid residue pass for Jev compaction.
 *
 * After the verbatim Jev selection has produced a summary, Cerebras
 * gpt-oss-120b calls compress it (dedupe, supersession, prose reduction) and
 * deterministic guards append the harvested identifier ledger and a verbatim
 * tail of the latest memory. Large memories are rewritten in context-sized
 * chunks and concatenated, because a real 1M-token session renders a memory
 * (up to `SUMMARY_CHAR_CAP`) that exceeds the residue model's context window;
 * the single-call path remains for memories that already fit. The pass is on by
 * default; setting `JEV_COMPACTION_HYBRID=0` disables it as an operator kill
 * switch. It is best-effort by contract: any missing credential, transport
 * failure, timeout, empty or non-shrinking output returns null and the caller
 * keeps the pure Jev summary, so a compaction can never fail because of this
 * pass.
 *
 * The model never carries identifiers on its own: the ledger is copied from the
 * original memory by code, and the tail is appended verbatim.
 */
import { CEREBRAS_GPT_OSS_120B_MODEL, fetchCerebrasChatCompletions, readCerebrasApiKey } from "../provider/cerebras.ts";

export const HYBRID_ENV = "JEV_COMPACTION_HYBRID";
export const HYBRID_RESIDUE_TIMEOUT_MS = 20_000;
export const HYBRID_TAIL_FRACTION = 0.12;
export const HYBRID_LEDGER_LIMIT = 300;
/**
 * Per-call residue input bound. The residue model's context is roughly 131k
 * tokens, and hash-dense memories tokenize near 2.2 characters per token, so a
 * 350k-character chunk could exceed the context and fail every chunk of a large
 * memory. 150k characters stays under ~70k tokens plus the prompt and required
 * identifier block; a whole 1.5M-character memory is covered by parallel calls.
 */
export const HYBRID_INPUT_CHUNK_CHARS = 150_000;
/** Residue chunk calls in flight at once; more trips provider transport limits. */
export const HYBRID_CHUNK_CONCURRENCY = 4;

const HYBRID_PROMPT = `You are compacting a coding-agent session memory so another model can continue the session.

Input: a machine-generated memory in sections:
- [user] / [assistant] / [developer] text blocks kept verbatim from the transcript;
- [tool call <id>] provenance lines with their input, labelled keep / drop_result / drop_call;
- [tool result <id>] blocks: kept verbatim or a bounded head ending in a truncation note.

Produce one compact memory that a continuation model can rely on, following these rules exactly:
1. Preserve every identifier verbatim and exactly as written: hashes, revisions, paths, thread ids, service names, versions, commands, exit codes, file names.
2. Resolve time order. When the same fact appears more than once, keep only the latest value. If an earlier blocker was later resolved, keep only the resolution (a historical note is allowed only when it explains a current decision).
3. Merge documents that repeat (the same instructions or memory pasted multiple times) into a single copy.
4. Keep: the goal and its current status, decisions and approvals with their times, ownership, exact next steps, and evidence pointers (paths and hashes).
5. Drop: superseded text, process chatter, duplicated documents, and bulk from truncated tool results.
6. Never invent facts, values, or identifiers that are not present in the input. When the memory shows a
   state change (an approval, acknowledgement, consumption or merge), keep the LATEST state exactly; never
   downgrade a state to its earlier form.
7. Output plain markdown between 20000 and 35000 characters. If you cannot fit everything, drop narrative
   prose first; never drop identifiers, current states, decisions, or next steps.

Memory to compact:
`;

export type LedgerEntry = { token: string; lastIndex: number; count: number };

const IDENTIFIER_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g,
  /\b[0-9a-f]{8,64}\b/g,
  /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,
  /\b[\w-]+\.(?:json|md|ts|sqlite3|sh|yml|yaml|service)\b/g,
];

const LEADING_TRIM = "`\"'()[]{},;:";
const TRAILING_TRIM = "`\"'()[]{},;:.";

function trimToken(raw: string): string {
  let start = 0;
  while (start < raw.length && LEADING_TRIM.includes(raw[start])) start += 1;
  let end = raw.length;
  while (end > start && TRAILING_TRIM.includes(raw[end - 1])) end -= 1;
  return raw.slice(start, end);
}

/** Path-like tokens, scanned linearly so the harvest stays cheap on huge memories. */
function pathOccurrences(text: string): { token: string; index: number }[] {
  const out: { token: string; index: number }[] = [];
  const isPathChar = (char: string): boolean => /[A-Za-z0-9_.@-]/.test(char);
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("/", cursor);
    if (start === -1) break;
    let end = start + 1;
    while (end < text.length && isPathChar(text[end])) end += 1;
    const candidate = text.slice(start, end);
    if (candidate.length >= 8 && candidate.slice(1).includes("/")) out.push({ token: candidate, index: start });
    cursor = Math.max(end, start + 1);
  }
  return out;
}

/** Slugs that carry an 8+ hex id (lane names, worktree names), scanned linearly. */
function slugOccurrences(text: string): { token: string; index: number }[] {
  const out: { token: string; index: number }[] = [];
  for (const raw of text.split(/\s+/)) {
    const token = trimToken(raw);
    if (token.length >= 8 && /[0-9a-f]{8,}/.test(token) && /[a-z-]/.test(token)) out.push({ token, index: text.lastIndexOf(token) });
  }
  return out;
}

/** Deterministic must-keep identifiers (SHAs, uuids, paths, slugs, file names). */
export function harvestLedger(text: string, max = HYBRID_LEDGER_LIMIT): LedgerEntry[] {
  const byToken = new Map<string, LedgerEntry>();
  const add = (token: string, index: number): void => {
    if (token.length < 8) return;
    const existing = byToken.get(token);
    if (existing) {
      existing.count += 1;
      existing.lastIndex = Math.max(existing.lastIndex, index);
    } else {
      byToken.set(token, { token, lastIndex: index, count: 1 });
    }
  };
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) add(match[0], match.index);
  }
  for (const occurrence of pathOccurrences(text)) add(occurrence.token, occurrence.index);
  for (const occurrence of slugOccurrences(text)) add(occurrence.token, occurrence.index);
  // The latest occurrences are the current state; keep them first when the cap bites.
  const latestFirst = [...byToken.values()].sort((a, b) => b.lastIndex - a.lastIndex).slice(0, max);
  return latestFirst.sort((a, b) => a.lastIndex - b.lastIndex);
}

function renderLedgerSection(entries: readonly LedgerEntry[], memoryChars: number): string {
  const selected = entries.filter((entry) => entry.lastIndex >= memoryChars * 0.6);
  if (selected.length === 0) return "";
  const lines = selected.map((entry) => {
    const suffix = entry.count > 1 ? " (seen " + String(entry.count) + "x)" : "";
    return "- " + entry.token + suffix;
  });
  return "\n\n## Verbatim identifiers (last seen in the final 40% of the rewritten memory)\n" + lines.join("\n") + "\n";
}

function renderTailSection(summary: string): string {
  const tailChars = Math.floor(summary.length * HYBRID_TAIL_FRACTION);
  if (tailChars <= 0) return "";
  return "\n\n## Verbatim latest transcript tail (" + String(tailChars) + " chars)\n" + summary.slice(summary.length - tailChars);
}

/** The deterministic presentation of one residue result: model text + ledger + tail. */
export function composeHybridSummary(modelText: string, pureSummary: string): string {
  const ledger = harvestLedger(pureSummary);
  return modelText + renderLedgerSection(ledger, pureSummary.length) + renderTailSection(pureSummary);
}

/** Split a memory into chunks at block boundaries so every residue call fits the model context. */
export function chunkMemoryForResidue(memory: string, maxChars: number): string[] {
  if (maxChars <= 0 || memory.length <= maxChars) return [memory];
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push(current);
    current = "";
  };
  for (const block of memory.split(/\n(?=\[)/)) {
    if (block.length > maxChars) {
      flush();
      for (let start = 0; start < block.length; start += maxChars) chunks.push(block.slice(start, start + maxChars));
      continue;
    }
    if (current.length > 0 && current.length + block.length + 1 > maxChars) {
      flush();
      current = block;
    } else {
      current = current.length > 0 ? current + "\n" + block : block;
    }
  }
  flush();
  return chunks;
}

function residueBody(memory: string): Record<string, unknown> {
  const required = harvestLedger(memory);
  const requiredBlock =
    required.length === 0
      ? ""
      : "\n\nREQUIRED IDENTIFIERS - every one of these must appear verbatim in your output; do not drop, rename, or summarize them away:\n" +
        required.map((entry) => "- " + entry.token).join("\n");
  return {
    model: CEREBRAS_GPT_OSS_120B_MODEL,
    stream: false,
    reasoning_effort: "medium",
    max_completion_tokens: 16_000,
    messages: [{ role: "user", content: HYBRID_PROMPT + memory + requiredBlock }],
  };
}

/** Text of a Chat Completions response; null when the shape is unusable. */
export function residueText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" && content.trim().length > 0 ? content : null;
}

function hybridFailureLog(detail: string): void {
  console.warn("[ai.ubq.fi] jev_compaction_hybrid " + JSON.stringify({ outcome: "failed", detail: detail.slice(0, 120) }));
}

export type HybridResidueDeps = Readonly<{
  fetcher?: typeof fetch;
  apiKey?: string | null;
  timeoutMs?: number;
  chunkChars?: number;
}>;

/**
 * One best-effort residue pass. Returns the composed summary (model text plus
 * the deterministic ledger and tail sections) when it is usable and smaller
 * than the pure summary, or null on every failure path.
 */
export async function runHybridResiduePass(summary: string, deps: HybridResidueDeps = {}): Promise<string | null> {
  const apiKey = deps.apiKey === undefined ? readCerebrasApiKey() : deps.apiKey;
  if (!apiKey) {
    hybridFailureLog("missing-key");
    return null;
  }
  const timeoutMs = deps.timeoutMs ?? HYBRID_RESIDUE_TIMEOUT_MS;
  const chunkChars = deps.chunkChars ?? HYBRID_INPUT_CHUNK_CHARS;
  const chunks = chunkMemoryForResidue(summary, chunkChars);
  try {
    const texts: string[] = new Array(chunks.length);
    let failed = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= chunks.length) return;
        const chunk = chunks[index];
        try {
          const upstream = await fetchCerebrasChatCompletions(residueBody(chunk), {
            apiKey,
            signal: AbortSignal.timeout(timeoutMs),
            ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
          });
          if (!upstream.ok) throw new Error("upstream-" + String(upstream.status));
          const text = residueText(await upstream.json());
          if (text === null) throw new Error("empty-output");
          texts[index] = text;
        } catch (error) {
          // One flaky chunk must not sink the whole rewrite: keep that chunk
          // verbatim and rewrite the rest.
          failed += 1;
          texts[index] = chunk;
          hybridFailureLog("chunk-" + (error instanceof Error && error.name === "TimeoutError" ? "timeout" : "failed") + "-" + String(index));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(HYBRID_CHUNK_CONCURRENCY, chunks.length)) }, () => worker()));
    if (failed === chunks.length) {
      hybridFailureLog("all-chunks-failed");
      return null;
    }
    const composed = composeHybridSummary(texts.join("\n\n"), summary);
    if (composed.trim().length === 0 || composed.length >= summary.length) {
      hybridFailureLog("no-reduction");
      return null;
    }
    return composed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("upstream-") || message === "empty-output") {
      hybridFailureLog(message);
      return null;
    }
    hybridFailureLog(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport");
    return null;
  }
}

/**
 * Operator switch: the residue pass runs by default and `JEV_COMPACTION_HYBRID=0`
 * is the kill switch. An environment that cannot be read at all keeps the safe
 * pure-Jev behavior.
 */
export function hybridResidueEnabled(): boolean {
  try {
    return Deno.env.get(HYBRID_ENV) !== "0";
  } catch {
    return false;
  }
}

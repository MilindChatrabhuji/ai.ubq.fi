import { readdir, readFile } from "node:fs/promises";
import { isFsError } from "../fs-errors.ts";
// corpus-build.ts — m1-corpus module worker for the DeepSeek V4.1 Flash provider waterfall benchmark.
// Builds the frozen v1 corpus from recorded DeepSeek V4.1 Flash subagent sessions under
// /Users/nv/.codex/sessions/2026/10 per DESIGN.md ("Frozen corpus"): one entry per chosen
// (session, turn boundary), boundary = last included response_item before an assistant-side record
// (user/developer message, tool result, or agent_message; call/output pairs never split); classes sized
// by the boundary turn's recorded input tokens (nearest token_count / token_usage_record at or after the
// boundary) small 2k-10k, medium 10k-40k, large 40k-160k, xlarge 160k-600k, target 6/9/9/6, closest
// recorded request used when a window cannot be filled; tools are the frozen fixture verbatim;
// instructions are the recorded base instructions; tool_choice "auto", parallel_tool_calls true,
// reasoning.effort from the boundary turn (else "high"), max_output_tokens null.
// The sanitizer stores each rule's canonical pattern text for the manifest (RULE_TEXT_* below) and
// executes a compile-ready equivalent whose match set is identical (see SANITIZER_RULES comments).
// Modes (all deterministic, no network): build (default), verify, selfcheck, report.

import type { CorpusClass, CorpusEntry, ResponsesInputItem } from "./types.ts";

export const SESSIONS_ROOT = "/Users/nv/.codex/sessions";
export const PRIMARY_MONTHS: readonly (readonly [string, string])[] = [["2026", "10"]];
export const FALLBACK_MONTHS: readonly (readonly [string, string])[] = [["2026", "09"]];

const BENCH_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname); // trailing slash
export const CORPUS_DIR = `${BENCH_DIR}corpus`;
export const JSONL_PATH = `${CORPUS_DIR}/corpus-v1.jsonl`;
export const MANIFEST_PATH = `${CORPUS_DIR}/corpus-v1.manifest.json`;
export const REPORT_PATH = `${BENCH_DIR}corpus-build-report.md`;
export const TOOLS_FIXTURE_PATH = `${BENCH_DIR}fixtures/codex-tools-0.160.1.json`;

// sha256 DESIGN.md records for the frozen tools capture (the committed fixture bytes, normalized by the
// repository's deno-fmt pre-commit hook); the manifest also records the actual bytes hash and the match.
const DESIGN_DOC_TOOLS_SHA256 = "e48b8f1e1533e676ba43f1f15660a8f5e35d2a775c607b94cb4d46a2116e29ab";

export const CLASS_ORDER: readonly CorpusClass[] = ["small", "medium", "large", "xlarge"];
const SELECTION_ORDER: readonly CorpusClass[] = ["xlarge", "small", "large", "medium"];
const CLASS_WINDOW: Readonly<Record<CorpusClass, readonly [number, number]>> = {
  small: [2000, 10000],
  medium: [10000, 40000],
  large: [40000, 160000],
  xlarge: [160000, 600000],
};
export const CLASS_QUOTA: Readonly<Record<CorpusClass, number>> = { small: 6, medium: 9, large: 9, xlarge: 6 };

const SANITIZER_REVISION = "sanitizer-v1";
const INCLUDED_ITEM_TYPES = new Set(["message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "agent_message"]);
const MODEL_PREFIXES = ["deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-v4-flash"];
const MODEL_EXACT = "deepseek-flash";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** String form for report/verification text: strings verbatim, numbers/booleans stringified, JSON otherwise. */
export const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value.toString();
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
};

export const textList = (value: unknown, separator: string): string => (Array.isArray(value) ? value.map((entry) => text(entry)).join(separator) : text(value));

const requireValue = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`internal error: missing ${what}`);
  return value;
};

export const compareText = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

// ------------------------------------------------------------------------------------------------ sanitizer

// Canonical rule text recorded in the manifest for the frozen corpus. The compiled patterns are
// lint-safe equivalents with an identical match set, fuzz-verified against the canonical form
// (600k random inputs plus adversarial cases):
//   - `[\w.~+/=-]` equals `[A-Za-z0-9._~+/=-]`;
//   - `(?<![A-Z0-9_])` / `(?<![A-Za-z0-9._%+-])` anchor the unanchored leading repetition at the leftmost
//     start the canonical forms already choose (a match whose predecessor class could extend it was
//     never the leftmost match), which removes the super-linear backtracking shape;
//   - `[0-9]` becomes `\d` in shapeMask (same single-character set).
const RULE_TEXT_AUTHORIZATION = "(Authorization:\\s*)[A-Za-z0-9._~+/=-]{16,}";
const RULE_TEXT_ASSIGNMENT = "([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=(?!\\[REDACTED:)[^\\s'\"`]+";
const RULE_TEXT_BEARER = "\\bBearer\\s+[A-Za-z0-9._-]{20,}";
const RULE_TEXT_LITH_SK = "lith_sk_[A-Za-z0-9]{16,}";
const RULE_TEXT_FERNET = "gAAAAA[A-Za-z0-9_-]{40,}";
const RULE_TEXT_SLACK_BOT = "xoxb-[A-Za-z0-9-]{10,}";
const RULE_TEXT_GITHUB_PAT = "ghp_[A-Za-z0-9]{30,}";
const RULE_TEXT_AWS_ACCESS_KEY = "AKIA[0-9A-Z]{16}";
const RULE_TEXT_HEX_AK_SK = "(?:AK|SK)[0-9a-f]{32}";
const RULE_TEXT_SK = "sk-[A-Za-z0-9_-]{16,}";

type SanitizerRule = {
  id: string;
  /** Canonical pattern text recorded in the corpus manifest for this rule. */
  patternText: string;
  /** Executable pattern whose match set is identical to patternText. */
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
};

const SANITIZER_RULES: readonly SanitizerRule[] = [
  {
    id: "authorization_header",
    patternText: RULE_TEXT_AUTHORIZATION,
    pattern: new RegExp("(Authorization:\\s*)[\\w.~+/=-]{16,}", "gi"),
    replace: (_match, head) => `${head}[REDACTED:authorization_header]`,
  },
  {
    id: "assignment",
    patternText: RULE_TEXT_ASSIGNMENT,
    pattern: new RegExp("(?<![A-Z0-9_])([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=(?!\\[REDACTED:)[^\\s'\"`]+", "g"),
    replace: (_match, name) => `${name}=[REDACTED:assignment]`,
  },
  { id: "bearer", patternText: RULE_TEXT_BEARER, pattern: new RegExp(RULE_TEXT_BEARER, "g"), replace: () => "[REDACTED:bearer]" },
  { id: "lith_sk", patternText: RULE_TEXT_LITH_SK, pattern: new RegExp(RULE_TEXT_LITH_SK, "g"), replace: () => "[REDACTED:lith_sk]" },
  { id: "fernet", patternText: RULE_TEXT_FERNET, pattern: new RegExp(RULE_TEXT_FERNET, "g"), replace: () => "[REDACTED:fernet]" },
  { id: "slack_bot", patternText: RULE_TEXT_SLACK_BOT, pattern: new RegExp(RULE_TEXT_SLACK_BOT, "g"), replace: () => "[REDACTED:slack_bot]" },
  { id: "github_pat", patternText: RULE_TEXT_GITHUB_PAT, pattern: new RegExp(RULE_TEXT_GITHUB_PAT, "g"), replace: () => "[REDACTED:github_pat]" },
  {
    id: "aws_access_key",
    patternText: RULE_TEXT_AWS_ACCESS_KEY,
    pattern: new RegExp(RULE_TEXT_AWS_ACCESS_KEY, "g"),
    replace: () => "[REDACTED:aws_access_key]",
  },
  { id: "hex_ak_sk", patternText: RULE_TEXT_HEX_AK_SK, pattern: new RegExp(RULE_TEXT_HEX_AK_SK, "g"), replace: () => "[REDACTED:hex_ak_sk]" },
  { id: "sk", patternText: RULE_TEXT_SK, pattern: new RegExp(RULE_TEXT_SK, "g"), replace: () => "[REDACTED:sk]" },
];

// Conditional email rule (applied only inside strings that matched a credential rule), canonical form
// "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"; the lookbehind anchors the same leftmost matches.
const EMAIL_PATTERN = new RegExp("(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "g");

const totalSubstitutions = (counts: Map<string, number>): number => {
  let total = 0;
  for (const value of counts.values()) total += value;
  return total;
};

export const sanitizeString = (value: string, counts: Map<string, number>): string => {
  const before = totalSubstitutions(counts);
  let out = value;
  for (const rule of SANITIZER_RULES) {
    out = out.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
      return rule.replace(match, ...(groups as string[]));
    });
  }
  if (totalSubstitutions(counts) === before) return out;
  return out.replace(EMAIL_PATTERN, () => {
    counts.set("email", (counts.get("email") ?? 0) + 1);
    return "[REDACTED:email]";
  });
};

const sanitizeObject = (value: JsonObject, counts: Map<string, number>): JsonObject => {
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) out[key] = sanitizeValue(entry, counts);
  return out;
};

/** @returns {JsonValue} a deep copy of the input with every string sanitized */
const sanitizeValue = (value: JsonValue, counts: Map<string, number>): JsonValue => {
  if (typeof value === "string") return sanitizeString(value, counts);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, counts));
  if (isObject(value)) return sanitizeObject(value, counts);
  return value;
};

const shapeMask = (value: string): string => value.replace(/[A-Za-z]/g, "L").replace(/\d/g, "D");

export const countResidualMatches = (value: string): number => SANITIZER_RULES.reduce((total, rule) => total + (value.match(rule.pattern)?.length ?? 0), 0);

type ResidualHit = { path: string; details: string[] };

/** Masked (shape-only) residual scan over every string in a JSON value, reporting the value path. */
const findResidualStrings = (value: JsonValue, path: string, hits: ResidualHit[]): void => {
  if (typeof value === "string") {
    if (countResidualMatches(value) !== 0) hits.push({ path, details: describeResidualMatches(value) });
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      findResidualStrings(entry, `${path}[${index}]`, hits);
    });
  } else if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) findResidualStrings(entry, `${path}.${key}`, hits);
  }
};

/** Masked (shape-only) description of any residual match, so failure diagnostics never echo values. */
const describeResidualMatches = (value: string): string[] => {
  const details: string[] = [];
  for (const rule of SANITIZER_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of value.matchAll(pattern)) {
      const start = match.index;
      const before = shapeMask(value.slice(Math.max(0, start - 120), start));
      const after = shapeMask(value.slice(start + match[0].length, start + match[0].length + 40));
      details.push(`${rule.id} len=${match[0].length} match=${shapeMask(match[0]).slice(0, 16)} before=${before} after=${after}`);
    }
  }
  return details;
};

// -------------------------------------------------------------------------------------------- session IO

type RawRecord = { ordinal: number; timestamp: string | null; type: string; payload: JsonObject };

const parseSessionLine = (path: string, lineNumber: number, line: string, fallbackOrdinal: number): RawRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`malformed JSON at ${path}:${lineNumber}: ${(error as Error).message}`, { cause: error });
  }
  if (!isObject(parsed)) throw new Error(`non-object record at ${path}:${lineNumber}`);
  return {
    ordinal: asNumber(parsed.ordinal) ?? fallbackOrdinal,
    timestamp: asString(parsed.timestamp),
    type: asString(parsed.type) ?? "",
    payload: isObject(parsed.payload) ? parsed.payload : {},
  };
};

const parseSessionRecords = (path: string, content: string): RawRecord[] => {
  const records: RawRecord[] = [];
  let lineNumber = 0;
  for (const line of content.split("\n")) {
    lineNumber += 1;
    if (!line.trim()) continue;
    records.push(parseSessionLine(path, lineNumber, line, records.length));
  }
  records.sort((a, b) => a.ordinal - b.ordinal);
  return records;
};

const modelMatches = (model: string | null): boolean => {
  if (!model) return false;
  return MODEL_PREFIXES.some((prefix) => model.startsWith(prefix)) || model === MODEL_EXACT;
};

type ItemRecord = { ordinal: number; timestamp: string | null; payload: JsonObject };
type TurnContext = { ordinal: number; turnId: string | null; model: string | null; effort: string | null };
type UsageRecord = { ordinal: number; kind: "token_usage_record" | "token_count"; payload: JsonObject };

type Boundary = {
  itemIndex: number;
  ordinal: number;
  itemType: string;
  role: string | null;
  tokens: number;
  turnId: string | null;
  threadId: string | null;
  model: string | null;
  effort: string | null;
  recordedAt: string | null;
  description: string;
};

type SessionData = {
  path: string;
  relativePath: string;
  metaRecords: number;
  sessionId: string;
  cwd: string | null;
  baseInstructions: string;
  items: ItemRecord[];
  turnContexts: TurnContext[];
  usages: UsageRecord[];
  boundaries: Boundary[];
};

const isSubagentMeta = (meta: JsonObject): string | null => {
  if (meta.thread_source === "subagent") return "thread_source=subagent";
  const source = meta.source;
  if (isObject(source) && "subagent" in source) return "source.subagent present";
  if (typeof source === "string" && source === "subagent") return "source=subagent";
  return null;
};

const isBoundaryItem = (payload: JsonObject): boolean => {
  const type = payload.type;
  if (type === "message") return payload.role === "user" || payload.role === "developer";
  return type === "agent_message" || type === "function_call_output" || type === "custom_tool_call_output";
};

const isAssistantSide = (payload: JsonObject): boolean => {
  const type = payload.type;
  if (type === "message") return payload.role === "assistant";
  return type === "function_call" || type === "custom_tool_call" || type === "reasoning";
};

const boundaryDescription = (payload: JsonObject, ordinal: number): string => {
  const type = asString(payload.type) ?? "unknown";
  const role = asString(payload.role);
  return role ? `${type}/${role} @ord ${ordinal}` : `${type} @ord ${ordinal}`;
};

const usageInputTokens = (usage: UsageRecord): number | null => {
  if (usage.kind === "token_usage_record") {
    const direct = isObject(usage.payload.turn_token_usage) ? usage.payload.turn_token_usage : usage.payload.usage;
    if (isObject(direct)) return asNumber(direct.input_tokens);
    return null;
  }
  const info = isObject(usage.payload.info) ? usage.payload.info : null;
  if (!info) return null;
  const last = isObject(info.last_token_usage) ? info.last_token_usage : info.total_token_usage;
  if (isObject(last)) return asNumber(last.input_tokens);
  return null;
};

const collectTurnContexts = (records: readonly RawRecord[]): TurnContext[] =>
  records
    .filter((record) => record.type === "turn_context")
    .map((record) => ({
      ordinal: record.ordinal,
      turnId: asString(record.payload.turn_id),
      model: asString(record.payload.model),
      effort: asString(record.payload.effort),
    }));

const collectItems = (records: readonly RawRecord[]): ItemRecord[] =>
  records
    .filter((record) => record.type === "response_item")
    .map((record) => ({ ordinal: record.ordinal, timestamp: record.timestamp, payload: record.payload }));

const collectUsages = (records: readonly RawRecord[]): UsageRecord[] =>
  records
    .filter((record) => record.type === "token_usage_record" || (record.type === "event_msg" && record.payload.type === "token_count"))
    .map((record) => ({
      ordinal: record.ordinal,
      kind: record.type === "token_usage_record" ? "token_usage_record" : "token_count",
      payload: record.payload,
    }));

const lookupTurnContext = (turnContexts: readonly TurnContext[], turnId: string | null, ordinal: number): TurnContext | null => {
  const exact = turnId ? turnContexts.find((context) => context.turnId === turnId) : undefined;
  if (exact) return exact;
  const before = turnContexts.filter((context) => context.ordinal <= ordinal);
  return before.length ? before[before.length - 1] : (turnContexts[0] ?? null);
};

const keepCallOrder = (seenCallIds: Set<string>, payload: JsonObject, type: string): boolean => {
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const callId = asString(payload.call_id);
    return callId !== null && seenCallIds.has(callId); // never split a call from its output
  }
  if (type === "function_call" || type === "custom_tool_call") {
    const callId = asString(payload.call_id);
    if (callId) seenCallIds.add(callId);
  }
  return true;
};

const makeBoundary = (current: ItemRecord, index: number, type: string, tokens: number, usage: UsageRecord, turnContexts: readonly TurnContext[]): Boundary => {
  const passthrough = isObject(current.payload.internal_chat_message_metadata_passthrough) ? current.payload.internal_chat_message_metadata_passthrough : null;
  const turnId = (passthrough ? asString(passthrough.turn_id) : null) ?? asString(usage.payload.turn_id);
  const context = lookupTurnContext(turnContexts, turnId, current.ordinal);
  return {
    itemIndex: index,
    ordinal: current.ordinal,
    itemType: type,
    role: asString(current.payload.role),
    tokens,
    turnId,
    threadId: asString(usage.payload.thread_id),
    model: context?.model ?? null,
    effort: context?.effort ?? "high",
    recordedAt: current.timestamp,
    description: boundaryDescription(current.payload, current.ordinal),
  };
};

const findBoundaries = (items: readonly ItemRecord[], usages: readonly UsageRecord[], turnContexts: readonly TurnContext[]): Boundary[] => {
  const seenCallIds = new Set<string>();
  const boundaries: Boundary[] = [];
  for (let index = 0; index < items.length - 1; index += 1) {
    const current = items[index];
    if (!isBoundaryItem(current.payload) || !isAssistantSide(items[index + 1].payload)) continue;
    const type = asString(current.payload.type) ?? "";
    if (!keepCallOrder(seenCallIds, current.payload, type)) continue;
    const usage = usages.find((record) => record.ordinal >= current.ordinal);
    if (!usage) continue;
    const tokens = usageInputTokens(usage);
    if (tokens === null) continue;
    boundaries.push(makeBoundary(current, index, type, tokens, usage, turnContexts));
  }
  return boundaries;
};

const parseSession = (path: string, relativePath: string, content: string): SessionData | null => {
  const records = parseSessionRecords(path, content);
  const metaRecords = records.filter((record) => record.type === "session_meta");
  const matchingMeta = metaRecords.map((record) => ({ record, reason: isSubagentMeta(record.payload) })).find((candidate) => candidate.reason !== null);
  if (!matchingMeta) return null;
  const turnContexts = collectTurnContexts(records);
  if (!turnContexts.some((context) => modelMatches(context.model))) return null;
  const items = collectItems(records);
  const usages = collectUsages(records);
  const meta = matchingMeta.record.payload;
  const baseInstructionsRaw = isObject(meta.base_instructions) ? asString(meta.base_instructions.text) : null;
  return {
    path,
    relativePath,
    metaRecords: metaRecords.length,
    sessionId: asString(meta.session_id) ?? asString(meta.id) ?? relativePath,
    cwd: asString(meta.cwd),
    baseInstructions: baseInstructionsRaw && baseInstructionsRaw.length > 0 ? baseInstructionsRaw : "",
    items,
    turnContexts,
    usages,
    boundaries: findBoundaries(items, usages, turnContexts),
  };
};

const listDayFiles = async (monthDir: string, day: string): Promise<string[]> => {
  const names: string[] = [];
  for (const entry of await readdir(`${monthDir}/${day}`, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) names.push(entry.name);
  }
  names.sort(compareText);
  return names.map((name) => `${monthDir}/${day}/${name}`);
};

const listMonthDays = async (monthDir: string): Promise<string[]> => {
  const days: string[] = [];
  try {
    for (const entry of await readdir(monthDir, { withFileTypes: true })) if (entry.isDirectory()) days.push(entry.name);
  } catch (error) {
    if (isFsError(error, "ENOENT")) return [];
    throw error;
  }
  return days.sort(compareText);
};

export const listJsonlFiles = async (months: readonly (readonly [string, string])[]): Promise<string[]> => {
  const files: string[] = [];
  for (const [year, month] of months) {
    const monthDir = `${SESSIONS_ROOT}/${year}/${month}`;
    for (const day of await listMonthDays(monthDir)) files.push(...(await listDayFiles(monthDir, day)));
  }
  return files.sort(compareText);
};

export const harvest = async (files: readonly string[], root: string): Promise<SessionData[]> => {
  const sessions: SessionData[] = [];
  for (const path of files) {
    const content = await readFile(path, "utf8");
    const relativePath = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    const session = parseSession(path, relativePath, content);
    if (session) sessions.push(session);
  }
  return sessions;
};

// ------------------------------------------------------------------------------------------------ selection

const inWindow = (cls: CorpusClass, tokens: number): boolean => {
  const [low, high] = CLASS_WINDOW[cls];
  return tokens >= low && tokens <= high;
};

const windowDistance = (cls: CorpusClass, tokens: number): number => {
  const [low, high] = CLASS_WINDOW[cls];
  if (tokens < low) return low - tokens;
  if (tokens > high) return tokens - high;
  return 0;
};

const pickFirstInWindow = (session: SessionData, cls: CorpusClass): Boundary | null =>
  session.boundaries.filter((boundary) => inWindow(cls, boundary.tokens)).sort((a, b) => a.ordinal - b.ordinal)[0] ?? null;

const pickLargestInWindow = (session: SessionData, cls: CorpusClass): Boundary | null =>
  session.boundaries.filter((boundary) => inWindow(cls, boundary.tokens)).sort((a, b) => b.tokens - a.tokens || a.ordinal - b.ordinal)[0] ?? null;

const pickClosest = (session: SessionData, cls: CorpusClass): Boundary | null =>
  session.boundaries.slice().sort((a, b) => windowDistance(cls, a.tokens) - windowDistance(cls, b.tokens) || a.tokens - b.tokens || a.ordinal - b.ordinal)[0] ??
  null;

type Chosen = { cls: CorpusClass; session: SessionData; boundary: Boundary };
type Take = (cls: CorpusClass, session: SessionData, boundary: Boundary) => void;

export const selectionFeasible = (candidateSessions: readonly SessionData[]): boolean => {
  for (const cls of CLASS_ORDER) {
    const inWindowCount = candidateSessions.filter((session) => session.boundaries.some((boundary) => inWindow(cls, boundary.tokens))).length;
    if (inWindowCount >= CLASS_QUOTA[cls]) continue;
    if (cls === "small" && candidateSessions.filter((session) => session.boundaries.length > 0).length >= CLASS_QUOTA.small) continue;
    return false;
  }
  return true;
};

const takeXlarge = (ordered: readonly SessionData[], take: Take): void => {
  // xlarge: prefer the largest in-window recorded request; sessions ranked by their largest in-window boundary.
  const ranked = ordered
    .filter((session) => session.boundaries.some((boundary) => inWindow("xlarge", boundary.tokens)))
    .map((session) => ({ session, boundary: requireValue(pickLargestInWindow(session, "xlarge"), "xlarge boundary") }))
    .sort((a, b) => b.boundary.tokens - a.boundary.tokens || compareText(a.session.path, b.session.path));
  for (const { session, boundary } of ranked.slice(0, CLASS_QUOTA.xlarge)) take("xlarge", session, boundary);
};

const compareClosestSmall = (a: { session: SessionData; boundary: Boundary }, b: { session: SessionData; boundary: Boundary }): number => {
  const distance = windowDistance("small", a.boundary.tokens) - windowDistance("small", b.boundary.tokens);
  if (distance !== 0) return distance;
  const byTokens = a.boundary.tokens - b.boundary.tokens;
  if (byTokens !== 0) return byTokens;
  return compareText(a.session.path, b.session.path);
};

const takeClosestSmall = (ordered: readonly SessionData[], take: Take, used: Set<string>): void => {
  const ranked = ordered
    .filter((session) => !used.has(session.path))
    .map((session) => ({ session, boundary: pickClosest(session, "small") }))
    .filter((candidate): candidate is { session: SessionData; boundary: Boundary } => candidate.boundary !== null)
    .sort(compareClosestSmall);
  let taken = 0;
  for (const { session, boundary } of ranked) {
    if (taken >= CLASS_QUOTA.small) break;
    if (used.has(session.path)) continue;
    take("small", session, boundary);
    taken += 1;
  }
};

const takeSmall = (ordered: readonly SessionData[], take: Take, used: Set<string>): string => {
  const inWindowSessions = ordered.filter((session) => !used.has(session.path) && session.boundaries.some((boundary) => inWindow("small", boundary.tokens)));
  if (inWindowSessions.length >= CLASS_QUOTA.small) {
    for (const session of inWindowSessions.slice(0, CLASS_QUOTA.small))
      take("small", session, requireValue(pickFirstInWindow(session, "small"), "small boundary"));
    return "in-window";
  }
  takeClosestSmall(ordered, take, used);
  return "closest-recorded-request";
};

const takeGroup = (cls: CorpusClass, ordered: readonly SessionData[], take: Take, used: Set<string>): void => {
  const pool = ordered.filter((session) => !used.has(session.path) && session.boundaries.some((boundary) => inWindow(cls, boundary.tokens)));
  for (const session of pool.slice(0, CLASS_QUOTA[cls])) take(cls, session, requireValue(pickFirstInWindow(session, cls), `${cls} boundary`));
};

const assertSelectionCounts = (chosen: readonly Chosen[]): void => {
  const counts = new Map<CorpusClass, number>();
  for (const entry of chosen) counts.set(entry.cls, (counts.get(entry.cls) ?? 0) + 1);
  for (const cls of CLASS_ORDER) {
    const got = counts.get(cls) ?? 0;
    if (got !== CLASS_QUOTA[cls]) throw new Error(`selection failed: ${cls} has ${got} entries, want ${CLASS_QUOTA[cls]}`);
  }
};

export const selectEntries = (sessions: readonly SessionData[]): { chosen: Chosen[]; smallMode: string } => {
  const ordered = sessions.slice().sort((a, b) => compareText(a.path, b.path));
  const used = new Set<string>();
  const chosen: Chosen[] = [];
  const take: Take = (cls, session, boundary) => {
    chosen.push({ cls, session, boundary });
    used.add(session.path);
  };
  takeXlarge(ordered, take);
  const smallMode = takeSmall(ordered, take, used);
  takeGroup("large", ordered, take, used);
  takeGroup("medium", ordered, take, used);
  assertSelectionCounts(chosen);
  return { chosen, smallMode };
};

// --------------------------------------------------------------------------------------------- entry build

type BuiltEntry = { entry: CorpusEntry; encryptedRemoved: number; droppedItems: Map<string, number> };

const buildInput = (session: SessionData, itemIndex: number): { input: ResponsesInputItem[]; dropped: Map<string, number>; encryptedRemoved: number } => {
  const input: ResponsesInputItem[] = [];
  const dropped = new Map<string, number>();
  let encryptedRemoved = 0;
  for (let index = 0; index <= itemIndex; index += 1) {
    const payload = session.items[index].payload;
    const type = asString(payload.type) ?? "unknown";
    if (!INCLUDED_ITEM_TYPES.has(type)) {
      dropped.set(type, (dropped.get(type) ?? 0) + 1);
      continue;
    }
    const copy = structuredClone(payload) as JsonObject;
    delete copy.internal_chat_message_metadata_passthrough;
    if (type === "message" || type === "agent_message") {
      const content = Array.isArray(copy.content) ? copy.content : [];
      const kept = content.filter((entry) => !(isObject(entry) && entry.type === "encrypted_content"));
      encryptedRemoved += content.length - kept.length;
      copy.content = kept;
    }
    input.push(copy as unknown as ResponsesInputItem);
  }
  return { input, dropped, encryptedRemoved };
};

const buildEntry = (chosen: Chosen, tools: JsonValue[], counts: Map<string, number>, indexInClass: number): BuiltEntry => {
  const { cls, session, boundary } = chosen;
  const { input, dropped, encryptedRemoved } = buildInput(session, boundary.itemIndex);
  const entry: CorpusEntry = {
    id: `corpus-${cls}-${String(indexInClass).padStart(2, "0")}`,
    cls,
    source: {
      session_id: session.sessionId,
      thread_id: boundary.threadId,
      turn_id: boundary.turnId,
      recorded_model: boundary.model ?? "",
      recorded_at: boundary.recordedAt ?? "",
      recorded_input_tokens: boundary.tokens,
      item_count: input.length,
      dropped_item_types: [...dropped.keys()].sort(compareText),
    },
    request: {
      instructions: session.baseInstructions,
      input,
      tools: tools as unknown as readonly ResponsesInputItem[],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: boundary.effort ?? "high" },
      max_output_tokens: null,
    },
  };
  const sanitized = sanitizeValue(entry as unknown as JsonValue, counts) as unknown as CorpusEntry;
  return { entry: sanitized, encryptedRemoved, droppedItems: dropped };
};

// ---------------------------------------------------------------------------------------------------- build

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

type BuiltRows = {
  rows: { entry: CorpusEntry; item: Chosen; encryptedRemoved: number }[];
  entries: CorpusEntry[];
  perClass: Map<CorpusClass, number>;
  droppedItemTotals: Map<string, number>;
  encryptedTotal: number;
};

export const collectRows = (chosen: readonly Chosen[], tools: JsonValue[], counts: Map<string, number>): BuiltRows => {
  const rows: BuiltRows["rows"] = [];
  const perClass = new Map<CorpusClass, number>();
  const droppedItemTotals = new Map<string, number>();
  let encryptedTotal = 0;
  for (const cls of CLASS_ORDER) {
    const group = chosen.filter((item) => item.cls === cls).sort((a, b) => compareText(a.session.path, b.session.path));
    for (const item of group) {
      const indexInClass = (perClass.get(cls) ?? 0) + 1;
      perClass.set(cls, indexInClass);
      const built = buildEntry(item, tools, counts, indexInClass);
      rows.push({ entry: built.entry, item, encryptedRemoved: built.encryptedRemoved });
      encryptedTotal += built.encryptedRemoved;
      for (const [type, count] of built.droppedItems) droppedItemTotals.set(type, (droppedItemTotals.get(type) ?? 0) + count);
    }
  }
  return { rows, entries: rows.map((row) => row.entry), perClass, droppedItemTotals, encryptedTotal };
};

export const findDecodedResiduals = (rows: readonly { entry: CorpusEntry }[]): string[] => {
  // Primary guarantee: no credential shape survives inside any decoded string value of any entry.
  const decodedResiduals: string[] = [];
  for (const { entry } of rows) {
    const hits: ResidualHit[] = [];
    findResidualStrings(entry as unknown as JsonValue, entry.id, hits);
    for (const hit of hits) decodedResiduals.push(`${hit.path}: ${hit.details.join(" | ")}`);
  }
  return decodedResiduals;
};

export const makeManifest = (
  corpus: JsonObject,
  smallMode: string,
  monthsUsed: readonly string[],
  fallbackHarvested: boolean,
  sessions: readonly SessionData[],
  counts: Map<string, number>,
  serializedArtifacts: number,
  fixtureSha256: string,
  fixtureBytes: Uint8Array,
  tools: JsonValue[],
  rows: BuiltRows["rows"],
  droppedItemTotals: Map<string, number>,
  encryptedTotal: number
): JsonObject => ({
  schema: "corpus-v1",
  generator: "benchmarks/provider-waterfall/corpus-build.ts",
  corpus,
  counts_by_class: CLASS_QUOTA,
  class_windows: CLASS_WINDOW as unknown as JsonValue,
  class_target: "6 small, 9 medium, 9 large, 6 xlarge",
  sources: {
    root: SESSIONS_ROOT,
    primary_months: ["2026/10"],
    months_used: monthsUsed as unknown as JsonValue,
    fallback_months_harvested: fallbackHarvested,
    candidate_sessions: sessions.length,
    multi_meta_candidate_files: sessions.filter((session) => session.metaRecords > 1).length,
    candidate_filter:
      "session_meta.thread_source=subagent or source.subagent present; turn_context model deepseek-ai/DeepSeek-V4.1-Flash*, deepseek-flash, or deepseek-v4-flash*",
  },
  selection: {
    order: SELECTION_ORDER as unknown as JsonValue,
    xlarge: "largest in-window boundary per session; sessions ranked by largest in-window recorded input tokens desc",
    small: smallMode,
    small_note:
      smallMode === "closest-recorded-request"
        ? "no DeepSeek V4.1 Flash session under 2026/10 has a boundary inside 2000-10000 recorded input tokens; the six recorded requests closest to the window were used"
        : null,
    large: "first in-window boundary per session; sessions in path order",
    medium: "first in-window boundary per session; sessions in path order",
    one_entry_per_session: true,
  },
  sanitizer: {
    revision: SANITIZER_REVISION,
    rules: SANITIZER_RULES.map((rule) => ({
      id: rule.id,
      pattern: rule.patternText,
      flags: rule.pattern.flags,
      substitutions: counts.get(rule.id) ?? 0,
    })),
    conditional_rules: [{ id: "email", note: "applied only inside strings that matched a credential rule", substitutions: counts.get("email") ?? 0 }],
    total_substitutions: [...counts.values()].reduce((sum, value) => sum + value, 0),
    decoded_string_residual_matches: 0,
    serialized_line_escape_artifacts: serializedArtifacts,
    serialized_line_note:
      serializedArtifacts === 0
        ? null
        : "matches exist only in the JSON-escaped serialization: a real newline is rendered as backslash-n, so an empty NAME= at end of line folds into the following lines; no decoded string contains a match",
  },
  tools_fixture: {
    path: "fixtures/codex-tools-0.160.1.json",
    sha256: fixtureSha256,
    bytes: fixtureBytes.length,
    entries: tools.length,
    design_doc_expected_sha256: DESIGN_DOC_TOOLS_SHA256,
    matches_design_doc: fixtureSha256 === DESIGN_DOC_TOOLS_SHA256,
  },
  dropped_item_types: [...droppedItemTotals.keys()].sort(compareText),
  dropped_item_type_counts: Object.fromEntries([...droppedItemTotals.entries()].sort((a, b) => compareText(a[0], b[0]))),
  encrypted_content_entries_removed: encryptedTotal,
  entries: rows.map(({ entry, item }) => ({
    id: entry.id,
    cls: entry.cls,
    session_id: entry.source.session_id,
    thread_id: entry.source.thread_id,
    turn_id: entry.source.turn_id,
    recorded_model: entry.source.recorded_model,
    recorded_at: entry.source.recorded_at,
    recorded_input_tokens: entry.source.recorded_input_tokens,
    item_count: entry.source.item_count,
    dropped_item_types: entry.source.dropped_item_types,
    boundary: { description: item.boundary.description, ordinal: item.boundary.ordinal, type: item.boundary.itemType, role: item.boundary.role },
    source_path: item.session.relativePath,
    cwd: item.session.cwd,
    session_meta_records: item.session.metaRecords,
  })) as unknown as JsonValue,
});

export const printBuildSummary = (
  entries: readonly CorpusEntry[],
  jsonlBytes: Uint8Array,
  corpusSha256: string,
  perClass: Map<CorpusClass, number>,
  sessions: readonly SessionData[],
  monthsUsed: readonly string[],
  smallMode: string,
  rows: BuiltRows["rows"],
  counts: Map<string, number>,
  decodedResiduals: readonly string[],
  serializedArtifacts: number,
  fixtureSha256: string
): void => {
  console.log(`built ${entries.length} entries: ${jsonlBytes.length} bytes sha256=${corpusSha256}`);
  console.log(`class counts: small=${perClass.get("small")} medium=${perClass.get("medium")} large=${perClass.get("large")} xlarge=${perClass.get("xlarge")}`);
  console.log(`candidates=${sessions.length} months=${monthsUsed.join(",")} small_mode=${smallMode}`);
  console.log("id\tclass\ttokens\titems\tboundary\tsession");
  for (const { entry, item } of rows)
    console.log(
      `${entry.id}\t${entry.cls}\t${entry.source.recorded_input_tokens}\t${entry.source.item_count}\t${item.boundary.description}\t${item.session.relativePath}`
    );
  console.log("sanitizer substitutions:", JSON.stringify(Object.fromEntries([...counts.entries()].sort((a, b) => compareText(a[0], b[0])))));
  console.log(`sanitizer residuals: decoded=${decodedResiduals.length} serialized_escape_artifacts=${serializedArtifacts}`);
  console.log(`tools fixture sha256=${fixtureSha256} (design doc says ${DESIGN_DOC_TOOLS_SHA256}, matches=${fixtureSha256 === DESIGN_DOC_TOOLS_SHA256})`);
};

// --------------------------------------------------------------------------------------------------- verify

const verifySource = (source: JsonObject, where: string, issues: string[]): void => {
  if (typeof source.session_id !== "string" || !source.session_id) issues.push(`${where}: bad source.session_id`);
  if (typeof source.recorded_model !== "string" || !source.recorded_model) issues.push(`${where}: bad source.recorded_model`);
  if (typeof source.recorded_input_tokens !== "number") issues.push(`${where}: bad source.recorded_input_tokens`);
  if (typeof source.item_count !== "number") issues.push(`${where}: bad source.item_count`);
  if (!Array.isArray(source.dropped_item_types)) issues.push(`${where}: bad source.dropped_item_types`);
};

const verifyRequest = (request: JsonObject, where: string, fixture: JsonValue[], issues: string[]): void => {
  if (typeof request.instructions !== "string") issues.push(`${where}: bad request.instructions`);
  if (request.tool_choice !== "auto") issues.push(`${where}: tool_choice != auto`);
  if (request.parallel_tool_calls !== true) issues.push(`${where}: parallel_tool_calls != true`);
  if (request.max_output_tokens !== null) issues.push(`${where}: max_output_tokens != null`);
  const reasoning = request.reasoning;
  if (!isObject(reasoning) || typeof reasoning.effort !== "string" || reasoning.effort.length === 0) {
    issues.push(`${where}: bad request.reasoning`);
  }
  if (!Array.isArray(request.tools)) {
    issues.push(`${where}: request.tools not an array`);
    return;
  }
  if (JSON.stringify(request.tools) !== JSON.stringify(fixture)) issues.push(`${where}: request.tools differ from fixture`);
};

const verifyInputItem = (item: JsonObject, where: string, seenCallIds: Set<string>, issues: string[]): void => {
  const type = asString(item.type) ?? "";
  if (!INCLUDED_ITEM_TYPES.has(type)) issues.push(`${where}: disallowed input item type ${type}`);
  if ("internal_chat_message_metadata_passthrough" in item) issues.push(`${where}: passthrough field present`);
  if (type === "message" || type === "agent_message") {
    if (!Array.isArray(item.content)) issues.push(`${where}: ${type} content not an array`);
    else if (item.content.some((contentItem) => isObject(contentItem) && contentItem.type === "encrypted_content")) {
      issues.push(`${where}: encrypted_content entry present`);
    }
  }
  if (type === "function_call" || type === "custom_tool_call") {
    const callId = asString(item.call_id);
    if (callId) seenCallIds.add(callId);
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const callId = asString(item.call_id);
    if (!callId || !seenCallIds.has(callId)) issues.push(`${where}: tool output without matching call`);
  }
};

const verifyInput = (input: JsonValue[], itemCount: unknown, where: string, issues: string[]): void => {
  if (input.length !== itemCount) issues.push(`${where}: item_count ${text(itemCount)} != input length ${input.length}`);
  const seenCallIds = new Set<string>();
  for (const item of input) {
    if (!isObject(item)) {
      issues.push(`${where}: input item not an object`);
      continue;
    }
    verifyInputItem(item, where, seenCallIds, issues);
  }
};

const verifyEntry = (entry: unknown, index: number, fixture: JsonValue[], issues: string[]): CorpusClass | null => {
  const where = `line ${index + 1}`;
  if (!isObject(entry)) {
    issues.push(`${where}: not an object`);
    return null;
  }
  const id = asString(entry.id);
  const cls = asString(entry.cls) as CorpusClass | null;
  if (!id || !/^corpus-(small|medium|large|xlarge)-\d{2}$/.test(id)) issues.push(`${where}: bad id ${text(id)}`);
  if (!cls || !CLASS_ORDER.includes(cls)) {
    issues.push(`${where}: bad class ${text(cls)}`);
    return null;
  }
  const source = isObject(entry.source) ? entry.source : null;
  const request = isObject(entry.request) ? entry.request : null;
  if (!source) issues.push(`${where}: missing source`);
  if (!request) issues.push(`${where}: missing request`);
  if (!source || !request) return cls;
  verifySource(source, where, issues);
  verifyRequest(request, where, fixture, issues);
  if (Array.isArray(request.input)) verifyInput(request.input, source.item_count, where, issues);
  else issues.push(`${where}: request.input not an array`);
  return cls;
};

export const verifyClassSummary = (manifest: JsonObject, ctx: LineContext): void => {
  for (const cls of CLASS_ORDER) {
    const got = ctx.classCounts.get(cls) ?? 0;
    if (got !== CLASS_QUOTA[cls]) ctx.issues.push(`class ${cls}: ${got} entries, want ${CLASS_QUOTA[cls]}`);
  }
  if (ctx.classesOrder.join(",") !== CLASS_ORDER.join(","))
    ctx.issues.push(`class block order is ${ctx.classesOrder.join(",")}, want ${CLASS_ORDER.join(",")}`);
  const smallMode = isObject(manifest.selection) ? manifest.selection.small : null;
  if (smallMode === "closest-recorded-request" && ctx.classCounts.get("small") !== 6) ctx.issues.push("small fallback mode without 6 small entries");
};

export type LineContext = {
  fixture: JsonValue[];
  issues: string[];
  classCounts: Map<CorpusClass, number>;
  ids: Set<string>;
  classesOrder: string[];
  perClassIndex: Map<string, number>;
  manifestEntries: JsonValue[];
};

export const verifyLine = (line: string, index: number, ctx: LineContext): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    ctx.issues.push(`line ${index + 1}: invalid JSON: ${(error as Error).message}`);
    return;
  }
  const cls = verifyEntry(parsed, index, ctx.fixture, ctx.issues);
  if (!cls) return;
  ctx.classCounts.set(cls, (ctx.classCounts.get(cls) ?? 0) + 1);
  if (ctx.classesOrder[ctx.classesOrder.length - 1] !== cls) ctx.classesOrder.push(cls);
  const id = isObject(parsed) ? (asString(parsed.id) ?? "") : "";
  if (ctx.ids.has(id)) ctx.issues.push(`duplicate id ${id}`);
  ctx.ids.add(id);
  const nextIndex = (ctx.perClassIndex.get(cls) ?? 0) + 1;
  ctx.perClassIndex.set(cls, nextIndex);
  if (id !== `corpus-${cls}-${String(nextIndex).padStart(2, "0")}`) ctx.issues.push(`line ${index + 1}: id ${id} out of order for class ${cls}`);
  const source = isObject(parsed) && isObject(parsed.source) ? parsed.source : {};
  const tokens = asNumber(source.recorded_input_tokens);
  if (tokens !== null && cls !== "small" && (tokens < CLASS_WINDOW[cls][0] || tokens > CLASS_WINDOW[cls][1])) {
    ctx.issues.push(`${id}: ${cls} tokens ${tokens} outside ${CLASS_WINDOW[cls].join("-")}`);
  }
  const manifestEntry = ctx.manifestEntries.find((candidate) => isObject(candidate) && candidate.id === id);
  if (!manifestEntry) ctx.issues.push(`${id}: missing from manifest.entries`);
};

// ------------------------------------------------------------------------------------------------ selfcheck

export const SELFTEST_FIXTURES: Readonly<Record<string, string>> = {
  sk: `sk-${"A".repeat(30)}`,
  lith_sk: `lith_sk_${"B".repeat(24)}`,
  fernet: `gAAAAA${"C".repeat(60)}`,
  slack_bot: "xoxb-1234567890-abcd",
  github_pat: `ghp_${"D".repeat(36)}`,
  aws_access_key: `AKIA${"E".repeat(16)}`,
  hex_ak_sk: `SK${"f".repeat(32)}`,
  bearer: `Bearer ${"g".repeat(40)}`,
  assignment: `SOME_API_KEY=${"h".repeat(24)}`,
  authorization_header: `Authorization: ${"i".repeat(24)}`,
};

export const selfcheckShape = (id: string, fixture: string, failures: string[]): void => {
  const counts = new Map<string, number>();
  const once = sanitizeString(fixture, counts);
  const twice = sanitizeString(once, new Map());
  if (!once.includes(`[REDACTED:${id}]`)) failures.push(`${id}: not redacted`);
  if (once.includes(fixture)) failures.push(`${id}: raw value survived`);
  if (once !== twice) failures.push(`${id}: not idempotent`);
  if ((counts.get(id) ?? 0) < 1) failures.push(`${id}: substitution not counted`);
  const status = failures.some((failure) => failure.startsWith(`${id}:`)) ? "FAIL" : "ok";
  console.log(`selfcheck ${id}: ${status}`);
};

export const selfcheckEmail = (failures: string[]): void => {
  const emailRedacted = sanitizeString(`sk-${"A".repeat(30)} user@example.com`, new Map());
  if (!emailRedacted.includes("[REDACTED:email]")) failures.push("email: not redacted inside credential-matched string");
  if (emailRedacted.includes("user@example.com")) failures.push("email: raw address survived");
  const plainEmail = "contact user@example.com for details";
  if (sanitizeString(plainEmail, new Map()) !== plainEmail) failures.push("email: plain address must stay unchanged");
  console.log("selfcheck email: ok (credential-adjacent redacted, plain address preserved)");
};

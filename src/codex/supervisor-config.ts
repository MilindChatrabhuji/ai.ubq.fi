// Supervisor configuration, shared types and small helpers, split out of src/codex_supervisor.ts.
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

const SUPERVISOR_CONFIG_PATH = ".data/codex-supervisor.json";

const MAX_SOURCES = 8;
const SOURCE_CONCURRENCY = 2;
const MAX_SOURCE_NAME_LENGTH = 64;
export const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

const INVENTORY_LIMIT = 60;
const LIST_PAGE_LIMIT = 50;
const MAX_LIST_PAGES = 2;
const LIVE_PROBE_LIMIT = 24;
const EXTRA_LOADED_LIMIT = 8;
const PROBE_CONCURRENCY = 4;
const OVERALL_DEADLINE_MS = 9_000;

const SNAPSHOT_TTL_MS = 4_000;
const RECENT_METADATA_LIMIT = 60;
const STATE_DATABASE_PATTERN = /^state_(\d+)\.sqlite$/;
const SQLITE_MODULE_SPECIFIER = "bun:sqlite";

const FOLLOW_POLL_MS = 2_000;
const FOLLOW_HEARTBEAT_EVERY = 5;
const FOLLOW_MAX_DURATION_MS = 600_000;
const FOLLOW_MAX_ENTRIES = 120;
const FOLLOW_MAX_TEXT_CHARS = 4_000;
const FOLLOW_MAX_COMMAND_CHARS = 400;

/** Every non-interactive source kind, requested explicitly so subagents are never hidden. */
const LIST_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

const METADATA_COLUMNS =
  "id, title, name, preview, cwd, model, reasoning_effort, tokens_used, git_branch, updated_at, updated_at_ms, archived, thread_source, source";

const TERMINAL_TURN_STATES: ReadonlySet<string> = new Set(["completed", "interrupted", "failed", "declined", "cancelled", "canceled", "errored", "aborted"]);

type SupervisorState = "active" | "idle" | "stale" | "unknown" | "system_error";

export type SupervisorSource = {
  id: string;
  name: string;
  socketPath: string;
  codexHome: string | null;
};

type SupervisorConfig = {
  sources: SupervisorSource[];
  configPath: string;
  configLoaded: boolean;
  notes: string[];
};

type SupervisorQuotaBucket = {
  limitId: string;
  limitName: string | null;
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAtMs: number | null;
  planType: string | null;
  reachedType: string | null;
};

type SupervisorQuota = {
  accountScope: "shared_codex_account";
  buckets: SupervisorQuotaBucket[];
  resetCreditsAvailable: number | null;
};

type SupervisorSession = {
  id: string;
  sourceId: string;
  machine: string;
  title: string | null;
  titleSource: "thread" | "metadata" | null;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  effort: string | null;
  provider: string | null;
  state: SupervisorState;
  activeFlags: string[];
  loaded: boolean | null;
  waitingOnApproval: boolean;
  waitingOnUserInput: boolean;
  sourceKind: string | null;
  parentThreadId: string | null;
  childIds: string[] | null;
  lastActivityAtMs: number | null;
  lastSampledAtMs: number;
  tokensUsed: number | null;
  usageSource: "state_db" | null;
  sampled: boolean;
  unavailable: string[];
};

type SupervisorSourceView = {
  id: string;
  name: string;
  kind: "local" | "remote";
  hostname: string | null;
  state: "ok" | "unavailable";
  reason: string | null;
  metadata: { available: boolean; database: string | null; reason: string | null };
  inventory: { listed: number; sampled: number; returned: number; truncated: boolean };
  lineage: "available" | "unavailable";
  quota: SupervisorQuota | null;
  quotaReason: string | null;
  durationMs: number;
  sampledAtMs: number;
};

type SupervisorSnapshot = {
  sampledAtMs: number;
  view: "codex_app_server_read_only";
  sources: SupervisorSourceView[];
  sessions: SupervisorSession[];
  counts: {
    total: number;
    active: number;
    waiting: number;
    idle: number;
    stale: number;
    unknown: number;
    systemError: number;
  };
  coverage: { listed: number; sampled: number; truncated: boolean; notes: string[] };
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asFiniteNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const joinPath = (base: string, leaf: string): string => (base.endsWith("/") ? `${base}${leaf}` : `${base}/${leaf}`);

/** Accepts either Unix seconds or Unix milliseconds and returns milliseconds. */
export const normalizeEpochMs = (value: unknown): number | null => {
  const numeric = asFiniteNumber(value);
  if (numeric === null || numeric <= 0) return null;
  return numeric < 1_000_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
};

const textOrNull = (value: unknown): string | null => {
  const text = asString(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const uniqueStrings = (values: readonly string[]): string[] => [...new Set(values)];

const boundedText = (value: string, limit: number): string => (value.length <= limit ? value : `${value.slice(0, limit)}…`);

const nowMs = (): number => Date.now();

const readHostname = (): string | null => {
  try {
    return hostname();
  } catch {
    return null;
  }
};

const waitForPoll = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const mapWithConcurrency = async <TItem, TResult>(items: readonly TItem[], limit: number, run: (item: TItem) => Promise<TResult>): Promise<TResult[]> => {
  const results: TResult[] = [];
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(
      (async () => {
        while (next < items.length) {
          const current = next;
          next += 1;
          results[current] = await run(items[current]);
        }
      })()
    );
  }
  await Promise.all(workers);
  return results;
};

/* ------------------------------------------------------------------ config */

const supervisorSourceOf = (entry: unknown, seen: ReadonlySet<string>, notes: string[]): SupervisorSource | null => {
  if (!isRecord(entry)) {
    notes.push("ignored a source that is not an object");
    return null;
  }
  const id = textOrNull(entry.id);
  const name = textOrNull(entry.name);
  const socketPath = textOrNull(entry.socketPath);
  const codexHome = entry.codexHome === undefined || entry.codexHome === null ? null : textOrNull(entry.codexHome);
  if (!id || !SOURCE_ID_PATTERN.test(id)) {
    notes.push("ignored a source whose id must match /^[a-z0-9][a-z0-9_-]{0,31}$/");
    return null;
  }
  if (seen.has(id)) {
    notes.push(`ignored duplicate source id ${id}`);
    return null;
  }
  if (!name || name.length > MAX_SOURCE_NAME_LENGTH) {
    notes.push(`ignored source ${id}: name must be 1-${MAX_SOURCE_NAME_LENGTH} characters`);
    return null;
  }
  if (!socketPath?.startsWith("/")) {
    notes.push(`ignored source ${id}: socketPath must be an absolute path`);
    return null;
  }
  if (codexHome !== null && !codexHome.startsWith("/")) {
    notes.push(`ignored source ${id}: codexHome must be an absolute path`);
    return null;
  }
  return { id, name, socketPath, codexHome };
};

/** Validates the optional configuration file. Pure, so tests can drive it directly. */
export const parseSupervisorConfig = (raw: unknown): { sources: SupervisorSource[]; notes: string[] } => {
  const notes: string[] = [];
  if (!isRecord(raw)) return { sources: [], notes: ["configuration must be a JSON object"] };
  const entries = isUnknownArray(raw.sources) ? raw.sources : [];
  if (entries.length === 0) return { sources: [], notes: ["configuration lists no sources"] };
  const sources: SupervisorSource[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, MAX_SOURCES)) {
    const source = supervisorSourceOf(entry, seen, notes);
    if (!source) continue;
    seen.add(source.id);
    sources.push(source);
  }
  if (entries.length > MAX_SOURCES) notes.push(`only the first ${MAX_SOURCES} sources are used`);
  return { sources, notes };
};

/** The fallback source: this machine's own Codex home, with no configuration file at all. */
export const defaultSupervisorSource = (env: (name: string) => string | undefined, notes: string[]): SupervisorSource | null => {
  const home = (env("HOME") ?? "").trim();
  const codexHome = (env("CODEX_HOME") ?? "").trim() || (home ? joinPath(home, ".codex") : "");
  if (!codexHome) {
    notes.push("HOME and CODEX_HOME are both unavailable, so no local source could be derived");
    return null;
  }
  return { id: "local", name: "Local Codex", socketPath: joinPath(codexHome, "app-server-control/app-server-control.sock"), codexHome };
};

const readEnvironment = (name: string): string | undefined => {
  try {
    return process.env[name];
  } catch {
    return undefined;
  }
};

export const resolveSupervisorConfig = async (options?: { cwd?: string; env?: (name: string) => string | undefined }): Promise<SupervisorConfig> => {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? readEnvironment;
  const configPath = joinPath(cwd, SUPERVISOR_CONFIG_PATH);
  const notes: string[] = [];
  let raw: unknown = null;
  let configLoaded = false;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
    configLoaded = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      notes.push(`${SUPERVISOR_CONFIG_PATH} could not be read; using the default local source`);
  }
  if (configLoaded) {
    const parsed = parseSupervisorConfig(raw);
    notes.push(...parsed.notes);
    if (parsed.sources.length > 0) return { sources: parsed.sources, configPath, configLoaded, notes };
    notes.push("no usable source in the configuration file; using the default local source");
  }
  const fallback = defaultSupervisorSource(env, notes);
  return { sources: fallback ? [fallback] : [], configPath, configLoaded, notes };
};

/* ---------------------------------------------------------------- metadata */

export type { JsonRecord, SupervisorQuota, SupervisorQuotaBucket, SupervisorSession, SupervisorSnapshot, SupervisorSourceView, SupervisorState };
export {
  EXTRA_LOADED_LIMIT,
  FOLLOW_HEARTBEAT_EVERY,
  FOLLOW_MAX_COMMAND_CHARS,
  FOLLOW_MAX_DURATION_MS,
  FOLLOW_MAX_ENTRIES,
  FOLLOW_MAX_TEXT_CHARS,
  FOLLOW_POLL_MS,
  INVENTORY_LIMIT,
  LIST_PAGE_LIMIT,
  LIST_SOURCE_KINDS,
  LIVE_PROBE_LIMIT,
  MAX_LIST_PAGES,
  METADATA_COLUMNS,
  OVERALL_DEADLINE_MS,
  PROBE_CONCURRENCY,
  RECENT_METADATA_LIMIT,
  SNAPSHOT_TTL_MS,
  SOURCE_CONCURRENCY,
  SQLITE_MODULE_SPECIFIER,
  STATE_DATABASE_PATTERN,
  TERMINAL_TURN_STATES,
  asBoolean,
  asFiniteNumber,
  asString,
  boundedText,
  isRecord,
  isUnknownArray,
  joinPath,
  mapWithConcurrency,
  nowMs,
  readHostname,
  textOrNull,
  uniqueStrings,
  waitForPoll,
};

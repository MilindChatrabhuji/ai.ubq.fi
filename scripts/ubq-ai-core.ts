// ubq-ai shared runtime, IO, flag and request helpers, split out of scripts/ubq-ai.ts.
import { realpath } from "node:fs/promises";
export type FlagValue = string | boolean | string[];
export type ParsedArgs = Readonly<{
  _: string[];
  flags: Record<string, FlagValue>;
}>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const getString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const TEXT_ENCODER = new TextEncoder();
const encodeHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
};
const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value));
  return encodeHex(new Uint8Array(digest));
};
const describeSecret = async (value: string | undefined): Promise<string> => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "(unset)";
  try {
    const fp = (await sha256Hex(trimmed)).slice(0, 12);
    return `(set len=${trimmed.length} sha256=${fp})`;
  } catch {
    return `(set len=${trimmed.length})`;
  }
};
const classifyToken = (token: string): string => {
  const trimmed = token.trim();
  if (!trimmed) return "unset";
  if (trimmed.startsWith("ddw_")) return "deno_deploy_like(ddw_)";
  if (trimmed.startsWith("ubq_ai_")) return "ubq_ai_prefix";
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return "hex64";
  if (trimmed.includes("_")) return "has_underscore";
  return "other";
};
const expandTilde = (path: string, homeDir: string | undefined): string => {
  if (path === "~") return homeDir ?? path;
  if (path.startsWith("~/") && homeDir) return `${homeDir}${path.slice(1)}`;
  return path;
};
const normalizeVersion = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};
const readCodexModelsCacheVersion = async (runtime: UbqAiRuntime, homeDir: string | undefined): Promise<string | null> => {
  if (!homeDir) return null;
  try {
    const text = await runtime.readTextFile(`${homeDir}/.codex/models_cache.json`);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return normalizeVersion(parsed.client_version);
  } catch {
    return null;
  }
};
const readCodexVersionFile = async (runtime: UbqAiRuntime, homeDir: string | undefined): Promise<string | null> => {
  if (!homeDir) return null;
  try {
    const text = await runtime.readTextFile(`${homeDir}/.codex/version.json`);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return normalizeVersion(parsed.latest_version ?? parsed.version ?? parsed.current_version);
  } catch {
    return null;
  }
};
const readCodexPackageVersion = async (runtime: UbqAiRuntime, codexPath: string | null): Promise<string | null> => {
  if (!codexPath) return null;
  const realPath = await realpath(codexPath).catch(() => codexPath);
  const normalized = realPath.replace(/\\/g, "/");
  const marker = "/node_modules/@openai/codex/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  const pkgPath = `${normalized.slice(0, index + marker.length)}package.json`;
  try {
    const text = await runtime.readTextFile(pkgPath);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return normalizeVersion(parsed.version);
  } catch {
    return null;
  }
};
const resolveCodexClientVersion = async (
  runtime: UbqAiRuntime,
  codexPaths: (string | null | undefined)[],
  homeDir: string | undefined
): Promise<string | null> => {
  const cachedVersion = await readCodexModelsCacheVersion(runtime, homeDir);
  if (cachedVersion) return cachedVersion;
  const versionFile = await readCodexVersionFile(runtime, homeDir);
  if (versionFile) return versionFile;
  for (const codexPath of codexPaths) {
    if (!codexPath) continue;
    const pkgVersion = await readCodexPackageVersion(runtime, codexPath);
    if (pkgVersion) return pkgVersion;
  }
  return null;
};
const listCodexBinaryCandidates = (runtime: UbqAiRuntime, codexBinFlag: string | null, homeDir: string | undefined): string[] => {
  const candidates: string[] = [];
  if (codexBinFlag) candidates.push(expandTilde(codexBinFlag, homeDir));
  const pathValue = runtime.envGet("PATH") ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  for (const segment of pathValue.split(separator).filter(Boolean)) {
    candidates.push(`${segment.replace(/\/$/, "")}/codex`);
  }
  return candidates;
};
/** A flag value, or undefined when the flag was never passed. */
const lookupFlag = (flags: Record<string, FlagValue>, key: string): FlagValue | undefined => flags[key];
const pushFlag = (flags: Record<string, FlagValue>, key: string, value: string | boolean): void => {
  const existing = lookupFlag(flags, key);
  if (existing === undefined) {
    flags[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    if (typeof value === "string") existing.push(value);
    return;
  }
  if (typeof existing === "string" && typeof value === "string") {
    flags[key] = [existing, value];
  }
};
const BOOLEAN_FLAGS = new Set(["help", "json", "raw", "reset-usage", "stream", "token-only", "verbose"]);
/** Normalizes a `--boolean-flag=<value>` payload exactly as this CLI always has. */
const coerceBooleanFlagValue = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "no");
};
/** Applies a `--key=value` argument, reporting whether the argument carried an equals sign. */
const applyEqualsFlag = (flags: Record<string, FlagValue>, arg: string): boolean => {
  const eq = arg.indexOf("=");
  if (eq === -1) return false;
  const key = arg.slice(2, eq);
  if (key) {
    const value = arg.slice(eq + 1);
    pushFlag(flags, key, BOOLEAN_FLAGS.has(key) ? coerceBooleanFlagValue(value) : value);
  }
  return true;
};
/**
 * Detects whether the token after a flag is itself a new flag: it must start with a double dash, or
 * be one of the known short flags. This avoids misinterpreting PEM content, which starts with five
 * dashes, as a flag.
 */
const isFlagToken = (next: string | undefined): boolean => !!next && (next.startsWith("--") || next === "-h" || next === "-v");
/**
 * Applies a bare `--key [value]` argument and returns how many argv entries it consumed: one when
 * the key is boolean or has no value, two when it took the following token as its value.
 */
const applySpaceFlag = (flags: Record<string, FlagValue>, key: string, next: string | undefined): number => {
  if (BOOLEAN_FLAGS.has(key)) {
    pushFlag(flags, key, true);
    return 1;
  }
  if (!next || isFlagToken(next)) {
    if (key) pushFlag(flags, key, true);
    return 1;
  }
  if (key) pushFlag(flags, key, next);
  return 2;
};
export const parseArgs = (args: string[]): ParsedArgs => {
  const flags: Record<string, FlagValue> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") continue;
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "-v") {
      flags.verbose = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (applyEqualsFlag(flags, arg)) continue;
    i += applySpaceFlag(flags, arg.slice(2), args[i + 1]) - 1;
  }
  return { _: positional, flags };
};
const SHORT_GIT_REVISION_LEN = 7;
const toShortGitRevision = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (!/^[0-9a-fA-F]{7,40}$/.test(trimmed)) return null;
  return trimmed.slice(0, SHORT_GIT_REVISION_LEN);
};
const tryReadTextFile = async (runtime: UbqAiRuntime, path: string): Promise<string | null> => {
  try {
    return await runtime.readTextFile(path);
  } catch {
    return null;
  }
};
const parseGitDirFromDotGitFile = (content: string): string | null => {
  const firstLine = (content.split(/\r?\n/, 1)[0] ?? "").trim();
  // Linear equivalent of /^gitdir:\s*(.+)\s*$/i: `firstLine` is already trimmed,
  // so the greedy capture always starts at the first non-whitespace character and
  // the two overlapping quantifiers only added quadratic backtracking.
  const match = /^gitdir:\s*(\S.*)$/i.exec(firstLine);
  const gitDir = (match?.[1] ?? "").trim();
  if (gitDir === "") return null;
  return gitDir;
};
const isAbsolutePath = (path: string): boolean => path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);
const readGitHeadShortRevision = async (runtime: UbqAiRuntime, gitDir: string): Promise<string | null> => {
  const head = await tryReadTextFile(runtime, `${gitDir}/HEAD`);
  if (!head) return null;
  const trimmedHead = head.trim();
  // Linear equivalent of /^ref:\s*(.+)\s*$/ for the already-trimmed HEAD text.
  const refMatch = /^ref:\s*(\S.*)$/.exec(trimmedHead);
  if (!refMatch) return toShortGitRevision(trimmedHead);
  const refPath = refMatch[1].trim();
  if (!refPath) return null;
  const ref = await tryReadTextFile(runtime, `${gitDir}/${refPath}`);
  if (ref) return toShortGitRevision(ref.trim());
  const packedRefs = await tryReadTextFile(runtime, `${gitDir}/packed-refs`);
  if (!packedRefs) return null;
  for (const line of packedRefs.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
    const space = trimmed.indexOf(" ");
    if (space === -1) continue;
    const hash = trimmed.slice(0, space).trim();
    const refName = trimmed.slice(space + 1).trim();
    if (refName === refPath) return toShortGitRevision(hash);
  }
  return null;
};
const gitShortRevision = async (runtime: UbqAiRuntime): Promise<string | null> => {
  const env = toShortGitRevision(runtime.envGet("GIT_REVISION") ?? runtime.envGet("GITHUB_SHA") ?? undefined);
  if (env) return env;
  const gitRoots = [".", "..", "../..", "../../..", "../../../..", "../../../../..", "../../../../../..", "../../../../../../.."];
  for (const root of gitRoots) {
    const dotGitHead = await tryReadTextFile(runtime, `${root}/.git/HEAD`);
    if (dotGitHead) return await readGitHeadShortRevision(runtime, `${root}/.git`);
    const dotGitFile = await tryReadTextFile(runtime, `${root}/.git`);
    if (!dotGitFile) continue;
    const gitDir = parseGitDirFromDotGitFile(dotGitFile);
    if (!gitDir) continue;
    const resolvedGitDir = isAbsolutePath(gitDir) ? gitDir : `${root}/${gitDir}`;
    const rev = await readGitHeadShortRevision(runtime, resolvedGitDir);
    if (rev) return rev;
  }
  return null;
};
const renderUbqLogo = (revision: string | null): string => {
  const revLabel = revision ?? "";
  return `⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣤⣾⣷⣤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⣀⣴⣾⡿⠛⠉⠉⠛⢿⣷⣦⣀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⣠⣴⣿⠿⠛⠁⠀⠀⠀⠀⠀⠀⠈⠛⠿⣿⣦⣄⠀⠀⠀
⠀⢰⣿⣿⣿⡁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢈⣿⣿⣿⡆⠀
⠀⢸⣿⡟⠻⢿⣷⡀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣾⡿⠟⢻⣿⡇⠀
⠀⢸⣿⡇⠀⠀⢻⣷⠀⠀⠀⠀⠀⠀⠀⠀⣾⡟⠀⠀⢸⣿⡇⠀ai.ubq.fi
⠀⢸⣿⡇⠀⠀⠀⣿⣇⠀⠀⠀⠀⠀⠀⣸⣿⠀⠀⠀⢸⣿⡇⠀
⠀⢸⣿⡇⠀⠀⠀⢸⣿⡀⠀⠀⠀⠀⢀⣿⡇⠀⠀⠀⢸⣿⡇⠀${revLabel}
⠀⢸⣿⡇⠀⠀⠀⠀⢻⣷⣄⣀⣀⣠⣾⡟⠀⠀⠀⠀⢸⣿⡇⠀
⠀⢸⣿⣧⣀⠀⠀⠀⠀⠙⠛⠿⠿⠛⠋⠀⠀⠀⠀⣀⣼⣿⡇⠀
⠀⠀⠈⠛⠿⣷⣦⣀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣴⣾⠿⠛⠁⠀⠀
⠀⠀⠀⠀⠀⠈⠙⠿⣷⣦⣄⠀⠀⣠⣴⣾⠿⠋⠁⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠻⣿⣿⠟⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀`;
};
const usageText = async (runtime: UbqAiRuntime): Promise<string> =>
  `${renderUbqLogo(await gitShortRevision(runtime))}
Usage:
  bun run scripts/ubq-ai.ts [--url <base>] <command> [options]
Global options:
  --url <url>                 Base URL (default: https://ai.ubq.fi)
  --token <token>             Client token (or set UOS_AI_TOKEN; falls back to admin token if unset)
  --admin-token <token>       Admin token (or set DENO_DEPLOY_TOKEN)
  --json                      Print full JSON (default prints text when possible)
  --stream                    Stream output (when supported)
  --raw                       For streams: print raw SSE bytes (no parsing)
  -v, --verbose               Print debug info (no secrets)
  -h, --help                  Show help
Commands:
  health
  info
  whoami
  models
  chat [<prompt>] [--model <id>] [--reasoning-effort <level>] [--system <text>] [--developer <text>] [--messages-json <json>] [--messages-file <path>]
  responses [<input>] [--model <id>] [--reasoning-effort <level>] [--instructions <text>] [--input-json <json>] [--input-file <path>]
  admin upload-auth [--auth-json <path>] [--codex-bin <path>]
  admin keys create "<name>" [--token <token>] [--expires <preset>|--expires-at-ms <ms>] [--usage-limit <requests>]
  admin keys list
  admin keys revoke --id <id>
  admin kernel-pubkeys list
  admin kernel-pubkeys add --app-id <id> --pem "<pem>" [--owner <name>]
  admin kernel-pubkeys remove --app-id <id>
  admin kernel-usage get --owner <name> [--repo <name>] [--scope repo|org]
  admin kernel-usage set --owner <name> [--repo <name>] --usage-limit <requests> [--window-ms <ms>] [--scope repo|org] [--reset-usage]
Admin notes:
  upload-auth stores the live Codex model catalog returned by upstream auth validation.
Admin key expiration:
  --expires <preset>           day|week|month|quarter|year|forever (sets expires_at_ms)
  --expires-at-ms <ms>         Unix epoch ms timestamp; -1 means does not expire
Examples:
  UOS_AI_TOKEN=... bun run scripts/ubq-ai.ts chat --system "You are a helpful assistant." "Tell me a short joke."
  UOS_AI_TOKEN=... bun run scripts/ubq-ai.ts chat --system "You are a helpful assistant." --stream "Say hello in 5 different ways."
  DENO_DEPLOY_TOKEN=... bun run scripts/ubq-ai.ts admin upload-auth
  DENO_DEPLOY_TOKEN=... bun run scripts/ubq-ai.ts admin keys create "example key"
  DENO_DEPLOY_TOKEN=... bun run scripts/ubq-ai.ts admin keys create "tmp key" --expires week
  UOS_AI_TOKEN=... bun run scripts/ubq-ai.ts whoami | jq
`;
export type UbqAiRuntime = Readonly<{
  fetch: (req: Request) => Promise<Response>;
  envGet: (key: string) => string | undefined;
  readTextFile: (path: string) => Promise<string>;
  stdinIsTerminal: boolean;
  readStdin: () => Promise<string>;
  out: (chunk: Uint8Array) => Promise<void>;
  err: (chunk: Uint8Array) => Promise<void>;
}>;
const writeOutText = async (runtime: UbqAiRuntime, text: string): Promise<void> => {
  await runtime.out(TEXT_ENCODER.encode(text));
};
const writeErrText = async (runtime: UbqAiRuntime, text: string): Promise<void> => {
  await runtime.err(TEXT_ENCODER.encode(text));
};
/** Renders a caught value for CLI diagnostics without ever printing "[object Object]". */
const errorText = (error: unknown): string => (error instanceof Error ? String(error) : JSON.stringify(error));
/** Parses CLI JSON text, returning null when it is not valid JSON. */
const parseJsonOrNull = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
const readStdin = async (): Promise<string> => {
  const chunks: Uint8Array[] = [];
  const reader = Bun.stdin.stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged).trim();
};
const doFetch = async (
  runtime: UbqAiRuntime,
  req: Request
): Promise<
  | { ok: true; status: number; contentType: string; json: unknown; headers: Headers }
  | {
      ok: false;
      status: number;
      contentType: string;
      body: string;
      headers: Headers;
    }
> => {
  const res = await runtime.fetch(req);
  const contentType = res.headers.get("Content-Type") ?? "";
  const isJson = contentType.includes("application/json");
  if (res.ok) {
    const json = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");
    return { ok: true, status: res.status, contentType, json, headers: res.headers };
  }
  const body = isJson ? JSON.stringify(await res.json().catch(() => null), null, 2) : await res.text().catch(() => "");
  return { ok: false, status: res.status, contentType, body: body || res.statusText, headers: res.headers };
};
const streamToOut = async (runtime: UbqAiRuntime, body: ReadableStream<Uint8Array>): Promise<void> => {
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await runtime.out(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
};
/** Parses one SSE frame into the value to yield, or null when the frame carries nothing to yield. */
const parseSseFrame = (part: string): { value: unknown } | null => {
  if (!part.trim()) return null;
  const lines = part.split("\n");
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  const data = dataLines.map((line) => line.slice(5).trim()).join("\n");
  if (!data) return null;
  if (data === "[DONE]") return { value: "[DONE]" };
  try {
    return { value: JSON.parse(data) };
  } catch {
    return null;
  }
};
async function* parseSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const frame = parseSseFrame(part);
        if (frame === null) continue;
        yield frame.value;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}
const extractChatDelta = (ev: unknown): string => {
  if (!isRecord(ev)) return "";
  const choices = Array.isArray(ev.choices) ? ev.choices : null;
  if (!choices || choices.length === 0) return "";
  const choice0 = isRecord(choices[0]) ? choices[0] : null;
  if (!choice0) return "";
  const delta = isRecord(choice0.delta) ? choice0.delta : null;
  if (!delta) return "";
  const content = getString(delta.content);
  return content ?? "";
};
const extractResponseDelta = (ev: unknown): string => {
  if (!isRecord(ev)) return "";
  const type = getString(ev.type);
  if (type !== "response.output_text.delta") return "";
  return getString(ev.delta) ?? getString(ev.text_delta) ?? "";
};
const extractChatContent = (json: unknown): string | null => {
  if (!isRecord(json)) return null;
  const choices = Array.isArray(json.choices) ? json.choices : null;
  if (!choices || choices.length === 0) return null;
  const choice0 = isRecord(choices[0]) ? choices[0] : null;
  if (!choice0) return null;
  const message = isRecord(choice0.message) ? choice0.message : null;
  if (!message) return null;
  const content = getString(message.content);
  return content;
};
/** Extracts the text of one `output_text`/`text` content part; empty when the part carries none. */
const extractOutputTextPart = (part: unknown): string => {
  if (!isRecord(part)) return "";
  const partType = getString(part.type);
  if (partType !== "output_text" && partType !== "text") return "";
  return getString(part.text) ?? "";
};
/** Collects the text parts of one assistant message item; null when the item is not an assistant message. */
const extractAssistantMessageParts = (item: unknown): string[] | null => {
  if (!isRecord(item)) return null;
  if (getString(item.type) !== "message") return null;
  if (getString(item.role) !== "assistant") return null;
  const content = Array.isArray(item.content) ? item.content : null;
  if (!content) return null;
  const parts: string[] = [];
  for (const part of content) {
    const text = extractOutputTextPart(part);
    if (text) parts.push(text);
  }
  return parts;
};
const extractResponseText = (json: unknown): string | null => {
  if (!isRecord(json)) return null;
  const output = Array.isArray(json.output) ? json.output : null;
  if (!output) return null;
  const messages: string[] = [];
  for (const item of output) {
    const parts = extractAssistantMessageParts(item);
    if (!parts || parts.length === 0) continue;
    messages.push(parts.join(""));
  }
  if (messages.length === 0) return null;
  return messages.join("\n");
};
const normalizeBaseUrl = (raw: string): string => raw.trim().replace(/\/$/, "") || "https://ai.ubq.fi";
const getFlagString = (flags: Record<string, FlagValue>, key: string): string | null => {
  const value = flags[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1] ?? null;
  return null;
};
type ApiKeyExpiryPreset = "day" | "week" | "month" | "quarter" | "year" | "forever";
const normalizeApiKeyExpiryPreset = (raw: string): ApiKeyExpiryPreset | null => {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (!normalized) return null;
  if (normalized === "day" || normalized === "1d" || normalized === "1day" || normalized === "oneday") return "day";
  if (normalized === "week" || normalized === "1w" || normalized === "1week" || normalized === "oneweek") return "week";
  if (normalized === "month" || normalized === "1m" || normalized === "1month" || normalized === "onemonth") {
    return "month";
  }
  if (normalized === "quarter" || normalized === "1q" || normalized === "1quarter" || normalized === "onequarter") {
    return "quarter";
  }
  if (normalized === "year" || normalized === "1y" || normalized === "1year" || normalized === "oneyear") return "year";
  if (normalized === "forever" || normalized === "never" || normalized === "noexpiry" || normalized === "noexpiration") {
    return "forever";
  }
  return null;
};
const apiKeyExpiresAtMsFromPreset = (preset: ApiKeyExpiryPreset, nowMs: number): number => {
  if (preset === "forever") return -1;
  const HOUR_MS = 60 * 60_000;
  const DAY_MS = 24 * HOUR_MS;
  const durations: Record<Exclude<ApiKeyExpiryPreset, "forever">, number> = {
    day: DAY_MS,
    week: 7 * DAY_MS,
    month: 30 * DAY_MS,
    quarter: 90 * DAY_MS,
    year: 365 * DAY_MS,
  };
  return nowMs + durations[preset];
};
/** Parses the numeric `--expires-at-ms` payload. */
const parseExpiresAtMsValue = (raw: string): { ok: true; value: number } | { ok: false; message: string } => {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: "--expires-at-ms must be a number (Unix epoch ms) or -1." };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false, message: "--expires-at-ms must be a finite number." };
  const expiresAtMs = Math.trunc(parsed);
  if (expiresAtMs === -1) return { ok: true, value: -1 };
  if (expiresAtMs < 0) return { ok: false, message: "--expires-at-ms must be -1 or a future timestamp." };
  if (expiresAtMs <= Date.now()) return { ok: false, message: "--expires-at-ms must be in the future (or -1)." };
  return { ok: true, value: expiresAtMs };
};
const parseApiKeyExpiresAtMs = (flags: Record<string, FlagValue>): { ok: true; value: number | undefined } | { ok: false; message: string } => {
  const rawExpiresAtMs = getFlagString(flags, "expires-at-ms");
  const rawPreset = getFlagString(flags, "expires");
  if (rawExpiresAtMs && rawPreset) {
    return { ok: false, message: "Pass only one of --expires-at-ms or --expires." };
  }
  if (rawExpiresAtMs) return parseExpiresAtMsValue(rawExpiresAtMs);
  if (rawPreset) {
    const preset = normalizeApiKeyExpiryPreset(rawPreset);
    if (!preset) {
      return { ok: false, message: "--expires must be one of: day, week, month, quarter, year, forever." };
    }
    return { ok: true, value: apiKeyExpiresAtMsFromPreset(preset, Date.now()) };
  }
  return { ok: true, value: undefined };
};
const resolveClientToken = (flags: Record<string, FlagValue>, runtime: UbqAiRuntime): string | null => {
  const fromFlag = getFlagString(flags, "token");
  const fromEnv = runtime.envGet("UOS_AI_TOKEN") ?? "";
  const token = (fromFlag ?? fromEnv).trim();
  if (token) return token;
  return resolveAdminToken(flags, runtime);
};
const resolveAdminToken = (flags: Record<string, FlagValue>, runtime: UbqAiRuntime): string | null => {
  const fromFlag = getFlagString(flags, "admin-token");
  const fromEnv = runtime.envGet("DENO_DEPLOY_TOKEN") ?? "";
  const token = (fromFlag ?? fromEnv).trim();
  return token || null;
};
/** Describes where a resolved token came from, for the `--verbose` diagnostics. */
const describeTokenSource = (
  runtime: UbqAiRuntime,
  flags: Record<string, FlagValue>,
  options: Readonly<{ flag: string; env: string; fallback?: () => string | null }>
): string => {
  if (getFlagString(flags, options.flag)) return `--${options.flag}`;
  if ((runtime.envGet(options.env) ?? "").trim()) return options.env;
  if (options.fallback?.()) return "(admin fallback)";
  return "(unset)";
};
/** Shared, already-resolved CLI state handed to every command implementation. */
type UbqAiCommandContext = Readonly<{
  runtime: UbqAiRuntime;
  flags: Record<string, FlagValue>;
  args: readonly string[];
  baseUrl: string;
  homeDir: string | undefined;
  endpoint: (path: string) => URL;
  wantsJson: boolean;
  wantsStream: boolean;
  wantsRaw: boolean;
  debug: (line: string) => Promise<void>;
  doFetchWithDebug: (req: Request) => Promise<Awaited<ReturnType<typeof doFetch>>>;
}>;
/** Admin state on top of the shared context: the resolved admin token and the args after `admin`. */
type UbqAiAdminContext = UbqAiCommandContext & Readonly<{ adminToken: string; subArgs: readonly string[] }>;
/** Writes the "unknown command" diagnostics plus the usage text, and returns the usage exit code. */
const writeUsageError = async (runtime: UbqAiRuntime, message: string): Promise<number> => {
  await writeErrText(runtime, message);
  await writeOutText(runtime, await usageText(runtime));
  return 2;
};
/** Writes the standard request-failure diagnostics and returns the request-failure exit code. */
const writeRequestFailure = async (runtime: UbqAiRuntime, status: number, body: string): Promise<number> => {
  await writeErrText(runtime, `Request failed (${status}).\n`);
  await writeErrText(runtime, `${body}\n`);
  return 1;
};
/** Reads a JSON flag file, printing the same diagnostics the inline branches used to print. */
const readJsonFileFlag = async (runtime: UbqAiRuntime, path: string, label: string): Promise<{ ok: true; value: unknown } | { ok: false }> => {
  let text: string;
  try {
    text = await runtime.readTextFile(path);
  } catch (error) {
    await writeErrText(runtime, `Failed to read ${label}: ${path}\n`);
    await writeErrText(runtime, `${errorText(error)}\n`);
    return { ok: false };
  }
  const parsed = parseJsonOrNull(text);
  if (parsed === null) {
    await writeErrText(runtime, `Invalid JSON in ${label}: ${path}\n`);
    return { ok: false };
  }
  return { ok: true, value: parsed };
};
/** Parses `--usage-limit`: `unlimited` and `-1` both mean no limit. */
const parseUsageLimitRequests = (raw: string): { ok: true; value: number } | { ok: false } => {
  const trimmed = raw.trim();
  if (trimmed === "unlimited" || trimmed === "-1") return { ok: true, value: -1 };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return { ok: false };
  return { ok: true, value: Math.trunc(parsed) };
};
/** Parses the optional `--window-ms` override. */
const parseWindowMs = (raw: string): { ok: true; value: number } | { ok: false } => {
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false };
  return { ok: true, value: Math.trunc(parsed) };
};
/** Extracts the created API key's token for `--token-only` output; null when the response has none. */
const extractCreatedToken = (json: unknown): string | null => {
  if (!isRecord(json)) return null;
  const tokenValue = json.token;
  return typeof tokenValue === "string" && tokenValue.trim() ? tokenValue : null;
};
/** Builds the chat messages for a positional prompt (or stdin); null when no prompt is available. */
const buildPromptMessages = async (
  runtime: UbqAiRuntime,
  args: readonly string[],
  system: string,
  developer: string
): Promise<{ role: string; content: string }[] | null> => {
  let prompt = args.join(" ").trim();
  if (!prompt && !runtime.stdinIsTerminal) {
    prompt = (await runtime.readStdin()).trim();
  }
  if (!prompt) {
    await writeErrText(runtime, "Missing prompt. Pass it as an argument, or pipe via stdin.\n");
    return null;
  }
  const messages: { role: string; content: string }[] = [];
  if (system.trim()) messages.push({ role: "system", content: system });
  if (developer.trim()) messages.push({ role: "developer", content: developer });
  messages.push({ role: "user", content: prompt });
  return messages;
};
/** Resolves the chat request `messages` from `--messages-json`, `--messages-file`, a prompt, or stdin. */
const resolveChatMessages = async (ctx: UbqAiCommandContext): Promise<{ ok: true; messages: unknown } | { ok: false; exitCode: number }> => {
  const { runtime, flags, homeDir, args } = ctx;
  const messagesJson = getFlagString(flags, "messages-json");
  const messagesFile = getFlagString(flags, "messages-file");
  if (typeof messagesJson === "string") {
    const parsed = parseJsonOrNull(messagesJson);
    if (parsed === null) {
      await writeErrText(runtime, "Invalid JSON in --messages-json\n");
      return { ok: false, exitCode: 2 };
    }
    return { ok: true, messages: parsed };
  }
  if (typeof messagesFile === "string") {
    const path = expandTilde(messagesFile, homeDir);
    const file = await readJsonFileFlag(runtime, path, "messages file");
    if (!file.ok) return { ok: false, exitCode: 2 };
    return { ok: true, messages: file.value };
  }
  const system = getFlagString(flags, "system") ?? "";
  const developer = getFlagString(flags, "developer") ?? "";
  const messages = await buildPromptMessages(runtime, args, system, developer);
  if (!messages) return { ok: false, exitCode: 2 };
  return { ok: true, messages };
};
/** Resolves the responses request `input` from `--input-json`, `--input-file`, a positional value, or stdin. */
const resolveResponsesInput = async (ctx: UbqAiCommandContext): Promise<{ ok: true; input: unknown } | { ok: false; exitCode: number }> => {
  const { runtime, flags, homeDir, args } = ctx;
  const inputJson = getFlagString(flags, "input-json");
  const inputFile = getFlagString(flags, "input-file");
  if (typeof inputJson === "string") {
    const parsed = parseJsonOrNull(inputJson);
    if (parsed === null) {
      await writeErrText(runtime, "Invalid JSON in --input-json\n");
      return { ok: false, exitCode: 2 };
    }
    return { ok: true, input: parsed };
  }
  if (typeof inputFile === "string") {
    const path = expandTilde(inputFile, homeDir);
    const file = await readJsonFileFlag(runtime, path, "input file");
    if (!file.ok) return { ok: false, exitCode: 2 };
    return { ok: true, input: file.value };
  }
  let text = args.join(" ").trim();
  if (!text && !runtime.stdinIsTerminal) {
    text = (await runtime.readStdin()).trim();
  }
  if (!text) {
    await writeErrText(runtime, "Missing input. Pass it as an argument, or pipe via stdin.\n");
    return { ok: false, exitCode: 2 };
  }
  return { ok: true, input: text };
};
/** Streams one chat SSE event to stdout; returns true when the stream is finished. */
export type { UbqAiAdminContext, UbqAiCommandContext };
export {
  TEXT_ENCODER,
  classifyToken,
  describeSecret,
  describeTokenSource,
  doFetch,
  errorText,
  expandTilde,
  extractChatContent,
  extractChatDelta,
  extractCreatedToken,
  extractResponseDelta,
  extractResponseText,
  getFlagString,
  getString,
  isRecord,
  listCodexBinaryCandidates,
  lookupFlag,
  normalizeBaseUrl,
  parseApiKeyExpiresAtMs,
  parseSseEvents,
  parseUsageLimitRequests,
  parseWindowMs,
  readStdin,
  resolveAdminToken,
  resolveChatMessages,
  resolveClientToken,
  resolveCodexClientVersion,
  resolveResponsesInput,
  streamToOut,
  usageText,
  writeErrText,
  writeOutText,
  writeRequestFailure,
  writeUsageError,
};

#!/usr/bin/env bun
/**
 * Repairs this host's Codex auth pool from another host's working credential.
 *
 * Run it from the repository root:
 *
 *   bun run scripts/codex-auth-repair.ts
 *
 * Without `--apply` the run is a report: it proves which accounts authenticate
 * and prints the plan it would execute. With `--apply` it writes the planned
 * replacement into this host's KV pool with a versionstamp check, so a
 * concurrent rotation inside the gateway loses the race instead of being
 * clobbered.
 *
 * Validation never runs inference and never calls the OAuth token endpoint.
 * Each credential is checked with an account-bound `GET` against the Codex
 * usage endpoint, which answers 200/429 for a live token and 401 for a dead
 * one. A refresh token is therefore never exercised, so a check cannot rotate
 * a shared refresh token and cannot break the host the credential came from.
 *
 * A probe that cannot decide an account — a timeout, or any status other than
 * 200/429/401 — leaves that account exactly as it is and is reported as
 * inconclusive. Only an explicit rejection or an already-expired access token
 * makes a slot repair-eligible, and an inconclusive slot never pays for SSH
 * reads or candidate probes on its own.
 *
 * `ssh` is the only transport for remote credentials, and the remote program
 * is streamed over stdin and imports the other host's deployed Bun storage module.
 * Nothing on the remote host is ever written.
 */
import { readFile, stat } from "node:fs/promises";
import { BUN_KV_DATABASE_PATH, openKv, type Kv } from "#kv";
import { prepareNativeKvForDevelopment } from "../src/runtime/native-kv-bootstrap.ts";
import {
  applyCodexAuthPlan,
  type AssessedCodexAuthCandidate,
  type CodexAuthCandidate,
  type CodexAuthCandidateSource,
  type CodexAuthProbeResult,
  type CodexAuthRepairAccount,
  codexAuthCandidateFromAuthJson,
  codexAuthCandidateKey,
  codexAuthCandidatesFromPool,
  needsCodexAuthReplacement,
  planCodexAuthRepair,
} from "../src/codex/auth-repair.ts";
import { getJwtExpMs, parseCodexAuthPool } from "../src/codex/index.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../src/types.ts";

const CODEX_AUTH_POOL_KEY = ["ubq_ai", "codex_auth"] as const;
const DEFAULT_REMOTE = "codex@vps.pavlovcik.com";
const DEFAULT_KV_PATH = BUN_KV_DATABASE_PATH;
const DEFAULT_REMOTE_KV_PATH = "/home/codex/repos/ubiquity/ai.ubq.fi/.data/kv-bun.sqlite3";
const PROBE_TIMEOUT_MS = 10_000;
const SSH_TIMEOUT_MS = 30_000;
const CODEX_USAGE_PATH = "/backend-api/wham/usage";
const CODEX_USER_AGENT = "codex_cli_rs/0.100.0 (ai.ubq.fi)";

type Flags = Readonly<{
  apply: boolean;
  diff: boolean;
  json: boolean;
  remote: string;
  kv: string;
  remoteKv: string;
  authJson: string;
  codexBaseUrl: string;
  ssh: string;
}>;

const parseArgs = (args: readonly string[]): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      out[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
};

const readFlagString = (flags: Record<string, string | boolean>, key: string, fallback: string): string => {
  const value = flags[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
};

const expandTilde = (path: string): string => {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) return `${home}${path.slice(1)}`;
  }
  return path;
};

const resolveFlags = (args: readonly string[]): Flags => {
  const flags = parseArgs(args);
  return Object.freeze({
    apply: flags.apply === true,
    diff: flags.diff === true,
    json: flags.json === true,
    remote: readFlagString(flags, "remote", DEFAULT_REMOTE),
    kv: expandTilde(readFlagString(flags, "kv", DEFAULT_KV_PATH)),
    remoteKv: readFlagString(flags, "remote-kv", DEFAULT_REMOTE_KV_PATH),
    authJson: expandTilde(readFlagString(flags, "auth-json", "~/.codex/auth.json")),
    codexBaseUrl: readFlagString(flags, "codex-base-url", "https://chatgpt.com/backend-api/codex").replace(/\/$/, ""),
    ssh: readFlagString(flags, "ssh", "ssh"),
  });
};

const usage = (): void => {
  console.log(`codex-auth-repair.ts

Reports whether this host's Codex auth pool authenticates, and optionally
adopts a working credential from another host.

  --apply              Write the plan into this host's KV pool (default: report only).
  --diff               Read the remote host even when nothing here is broken, to report divergence.
  --json               Emit the plan as JSON instead of text.
  --remote <target>    SSH target holding the other host's pool (default ${DEFAULT_REMOTE}).
  --kv <path>          Local Bun KV path (default ${DEFAULT_KV_PATH}).
  --remote-kv <path>   Remote Bun KV path under the deployed tree's .data directory (default ${DEFAULT_REMOTE_KV_PATH}).
  --auth-json <path>   Local auth.json candidate source (default ~/.codex/auth.json).
  --codex-base-url <url>
  --ssh <path>         ssh binary (default ssh).

Exit codes: 0 healthy or repaired, 1 repair needed but not applied or a probe was
inconclusive, 2 blocked.`);
};

const sha256Prefix = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
};

const formatTime = (ms: number | null): string => (ms === null ? "n/a" : new Date(ms).toISOString());

/** Reads a local KV pool entry with the versionstamp the write must still match. */
const readLocalPool = async (kvPath: string): Promise<{ pool: CodexAuthPoolState; versionstamp: string } | { error: string }> => {
  let kv: Kv;
  try {
    kv = await openKv(kvPath);
  } catch (error) {
    return { error: `could not open ${kvPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const entry = await kv.get(CODEX_AUTH_POOL_KEY, { consistency: "strong" });
    if (entry.value === null) return { error: `${kvPath} has no [ubq_ai, codex_auth] entry` };
    const pool = parseCodexAuthPool(entry.value);
    if (!pool) return { error: `${kvPath} holds a malformed Codex auth pool` };
    if (!entry.versionstamp) return { error: `${kvPath} returned no versionstamp` };
    return { pool, versionstamp: entry.versionstamp };
  } finally {
    kv.close();
  }
};

/**
 * Commits a repaired pool only while the entry still matches the versionstamp
 * read before planning. A gateway rotation that lands in between makes the
 * commit fail, and the caller retries on its next run instead of overwriting a
 * freshly refreshed credential. The atomic check also covers a pool that
 * disappeared, so no separate read is needed.
 */
const writeLocalPool = async (kvPath: string, versionstamp: string, pool: CodexAuthPoolState): Promise<{ ok: true } | { ok: false; error: string }> => {
  const kv = await openKv(kvPath);
  try {
    const committed = await kv.atomic().check({ key: CODEX_AUTH_POOL_KEY, versionstamp }).set(CODEX_AUTH_POOL_KEY, pool).commit();
    if (!committed.ok) return { ok: false, error: "auth pool changed while planning; nothing was written" };
    return { ok: true };
  } finally {
    kv.close();
  }
};

/**
 * Proves one access token upstream without inference and without refreshing.
 * 200 and 429 both mean the upstream accepted the credential; 401 means it was
 * rejected; anything else, including a transport failure, is inconclusive and
 * can never justify a write.
 */
const probeAccessToken = async (accessToken: string, accountId: string, baseUrl: string, fetcher: typeof fetch): Promise<CodexAuthProbeResult> => {
  let url: string;
  try {
    url = new URL(CODEX_USAGE_PATH, baseUrl).toString();
  } catch {
    return { outcome: "inconclusive", status: null };
  }
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-ID": accountId,
        "User-Agent": CODEX_USER_AGENT,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const status = response.status;
    try {
      await response.body?.cancel();
    } catch {
      // The status is the only evidence this probe needs.
    }
    if (status === 200 || status === 429) return { outcome: "valid", status };
    if (status === 401) return { outcome: "invalid", status };
    return { outcome: "inconclusive", status };
  } catch {
    return { outcome: "inconclusive", status: null };
  }
};

const runCommand = async (
  command: string,
  args: readonly string[],
  stdin: string | null,
  timeoutMs: number
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> => {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([command, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return { ok: false, error: `${command} could not start: ${error instanceof Error ? error.message : String(error)}` };
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }, timeoutMs);
  try {
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    if (stdin !== null) await child.stdin.write(stdin);
    await child.stdin.end();
    const [code, stdoutText, stderrText] = await Promise.all([child.exited, stdout, stderr]);
    if (code !== 0) {
      const detail = stderrText.trim().split("\n").slice(-2).join(" ").slice(0, 300);
      const suffix = detail ? `: ${detail}` : "";
      return { ok: false, error: `${command} exited ${code}${suffix}` };
    }
    return { ok: true, stdout: stdoutText };
  } catch (error) {
    return { ok: false, error: `${command} failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
};

/**
 * The remote program imports the Bun storage seam from the deployed repository
 * beside the remote .data directory, then opens a marked database read-only in effect —
 * it reads one key and closes — and prints the stored pool so the caller can
 * rank credentials. Missing files, incompatible codecs, or an absent deployed
 * module fail closed; there is no legacy runtime or dependency-install fallback.
 */
const buildRemotePoolProgram = (remoteKvPath: string): string =>
  `import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const kvPath = ${JSON.stringify(remoteKvPath)};
try {
  if (basename(dirname(kvPath)) !== ".data") throw new Error("remote KV must be inside the deployed repository's .data directory");
  if (!(await lstat(kvPath)).isFile()) throw new Error("remote KV must be an existing regular database");
  const releaseRoot = await realpath(join(dirname(kvPath), "current"));
  const sha = basename(releaseRoot);
  if (basename(dirname(releaseRoot)) !== "releases" || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("remote KV requires an immutable release identity");
  const { verifyReleasePayload } = await import(pathToFileURL(join(releaseRoot, "ops", "release-artifact.ts")).href);
  const manifest = await verifyReleasePayload(releaseRoot, sha);
  if (manifest.schema !== 3) throw new Error("remote KV requires a verified native release binding");
  const { nativeKvReleaseBinding } = await import(pathToFileURL(join(releaseRoot, "ops", "native-kv-release.ts")).href);
  const { prepareNativeKvBackend } = await import(pathToFileURL(join(releaseRoot, "src", "storage", "native-addon.ts")).href);
  prepareNativeKvBackend(nativeKvReleaseBinding(releaseRoot, manifest.native_kv));
  const { openKv } = await import(pathToFileURL(join(releaseRoot, "src", "storage", "kv.ts")).href);
  const kv = await openKv(kvPath);
  try {
    const entry = await kv.get(["ubq_ai", "codex_auth"], { consistency: "strong" });
    console.log(JSON.stringify({ ok: true, pool: entry.value ?? null }));
  } finally {
    kv.close();
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
`;

const fetchRemotePool = async (flags: Flags, warn: (message: string) => void): Promise<{ candidates: readonly CodexAuthCandidate[]; error: string | null }> => {
  const result = await runCommand(
    flags.ssh,
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", flags.remote, "bun", "--no-env-file", "run", "-"],
    buildRemotePoolProgram(flags.remoteKv),
    SSH_TIMEOUT_MS
  );
  if (!result.ok) {
    warn(`remote pool unavailable (${result.error})`);
    return { candidates: [], error: result.error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "");
  } catch {
    warn("remote pool read returned no JSON");
    return { candidates: [], error: "remote pool read returned no JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { ok?: unknown }).ok !== true) {
    const detail = typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : "unknown error";
    warn(`remote pool read failed: ${detail}`);
    return { candidates: [], error: detail };
  }
  const candidates = codexAuthCandidatesFromPool((parsed as { pool: unknown }).pool, "vps-pool");
  if (candidates.length === 0) warn("remote pool read returned no usable account");
  return { candidates, error: null };
};

const fetchRemoteAuthJson = async (flags: Flags, warn: (message: string) => void): Promise<readonly CodexAuthCandidate[]> => {
  const result = await runCommand(
    flags.ssh,
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", flags.remote, "cat", "~/.codex/auth.json"],
    null,
    SSH_TIMEOUT_MS
  );
  if (!result.ok) {
    warn(`remote auth.json unavailable (${result.error})`);
    return [];
  }
  try {
    const candidate = codexAuthCandidateFromAuthJson(JSON.parse(result.stdout), "vps-auth-json", null);
    return candidate ? [candidate] : [];
  } catch {
    warn("remote auth.json was not valid JSON");
    return [];
  }
};

const readLocalAuthJsonCandidate = async (flags: Flags): Promise<CodexAuthCandidate | null> => {
  try {
    const text = await readFile(flags.authJson, "utf8");
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await stat(flags.authJson)).mtime.getTime();
    } catch {
      mtimeMs = null;
    }
    return codexAuthCandidateFromAuthJson(JSON.parse(text), "local-auth-json", mtimeMs);
  } catch {
    return null;
  }
};

const describeProbe = (probe: CodexAuthProbeResult): string => (probe.status === null ? probe.outcome : `${probe.outcome}(${probe.status})`);

const collectCandidates = async (flags: Flags, warn: (message: string) => void): Promise<readonly CodexAuthCandidate[]> => {
  const gathered: CodexAuthCandidate[] = [];
  const localAuthJson = await readLocalAuthJsonCandidate(flags);
  if (localAuthJson) gathered.push(localAuthJson);
  const remotePool = await fetchRemotePool(flags, warn);
  gathered.push(...remotePool.candidates);
  gathered.push(...(await fetchRemoteAuthJson(flags, warn)));
  const seen = new Set<string>();
  return gathered.filter((candidate) => {
    const key = codexAuthCandidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

type Report = Readonly<{
  status: "healthy" | "repaired" | "repair_available" | "inconclusive" | "blocked";
  applied: boolean;
  accounts: readonly Readonly<{
    slot: number;
    account_id: string;
    access_sha: string;
    access_exp: string;
    probe: string;
    action: string;
    adopted_from: CodexAuthCandidateSource | null;
    adopted_access_sha: string | null;
    adopted_access_exp: string | null;
    refresh_diverged: boolean | null;
    rejected: readonly string[];
  }>[];
  /** Every credential read from another source, reported only when one was read. */
  candidates: readonly Readonly<{
    source: CodexAuthCandidateSource;
    account_id: string;
    access_sha: string;
    access_exp: string;
    /** True when this credential is byte-identical to the local account's own. */
    duplicate_of_local: boolean;
    probe: string;
  }>[];
  notes: readonly string[];
}>;

const describeRejection = (item: Readonly<{ source: CodexAuthCandidateSource; outcome: CodexAuthProbeResult["outcome"]; status: number | null }>): string => {
  const status = item.status === null ? "" : `(${item.status})`;
  return `${item.source}=${item.outcome}${status}`;
};

export const accountAction = (
  selection: ReturnType<typeof planCodexAuthRepair>["selections"][number] | undefined,
  blocked: ReturnType<typeof planCodexAuthRepair>["unrepairable"][number] | undefined,
  inconclusive: ReturnType<typeof planCodexAuthRepair>["inconclusive"][number] | undefined,
  applied: boolean
): string => {
  if (selection) return applied ? "replaced" : "would replace";
  if (blocked) return `blocked:${blocked.reason}`;
  if (inconclusive) return "inconclusive";
  return "kept";
};

/**
 * An inconclusive probe is its own outcome: the run cannot certify the pool, so
 * it never reports health, and it never claims a repair was needed either.
 */
export const reportStatus = (plan: ReturnType<typeof planCodexAuthRepair>, applied: boolean): Report["status"] => {
  if (plan.unrepairable.length > 0) return "blocked";
  if (plan.inconclusive.length > 0) return "inconclusive";
  if (plan.selections.length === 0) return "healthy";
  return applied ? "repaired" : "repair_available";
};

const buildAccountRow = async (
  entry: CodexAuthRepairAccount,
  plan: ReturnType<typeof planCodexAuthRepair>,
  applied: boolean
): Promise<Report["accounts"][number]> => {
  const selection = plan.selections.find((candidate) => candidate.slot === entry.slot);
  const blocked = plan.unrepairable.find((candidate) => candidate.slot === entry.slot);
  const healthy = plan.healthy.find((candidate) => candidate.slot === entry.slot);
  const inconclusive = plan.inconclusive.find((candidate) => candidate.slot === entry.slot);
  const rejected = (selection?.rejected ?? blocked?.rejected ?? []).map(describeRejection);
  return {
    slot: entry.slot,
    account_id: entry.account.account_id,
    access_sha: await sha256Prefix(entry.account.access_token),
    access_exp: formatTime(getJwtExpMs(entry.account.access_token)),
    probe: describeProbe(entry.probe),
    action: accountAction(selection, blocked, inconclusive, applied),
    adopted_from: selection?.candidate.source ?? null,
    adopted_access_sha: selection ? await sha256Prefix(selection.candidate.access_token) : null,
    adopted_access_exp: selection ? formatTime(getJwtExpMs(selection.candidate.access_token)) : null,
    refresh_diverged: healthy?.refresh_diverged ?? inconclusive?.refresh_diverged ?? null,
    rejected,
  };
};

const buildCandidateRow = async (assessed: AssessedCodexAuthCandidate, accounts: readonly CodexAuthRepairAccount[]): Promise<Report["candidates"][number]> => {
  const local = accounts.find((entry) => entry.account.account_id === assessed.candidate.account_id);
  return {
    source: assessed.candidate.source,
    account_id: assessed.candidate.account_id,
    access_sha: await sha256Prefix(assessed.candidate.access_token),
    access_exp: formatTime(assessed.access_exp_ms),
    duplicate_of_local: local?.account.access_token === assessed.candidate.access_token,
    probe: describeProbe(assessed.probe),
  };
};

const collectNotes = (plan: ReturnType<typeof planCodexAuthRepair>, candidateRows: Report["candidates"]): string[] => {
  const notes: string[] = [];
  const divergent = candidateRows.filter((row) => !row.duplicate_of_local && row.probe.startsWith("valid")).length;
  if (divergent > 0) notes.push(`${divergent} credential(s) from another source differ from this host's and authenticate`);
  if (plan.selections.length === 0 && plan.unrepairable.length === 0) {
    const diverged = plan.healthy.filter((entry) => entry.refresh_diverged === true).length;
    if (diverged > 0) {
      notes.push(`${diverged} account(s) hold a refresh token no candidate source matches; no action is taken while the access token authenticates`);
    }
  }
  if (plan.unrepairable.length > 0) notes.push("at least one account has no credential that authenticates; sign in on a host and re-run");
  if (plan.inconclusive.length > 0) {
    notes.push(`${plan.inconclusive.length} account(s) could not be probed (a timeout or a status other than 200/429/401); they were left unchanged`);
  }
  return notes;
};

const buildReport = async (
  plan: ReturnType<typeof planCodexAuthRepair>,
  accounts: readonly CodexAuthRepairAccount[],
  candidates: readonly AssessedCodexAuthCandidate[],
  applied: boolean
): Promise<Report> => {
  const rows: Report["accounts"][number][] = [];
  for (const entry of accounts) rows.push(await buildAccountRow(entry, plan, applied));
  const candidateRows: Report["candidates"][number][] = [];
  for (const assessed of candidates) candidateRows.push(await buildCandidateRow(assessed, accounts));
  return {
    status: reportStatus(plan, applied),
    applied,
    accounts: rows,
    candidates: candidateRows,
    notes: collectNotes(plan, candidateRows),
  };
};

/**
 * One banner per status, as an exhaustive map instead of a branch chain: the
 * report path stays flat and a new status cannot be added without its message.
 */
const STATUS_BANNERS: Readonly<Record<Report["status"], string>> = {
  healthy: "codex-auth-repair: every account authenticates; nothing to change",
  repaired: "codex-auth-repair: replaced credential(s) from another host",
  repair_available: "codex-auth-repair: a replacement is available; re-run with --apply to adopt it",
  inconclusive: "codex-auth-repair: INCONCLUSIVE — at least one account could not be probed; no credential was replaced for it",
  blocked: "codex-auth-repair: BLOCKED — an account has no credential that authenticates",
};

const printReport = (report: Report): void => {
  console.log(STATUS_BANNERS[report.status]);
  for (const row of report.accounts) {
    console.log(
      `  slot ${row.slot} ${row.account_id} probe=${row.probe} access=${row.access_sha} exp=${row.access_exp} ${row.action}` +
        (row.adopted_from ? ` <- ${row.adopted_from} ${row.adopted_access_sha} exp=${row.adopted_access_exp}` : "") +
        (row.refresh_diverged === true ? " refresh=diverged" : "")
    );
    for (const rejected of row.rejected) console.log(`      rejected: ${rejected}`);
  }
  for (const candidate of report.candidates) {
    console.log(
      `  source ${candidate.source} ${candidate.account_id} access=${candidate.access_sha} exp=${candidate.access_exp} ` +
        `probe=${candidate.probe}${candidate.duplicate_of_local ? " (identical to local)" : " (differs from local)"}`
    );
  }
  for (const note of report.notes) console.log(`  note: ${note}`);
};

const probeLocalPool = async (
  pool: CodexAuthPoolState,
  baseUrl: string
): Promise<readonly Readonly<{ account: CodexAuthState; probe: CodexAuthProbeResult }>[]> =>
  await Promise.all(
    pool.accounts.map(async (account) => ({
      account,
      probe: await probeAccessToken(account.access_token, account.account_id, baseUrl, fetch),
    }))
  );

/**
 * True only when a local slot's own evidence justifies reading credential
 * sources. An inconclusive probe is not evidence, so it never buys SSH reads or
 * upstream candidate probes by itself; `--diff` remains the explicit way to ask
 * for a divergence report anyway.
 */
export const anyCodexAuthSlotNeedsRepair = (
  localProbes: readonly Readonly<{ account: CodexAuthState; probe: CodexAuthProbeResult }>[],
  nowMs: number
): boolean => localProbes.some((entry) => needsCodexAuthReplacement(entry.probe, getJwtExpMs(entry.account.access_token), nowMs));

const assessCandidates = async (candidates: readonly CodexAuthCandidate[], baseUrl: string): Promise<AssessedCodexAuthCandidate[]> => {
  const assessed: AssessedCodexAuthCandidate[] = [];
  for (const candidate of candidates) {
    assessed.push({
      candidate,
      access_exp_ms: getJwtExpMs(candidate.access_token),
      probe: await probeAccessToken(candidate.access_token, candidate.account_id, baseUrl, fetch),
    });
  }
  return assessed;
};

/**
 * A slot is only marked refresh-divergent when a candidate source was actually
 * read, so the steady-state run never claims a comparison it did not make.
 */
const buildRepairAccounts = (
  localProbes: readonly Readonly<{ account: CodexAuthState; probe: CodexAuthProbeResult }>[],
  candidates: readonly CodexAuthCandidate[]
): CodexAuthRepairAccount[] =>
  localProbes.map((entry, index) => ({
    slot: index + 1,
    account: entry.account,
    probe: entry.probe,
    refresh_diverged:
      candidates.length === 0
        ? null
        : !candidates.some((candidate) => candidate.account_id === entry.account.account_id && candidate.refresh_token === entry.account.refresh_token),
  }));

type ApplyOutcome = Readonly<{ ok: true; applied: boolean }> | Readonly<{ ok: false; exitCode: number; message: string }>;

const applyPlannedRepair = async (
  flags: Flags,
  pool: CodexAuthPoolState,
  versionstamp: string,
  plan: ReturnType<typeof planCodexAuthRepair>,
  nowMs: number
): Promise<ApplyOutcome> => {
  if (!flags.apply || plan.selections.length === 0) return { ok: true, applied: false };
  const next = applyCodexAuthPlan(pool, plan, nowMs);
  if (!next) return { ok: false, exitCode: 2, message: "the plan could not be represented in the auth pool; nothing was written" };
  const written = await writeLocalPool(flags.kv, versionstamp, next);
  if (!written.ok) return { ok: false, exitCode: 1, message: written.error };
  return { ok: true, applied: true };
};

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return 0;
  }
  const flags = resolveFlags(args);
  const notes: string[] = [];
  // Source warnings travel in the report, so they appear once in both the text
  // and JSON forms instead of being printed and then repeated.
  const warn = (message: string): void => {
    notes.push(message);
  };

  await prepareNativeKvForDevelopment();
  const local = await readLocalPool(flags.kv);
  if ("error" in local) {
    console.error(`codex-auth-repair: ${local.error}`);
    return 2;
  }

  const nowMs = Date.now();
  const localProbes = await probeLocalPool(local.pool, flags.codexBaseUrl);
  const anyNeedsRepair = anyCodexAuthSlotNeedsRepair(localProbes, nowMs);
  // SSH and every candidate probe are paid only when a slot needs repair, or
  // when the caller explicitly asked for a divergence report. An inconclusive
  // probe is not a repair need, so it never triggers them on its own.
  const readSources = anyNeedsRepair || flags.diff;
  const candidates = readSources ? await collectCandidates(flags, warn) : [];
  const assessed = readSources ? await assessCandidates(candidates, flags.codexBaseUrl) : [];
  const accounts = buildRepairAccounts(localProbes, candidates);
  const plan = planCodexAuthRepair({ accounts, candidates: assessed, nowMs });

  const write = await applyPlannedRepair(flags, local.pool, local.versionstamp, plan, nowMs);
  if (!write.ok) {
    console.error(`codex-auth-repair: ${write.message}`);
    return write.exitCode;
  }
  if (write.applied && candidates.length > 0) {
    const diverged = accounts.filter((entry) => entry.refresh_diverged === true).length;
    if (diverged > 0) notes.push(`${diverged} account(s) still hold a refresh token no candidate source matches`);
  }

  const report = await buildReport(plan, accounts, assessed, write.applied);
  const merged: Report = { ...report, notes: [...report.notes, ...notes] };
  if (flags.json) console.log(JSON.stringify(merged, null, 2));
  else printReport(merged);

  if (merged.status === "blocked") return 2;
  if (merged.status === "inconclusive" || merged.status === "repair_available") return 1;
  return 0;
};

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`codex-auth-repair: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

import { openKv as openBunKv, type Kv, type KvKey } from "#kv";
import { prepareNativeKvForDevelopment } from "../src/runtime/native-kv-bootstrap.ts";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Writable } from "node:stream";
import { exportEntries } from "../src/kv-conversion/profile-json.ts";
import {
  classifyKvMigrationKey,
  defaultIncludeLegacyForProfile,
  importKvMigrationLines,
  type KvMigrationDecisionAction,
  type KvMigrationProfile,
  migrateKvReadIncidentV2,
  parseKvMigrationEntryLine,
  safeKvMigrationValueType,
  validateKvMigrationTarget,
} from "../src/cache/kv-migration.ts";

// Parsed CLI flags. Index access can miss -- the lint project does not enable
// noUncheckedIndexedAccess -- so a value is possibly `undefined`; `hasFlag`
// depends on exactly that to report a missing flag as false (`undefined !== false`).
type Args = Record<string, string | boolean | undefined>;

const DEFAULT_EXPORT_PATH = ".kv-migration/deno1.ndjson";
const DEFAULT_LOCAL_DB_PATH = ".kv-migration/deno1.sqlite3";

const parseArgs = (args: string[]): { command: string; flags: Args } => {
  const [command = "help", ...rest] = args;
  const flags: Args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { command, flags };
};

const getFlagString = (flags: Args, key: string, fallback = ""): string => {
  const value = flags[key];
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const getProfile = (flags: Args, fallback: KvMigrationProfile = "local"): KvMigrationProfile => {
  const profile = getFlagString(flags, "profile", fallback);
  if (profile === "local" || profile === "prod") return profile;
  throw new Error("--profile must be local or prod");
};

const hasFlag = (flags: Args, key: string): boolean => flags[key] !== undefined && flags[key] !== false;

const getRequiredFlagString = (flags: Args, key: string): string => {
  const value = getFlagString(flags, key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
};

const getDryRun = (flags: Args, fallback: boolean): boolean => {
  const dryRun = hasFlag(flags, "dry-run");
  const write = hasFlag(flags, "write");
  if (dryRun && write) throw new Error("--dry-run and --write are mutually exclusive");
  if (dryRun) return true;
  if (write) return false;
  return fallback;
};

const getIncludeLegacy = (flags: Args, profile: KvMigrationProfile): boolean => {
  const includeLegacy = hasFlag(flags, "include-legacy");
  const excludeLegacy = hasFlag(flags, "exclude-legacy");
  if (includeLegacy && excludeLegacy) throw new Error("--include-legacy and --exclude-legacy are mutually exclusive");
  if (includeLegacy) return true;
  if (excludeLegacy) return false;
  return defaultIncludeLegacyForProfile(profile);
};

async function* readLines(path: string): AsyncGenerator<string> {
  const file = createReadStream(path, { encoding: "utf8" });
  try {
    let buffer = "";
    for await (const chunk of file) {
      if (typeof chunk !== "string") throw new TypeError("Expected decoded profile NDJSON text");
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) yield line;
        index = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield buffer;
  } finally {
    try {
      file.destroy();
    } catch {
      // FsFile.readable may already have closed the file.
    }
  }
}

const ensureParentDir = async (path: string): Promise<void> => {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index <= 0) return;
  await mkdir(path.slice(0, index), { recursive: true });
};

const openKv = async (target: string): Promise<Kv> => {
  if (import.meta.main && !/^https?:\/\//i.test(target)) await prepareNativeKvForDevelopment();
  return await openBunKv(target || undefined);
};

const exportCommand = async (flags: Args): Promise<void> => {
  const source = getRequiredFlagString(flags, "source");
  const out = getFlagString(flags, "out", DEFAULT_EXPORT_PATH);
  await ensureParentDir(out);
  const kv = await openKv(source);
  const file = createWriteStream(out);
  try {
    const stream = exportEntries(kv, { prefix: [] });
    await stream.pipeTo(Writable.toWeb(file));
  } finally {
    kv.close();
  }
  console.log(JSON.stringify({ exported: out, source }, null, 2));
};

const probeCommand = async (flags: Args): Promise<void> => {
  const source = getRequiredFlagString(flags, "source");
  const kv = await openKv(source);
  try {
    const prefixes = [[], ["ubq_ai"], ["uos_ai"], ["default"], ["embeddings"], ["agent_messages"]] as KvKey[];
    const result = [];
    for (const prefix of prefixes) {
      let count = 0;
      const samples: KvKey[] = [];
      for await (const entry of kv.list({ prefix }, { limit: 20 })) {
        count += 1;
        if (samples.length < 5) samples.push(entry.key);
      }
      result.push({ prefix, count_at_most_20: count, sample_keys: samples });
    }
    console.log(JSON.stringify({ source, result }, null, 2));
  } finally {
    kv.close();
  }
};

/**
 * Compares two strings by UTF-16 code unit, reproducing the default `Array#sort`
 * order exactly. `localeCompare` is locale-dependent and would reorder the
 * export-controlled value types (e.g. "Array" ahead of "array").
 */
const compareCodeUnits = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const analyzeCommand = async (flags: Args): Promise<void> => {
  const input = getFlagString(flags, "in", DEFAULT_EXPORT_PATH);
  const profile = getProfile(flags);
  const includeCache = hasFlag(flags, "include-cache");
  const includeLegacy = getIncludeLegacy(flags, profile);
  const groups = new Map<string, { count: number; action: KvMigrationDecisionAction; reason: string; valueTypes: Set<string> }>();
  const firstParts = new Map<string, number>();
  let total = 0;
  let errors = 0;

  for await (const line of readLines(input)) {
    try {
      const entry = parseKvMigrationEntryLine(line);
      const decision = classifyKvMigrationKey(entry.key, { profile, includeCache, includeLegacy });
      total += 1;
      firstParts.set(String(entry.key[0] ?? ""), (firstParts.get(String(entry.key[0] ?? "")) ?? 0) + 1);
      const current = groups.get(decision.group) ?? {
        count: 0,
        action: decision.action,
        reason: decision.reason,
        valueTypes: new Set<string>(),
      };
      current.count += 1;
      current.valueTypes.add(safeKvMigrationValueType(entry.raw.value));
      groups.set(decision.group, current);
    } catch {
      errors += 1;
    }
  }

  const groupRows = Array.from(groups.entries())
    .map(([group, data]) => ({
      group,
      count: data.count,
      action: data.action,
      reason: data.reason,
      value_types: Array.from(data.valueTypes).sort(compareCodeUnits),
    }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));

  console.log(
    JSON.stringify(
      {
        input,
        profile,
        include_cache: includeCache,
        include_legacy: includeLegacy,
        total,
        parse_errors: errors,
        first_key_parts: Object.fromEntries(Array.from(firstParts.entries()).sort((a, b) => b[1] - a[1])),
        groups: groupRows,
      },
      null,
      2
    )
  );
};

type ImportOptions = Readonly<{
  target: string;
  targetName: string;
  profileFallback: KvMigrationProfile;
  defaultDryRun: boolean;
  ensureTargetParentDir: boolean;
}>;

const importCommand = async (flags: Args, options: ImportOptions): Promise<void> => {
  const input = getFlagString(flags, "in", DEFAULT_EXPORT_PATH);
  const profile = getProfile(flags, options.profileFallback);
  const includeCache = hasFlag(flags, "include-cache");
  const includeLegacy = getIncludeLegacy(flags, profile);
  const overwrite = hasFlag(flags, "overwrite");
  const dryRun = getDryRun(flags, options.defaultDryRun);
  if (options.ensureTargetParentDir) await ensureParentDir(options.target);

  const kv = dryRun ? null : await openKv(options.target);
  try {
    const result = await importKvMigrationLines(kv, readLines(input), {
      profile,
      includeCache,
      includeLegacy,
      overwrite,
      dryRun,
    });

    console.log(
      JSON.stringify(
        {
          input,
          [options.targetName]: options.target,
          profile,
          include_cache: includeCache,
          include_legacy: includeLegacy,
          overwrite,
          dry_run: dryRun,
          ...result,
        },
        null,
        2
      )
    );
    if (result.errors > 0) process.exitCode = 1;
  } finally {
    kv?.close();
  }
};

const importLocalCommand = async (flags: Args): Promise<void> => {
  const db = getFlagString(flags, "db", DEFAULT_LOCAL_DB_PATH);
  await importCommand(flags, {
    target: db,
    targetName: "db",
    profileFallback: "local",
    defaultDryRun: false,
    ensureTargetParentDir: true,
  });
};

const importRemoteCommand = async (flags: Args): Promise<void> => {
  const dest = getRequiredFlagString(flags, "dest");
  await importCommand(flags, {
    target: dest,
    targetName: "dest",
    profileFallback: "prod",
    defaultDryRun: true,
    ensureTargetParentDir: false,
  });
};

const validateCommand = async (flags: Args): Promise<void> => {
  const target = getFlagString(flags, "target", getFlagString(flags, "db", DEFAULT_LOCAL_DB_PATH));
  const strict = hasFlag(flags, "strict");
  const kv = await openKv(target);

  try {
    const result = { target, ...(await validateKvMigrationTarget(kv)) };

    console.log(JSON.stringify(result, null, 2));
    if (strict && result.errors.length) process.exitCode = 1;
  } finally {
    kv.close();
  }
};

const incidentV2Command = async (flags: Args): Promise<void> => {
  const target = getRequiredFlagString(flags, "target");
  const kv = await openKv(target);
  try {
    const migration = await migrateKvReadIncidentV2(kv);
    const validation = await validateKvMigrationTarget(kv);
    console.log(JSON.stringify({ target, migration, validation }, null, 2));
    if (validation.errors.length) process.exitCode = 1;
  } finally {
    kv.close();
  }
};

const getAuthToken = (flags: Args): string => {
  // Candidates are tried in order and an empty value means "not provided", exactly
  // as the previous `||` chain treated it: `??` would accept an empty `--token=`
  // and reject a run that DENO_DEPLOY_TOKEN could have served.
  const candidates = [getFlagString(flags, "token"), process.env.DENO_DEPLOY_TOKEN?.trim(), process.env.UOS_AI_TOKEN?.trim()];
  const token = candidates.find((value) => value !== undefined && value !== "") ?? "";
  if (!token) throw new Error("--token or DENO_DEPLOY_TOKEN is required for HTTP migration commands");
  return token;
};

export const appendBooleanParam = (url: URL, key: string, value: boolean): void => {
  url.searchParams.set(key, value ? "1" : "0");
};

const parseJsonOrText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const importSummaryHasErrors = (value: unknown): boolean =>
  typeof value === "object" && value !== null && typeof (value as { errors?: unknown }).errors === "number" && (value as { errors: number }).errors > 0;

/** Removes every trailing `/`, equivalent to `value.replace(/\/+$/, "")` via an explicit linear scan. */
const stripTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
};

const importHttpCommand = async (flags: Args): Promise<void> => {
  const input = getFlagString(flags, "in", DEFAULT_EXPORT_PATH);
  const baseUrl = stripTrailingSlashes(getRequiredFlagString(flags, "base-url"));
  const token = getAuthToken(flags);
  const profile = getProfile(flags, "prod");
  const includeCache = hasFlag(flags, "include-cache");
  const includeLegacy = getIncludeLegacy(flags, profile);
  const overwrite = hasFlag(flags, "overwrite");
  const dryRun = getDryRun(flags, true);
  const body = await Bun.file(input).text();
  const url = new URL("/admin/kv-migration/import", baseUrl);
  url.searchParams.set("profile", profile);
  appendBooleanParam(url, "include_cache", includeCache);
  appendBooleanParam(url, "include_legacy", includeLegacy);
  appendBooleanParam(url, "overwrite", overwrite);
  if (dryRun) url.searchParams.set("dry_run", "1");
  else url.searchParams.set("write", "1");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-ndjson",
    },
    body,
  });
  const text = await response.text();
  const parsed = parseJsonOrText(text);
  console.log(
    JSON.stringify(
      {
        input,
        url: url.toString(),
        status: response.status,
        dry_run: dryRun,
        response: parsed,
      },
      null,
      2
    )
  );
  if (!response.ok || importSummaryHasErrors(parsed)) process.exitCode = 1;
};

const validateHttpCommand = async (flags: Args): Promise<void> => {
  const baseUrl = stripTrailingSlashes(getRequiredFlagString(flags, "base-url"));
  const token = getAuthToken(flags);
  const strict = hasFlag(flags, "strict");
  const url = new URL("/admin/kv-migration/validate", baseUrl);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const body = parseJsonOrText(text);
  console.log(
    JSON.stringify(
      {
        url: url.toString(),
        status: response.status,
        response: body,
      },
      null,
      2
    )
  );
  if (!response.ok) process.exitCode = 1;
  if (strict && typeof body === "object" && body && Array.isArray((body as { errors?: unknown }).errors)) {
    if ((body as { errors: unknown[] }).errors.length) process.exitCode = 1;
  }
};

const usage = (): void => {
  console.log(`kv-migrate.ts

Usage:
  bun run kv:probe --source <remote-kv-url>
  bun run kv:export --source <remote-kv-url> --out .kv-migration/deno1.ndjson
  bun run kv:analyze --in .kv-migration/deno1.ndjson --profile local
  bun run kv:import-local --in .kv-migration/deno1.ndjson --db .kv-migration/deno1.sqlite3 --profile local --overwrite
  bun run kv:import-remote --in .kv-migration/deno1.ndjson --dest <remote-kv-url> --profile prod
  bun run kv:import-remote --in .kv-migration/deno1.ndjson --dest <remote-kv-url> --profile prod --overwrite --write
  bun run kv:import-http --in .kv-migration/deno1.ndjson --base-url https://ai.ubq.fi --profile prod --overwrite
  bun run kv:import-http --in .kv-migration/deno1.ndjson --base-url https://ai.ubq.fi --profile prod --overwrite --write
  bun run kv:validate --target <remote-kv-url>
  bun run kv:incident-v2 --target <remote-kv-url>
  bun run kv:validate-http --base-url https://ai.ubq.fi --strict

Direct remote Deno/V8 KV access is retired. Use the source Deno release to export profile NDJSON before conversion, or use the HTTP import API.
HTTP imports require an admin bearer token; DENO_DEPLOY_TOKEN is used by default.

Profiles:
  local  Imports durable keys, codex_auth/codex_models, and legacy rows for replay.
  prod   Imports modern durable keys only. Skips codex_auth/codex_models and legacy rows by default.

Defaults:
  --out    ${DEFAULT_EXPORT_PATH}
  --db     ${DEFAULT_LOCAL_DB_PATH}

Remote imports are dry-run by default. Pass --write to modify the destination.
Use --include-cache to migrate embedding cache rows and --include-legacy to migrate legacy ["key", ...] rows.
`);
};

const main = async (): Promise<void> => {
  const { command, flags } = parseArgs(Bun.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "probe") {
    await probeCommand(flags);
    return;
  }
  if (command === "export") {
    await exportCommand(flags);
    return;
  }
  if (command === "analyze") {
    await analyzeCommand(flags);
    return;
  }
  if (command === "import-local") {
    await importLocalCommand(flags);
    return;
  }
  if (command === "import-remote") {
    await importRemoteCommand(flags);
    return;
  }
  if (command === "validate") {
    await validateCommand(flags);
    return;
  }
  if (command === "incident-v2") {
    await incidentV2Command(flags);
    return;
  }
  if (command === "import-http") {
    await importHttpCommand(flags);
    return;
  }
  if (command === "validate-http") {
    await validateHttpCommand(flags);
    return;
  }
  usage();
  throw new Error(`Unknown command: ${command}`);
};

if (import.meta.main) {
  await main();
}

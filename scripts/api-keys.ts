// Explicit module status. As a script, this file's top-level `command` CLI
// argument is a global declaration, and the ops/*.ts deploy scripts (also
// scripts, in the same ESLint type program) declare `async function command`
// in that shared scope, which made the type-aware rules read it as a function.
export {};

const parseArgs = (args: string[]): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
};

const usage = () => {
  console.log(`api-keys.ts

Manage ai.ubq.fi client API keys (admin-only).

Usage:
  bun run scripts/api-keys.ts <command> [options]

Commands:
  create --name "<label>" [--token "<exact token>"] [--expires <preset>|--expires-at-ms <ms>] [--token-only]
  list
  revoke --id "<id>"

Options:
  --url https://ai.ubq.fi          Base URL (default: https://ai.ubq.fi)
  --admin-token "<token>"         Admin token (or set DENO_DEPLOY_TOKEN)
  --expires <preset>              day|week|month|quarter|year|forever (sets expires_at_ms)
  --expires-at-ms <ms>            Unix epoch ms timestamp; -1 means does not expire
`);
};

if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
  usage();
  process.exit(0);
}

// process.argv.slice(2) is empty when the script is invoked without arguments, so the
// first element is annotated as possibly absent.
const commandRaw: string | undefined = process.argv.slice(2).at(0);
const rest = process.argv.slice(2).slice(1);
const command = commandRaw?.trim() ?? "";
if (!command || command.startsWith("--")) {
  usage();
  process.exit(2);
}

const parsed = parseArgs(rest);
const baseUrl = (parsed.url as string | undefined) ?? "https://ai.ubq.fi";
const adminToken = (parsed["admin-token"] as string | undefined) ?? process.env["DENO_DEPLOY_TOKEN"] ?? "";

if (!adminToken) {
  console.error("Missing admin token. Set DENO_DEPLOY_TOKEN or pass --admin-token.");
  process.exit(2);
}

const doFetch = async (req: Request): Promise<{ ok: true; json: unknown } | { ok: false; status: number; body: string }> => {
  const res = await fetch(req);
  const contentType = res.headers.get("Content-Type") ?? "";
  const isJson = contentType.includes("application/json");
  if (res.ok) {
    const json = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");
    return { ok: true, json };
  }
  const body = isJson ? JSON.stringify(await res.json().catch(() => null), null, 2) : await res.text().catch(() => "");
  return { ok: false, status: res.status, body: body || res.statusText };
};

const endpoint = (path: string): URL => new URL(path, baseUrl);

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

if (command === "create") {
  const name = (parsed.name as string | undefined) ?? "";
  if (!name.trim()) {
    console.error("Missing --name");
    process.exit(2);
  }

  const rawExpiresAtMs = parsed["expires-at-ms"];
  const rawPreset = parsed.expires;
  if (typeof rawExpiresAtMs === "string" && typeof rawPreset === "string") {
    console.error("Pass only one of --expires-at-ms or --expires.");
    process.exit(2);
  }

  let expiresAtMsValue: number | undefined;
  if (typeof rawExpiresAtMs === "string") {
    const parsedNumber = Number(rawExpiresAtMs.trim());
    if (!Number.isFinite(parsedNumber)) {
      console.error("--expires-at-ms must be a finite number (Unix epoch ms) or -1.");
      process.exit(2);
    }
    const expiresAtMs = Math.trunc(parsedNumber);
    if (expiresAtMs === -1) expiresAtMsValue = -1;
    else if (expiresAtMs <= Date.now()) {
      console.error("--expires-at-ms must be in the future (or -1).");
      process.exit(2);
    } else if (expiresAtMs < 0) {
      console.error("--expires-at-ms must be -1 or a future timestamp.");
      process.exit(2);
    } else {
      expiresAtMsValue = expiresAtMs;
    }
  } else if (typeof rawPreset === "string") {
    const preset = normalizeApiKeyExpiryPreset(rawPreset);
    if (!preset) {
      console.error("--expires must be one of: day, week, month, quarter, year, forever.");
      process.exit(2);
    }
    expiresAtMsValue = apiKeyExpiresAtMsFromPreset(preset, Date.now());
  }

  const token = (parsed.token as string | undefined) ?? null;
  const body: Record<string, unknown> = token ? { name, token } : { name };
  if (expiresAtMsValue !== undefined) body.expires_at_ms = expiresAtMsValue;
  const req = new Request(endpoint("/admin/api-keys"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const result = await doFetch(req);
  if (!result.ok) {
    console.error(`Request failed (${result.status}).`);
    console.error(result.body);
    process.exit(1);
  }

  const tokenOnly = parsed["token-only"] === true;
  if (tokenOnly) {
    const tokenValue = result.json && typeof result.json === "object" && "token" in result.json ? (result.json as { token?: unknown }).token : null;
    console.log(typeof tokenValue === "string" ? tokenValue : "");
  } else {
    console.log(JSON.stringify(result.json, null, 2));
  }
  process.exit(0);
}

if (command === "list") {
  const req = new Request(endpoint("/admin/api-keys"), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      Accept: "application/json",
    },
  });
  const result = await doFetch(req);
  if (!result.ok) {
    console.error(`Request failed (${result.status}).`);
    console.error(result.body);
    process.exit(1);
  }
  console.log(JSON.stringify(result.json, null, 2));
  process.exit(0);
}

if (command === "revoke") {
  const id = (parsed.id as string | undefined) ?? "";
  if (!id.trim()) {
    console.error("Missing --id");
    process.exit(2);
  }
  const req = new Request(endpoint("/admin/api-keys/revoke"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ id }),
  });
  const result = await doFetch(req);
  if (!result.ok) {
    console.error(`Request failed (${result.status}).`);
    console.error(result.body);
    process.exit(1);
  }
  console.log(JSON.stringify(result.json, null, 2));
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
usage();
process.exit(2);

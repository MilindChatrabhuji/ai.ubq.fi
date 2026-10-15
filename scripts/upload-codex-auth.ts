import { readFile, realpath } from "node:fs/promises";
const parseArgs = (args: string[]): Record<string, string | boolean | undefined> => {
  const out: Record<string, string | boolean | undefined> = {};
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

const expandTilde = (path: string): string => {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) {
    const home = process.env.HOME;
    if (home) return `${home}${path.slice(1)}`;
  }
  return path;
};

const normalizeVersion = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const readCodexModelsCacheVersion = async (): Promise<string | null> => {
  const home = process.env.HOME;
  if (!home) return null;
  try {
    const text = await readFile(`${home}/.codex/models_cache.json`, "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return normalizeVersion(parsed.client_version);
  } catch {
    return null;
  }
};

const readCodexVersionFile = async (): Promise<string | null> => {
  const home = process.env.HOME;
  if (!home) return null;
  try {
    const text = await readFile(`${home}/.codex/version.json`, "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return normalizeVersion(parsed.latest_version ?? parsed.version ?? parsed.current_version);
  } catch {
    return null;
  }
};

const readCodexPackageVersion = async (codexPath: string): Promise<string | null> => {
  if (!codexPath) return null;
  let realPath: string;
  try {
    realPath = await realpath(codexPath);
  } catch {
    realPath = codexPath;
  }
  const normalized = realPath.replace(/\\/g, "/");
  const marker = "/node_modules/@openai/codex/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return null;
  const pkgPath = `${normalized.slice(0, index + marker.length)}package.json`;
  try {
    const text = await readFile(pkgPath, "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return normalizeVersion(parsed.version);
  } catch {
    return null;
  }
};

const resolveCodexClientVersion = async (paths: string[]): Promise<string | null> => {
  const cachedVersion = await readCodexModelsCacheVersion();
  if (cachedVersion) return cachedVersion;
  const versionFile = await readCodexVersionFile();
  if (versionFile) return versionFile;
  for (const candidate of paths) {
    const version = await readCodexPackageVersion(candidate);
    if (version) return version;
  }
  return null;
};

const listCodexBinaryCandidates = (codexBinFlag?: string): string[] => {
  const candidates: string[] = [];
  if (codexBinFlag) candidates.push(expandTilde(codexBinFlag));
  const pathValue = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  for (const segment of pathValue.split(separator).filter(Boolean)) {
    candidates.push(`${segment.replace(/\/$/, "")}/codex`);
  }
  return candidates;
};

const usage = () => {
  console.log(`upload-codex-auth.ts

Uploads your local Codex ~/.codex/auth.json to ai.ubq.fi for validation + storage in Bun KV.
Stores the live Codex model catalog returned by upstream auth validation.

Usage:
  bun run scripts/upload-codex-auth.ts [--url https://ai.ubq.fi] [--auth-json ~/.codex/auth.json] [--codex-bin /path/to/codex]

Auth:
  Set DENO_DEPLOY_TOKEN in env, or pass --admin-token.
`);
};

if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
  usage();
  process.exit(0);
}

const parsed = parseArgs(process.argv.slice(2));
const baseUrl = (parsed.url as string | undefined) ?? "https://ai.ubq.fi";
const authJsonPath = expandTilde((parsed["auth-json"] as string | undefined) ?? "~/.codex/auth.json");
const adminToken = (parsed["admin-token"] as string | undefined) ?? process.env.DENO_DEPLOY_TOKEN ?? "";
if (Object.hasOwn(parsed, "skip-models") || Object.hasOwn(parsed, "no-models")) {
  console.error("--skip-models is obsolete; upload-auth always stores the live upstream Codex model catalog.");
  process.exit(2);
}

if (!adminToken) {
  console.error("Missing admin token. Set DENO_DEPLOY_TOKEN or pass --admin-token.");
  process.exit(2);
}

let authJsonText: string;
try {
  authJsonText = await readFile(authJsonPath, "utf8");
} catch (error) {
  console.error(`Failed to read auth.json at ${authJsonPath}:`, error);
  process.exit(2);
}

let authJson: unknown;
try {
  authJson = JSON.parse(authJsonText) as unknown;
} catch (error) {
  console.error(`auth.json at ${authJsonPath} is not valid JSON:`, error);
  process.exit(2);
}
const codexBinFlag = parsed["codex-bin"] as string | undefined;
const clientVersion = (await resolveCodexClientVersion(listCodexBinaryCandidates(codexBinFlag))) ?? undefined;
const modelsPayload: Record<string, unknown> = {
  source: "chatgpt_codex",
  client_version: clientVersion,
  updated_at_ms: Date.now(),
};

const endpoint = new URL("/admin/codex/auth", baseUrl);
const requestPayload = { auth: authJson, models: modelsPayload };
const body = JSON.stringify(requestPayload);
const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body,
});

const contentType = res.headers.get("Content-Type") ?? "";
const isJson = contentType.includes("application/json");
const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");

if (!res.ok) {
  console.error(`Request failed (${res.status}).`);
  if (payload) console.error(isJson ? JSON.stringify(payload, null, 2) : payload);
  process.exit(1);
}

if (payload) {
  console.log(isJson ? JSON.stringify(payload, null, 2) : payload);
} else {
  console.log("OK");
}

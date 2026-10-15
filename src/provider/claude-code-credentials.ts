/**
 * Operator-managed Claude subscription credential and workspace state. The
 * Codex tier keeps an `auth.json` pool in KV with an admin upload surface; the
 * Claude subscription tier gets the same shape here: one credential (a Console
 * API key or a Claude Code OAuth token) plus the workspace selection an
 * organization-scoped key needs. Resolution is KV first and environment
 * second, so a deployment can bootstrap from the environment and rotate from
 * the admin console without a restart. Secrets never leave this module
 * unmasked except on the outbound inference request itself.
 */
import { isRecord } from "../utils.ts";
import type { ClaudeCodeEnvLookup } from "./claude-code.ts";

export const CLAUDE_CODE_AUTH_KV_KEY = ["ubq_ai", "claude_code_auth"] as const;
export const CLAUDE_CODE_WORKSPACE_KV_KEY = ["ubq_ai", "claude_code_workspace"] as const;
export const CLAUDE_API_KEY_ENV = "CLAUDE_API_KEY";
export const CLAUDE_CODE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const CLAUDE_CODE_WORKSPACE_ID_ENV = "CLAUDE_CODE_WORKSPACE_ID";
export const CLAUDE_CODE_CREDENTIAL_CACHE_TTL_MS = 60_000;
/** Console hints show a long prefix; 14 characters covers `sk-ant-usr-1A6`. */
export const CLAUDE_CODE_HINT_PREFIX_LENGTH = 14;
export const CLAUDE_CODE_HINT_SUFFIX_LENGTH = 4;
export const CLAUDE_CODE_CREDENTIAL_MAX_LENGTH = 512;
export const CLAUDE_CODE_WORKSPACE_ID_MAX_LENGTH = 256;

/**
 * `api_key` credentials travel as `x-api-key`; `oauth` credentials travel as
 * `Authorization: Bearer` plus the OAuth beta header, exactly like the
 * documented `claude setup-token` flow the tier shipped with. Everything else
 * that looks like a Console key (`sk-ant-api*`, `sk-ant-usr*`) is an API key.
 */
export type ClaudeCodeCredentialKind = "api_key" | "oauth";
export type ClaudeCodeCredentialSource = "kv" | typeof CLAUDE_API_KEY_ENV | typeof CLAUDE_CODE_OAUTH_TOKEN_ENV;

export const classifyClaudeCodeCredentialKind = (secret: string): ClaudeCodeCredentialKind => {
  const value = secret.trim();
  if (/^sk-ant-o(at|rt)/i.test(value)) return "oauth";
  return "api_key";
};

const trimmedOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

/** The Console-style partial hint (`sk-ant-usr-1A6...BwAA`) with the secret absent. */
export const partialClaudeCodeCredentialHint = (secret: string): string => {
  const value = secret.trim();
  if (value.length <= CLAUDE_CODE_HINT_PREFIX_LENGTH + CLAUDE_CODE_HINT_SUFFIX_LENGTH) return "configured";
  return `${value.slice(0, CLAUDE_CODE_HINT_PREFIX_LENGTH)}...${value.slice(-CLAUDE_CODE_HINT_SUFFIX_LENGTH)}`;
};

export type ClaudeCodeStoredCredential = Readonly<{
  kind: ClaudeCodeCredentialKind;
  secret: string;
  hint: string;
  label: string | null;
  updated_at_ms: number;
}>;

export type ClaudeCodeResolvedCredential = Readonly<{
  kind: ClaudeCodeCredentialKind;
  secret: string;
  hint: string;
  label: string | null;
  source: ClaudeCodeCredentialSource;
  updated_at_ms: number | null;
}>;

const finitePositive = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null);

const parseCredentialKind = (value: unknown): ClaudeCodeCredentialKind | null => (value === "api_key" || value === "oauth" ? value : null);

/** A stored credential must parse completely; a partial record is rejected. */
export const parseClaudeCodeStoredCredential = (value: unknown): ClaudeCodeStoredCredential | null => {
  if (!isRecord(value)) return null;
  const secret = trimmedOrNull(value.secret);
  const kind = parseCredentialKind(value.kind) ?? (secret ? classifyClaudeCodeCredentialKind(secret) : null);
  const updatedAtMs = finitePositive(value.updated_at_ms);
  if (!secret || !kind || updatedAtMs === null) return null;
  if (secret.length > CLAUDE_CODE_CREDENTIAL_MAX_LENGTH) return null;
  return {
    kind,
    secret,
    hint: trimmedOrNull(value.hint) ?? partialClaudeCodeCredentialHint(secret),
    label: trimmedOrNull(value.label),
    updated_at_ms: updatedAtMs,
  };
};

export type ClaudeCodeWorkspaceSource = "kv" | "env" | "discovered";

export type ClaudeCodeWorkspaceState = Readonly<{
  id: string;
  name: string | null;
  source: ClaudeCodeWorkspaceSource;
  discovered_at_ms: number | null;
  verified_at_ms: number | null;
  /** Last workspace-resolution failure text, sanitized for operator display. */
  last_error: string | null;
}>;

export type ClaudeCodeResolvedWorkspace = Readonly<{
  id: string;
  name: string | null;
  source: ClaudeCodeWorkspaceSource;
}>;

export const parseClaudeCodeWorkspaceState = (value: unknown): ClaudeCodeWorkspaceState | null => {
  if (!isRecord(value)) return null;
  const id = trimmedOrNull(value.id);
  if (!id || id.length > CLAUDE_CODE_WORKSPACE_ID_MAX_LENGTH) return null;
  const source = value.source === "kv" || value.source === "env" || value.source === "discovered" ? value.source : "kv";
  return {
    id,
    name: trimmedOrNull(value.name),
    source,
    discovered_at_ms: finitePositive(value.discovered_at_ms),
    verified_at_ms: finitePositive(value.verified_at_ms),
    last_error: trimmedOrNull(value.last_error),
  };
};

export const parseClaudeCodeWorkspaceId = (value: unknown): string | null => {
  const id = trimmedOrNull(value);
  if (!id || id.length > CLAUDE_CODE_WORKSPACE_ID_MAX_LENGTH) return null;
  if (!id.startsWith("wrkspc_")) return null;
  return id;
};

let cachedCredential: ClaudeCodeStoredCredential | null = null;
let cachedCredentialExpiresAtMs = 0;

export const resetClaudeCodeCredentialCacheForTest = (): void => {
  cachedCredential = null;
  cachedCredentialExpiresAtMs = 0;
};

const cacheStoredCredential = (credential: ClaudeCodeStoredCredential | null): void => {
  cachedCredential = credential;
  cachedCredentialExpiresAtMs = Date.now() + CLAUDE_CODE_CREDENTIAL_CACHE_TTL_MS;
};

export const loadClaudeCodeStoredCredential = async (kv: Deno.Kv | null): Promise<ClaudeCodeStoredCredential | null> => {
  if (!kv) return null;
  if (cachedCredentialExpiresAtMs > Date.now()) return cachedCredential;
  const entry = await kv.get(CLAUDE_CODE_AUTH_KV_KEY, { consistency: "strong" });
  const parsed = parseClaudeCodeStoredCredential(entry.value);
  cacheStoredCredential(parsed);
  return parsed;
};

export const storeClaudeCodeStoredCredential = async (
  kv: Deno.Kv | null,
  input: Readonly<{ secret: string; label?: string | null }>
): Promise<ClaudeCodeStoredCredential | null> => {
  if (!kv) return null;
  const secret = trimmedOrNull(input.secret);
  if (!secret || secret.length > CLAUDE_CODE_CREDENTIAL_MAX_LENGTH) return null;
  const stored: ClaudeCodeStoredCredential = {
    kind: classifyClaudeCodeCredentialKind(secret),
    secret,
    hint: partialClaudeCodeCredentialHint(secret),
    label: trimmedOrNull(input.label),
    updated_at_ms: Date.now(),
  };
  await kv.set(CLAUDE_CODE_AUTH_KV_KEY, stored);
  cacheStoredCredential(stored);
  return stored;
};

export const clearClaudeCodeStoredCredential = async (kv: Deno.Kv | null): Promise<boolean> => {
  if (!kv) return false;
  await kv.delete(CLAUDE_CODE_AUTH_KV_KEY);
  cacheStoredCredential(null);
  return true;
};

export const loadClaudeCodeWorkspaceState = async (kv: Deno.Kv | null): Promise<ClaudeCodeWorkspaceState | null> => {
  if (!kv) return null;
  const entry = await kv.get(CLAUDE_CODE_WORKSPACE_KV_KEY, { consistency: "strong" });
  return parseClaudeCodeWorkspaceState(entry.value);
};

export const storeClaudeCodeWorkspaceState = async (kv: Deno.Kv | null, state: ClaudeCodeWorkspaceState): Promise<boolean> => {
  if (!kv) return false;
  await kv.set(CLAUDE_CODE_WORKSPACE_KV_KEY, state);
  return true;
};

export const clearClaudeCodeWorkspaceState = async (kv: Deno.Kv | null): Promise<boolean> => {
  if (!kv) return false;
  await kv.delete(CLAUDE_CODE_WORKSPACE_KV_KEY);
  return true;
};

/**
 * Environment credentials carry their own source so the admin panel can say
 * where a working credential came from. `CLAUDE_API_KEY` wins over the legacy
 * OAuth token when both are set, because the API key is the Console-billed
 * direction and the OAuth token is the owner-gated legacy path.
 */
export const readClaudeCodeEnvCredential = (env?: ClaudeCodeEnvLookup): ClaudeCodeResolvedCredential | null => {
  const lookup =
    env ??
    ((name: string) => {
      try {
        return Deno.env.get(name);
      } catch {
        return null;
      }
    });
  const apiKey = trimmedOrNull(lookup(CLAUDE_API_KEY_ENV) ?? undefined);
  if (apiKey) {
    return {
      kind: classifyClaudeCodeCredentialKind(apiKey),
      secret: apiKey,
      hint: partialClaudeCodeCredentialHint(apiKey),
      label: null,
      source: CLAUDE_API_KEY_ENV,
      updated_at_ms: null,
    };
  }
  const oauthToken = trimmedOrNull(lookup(CLAUDE_CODE_OAUTH_TOKEN_ENV) ?? undefined);
  if (oauthToken) {
    return {
      kind: "oauth",
      secret: oauthToken,
      hint: partialClaudeCodeCredentialHint(oauthToken),
      label: null,
      source: CLAUDE_CODE_OAUTH_TOKEN_ENV,
      updated_at_ms: null,
    };
  }
  return null;
};

/** KV credential first, then `CLAUDE_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`. */
export const resolveClaudeCodeCredential = async (kv: Deno.Kv | null, env?: ClaudeCodeEnvLookup): Promise<ClaudeCodeResolvedCredential | null> => {
  const stored = await loadClaudeCodeStoredCredential(kv);
  if (stored) {
    return {
      kind: stored.kind,
      secret: stored.secret,
      hint: stored.hint,
      label: stored.label,
      source: "kv",
      updated_at_ms: stored.updated_at_ms,
    };
  }
  return readClaudeCodeEnvCredential(env);
};

export const readClaudeCodeWorkspaceIdEnv = (env?: ClaudeCodeEnvLookup): string | null => {
  const lookup =
    env ??
    ((name: string) => {
      try {
        return Deno.env.get(name);
      } catch {
        return null;
      }
    });
  return parseClaudeCodeWorkspaceId(lookup(CLAUDE_CODE_WORKSPACE_ID_ENV) ?? undefined);
};

/** KV workspace first, then the environment pin, then a discovered workspace. */
export const resolveClaudeCodeWorkspace = async (kv: Deno.Kv | null, env?: ClaudeCodeEnvLookup): Promise<ClaudeCodeResolvedWorkspace | null> => {
  const stored = await loadClaudeCodeWorkspaceState(kv);
  if (stored) return { id: stored.id, name: stored.name, source: stored.source };
  const fromEnv = readClaudeCodeWorkspaceIdEnv(env);
  if (fromEnv) return { id: fromEnv, name: null, source: "env" };
  return null;
};

/**
 * Fold discovery or validation results into stored workspace state. A pinned
 * KV or environment selection is never replaced by a discovery result; the
 * failure detail is retained only for operator display.
 */
export const mergeClaudeCodeWorkspaceState = (
  previous: ClaudeCodeWorkspaceState | null,
  input: Readonly<{ id: string; name?: string | null; source: ClaudeCodeWorkspaceSource; nowMs?: number; last_error?: string | null; verified?: boolean }>
): ClaudeCodeWorkspaceState => {
  const nowMs = input.nowMs ?? Date.now();
  const sameId = previous?.id === input.id;
  return {
    id: input.id,
    name: input.name ?? (sameId ? (previous?.name ?? null) : null),
    source: input.source,
    discovered_at_ms: input.source === "discovered" ? nowMs : sameId ? (previous?.discovered_at_ms ?? null) : null,
    verified_at_ms: input.verified ? nowMs : sameId ? (previous?.verified_at_ms ?? null) : null,
    last_error: input.last_error ?? null,
  };
};

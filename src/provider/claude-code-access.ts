import type { Kv } from "#kv";
import { isRecord } from "../utils.ts";
import { readClaudeCodeAllowedKeyIds, type ClaudeCodeEnvLookup } from "./claude-code.ts";

export const CLAUDE_CODE_ACCESS_KEY = ["uos_ai", "claude_code_access", "v1"] as const;
export type ClaudeCodeAccessPolicy = Readonly<{ v: 1; source: "env" | "kv"; allowed_key_ids: readonly string[]; updated_at_ms: number }>;

export const parseClaudeCodeAccessIds = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > 1000) return null;
  if (
    value.some(
      (id: unknown) =>
        typeof id !== "string" ||
        !id.trim() ||
        id.length > 256 ||
        /[\s,]/.test(id) ||
        Array.from(id).some((character) => (character.codePointAt(0) ?? 0) < 32 || character.codePointAt(0) === 127)
    )
  )
    return null;
  return [...new Set(value as string[])].sort((left, right) => left.localeCompare(right));
};
const parsePolicy = (value: unknown): ClaudeCodeAccessPolicy | null => {
  if (!isRecord(value) || value.v !== 1 || (value.source !== "env" && value.source !== "kv")) return null;
  const ids = parseClaudeCodeAccessIds(value.allowed_key_ids);
  if (!ids || typeof value.updated_at_ms !== "number" || !Number.isSafeInteger(value.updated_at_ms) || value.updated_at_ms <= 0) return null;
  return { v: 1, source: value.source, allowed_key_ids: ids, updated_at_ms: value.updated_at_ms };
};

/** Seed only the existing explicit environment list once. Credential imports never call the writer or grant access. */
export const loadClaudeCodeAccessPolicy = async (kv: Kv | null, env?: ClaudeCodeEnvLookup): Promise<ClaudeCodeAccessPolicy> => {
  if (!kv) throw new Error("Claude principal policy storage is unavailable");
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = await kv.get(CLAUDE_CODE_ACCESS_KEY, { consistency: "strong" });
    if (entry.value !== null) {
      const policy = parsePolicy(entry.value);
      if (!policy) throw new Error("Claude principal policy is invalid; refusing environment fallback");
      return policy;
    }
    const policy: ClaudeCodeAccessPolicy = {
      v: 1,
      source: "env",
      allowed_key_ids: [...readClaudeCodeAllowedKeyIds(env)].sort((left, right) => left.localeCompare(right)),
      updated_at_ms: Date.now(),
    };
    if ((await kv.atomic().check(entry).set(CLAUDE_CODE_ACCESS_KEY, policy).commit()).ok) return policy;
  }
  throw new Error("Claude principal policy changed repeatedly");
};

/** Only an intentional authenticated admin action creates an explicit stored policy. Empty is authoritative deny. */
export const storeClaudeCodeAccessPolicy = async (kv: Kv, allowedKeyIds: readonly string[]): Promise<ClaudeCodeAccessPolicy> => {
  const ids = parseClaudeCodeAccessIds(allowedKeyIds);
  if (!ids) throw new Error("Claude principal IDs are invalid");
  const policy: ClaudeCodeAccessPolicy = { v: 1, source: "kv", allowed_key_ids: ids, updated_at_ms: Date.now() };
  await kv.set(CLAUDE_CODE_ACCESS_KEY, policy);
  return policy;
};

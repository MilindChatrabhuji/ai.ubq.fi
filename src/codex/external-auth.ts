import type { CodexAuthState } from "../types.ts";
import { decodeBase64ToString, getString, isRecord } from "../utils.ts";

export type ExternalCodexIdentity = Readonly<{ userId: string; accountId: string }>;

/** Claims are identity preconditions; a passive upstream read separately proves authorization. */
export const externalCodexIdentity = (token: string): ExternalCodexIdentity | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const raw: unknown = JSON.parse(decodeBase64ToString(payload + "=".repeat((4 - (payload.length % 4)) % 4)));
    const claims = isRecord(raw) && isRecord(raw["https://api.openai.com/auth"]) ? raw["https://api.openai.com/auth"] : null;
    const userId = claims && getString(claims.chatgpt_user_id);
    const accountId = claims && getString(claims.chatgpt_account_id);
    return userId && accountId ? { userId, accountId } : null;
  } catch {
    return null;
  }
};

export type ExternalNativeCodexDocument = Readonly<{
  auth: Omit<CodexAuthState, "updated_at_ms" | "native_owner">;
  userId: string;
  refreshedAt: string | null;
}>;

/** Exact native 0.162.1 external AuthDotJson, only for a trusted local native file. */
export const parseExternalNativeCodexDocument = (raw: unknown): ExternalNativeCodexDocument | null => {
  if (!isRecord(raw) || raw.auth_mode !== "chatgptAuthTokens" || raw.OPENAI_API_KEY !== null || !isRecord(raw.tokens)) return null;
  const accessToken = getString(raw.tokens.access_token);
  const accountId = getString(raw.tokens.account_id);
  if (!accessToken || !accountId || raw.tokens.id_token !== accessToken || raw.tokens.refresh_token !== "") return null;
  const identity = externalCodexIdentity(accessToken);
  if (identity?.accountId !== accountId) return null;
  const refreshedAt = getString(raw.last_refresh);
  if (raw.last_refresh !== undefined && raw.last_refresh !== null && (!refreshedAt || !Number.isFinite(Date.parse(refreshedAt)))) return null;
  return { auth: { access_token: accessToken, refresh_token: "", account_id: accountId }, userId: identity.userId, refreshedAt };
};

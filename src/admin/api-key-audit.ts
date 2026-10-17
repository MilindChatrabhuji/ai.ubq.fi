import type { AtomicOperation, Kv, KvKey } from "#kv";
// Durable key-change audit: one compact event per actual API-key lifecycle
// state change, appended in the same KV atomic commit as the key state change,
// with a 90-day TTL and a bounded newest-first admin read surface that also
// excludes events past the retention window by their own timestamp.

import type { AdminAuthResult } from "../auth/index.ts";
import { runtimeGitSha } from "../config.ts";
import { json, openaiError } from "../http.ts";
import { getKv } from "../kv.ts";
import { isRecord } from "../utils.ts";

/** Newest-first event index; the second key part inverts the timestamp. */
export const API_KEY_CHANGE_PREFIX = ["uos_ai", "api_keys", "change"] as const;
export const API_KEY_CHANGE_RETENTION_DAYS = 90;
export const API_KEY_CHANGE_RETENTION_MS = API_KEY_CHANGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const API_KEY_CHANGE_DEFAULT_LIMIT = 20;
export const API_KEY_CHANGE_MAX_LIMIT = 50;

export type ApiKeyChangeAction = "create" | "update" | "revoke" | "unrevoke" | "delete";

export type ApiKeyChangeActor = Readonly<{
  kind: "passkey_user" | "shared_admin_credential" | "local_admin" | "unknown";
  /** Passkey user id when an identified person acted; null for shared credentials. */
  principal_id: string | null;
  /** Passkey handle when one is known; never a token or credential secret. */
  principal_label: string | null;
  is_super_admin: boolean;
}>;

export type ApiKeyChangeEvent = Readonly<{
  id: string;
  at_ms: number;
  action: ApiKeyChangeAction;
  actor: ApiKeyChangeActor;
  target_key_id: string;
  target_key_name: string | null;
  changed: Readonly<Record<string, string | number | boolean | null>>;
  request_id: string;
  release: string;
}>;

/** The router-owned identity passed to key mutation handlers. */
export type ApiKeyAuditContext = Readonly<{
  auth?: AdminAuthResult;
  request_id?: string;
}>;

/**
 * The only policy fields an audit event may carry. The allowlist is the
 * enforcement point for "never persist tokens, hashes, Authorization, prompts
 * or raw errors": a caller cannot smuggle any other field into the store.
 */
const SAFE_CHANGED_FIELDS = new Set([
  "name",
  "expires_at_ms",
  "usage_limit_requests",
  "window_ms",
  "paid_fallback_enabled",
  "paid_fallback_limit_credits",
  "reset_usage",
  "revoked_at_ms",
]);

type SanitizedChangedValue = Readonly<{ ok: true; value: string | number | boolean | null }> | Readonly<{ ok: false }>;

const sanitizeChangedValue = (value: unknown): SanitizedChangedValue => {
  if (value === null || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (typeof value === "string") return { ok: true, value: value.length > 200 ? value.slice(0, 200) : value };
  return { ok: false };
};

/** Keeps only allowlisted policy fields with scalar values. */
export const sanitizeApiKeyChangeFields = (value: Record<string, unknown>): Record<string, string | number | boolean | null> => {
  const changed: Record<string, string | number | boolean | null> = {};
  for (const field of SAFE_CHANGED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const sanitized = sanitizeChangedValue(value[field]);
    if (sanitized.ok) changed[field] = sanitized.value;
  }
  return changed;
};

/**
 * Maps the authenticated admin credential to an actor record. A shared admin
 * allowlist or deploy token is a shared operator credential, never an
 * identified human; only a passkey session carries a principal id.
 */
export const apiKeyChangeActorFromAuth = (auth?: AdminAuthResult): ApiKeyChangeActor => {
  if (!auth?.ok) {
    return { kind: "unknown", principal_id: null, principal_label: null, is_super_admin: false };
  }
  const isSuperAdmin = auth.is_super_admin;
  if (auth.method.kind === "passkey_session") {
    return {
      kind: "passkey_user",
      principal_id: auth.method.user_id,
      principal_label: auth.method.handle,
      is_super_admin: isSuperAdmin,
    };
  }
  if (auth.method.kind === "disabled") {
    return { kind: "local_admin", principal_id: null, principal_label: null, is_super_admin: isSuperAdmin };
  }
  return { kind: "shared_admin_credential", principal_id: null, principal_label: null, is_super_admin: isSuperAdmin };
};

export type ApiKeyChangeEventInput = Readonly<{
  action: ApiKeyChangeAction;
  targetKeyId: string;
  targetKeyName?: string | null;
  changed?: Record<string, unknown>;
  context?: ApiKeyAuditContext;
  nowMs?: number;
}>;

export const buildApiKeyChangeEvent = (input: ApiKeyChangeEventInput): ApiKeyChangeEvent => {
  const id = crypto.randomUUID();
  const requestId = input.context?.request_id?.trim() ?? "";
  return {
    id,
    at_ms: input.nowMs ?? Date.now(),
    action: input.action,
    actor: apiKeyChangeActorFromAuth(input.context?.auth),
    target_key_id: input.targetKeyId,
    target_key_name: input.targetKeyName ? input.targetKeyName.slice(0, 200) : null,
    changed: sanitizeApiKeyChangeFields(input.changed ?? {}),
    request_id: requestId === "" ? id : requestId,
    release: runtimeGitSha(),
  };
};

export const apiKeyChangeEventKey = (event: Pick<ApiKeyChangeEvent, "at_ms" | "id">): KvKey => [
  ...API_KEY_CHANGE_PREFIX,
  Number.MAX_SAFE_INTEGER - event.at_ms,
  event.id,
];

/** Appends the audit event to an existing `kv.atomic()` chain. */
export const appendApiKeyChangeEvent = (atomic: AtomicOperation, event: ApiKeyChangeEvent): AtomicOperation =>
  atomic.set(apiKeyChangeEventKey(event), event, { expireIn: API_KEY_CHANGE_RETENTION_MS });

export type ApiKeyChangePage = Readonly<{ events: ApiKeyChangeEvent[]; next_cursor: string | null }>;

export const listApiKeyChangeEvents = async (kv: Kv, input: Readonly<{ limit: number; cursor?: string }>): Promise<ApiKeyChangePage> => {
  const oldestRetainedAtMs = Date.now() - API_KEY_CHANGE_RETENTION_MS;
  const iterator = kv.list<ApiKeyChangeEvent>({ prefix: API_KEY_CHANGE_PREFIX }, { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) });
  const events: ApiKeyChangeEvent[] = [];
  let scanned = 0;
  for await (const entry of iterator) {
    scanned += 1;
    const value: unknown = entry.value;
    // TTL expiry is not an exact-time visibility guarantee, so the reader also
    // refuses any event whose own timestamp is past the 90-day window.
    if (isRecord(value)) {
      const event = value as ApiKeyChangeEvent;
      if (typeof event.at_ms === "number" && event.at_ms >= oldestRetainedAtMs) events.push(event);
    }
    if (scanned >= input.limit) break;
  }
  return { events, next_cursor: scanned < input.limit || !iterator.cursor ? null : iterator.cursor };
};

const parseApiKeyChangeLimit = (raw: string | null): number | null => {
  if (raw !== null && !/^\d+$/.test(raw.trim())) return null;
  const requested = raw === null ? API_KEY_CHANGE_DEFAULT_LIMIT : Number(raw);
  if (!Number.isSafeInteger(requested) || requested < 1) return null;
  return Math.min(requested, API_KEY_CHANGE_MAX_LIMIT);
};

export const handleAdminApiKeyChanges = async (req: Request, kvOverride?: Kv | null): Promise<Response> => {
  const kv = kvOverride === undefined ? await getKv() : kvOverride;
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot load key change history", "server_error");
  }

  const params = new URL(req.url).searchParams;
  const limit = parseApiKeyChangeLimit(params.get("limit"));
  if (limit === null) {
    return openaiError(400, "limit must be a positive integer", "invalid_request_error");
  }
  const rawCursor = params.get("cursor");
  const cursor = rawCursor?.trim();
  if (cursor !== undefined && (!cursor || cursor.length > 1024)) {
    return openaiError(400, "cursor is invalid", "invalid_request_error");
  }

  try {
    const page = await listApiKeyChangeEvents(kv, { limit, ...(cursor ? { cursor } : {}) });
    return json(
      200,
      {
        object: "list",
        retention_days: API_KEY_CHANGE_RETENTION_DAYS,
        data: page.events,
        next_cursor: page.next_cursor,
      },
      { "Cache-Control": "no-store" }
    );
  } catch (error) {
    if (error instanceof TypeError) {
      return openaiError(400, "cursor is invalid", "invalid_request_error");
    }
    console.error("[ai.ubq.fi] Failed to load API key change history:", error);
    return openaiError(500, "Failed to load key change history", "server_error");
  }
};

import type { AtomicOperation, Kv, KvKey } from "#kv";
// Durable key-change audit: one compact event per actual API-key lifecycle
// state change, appended in the same KV atomic commit as the key state change,
// with a 90-day TTL and a bounded newest-first admin read surface that also
// excludes events past the retention window by their own timestamp.

import { runtimeGitSha } from "../config.ts";
import { json, openaiError } from "../http.ts";
import { getKv } from "../kv.ts";

import * as audit from "../authority/native-api-key-audit.ts";
import { API_KEY_CHANGE_PREFIX, API_KEY_CHANGE_RETENTION_DAYS, API_KEY_CHANGE_RETENTION_MS } from "../authority/native-api-key-audit.ts";
import type { ApiKeyChangeEvent, ApiKeyChangeEventInput } from "../authority/native-api-key-audit.ts";

export { API_KEY_CHANGE_PREFIX, API_KEY_CHANGE_RETENTION_DAYS, API_KEY_CHANGE_RETENTION_MS } from "../authority/native-api-key-audit.ts";
export type { ApiKeyChangeEvent, ApiKeyAuditContext, ApiKeyChangeEventInput } from "../authority/native-api-key-audit.ts";

export const buildApiKeyChangeEvent = (input: ApiKeyChangeEventInput): ApiKeyChangeEvent =>
  audit.buildApiKeyChangeEvent(input, {
    randomUUID: () => crypto.randomUUID(),
    now: () => Date.now(),
    release: () => runtimeGitSha(),
  });

export const apiKeyChangeEventKey = (event: Pick<ApiKeyChangeEvent, "at_ms" | "id">): KvKey => audit.apiKeyChangeEventKey(event);

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
    if (audit.isRetainedApiKeyChangeEvent(value, oldestRetainedAtMs)) events.push(value);
    if (scanned >= input.limit) break;
  }
  return { events, next_cursor: scanned < input.limit || !iterator.cursor ? null : iterator.cursor };
};

export const handleAdminApiKeyChanges = async (req: Request, kvOverride?: Kv | null): Promise<Response> => {
  const kv = kvOverride === undefined ? await getKv() : kvOverride;
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot load key change history", "server_error");
  }

  const params = new URL(req.url).searchParams;
  const limit = audit.parseApiKeyChangeLimit(params.get("limit"));
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

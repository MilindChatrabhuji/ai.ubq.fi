import type { KvEntry, KvKey, KvListOptions, KvListSelector } from "#kv";
import { authenticateClient } from "./auth/index.ts";
import { json, openaiError } from "./http.ts";
import { getKv } from "./kv.ts";
import { readJsonBody } from "./request.ts";
import { getString, isRecord } from "./utils.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_AGENT_ID_LENGTH = 120;
const MAX_CHANNEL_LENGTH = 120;
const MAX_KIND_LENGTH = 120;
const MAX_BODY_LENGTH = 8000;
const MAX_METADATA_LENGTH = 8000;

type AgentMessageRecord = Readonly<{
  id: string;
  owner: string;
  repo: string;
  state_id: string;
  agent_id: string;
  channel: string | null;
  kind: string | null;
  body: string;
  metadata: Record<string, unknown> | null;
  created_at_ms: number;
}>;

type AgentMessagesKvListIterator<T> = AsyncIterableIterator<KvEntry<T>> & { readonly cursor: string };

type AgentMessagesKv = Readonly<{
  set: (key: KvKey, value: unknown, options?: { expireIn?: number }) => Promise<unknown>;
  list: <T>(selector: KvListSelector, options?: KvListOptions) => AgentMessagesKvListIterator<T>;
}>;

type AgentMessagesDeps = Readonly<{
  authenticateClient?: typeof authenticateClient;
  kv?: AgentMessagesKv | null;
  now?: () => number;
  uuid?: () => string;
}>;

const normalizeAgentId = (value: unknown): string | null => {
  const raw = getString(value);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_AGENT_ID_LENGTH) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
};

const normalizeOptionalTag = (value: unknown, maxLength: number): string | null => {
  if (value === undefined || value === null) return null;
  const raw = getString(value);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
};

const normalizeBody = (value: unknown): string | null => {
  const raw = getString(value);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (raw.length > MAX_BODY_LENGTH) return null;
  return raw;
};

const normalizeMetadata = (value: unknown): { ok: true; value: Record<string, unknown> | null } | { ok: false } => {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false };
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length > MAX_METADATA_LENGTH) return { ok: false };
  } catch {
    return { ok: false };
  }
  return { ok: true, value };
};

const parsePositiveInt = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= 0) return null;
  return Math.trunc(parsed);
};

type AgentMessagesListQuery = Readonly<{
  since: number | null;
  limit: number;
  scanLimit: number;
  cursor: string;
  channel: string | null;
  agentId: string | null;
}>;

/** Parses the bounded list parameters; the scan over-fetches only when a filter can discard entries. */
const agentMessagesListQuery = (url: URL): AgentMessagesListQuery => {
  const limit = Math.min(Math.max(parsePositiveInt(url.searchParams.get("limit")) ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const channel = normalizeOptionalTag(url.searchParams.get("channel"), MAX_CHANNEL_LENGTH);
  const agentId = normalizeOptionalTag(url.searchParams.get("agent_id"), MAX_AGENT_ID_LENGTH);
  return {
    since: parsePositiveInt(url.searchParams.get("since")),
    limit,
    scanLimit: channel || agentId ? Math.min(limit * 2, MAX_LIMIT) : limit,
    cursor: getString(url.searchParams.get("cursor"))?.trim() ?? "",
    channel,
    agentId,
  };
};

/** Whether one stored message satisfies every list filter. */
const messageMatchesListQuery = (message: AgentMessageRecord, query: AgentMessagesListQuery): boolean => {
  if (query.since !== null && message.created_at_ms < query.since) return false;
  if (query.agentId && message.agent_id !== query.agentId) return false;
  if (query.channel && message.channel !== query.channel) return false;
  return true;
};

export const handleAgentMessagesPost = async (req: Request, deps: AgentMessagesDeps = {}): Promise<Response> => {
  const authResult = await (deps.authenticateClient ?? authenticateClient)(req);
  if (!authResult.ok) return authResult.response;
  if (authResult.method.kind !== "github_token") {
    return openaiError(403, "GitHub token auth required", "forbidden");
  }

  const kv = deps.kv !== undefined ? deps.kv : await getKv();
  if (!kv) return openaiError(503, "Deno KV unavailable", "server_error");

  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");

  const agentId = normalizeAgentId(raw.agent_id);
  if (!agentId) return openaiError(400, "agent_id must be a non-empty string (<=120 chars)", "invalid_request_error");

  const body = normalizeBody(raw.body);
  if (!body) return openaiError(400, "body must be a non-empty string (<=8000 chars)", "invalid_request_error");

  const channel = normalizeOptionalTag(raw.channel, MAX_CHANNEL_LENGTH);
  if (raw.channel !== undefined && raw.channel !== null && !channel) {
    return openaiError(400, "channel must be a string (<=120 chars)", "invalid_request_error");
  }

  const kind = normalizeOptionalTag(raw.kind, MAX_KIND_LENGTH);
  if (raw.kind !== undefined && raw.kind !== null && !kind) {
    return openaiError(400, "kind must be a string (<=120 chars)", "invalid_request_error");
  }

  const metadataResult = normalizeMetadata(raw.metadata);
  if (!metadataResult.ok) {
    return openaiError(400, "metadata must be a JSON object (<=8000 chars)", "invalid_request_error");
  }

  const createdAtMs = (deps.now ?? Date.now)();
  const id = (deps.uuid ?? (() => crypto.randomUUID()))();
  const record: AgentMessageRecord = {
    id,
    owner: authResult.method.owner,
    repo: authResult.method.repo,
    state_id: authResult.method.state_id,
    agent_id: agentId,
    channel,
    kind,
    body,
    metadata: metadataResult.value,
    created_at_ms: createdAtMs,
  };

  const key = ["agent_messages", record.owner, record.repo, record.state_id, createdAtMs, id] as const;
  await kv.set(key, record);

  return json(200, { message: record }, { "Cache-Control": "no-store" });
};

export const handleAgentMessagesList = async (req: Request, deps: AgentMessagesDeps = {}): Promise<Response> => {
  const authResult = await (deps.authenticateClient ?? authenticateClient)(req);
  if (!authResult.ok) return authResult.response;
  if (authResult.method.kind !== "github_token") {
    return openaiError(403, "GitHub token auth required", "forbidden");
  }

  const kv = deps.kv !== undefined ? deps.kv : await getKv();
  if (!kv) return openaiError(503, "Deno KV unavailable", "server_error");

  const url = new URL(req.url);
  const query = agentMessagesListQuery(url);

  const prefix = ["agent_messages", authResult.method.owner, authResult.method.repo, authResult.method.state_id];

  const options: KvListOptions = { limit: query.scanLimit };
  if (query.cursor) {
    options.cursor = query.cursor;
  }

  const iterator = kv.list<AgentMessageRecord>({ prefix }, options);
  const messages: AgentMessageRecord[] = [];

  for await (const entry of iterator) {
    if (!messageMatchesListQuery(entry.value, query)) continue;
    messages.push(entry.value);
    if (messages.length >= query.limit) break;
  }

  const nextSince = messages.at(-1)?.created_at_ms ?? null;
  const nextCursor = iterator.cursor && iterator.cursor.length > 0 ? iterator.cursor : null;

  return json(
    200,
    {
      messages,
      next_since: nextSince,
      next_cursor: nextCursor,
      has_more: Boolean(nextCursor),
    },
    { "Cache-Control": "no-store" }
  );
};

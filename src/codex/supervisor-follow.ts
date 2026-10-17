// Supervisor follow polling, split out of src/codex_supervisor.ts.

import { newestTurnOf } from "./supervisor-inventory.ts";
import { openSupervisorConnection } from "./supervisor-transport.ts";
import {
  FOLLOW_MAX_COMMAND_CHARS,
  FOLLOW_MAX_ENTRIES,
  FOLLOW_MAX_TEXT_CHARS,
  asFiniteNumber,
  asString,
  boundedText,
  isRecord,
  isUnknownArray,
  textOrNull,
} from "./supervisor-config.ts";
import type { JsonRecord, SupervisorSource } from "./supervisor-config.ts";

type SupervisorFollowEntry = {
  key: string;
  kind: "message" | "command";
  turnId: string;
  index: number;
  text: string;
  command: string | null;
  status: string | null;
  exitCode: number | null;
  atMs: number | null;
};

/**
 * Extracts only what a super admin may see: assistant messages and command
 * output. Reasoning, system, developer, user, and tool-internal items are never
 * converted into panel entries.
 */
export const extractFollowEntries = (turnId: string, items: unknown): SupervisorFollowEntry[] => {
  if (!isUnknownArray(items)) return [];
  const entries: SupervisorFollowEntry[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isRecord(item)) continue;
    const type = asString(item.type);
    const id = textOrNull(item.id) ?? String(index);
    if (type === "agentMessage") {
      entries.push({
        key: `${turnId}:${id}`,
        kind: "message",
        turnId,
        index,
        text: asString(item.text) ?? "",
        command: null,
        status: textOrNull(item.phase),
        exitCode: null,
        atMs: null,
      });
      continue;
    }
    if (type === "commandExecution") {
      entries.push({
        key: `${turnId}:${id}`,
        kind: "command",
        turnId,
        index,
        text: asString(item.aggregatedOutput) ?? "",
        command: asString(item.command) ?? "",
        status: textOrNull(item.status),
        exitCode: asFiniteNumber(item.exitCode),
        atMs: null,
      });
    }
  }
  return entries;
};

export const parseFollowCursor = (cursor: string): { turnId: string; index: number } | null => {
  const separator = cursor.lastIndexOf(":");
  if (separator <= 0) return null;
  const index = Number(cursor.slice(separator + 1));
  if (!Number.isSafeInteger(index) || index < -1) return null;
  return { turnId: cursor.slice(0, separator), index };
};

/**
 * Content revision for one follow entry. Command output, status and exit code
 * mutate in place at a stable item index, so the index alone cannot tell the
 * client that an already-rendered entry changed.
 */
export const followEntryRevision = (entry: SupervisorFollowEntry): string => {
  const text = entry.text;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}:${entry.status ?? ""}:${entry.exitCode ?? ""}`;
};

/**
 * Chooses the entries one poll must emit: new indices plus any entry whose
 * content revision changed since the previous poll, including entries at or
 * below the cursor. `revisions` is per SSE connection, so unchanged polls emit
 * nothing and later output or completion reaches the already-rendered item.
 * Only entries that survive the emission filter and cap are committed, so a
 * dropped revision remains eligible for a later poll.
 */
export const selectFollowUpdates = (entries: readonly SupervisorFollowEntry[], startIndex: number, revisions: Map<string, string>): SupervisorFollowEntry[] => {
  const updates: SupervisorFollowEntry[] = [];
  for (const entry of entries) {
    const revision = followEntryRevision(entry);
    if (entry.index > startIndex || revisions.get(entry.key) !== revision) updates.push(entry);
  }
  const emitted = updates.filter((entry) => entry.kind === "command" || entry.text.length > 0).slice(-FOLLOW_MAX_ENTRIES);
  for (const entry of emitted) revisions.set(entry.key, followEntryRevision(entry));
  return emitted;
};

const followEntryPayload = (entry: SupervisorFollowEntry): JsonRecord => ({
  key: entry.key,
  kind: entry.kind,
  turnId: entry.turnId,
  text: boundedText(entry.text, FOLLOW_MAX_TEXT_CHARS),
  command: entry.command === null ? null : boundedText(entry.command, FOLLOW_MAX_COMMAND_CHARS),
  status: entry.status,
  exitCode: entry.exitCode,
  atMs: entry.atMs,
  revision: followEntryRevision(entry),
});

type FollowUpdate = { entries: SupervisorFollowEntry[]; cursor: string; turnId: string | null; turnStatus: string | null; enriched: boolean };

const readFollowUpdate = async (
  source: SupervisorSource,
  threadId: string,
  cursor: string,
  signal: AbortSignal,
  revisions: Map<string, string>
): Promise<FollowUpdate> => {
  const connection = await openSupervisorConnection(source.socketPath, signal);
  try {
    const summary = await connection.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "summary" }, signal);
    const turn = newestTurnOf(summary);
    if (!turn?.id) return { entries: [], cursor, turnId: null, turnStatus: null, enriched: false };
    const previous = parseFollowCursor(cursor);
    const startIndex = previous?.turnId === turn.id ? previous.index : -1;
    let items = turn.items;
    let enriched = false;
    let entries = extractFollowEntries(turn.id, items);
    let selectableEntries = entries;
    let lastIndex = entries.length > 0 ? entries[entries.length - 1].index : startIndex;
    const missingContent = entries.some((entry) => entry.text.length === 0);
    if (missingContent) {
      try {
        const full = await connection.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "full" }, signal);
        const fullTurn = newestTurnOf(full);
        if (fullTurn?.id === turn.id) {
          items = fullTurn.items;
          enriched = true;
          entries = extractFollowEntries(turn.id, items);
          selectableEntries = entries;
          lastIndex = entries.length > 0 ? entries[entries.length - 1].index : startIndex;
        } else {
          // A summary item with no text is not a new revision when its full
          // view was unavailable; leave any previously rendered output alone.
          selectableEntries = entries.filter((entry) => entry.text.length > 0);
        }
      } catch {
        // Do not emit empty summary entries: they would replace known output
        // in the follow panel with its "no recorded output" placeholder.
        selectableEntries = entries.filter((entry) => entry.text.length > 0);
      }
    }
    const emitted = selectFollowUpdates(selectableEntries, startIndex, revisions);
    return { entries: emitted, cursor: `${turn.id}:${lastIndex}`, turnId: turn.id, turnStatus: turn.status, enriched };
  } finally {
    await connection.close();
  }
};

/* ------------------------------------------------------------------ routes */

export { followEntryPayload, readFollowUpdate };

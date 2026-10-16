/**
 * Bounded, read-only tail reader for a local Codex rollout file.
 *
 * The app-server's projected turn history can lag an active session, while the
 * rollout JSONL it is derived from keeps growing. This module reads only the
 * last 256 KiB of one already-selected session's rollout, validates the path
 * against the configured Codex home, and normalizes only visible user/assistant
 * messages and safe tool progress. Reasoning, system, and developer payloads
 * are never returned, and no Codex file, database, or session is written.
 */

import { open, realpath } from "node:fs/promises";

const MAX_TAIL_BYTES = 256 * 1024;
const MAX_EVENTS = 200;

export type SupervisorLogEvent = {
  atMs: number;
  kind: "user" | "assistant" | "tool";
  text: string;
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const textOrNull = (value: unknown): string | null => {
  const text = asString(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Legacy assistant messages have no channel/phase; only visible phases are
 * accepted. `final_answer` is the app-server phase the follow panel renders as
 * "Assistant · final", so the brief must treat it as visible too.
 */
const VISIBLE_MESSAGE_PHASES: ReadonlySet<string> = new Set(["commentary", "final", "final_answer"]);

/** Rejects private analysis/reasoning channels and phases; absent values are legacy visible. */
const isVisibleMessage = (payload: JsonRecord): boolean => {
  for (const key of ["channel", "phase"]) {
    const value = textOrNull(payload[key])?.toLowerCase() ?? null;
    if (value === null) continue;
    if (!VISIBLE_MESSAGE_PHASES.has(value)) return false;
  }
  return true;
};

/**
 * Accepts only a rollout path inside the configured Codex home's session trees
 * whose file name carries the selected thread id. Paths never come from HTTP
 * input; this is the lexical check, and the reader re-checks after realpath.
 */
export const resolveSupervisorRolloutPath = (codexHome: string, threadId: string, rolloutPath: unknown): string | null => {
  const path = textOrNull(rolloutPath);
  if (!path?.startsWith("/") || path.includes("..")) return null;
  let home = codexHome;
  while (home.endsWith("/")) home = home.slice(0, -1);
  const inSessions = path.startsWith(`${home}/sessions/`);
  const inArchived = path.startsWith(`${home}/archived_sessions/`);
  if (!inSessions && !inArchived) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.includes(threadId) ? path : null;
};

const messageText = (payload: JsonRecord): string => {
  const content = payload.content;
  if (!isUnknownArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = asString(part.type);
    if (type !== "output_text" && type !== "input_text" && type !== "text") continue;
    const text = asString(part.text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
};

const messageEventOf = (payload: JsonRecord, atMs: number): SupervisorLogEvent | null => {
  if (!isVisibleMessage(payload)) return null;
  const role = asString(payload.role);
  if (role !== "user" && role !== "assistant") return null;
  const text = messageText(payload);
  return text ? { atMs, kind: role, text } : null;
};

const eventOf = (record: JsonRecord): SupervisorLogEvent | null => {
  if (record.type !== "response_item") return null;
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return null;
  const atMs = Date.parse(asString(record.timestamp) ?? "");
  if (!Number.isFinite(atMs)) return null;
  const payloadType = asString(payload.type);
  if (payloadType === "message") return messageEventOf(payload, atMs);
  if (payloadType === "custom_tool_call" || payloadType === "function_call") {
    const name = textOrNull(payload.name) ?? payloadType;
    const status = textOrNull(payload.status) ?? "recorded";
    return { atMs, kind: "tool", text: `tool: ${name} ${status}` };
  }
  if (payloadType === "custom_tool_call_output" || payloadType === "function_call_output") {
    const output = textOrNull(payload.output);
    return output ? { atMs, kind: "tool", text: `tool output: ${output}` } : null;
  }
  return null;
};

const parseLine = (line: string): SupervisorLogEvent | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isRecord(parsed) ? eventOf(parsed) : null;
};

/**
 * Parses rollout JSONL text, keeping visible messages and safe tool progress
 * only. Raw text is never clipped here: the caller redacts first and applies
 * the final field caps, and the newest 200 events are the ones that survive.
 */
export const parseSupervisorRolloutTail = (text: string): SupervisorLogEvent[] => {
  const events: SupervisorLogEvent[] = [];
  for (const line of text.split("\n")) {
    const event = parseLine(line);
    if (!event) continue;
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
  }
  return events;
};

/**
 * Reads at most the last 256 KiB of the selected session's rollout and returns
 * its normalized events. A partial leading JSONL record is discarded. Any
 * validation, permission, or read failure returns an empty list so the brief
 * degrades to the projected history instead of failing.
 */
export const readSupervisorRolloutTail = async (input: { codexHome: string | null; threadId: string; rolloutPath: unknown }): Promise<SupervisorLogEvent[]> => {
  if (!input.codexHome) return [];
  const lexical = resolveSupervisorRolloutPath(input.codexHome, input.threadId, input.rolloutPath);
  if (!lexical) return [];
  try {
    const resolved = await realpath(lexical);
    if (!resolveSupervisorRolloutPath(input.codexHome, input.threadId, resolved)) return [];
    const file = await open(resolved, "r");
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, size - MAX_TAIL_BYTES);
      const buffer = new Uint8Array(size - start);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await file.read(buffer, read, buffer.length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const text = new TextDecoder().decode(buffer.subarray(0, read));
      const newline = text.indexOf("\n");
      const complete = start > 0 && newline >= 0 ? text.slice(newline + 1) : text;
      return parseSupervisorRolloutTail(complete);
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
};

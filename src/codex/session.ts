import type { KvKey } from "#kv";
import { getKv } from "../kv.ts";
import { getString, isRecord, sha256Hex } from "../utils.ts";

/**
 * Session activity is an observation only. It must not be used as evidence
 * that a person is asleep, and it must not change request priority by itself.
 */
export const CODEX_SESSION_CONTINUATION_THRESHOLD_MS = 60 * 60 * 1000;
export const CODEX_SESSION_ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000;
export const CODEX_SESSION_ACTIVITY_PREFIX = ["uos_ai", "codex_session_activity"] as const;

type CodexSessionRecord = Readonly<{
  v: 1;
  session_id_hash: string;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
}>;

type CodexKeyActivityRecord = Readonly<{
  v: 1;
  last_request_at_ms: number;
  last_new_session_at_ms: number;
}>;

export type CodexSessionObservationState = "unknown" | "new" | "continuation";

export type CodexSessionObservation = Readonly<{
  metadata_present: boolean;
  session_id_present: boolean;
  session_id_hash: string | null;
  state: CodexSessionObservationState;
  continuation_age_ms: number | null;
  continuation_only_candidate: boolean;
}>;

const unknownObservation = (metadataPresent: boolean, sessionIdHash: string | null = null, sessionIdPresent = false): CodexSessionObservation => ({
  metadata_present: metadataPresent,
  session_id_present: sessionIdPresent,
  session_id_hash: sessionIdHash,
  state: "unknown",
  continuation_age_ms: null,
  continuation_only_candidate: false,
});

const keyActivityKey = (keyIdHash: string): KvKey => [...CODEX_SESSION_ACTIVITY_PREFIX, "key", keyIdHash];
const sessionActivityKey = (keyIdHash: string, sessionIdHash: string): KvKey => [...CODEX_SESSION_ACTIVITY_PREFIX, "session", keyIdHash, sessionIdHash];

const normalizeSessionRecord = (value: unknown): CodexSessionRecord | null => {
  if (!isRecord(value) || value.v !== 1) return null;
  const sessionIdHash = getString(value.session_id_hash)?.trim();
  const firstSeen = value.first_seen_at_ms;
  const lastSeen = value.last_seen_at_ms;
  if (
    !sessionIdHash ||
    typeof firstSeen !== "number" ||
    !Number.isSafeInteger(firstSeen) ||
    firstSeen < 0 ||
    typeof lastSeen !== "number" ||
    !Number.isSafeInteger(lastSeen) ||
    lastSeen < 0
  )
    return null;
  return {
    v: 1,
    session_id_hash: sessionIdHash,
    first_seen_at_ms: firstSeen,
    last_seen_at_ms: lastSeen,
  };
};

const normalizeKeyActivityRecord = (value: unknown): CodexKeyActivityRecord | null => {
  if (!isRecord(value) || value.v !== 1) return null;
  const lastRequest = value.last_request_at_ms;
  const lastNewSession = value.last_new_session_at_ms;
  if (
    typeof lastRequest !== "number" ||
    !Number.isSafeInteger(lastRequest) ||
    lastRequest < 0 ||
    typeof lastNewSession !== "number" ||
    !Number.isSafeInteger(lastNewSession) ||
    lastNewSession < 0
  )
    return null;
  return { v: 1, last_request_at_ms: lastRequest, last_new_session_at_ms: lastNewSession };
};

const sessionIdFromMetadata = (metadata: unknown): string | null => {
  if (!isRecord(metadata) || Array.isArray(metadata)) return null;
  const sessionId = getString(metadata.session_id)?.trim();
  // An empty or whitespace-only id is absent, not a session named "".
  if (!sessionId) return null;
  return sessionId;
};

const classifyWithState = (
  metadataPresent: boolean,
  sessionIdHash: string,
  sessionRecord: CodexSessionRecord | null,
  keyActivity: CodexKeyActivityRecord | null,
  nowMs: number
): CodexSessionObservation => {
  if (!sessionRecord || !keyActivity) {
    return {
      metadata_present: metadataPresent,
      session_id_present: true,
      session_id_hash: sessionIdHash,
      state: "unknown",
      continuation_age_ms: null,
      continuation_only_candidate: false,
    };
  }
  const continuationAgeMs = Math.max(0, nowMs - keyActivity.last_new_session_at_ms);
  return {
    metadata_present: metadataPresent,
    session_id_present: true,
    session_id_hash: sessionIdHash,
    state: "continuation",
    continuation_age_ms: continuationAgeMs,
    continuation_only_candidate: continuationAgeMs >= CODEX_SESSION_CONTINUATION_THRESHOLD_MS,
  };
};

const newSessionObservation = (metadataPresent: boolean, sessionIdHash: string): CodexSessionObservation => ({
  metadata_present: metadataPresent,
  session_id_present: true,
  session_id_hash: sessionIdHash,
  state: "new",
  continuation_age_ms: null,
  continuation_only_candidate: false,
});

type CodexSessionClassification = Readonly<{
  metadataPresent: boolean;
  sessionIdHash: string;
  malformedState: boolean;
  isNewSession: boolean;
  existingSession: CodexSessionRecord | null;
  existingKeyActivity: CodexKeyActivityRecord | null;
  lastNewSessionAtMs: number | null;
  nowMs: number;
}>;

/**
 * Precedence is unchanged from the inline classification: malformed prior state
 * fails closed to `unknown`, a first observation is `new`, recorded key activity
 * is a continuation, and anything else is unknown.
 */
const classifyObservation = (classification: CodexSessionClassification): CodexSessionObservation => {
  const { metadataPresent, sessionIdHash, malformedState, isNewSession, existingSession, existingKeyActivity, lastNewSessionAtMs, nowMs } = classification;
  if (malformedState) return unknownObservation(metadataPresent, sessionIdHash, true);
  if (isNewSession) return newSessionObservation(metadataPresent, sessionIdHash);
  if (existingKeyActivity && lastNewSessionAtMs !== null) return classifyWithState(metadataPresent, sessionIdHash, existingSession, existingKeyActivity, nowMs);
  return unknownObservation(metadataPresent);
};

/**
 * Observe one Responses request. Missing API-key identity, missing session
 * metadata, unavailable KV, and malformed prior state all fail closed to
 * `unknown`; the request itself is never rejected for telemetry reasons.
 */
export const observeCodexSession = async (keyId: string | null | undefined, clientMetadata: unknown, nowMs = Date.now()): Promise<CodexSessionObservation> => {
  const metadataPresent = clientMetadata !== undefined;
  const sessionId = sessionIdFromMetadata(clientMetadata);
  if (!sessionId) return unknownObservation(metadataPresent);

  try {
    const sessionIdHash = await sha256Hex(`uos-codex-session-v1\u0000${sessionId}`);
    if (!keyId?.trim()) return unknownObservation(metadataPresent, sessionIdHash, true);
    const kv = await getKv();
    if (!kv) return unknownObservation(metadataPresent, sessionIdHash, true);

    const keyIdHash = await sha256Hex(`uos-codex-api-key-v1\u0000${keyId}`);
    const key = keyActivityKey(keyIdHash);
    const sessionKey = sessionActivityKey(keyIdHash, sessionIdHash);
    const [keyEntry, sessionEntry] = await kv.getMany<[CodexKeyActivityRecord, CodexSessionRecord]>([key, sessionKey], { consistency: "strong" });
    const existingKeyActivity = normalizeKeyActivityRecord(keyEntry.value);
    const existingSession = normalizeSessionRecord(sessionEntry.value);
    const malformedState = (keyEntry.value !== null && existingKeyActivity === null) || (sessionEntry.value !== null && existingSession === null);
    const isNewSession = !malformedState && existingSession === null;
    const lastNewSessionAtMs = isNewSession ? nowMs : (existingKeyActivity?.last_new_session_at_ms ?? null);
    const observation = classifyObservation({
      metadataPresent,
      sessionIdHash,
      malformedState,
      isNewSession,
      existingSession,
      existingKeyActivity,
      lastNewSessionAtMs,
      nowMs,
    });

    const nextSession: CodexSessionRecord = {
      v: 1,
      session_id_hash: sessionIdHash,
      first_seen_at_ms: existingSession?.first_seen_at_ms ?? nowMs,
      last_seen_at_ms: nowMs,
    };
    const nextKeyActivity: CodexKeyActivityRecord = {
      v: 1,
      last_request_at_ms: nowMs,
      last_new_session_at_ms: isNewSession || malformedState ? nowMs : (existingKeyActivity?.last_new_session_at_ms ?? nowMs),
    };
    const expireIn = CODEX_SESSION_ACTIVITY_TTL_MS;
    const committed = await kv
      .atomic()
      .check(keyEntry)
      .check(sessionEntry)
      .set(key, nextKeyActivity, { expireIn })
      .set(sessionKey, nextSession, { expireIn })
      .commit();
    if (!committed.ok) {
      // A concurrent request can win the first observation. Returning unknown
      // avoids treating an uncommitted observation as routing evidence.
      return unknownObservation(metadataPresent, sessionIdHash, true);
    }
    return observation;
  } catch {
    // Session telemetry is best effort and must never reject an inference.
    return unknownObservation(metadataPresent);
  }
};

import type { KvKey } from "#kv";
// Upstream addresses, header construction, and the call-id to account mapping
// for the `/v1/live` realtime voice relay.
//
// Call creation belongs to the ChatGPT backend (`${config.codexBaseUrl}/realtime/calls`
// with the JSON `{sdp, session}` body, probed 2026-09-30), while the sideband
// lives on the OpenAI API host (`wss://api.openai.com/v1/live/<call_id>`). The
// two therefore cannot share one base URL.

import { config } from "../config.ts";
import { CODEX_ORIGINATOR, codexUserAgent } from "../codex/auth.ts";
import { getKv } from "../kv.ts";
import { getString, isRecord } from "../utils.ts";

/** The client's SDP offer is small; one mebibyte is a generous ceiling for it. */
export const LIVE_CALL_MAX_BODY_BYTES = 1_048_576;
/** The upstream error body kept for a same-request retry with another account. */
export const LIVE_CALL_CAPTURED_ERROR_MAX_BYTES = 8 * 1024;
/** A sideband frame is JSON text with base64 audio; bound it instead of buffering without limit. */
export const LIVE_SIDEBAND_MAX_PAYLOAD_BYTES = 4 * 1_048_576;
/** A peer that stops draining frames ends the relay instead of growing a send buffer. */
export const LIVE_SIDEBAND_MAX_BUFFERED_BYTES = 8 * 1_048_576;
/** Frames the client may send between the downstream 101 and the upstream handshake. */
export const LIVE_SIDEBAND_PREOPEN_MAX_FRAMES = 32;
export const LIVE_SIDEBAND_HANDSHAKE_TIMEOUT_MS = 10_000;
/** The sideband reconnects quickly; one hour outlives any call that can still be joined. */
export const LIVE_CALL_ACCOUNT_TTL_MS = 60 * 60_000;
/** A terminal sideband mapping is retried until KV accepts its retirement. */
const LIVE_CALL_RETIRE_RETRY_MS = 250;
/** The frameless (v3) alpha selector the client sends; forwarded, with this default. */
export const LIVE_OPENAI_ALPHA_DEFAULT = "quicksilver=v2";

/** Durable `call_id -> account_id` mapping so a sideband rejoins on the creating account. */
export const LIVE_CALL_ACCOUNT_KV_PREFIX = ["uos_ai", "codex_live_calls", "v1"] as const;

const DEFAULT_SIDEBAND_BASE_URL = "wss://api.openai.com/v1/live";
const LIVE_CALLS_ROUTE_PATH = "/realtime/calls?intent=quicksilver&architecture=avas";

/**
 * Client headers the upstream realtime route consumes. Everything else the
 * client sent - including its own `authorization`, which belongs to the
 * gateway - is deliberately dropped.
 */
const LIVE_FORWARDED_CLIENT_HEADERS = ["openai-alpha", "x-session-id", "session-id", "thread-id", "x-codex-turn-metadata", "x-oai-attestation"] as const;

let callsBaseUrlOverride: string | null = null;
let sidebandBaseUrlOverride: string | null = null;

/** Test seam: point the two upstreams at loopback servers. `null` restores the defaults. */
export const setLiveUpstreamBasesForTest = (overrides: Readonly<{ callsBaseUrl?: string | null; sidebandBaseUrl?: string | null }>): void => {
  callsBaseUrlOverride = overrides.callsBaseUrl ?? null;
  sidebandBaseUrlOverride = overrides.sidebandBaseUrl ?? null;
};

const withoutTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === "/") end -= 1;
  return value.slice(0, end);
};

/** The Chatgpt backend call-creation endpoint, including its legacy alpha query. */
export const liveCallsUrl = (): string => `${withoutTrailingSlashes(callsBaseUrlOverride ?? config.codexBaseUrl)}${LIVE_CALLS_ROUTE_PATH}`;

/** The sideband URL for one call id; the id stays exactly one encoded path segment. */
export const liveSidebandUrl = (callId: string): string =>
  `${withoutTrailingSlashes(sidebandBaseUrlOverride ?? DEFAULT_SIDEBAND_BASE_URL)}/${encodeURIComponent(callId)}`;

/** The client's alpha selector, or the frameless default when it sent none. */
const forwardedOpenAiAlpha = (req: Request): string => {
  const alpha = req.headers.get("openai-alpha")?.trim() ?? "";
  return alpha === "" ? LIVE_OPENAI_ALPHA_DEFAULT : alpha;
};

/** Call-creation headers; `fetchCodexResponseWithAuth` adds the account credentials. */
export const liveCallsUpstreamHeaders = (req: Request): Headers => {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("originator", CODEX_ORIGINATOR);
  headers.set("user-agent", codexUserAgent());
  headers.set("openai-alpha", forwardedOpenAiAlpha(req));
  for (const name of LIVE_FORWARDED_CLIENT_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null && value.trim() !== "") headers.set(name, value);
  }
  return headers;
};

/** Sideband handshake headers for the `ws` client, which takes a plain object. */
export const liveSidebandUpstreamHeaders = (accessToken: string, accountId: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
  "chatgpt-account-id": accountId,
  originator: CODEX_ORIGINATOR,
  "user-agent": codexUserAgent(),
  "openai-alpha": LIVE_OPENAI_ALPHA_DEFAULT,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The call id is the rightmost `Location` path segment that is an `rtc_*` id or
 * a canonical UUID, with the query string discarded. These are exactly the
 * segments the Codex client accepts, so a relayed `Location` stays parseable.
 */
export const parseLiveCallIdFromLocation = (location: string): string | null => {
  const withoutQuery = location.split("?")[0] ?? "";
  const segments = withoutQuery.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? "";
    if (segment.startsWith("rtc_") && segment.length > "rtc_".length) return segment;
    if (UUID_PATTERN.test(segment)) return segment;
  }
  return null;
};

/** The gateway-local `Location` for a created call; the upstream origin never leaks. */
export const liveCallLocation = (callId: string): string => `/v1/live/${encodeURIComponent(callId)}`;

export const liveCallAccountKey = (callId: string): KvKey => [...LIVE_CALL_ACCOUNT_KV_PREFIX, callId];

/** A pending terminal delete makes concurrent reconnects fail closed. */
const pendingLiveCallRetirements = new Set<string>();

/** The account that created a call and the authenticated principal it was created for. */
export type LiveCallMapping = Readonly<{ accountId: string; principalId: string | null }>;

/**
 * Records the creating account and gateway principal for a call. The write is
 * best effort: an unavailable KV leaves the call unjoinable rather than failing
 * a call that upstream already created.
 */
export const writeLiveCallAccount = async (callId: string, accountId: string, principalId: string): Promise<void> => {
  const kv = await getKv();
  if (!kv) {
    console.warn("[ai.ubq.fi] live_call_account_mapping_skipped", JSON.stringify({ call_id: callId, reason: "kv_unavailable" }));
    return;
  }
  try {
    await kv.set(
      liveCallAccountKey(callId),
      { account_id: accountId, principal_id: principalId, created_at_ms: Date.now() },
      { expireIn: LIVE_CALL_ACCOUNT_TTL_MS }
    );
  } catch (error) {
    console.warn("[ai.ubq.fi] live_call_account_mapping_failed", JSON.stringify({ call_id: callId, reason: error instanceof Error ? error.name : "unknown" }));
  }
};

/**
 * The account and principal that created the call, or null when the mapping
 * expired or is absent. A legacy record written before principal binding has no
 * `principal_id` and yields `principalId: null`; callers fail closed on it
 * rather than joining a call whose creating principal cannot be proven.
 */
export const readLiveCallMapping = async (callId: string): Promise<LiveCallMapping | null> => {
  if (pendingLiveCallRetirements.has(callId)) return null;
  const kv = await getKv();
  if (!kv) return null;
  try {
    const entry = await kv.get(liveCallAccountKey(callId));
    if (pendingLiveCallRetirements.has(callId)) return null;
    if (!isRecord(entry.value)) return null;
    const accountId = getString(entry.value.account_id);
    if (accountId === null) return null;
    return { accountId, principalId: getString(entry.value.principal_id) };
  } catch {
    return null;
  }
};

const waitForLiveCallRetirementRetry = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, LIVE_CALL_RETIRE_RETRY_MS));

/** Retires a call after the upstream says that it no longer exists. */
export const retireLiveCallMapping = async (callId: string): Promise<void> => {
  pendingLiveCallRetirements.add(callId);
  try {
    for (;;) {
      const kv = await getKv();
      if (kv) {
        try {
          await kv.delete(liveCallAccountKey(callId));
          return;
        } catch (error) {
          console.warn(
            "[ai.ubq.fi] live_call_account_mapping_retire_failed",
            JSON.stringify({ call_id: callId, reason: error instanceof Error ? error.name : "unknown" })
          );
        }
      }
      await waitForLiveCallRetirementRetry();
    }
  } finally {
    pendingLiveCallRetirements.delete(callId);
  }
};

// `GET /v1/live/<call_id>`: accept the client's sideband upgrade and bridge it
// to the OpenAI realtime WebSocket upstream with the creating account's auth.
//
// The downstream upgrade response is handed back to the runtime untouched: any
// `new Response(...)` wrapper drops the socket associated with the 101.

import type WebSocket from "ws";
import { CodexError, getAuthPoolEntry } from "../codex/auth.ts";
import { getCurrentAccountEntry, getValidAuth } from "../codex/auth-refresh.ts";
import { openaiError } from "../http.ts";
import { isRecord } from "../utils.ts";
import {
  LIVE_SIDEBAND_HANDSHAKE_TIMEOUT_MS,
  LIVE_SIDEBAND_MAX_BUFFERED_BYTES,
  LIVE_SIDEBAND_MAX_PAYLOAD_BYTES,
  LIVE_SIDEBAND_PREOPEN_MAX_FRAMES,
  liveSidebandUpstreamHeaders,
  liveSidebandUrl,
  readLiveCallMapping,
  retireLiveCallMapping,
} from "./upstream.ts";

type DownstreamSocket = ReturnType<typeof Deno.upgradeWebSocket>["socket"];

type UpstreamSocket = WebSocket;

type UpstreamWebSocketConstructor = new (
  url: string,
  options: Readonly<{ headers: Record<string, string>; perMessageDeflate: boolean; maxPayload: number; handshakeTimeout: number }>
) => UpstreamSocket;

/** `WebSocket.readyState` values, mirrored here because the DOM binding is not importable by name. */
const SOCKET_OPEN = 1;
/** The gateway's own failure close: the client can reconnect the sideband. */
const SIDEBAND_FAILURE_CLOSE_CODE = 1011;

let upstreamWebSocketConstructor: UpstreamWebSocketConstructor | null = null;

/**
 * Loads `ws` on first use. Importing it at module scope evaluates code that
 * reads `WS_NO_BUFFER_UTIL` from the environment while the module graph loads,
 * which the repository's strict test env allowlist rejects.
 */
const loadUpstreamWebSocketConstructor = async (): Promise<UpstreamWebSocketConstructor> => {
  if (upstreamWebSocketConstructor) return upstreamWebSocketConstructor;
  const module: unknown = await import("ws");
  const candidate = isRecord(module) ? module.default : undefined;
  if (typeof candidate !== "function") throw new Error("ws module did not expose a WebSocket constructor");
  upstreamWebSocketConstructor = candidate as UpstreamWebSocketConstructor;
  return upstreamWebSocketConstructor;
};

const logLiveSideband = (event: "joined" | "closed" | "rejected", fields: Readonly<Record<string, string | number | null>>): void => {
  try {
    console.info("[ai.ubq.fi] live_sideband", JSON.stringify({ event, ...fields }));
  } catch {
    // Observability must never break the relay.
  }
};

/** `ws` only accepts 1000 or 3000-4999 on the wire; anything else closes bare. */
const upstreamCloseCode = (code: number): number | null => (code === 1000 || (code >= 3000 && code <= 4999) ? code : null);

/** The client accepts 1000-4999 except the three reserved codes. */
const downstreamCloseCode = (code: number): number | null => (code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015 ? code : null);

const frameText = (raw: unknown): string | null => {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return null;
};

const frameBytes = (raw: unknown): number => {
  if (typeof raw === "string") return new TextEncoder().encode(raw).byteLength;
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return raw.byteLength;
  if (raw instanceof Blob) return raw.size;
  return 0;
};

const closeDownstream = (socket: DownstreamSocket, code: number, reason: string): void => {
  if (socket.readyState !== 0 && socket.readyState !== SOCKET_OPEN) return;
  const sendable = downstreamCloseCode(code);
  try {
    if (sendable === null) socket.close();
    else socket.close(sendable, reason.slice(0, 100));
  } catch {
    try {
      socket.close();
    } catch {
      // The peer is already gone.
    }
  }
};

const closeUpstream = (socket: UpstreamSocket, code: number, reason: string): void => {
  if (socket.readyState !== SOCKET_OPEN) {
    try {
      socket.terminate();
    } catch {
      // The dial already settled.
    }
    return;
  }
  const sendable = upstreamCloseCode(code);
  try {
    if (sendable === null) socket.close();
    else socket.close(sendable, reason.slice(0, 100));
  } catch {
    try {
      socket.terminate();
    } catch {
      // The dial already settled.
    }
  }
};

type LiveSidebandBridge = Readonly<{ downstream: DownstreamSocket; callId: string; accountId: string; accessToken: string }>;

/**
 * Bridges one downgoing socket to one upstream socket: text frames both ways,
 * close codes propagated, and frames the client sent before the upstream
 * handshake finished held in a small bounded queue rather than dropped or
 * buffered without limit.
 */
const bridgeLiveSideband = async (input: LiveSidebandBridge): Promise<void> => {
  const { downstream, callId, accountId, accessToken } = input;

  const preopenFrames: string[] = [];
  let preopenBytes = 0;
  // The state the downstream handlers share with the dial behind the first
  // await: whether the bridge settled, whether the upstream handshake finished,
  // and whether that dial produced the socket below.
  const relay = { settled: false, upstreamOpen: false, dialed: false };
  let upstream: UpstreamSocket;

  const finish = (code: number, reason: string, beforeClose?: Promise<void>): void => {
    if (relay.settled) return;
    relay.settled = true;
    preopenFrames.length = 0;
    preopenBytes = 0;
    const close = (): void => {
      if (relay.dialed) closeUpstream(upstream, code, reason);
      closeDownstream(downstream, code, reason);
      logLiveSideband("closed", { call_id: callId, account_id: accountId, code });
    };
    if (beforeClose) void beforeClose.then(close, close);
    else close();
  };

  const sendUpstreamFrame = (text: string): boolean => {
    const bufferedBytes: unknown = upstream.bufferedAmount;
    if (typeof bufferedBytes !== "number" || bufferedBytes + frameBytes(text) > LIVE_SIDEBAND_MAX_BUFFERED_BYTES) {
      finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream is not draining frames");
      return false;
    }
    try {
      upstream.send(text);
      return true;
    } catch {
      finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream send failed");
      return false;
    }
  };

  // Deno delivers the downstream events to the handler attached when they
  // arrive and discards the rest, so these come before the first await: a frame
  // the client sends right after the 101, or its disconnect, has to be queued
  // (or acted on) instead of lost while the upstream constructor loads.
  downstream.onmessage = (event: MessageEvent) => {
    if (relay.settled) return;
    if (frameBytes(event.data) > LIVE_SIDEBAND_MAX_PAYLOAD_BYTES) {
      finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime sideband frame exceeds payload limit");
      return;
    }
    // The frameless sideband is JSON text; a binary frame is a protocol error.
    const text = frameText(event.data);
    if (text === null) return;
    const bytes = frameBytes(text);
    if (bytes > LIVE_SIDEBAND_MAX_PAYLOAD_BYTES) {
      finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime sideband frame exceeds payload limit");
      return;
    }
    if (!relay.upstreamOpen) {
      if (preopenFrames.length >= LIVE_SIDEBAND_PREOPEN_MAX_FRAMES || preopenBytes + bytes > LIVE_SIDEBAND_MAX_BUFFERED_BYTES) {
        finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime sideband frame queue overflow");
        return;
      }
      preopenFrames.push(text);
      preopenBytes += bytes;
      return;
    }
    sendUpstreamFrame(text);
  };
  downstream.onclose = (event: CloseEvent) => {
    finish(event.code, event.reason);
  };
  downstream.onerror = () => {
    finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime sideband error");
  };

  try {
    const WEB_SOCKET_CONSTRUCTOR = await loadUpstreamWebSocketConstructor();
    // The client can be gone by now: its queued frames were cleared with it, so
    // no upstream socket is dialed for a call nobody is joining.
    if (relay.settled) return;
    upstream = new WEB_SOCKET_CONSTRUCTOR(liveSidebandUrl(callId), {
      headers: liveSidebandUpstreamHeaders(accessToken, accountId),
      perMessageDeflate: false,
      maxPayload: LIVE_SIDEBAND_MAX_PAYLOAD_BYTES,
      handshakeTimeout: LIVE_SIDEBAND_HANDSHAKE_TIMEOUT_MS,
    });
    relay.dialed = true;
  } catch {
    logLiveSideband("rejected", { call_id: callId, reason: "upstream_dial_failed" });
    closeDownstream(downstream, SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream unavailable");
    return;
  }

  upstream.on("open", () => {
    relay.upstreamOpen = true;
    logLiveSideband("joined", { call_id: callId, account_id: accountId });
    preopenBytes = 0;
    for (const frame of preopenFrames.splice(0)) {
      if (!sendUpstreamFrame(frame)) return;
    }
  });
  upstream.on("message", (data: unknown, isBinary: boolean) => {
    if (isBinary) return;
    const text = frameText(data);
    if (text === null || downstream.readyState !== SOCKET_OPEN || downstream.bufferedAmount + frameBytes(text) > LIVE_SIDEBAND_MAX_BUFFERED_BYTES) {
      finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime sideband is not writable");
      return;
    }
    downstream.send(text);
  });
  upstream.on("close", (code: number, reason: unknown) => {
    finish(code, frameText(reason) ?? "");
  });
  upstream.on("error", () => {
    finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream error");
  });
  upstream.on("unexpected-response", (_request, response: { statusCode?: number }) => {
    if (response.statusCode === 404 || response.statusCode === 410) {
      // A downstream 101 has already been sent by this point, so retire the
      // mapping before closing it. Reconnects then receive the terminal 404
      // instead of repeatedly dialing an ended upstream call.
      finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream rejected the sideband", retireLiveCallMapping(callId));
      return;
    }
    finish(SIDEBAND_FAILURE_CLOSE_CODE, "realtime upstream rejected the sideband");
  });
};

type LiveCallAccountToken = Readonly<{ ok: true; accessToken: string }> | Readonly<{ ok: false; response: Response }>;

const liveCallMissingAccountResponse = (): Response => openaiError(404, "The realtime call's account is no longer configured.", "invalid_request_error");

const liveCallAuthUnavailableResponse = (): Response =>
  openaiError(503, "Codex auth pool is temporarily unavailable; retry the request.", "codex_auth_missing");

/**
 * The mapped account's current token. A missing account stays a 404 before the
 * upgrade, while an unreadable pool or an unrefreshable credential is a
 * retryable 5xx. The account is re-read by identity and passed through the same
 * coordinated refresh ordinary inference uses, so a sideband join or reconnect
 * never dials upstream with an expired cached bearer.
 */
const liveCallAccountToken = async (accountId: string): Promise<LiveCallAccountToken> => {
  try {
    const poolEntry = await getAuthPoolEntry(true, true);
    if (!poolEntry.pool.accounts.some((candidate) => candidate.account_id === accountId)) {
      return { ok: false, response: liveCallMissingAccountResponse() };
    }
  } catch {
    return { ok: false, response: liveCallAuthUnavailableResponse() };
  }
  try {
    const current = await getCurrentAccountEntry(accountId, true);
    const auth = await getValidAuth(current);
    return { ok: true, accessToken: auth.access_token };
  } catch (error) {
    if (error instanceof CodexError && error.code === "codex_auth_missing") return { ok: false, response: liveCallMissingAccountResponse() };
    if (error instanceof CodexError) {
      const status = error.status >= 400 && error.status <= 599 ? error.status : 503;
      return { ok: false, response: openaiError(status, error.message, error.code) };
    }
    return { ok: false, response: liveCallAuthUnavailableResponse() };
  }
};

/**
 * Joins one call's sideband.
 *
 * The durable mapping binds the call to the account and gateway principal that
 * created it. A call id with no mapping is answered with 404 *before*
 * upgrading: the mapping is the gateway's only routing signal for the upstream
 * account, and the Codex client stops reconnecting on 404/410 exactly as it
 * would for a finished upstream call. A join from any other principal - or a
 * legacy record with no recorded principal, which can never be authorized - is
 * refused with 403 *before* the upgrade, deliberately without a permissive
 * compatibility fallback.
 */
export const handleLiveSideband = async (req: Request, callId: string, principal: string): Promise<Response> => {
  const mapping = await readLiveCallMapping(callId);
  if (mapping === null) {
    logLiveSideband("rejected", { call_id: callId, reason: "unknown_call" });
    return openaiError(404, "Unknown realtime call.", "invalid_request_error");
  }
  if (mapping.principalId === null || mapping.principalId !== principal) {
    logLiveSideband("rejected", { call_id: callId, reason: mapping.principalId === null ? "principal_missing" : "principal_mismatch" });
    return openaiError(403, "The realtime call was not created by this gateway principal.", "forbidden");
  }
  const account = await liveCallAccountToken(mapping.accountId);
  if (!account.ok) {
    logLiveSideband("rejected", { call_id: callId, reason: "account_unavailable" });
    return account.response;
  }
  if ((req.headers.get("upgrade") ?? "").trim().toLowerCase() !== "websocket") {
    return openaiError(426, "The realtime sideband requires a WebSocket upgrade.", "invalid_request_error");
  }

  const upgrade = Deno.upgradeWebSocket(req);
  void bridgeLiveSideband({ downstream: upgrade.socket, callId, accountId: mapping.accountId, accessToken: account.accessToken });
  return upgrade.response;
};

// `POST /v1/live`: translate the Codex client's multipart SDP call creation
// into the ChatGPT backend JSON shape and relay the answer verbatim.

import { CODEX_QUOTA_BLOCKED_ERROR_CODE, CodexError, getAuthPoolEntry } from "../codex/auth.ts";
import { getCurrentAccountEntry, getValidAuth } from "../codex/auth-refresh.ts";
import { markCodexCredentialInvalid, reconcileCodexRoutingAccount, selectCodexRoutingAccountsStrong } from "../codex/account-routing.ts";
import {
  awaitPendingCodexProbeTransitions,
  fetchCodexResponseWithAuth,
  initialCodexSelectionResponse,
  recordCodexResponseHealth,
  recordCodexThrownHealth,
  routingErrorResponse,
} from "../codex/dispatch.ts";
import type { RouteSelection, RoutingAccount } from "../codex/routing-state.ts";
import type { CodexAuthState } from "../types.ts";
import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { openaiError } from "../http.ts";
import { getString, isRecord } from "../utils.ts";
import {
  LIVE_CALL_CAPTURED_ERROR_MAX_BYTES,
  LIVE_CALL_MAX_BODY_BYTES,
  liveCallsUrl,
  liveCallsUpstreamHeaders,
  liveCallLocation,
  parseLiveCallIdFromLocation,
  writeLiveCallAccount,
} from "./upstream.ts";

/** One retry with the next eligible account, and no more. */
const LIVE_CALL_MAX_UPSTREAM_ATTEMPTS = 2;
/** A whole multipart SDP offer is kilobytes; this only has to cover a slow client. */
const LIVE_CALL_BODY_TIMEOUT_MS = 5_000;

type LiveCallCreateParts = Readonly<{ sdp: string; session: Record<string, unknown> }>;

type ParsedLiveCallCreate = Readonly<{ ok: true; parts: LiveCallCreateParts }> | Readonly<{ ok: false; response: Response }>;

const liveCallCreateError = (status: number, message: string, code: string, param?: string): Readonly<{ ok: false; response: Response }> => ({
  ok: false,
  response: openaiError(status, message, code, param === undefined ? {} : { param }),
});

const declaredLiveCallBodyTooLarge = async (req: Request): Promise<Response | null> => {
  const declaredLength = req.headers.get("content-length");
  if (declaredLength === null) return null;
  const normalized = declaredLength.trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(normalized)) return openaiError(400, "Live call creation Content-Length is invalid.", "invalid_request_error");
  const parsedLength = Number(normalized);
  if (Number.isSafeInteger(parsedLength) && parsedLength <= LIVE_CALL_MAX_BODY_BYTES) return null;
  await req.body?.cancel().catch(() => {});
  return openaiError(413, `Live call creation bodies must be no larger than ${LIVE_CALL_MAX_BODY_BYTES} bytes.`, "invalid_request_error");
};

const readLiveCallBody = async (
  req: Request
): Promise<Readonly<{ ok: true; bytes: Uint8Array<ArrayBuffer> }> | Readonly<{ ok: false; response: Response }>> => {
  const rejected = await declaredLiveCallBodyTooLarge(req);
  if (rejected) return { ok: false, response: rejected };
  const bounded = await readBoundedResponseBody(new Response(req.body), {
    maxBytes: LIVE_CALL_MAX_BODY_BYTES + 1,
    timeoutMs: LIVE_CALL_BODY_TIMEOUT_MS,
    signal: req.signal,
    cancellationReason: "Live call creation body exceeded its read limit",
  });
  // The byte cap is checked before completeness: a streamed body that passes
  // the cap is truncated at the cap and reported incomplete, and it is too
  // large whichever way it ended.
  if (bounded.bytes.byteLength > LIVE_CALL_MAX_BODY_BYTES) {
    return {
      ok: false,
      response: openaiError(413, `Live call creation bodies must be no larger than ${LIVE_CALL_MAX_BODY_BYTES} bytes.`, "invalid_request_error"),
    };
  }
  if (!bounded.complete) {
    return { ok: false, response: openaiError(400, "Live call creation body could not be read completely.", "invalid_request_error") };
  }
  return { ok: true, bytes: bounded.bytes };
};

/** A multipart value is a plain string unless the client set a part media type. */
const liveCallPartText = async (value: FormDataEntryValue | null): Promise<string | null> => {
  if (value === null) return null;
  return typeof value === "string" ? value : await value.text();
};

/** The client declares `multipart/form-data; boundary=<...>` with parts `sdp` and `session`. */
const parseLiveCallCreate = async (req: Request): Promise<ParsedLiveCallCreate> => {
  const contentType = req.headers.get("content-type") ?? "";
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType !== "multipart/form-data" || !/boundary=/iu.test(contentType)) {
    return liveCallCreateError(400, "Live call creation requires multipart/form-data with a declared boundary.", "invalid_request_error");
  }
  const body = await readLiveCallBody(req);
  if (!body.ok) return { ok: false, response: body.response };

  let form: FormData;
  try {
    form = await new Request(req.url, { method: req.method, headers: req.headers, body: body.bytes }).formData();
  } catch {
    return liveCallCreateError(400, "Live call creation multipart body could not be parsed.", "invalid_request_error");
  }
  const sdp = await liveCallPartText(form.get("sdp"));
  if (sdp === null || sdp === "") {
    return liveCallCreateError(400, "Live call creation requires a non-empty `sdp` part.", "invalid_request_error", "sdp");
  }
  const sessionText = await liveCallPartText(form.get("session"));
  if (sessionText === null) {
    return liveCallCreateError(400, "Live call creation requires a `session` part.", "invalid_request_error", "session");
  }
  let session: unknown;
  try {
    session = JSON.parse(sessionText);
  } catch {
    return liveCallCreateError(400, "Live call creation `session` part must be valid JSON.", "invalid_request_error", "session");
  }
  if (!isRecord(session) || Array.isArray(session)) {
    return liveCallCreateError(400, "Live call creation `session` part must be a JSON object.", "invalid_request_error", "session");
  }
  return { ok: true, parts: { sdp, session } };
};

/** The repo's routing failure shapes, plus the quota case realtime voice cannot fall back from. */
const liveRoutingFailureResponse = (selection: RouteSelection): Response => {
  const shared = initialCodexSelectionResponse(selection);
  if (shared) return shared;
  if (selection.kind === "quota_blocked") {
    return routingErrorResponse(
      429,
      "Codex subscription capacity is exhausted for realtime voice; retry after the reported reset.",
      CODEX_QUOTA_BLOCKED_ERROR_CODE,
      selection.retryAtMs
    );
  }
  return routingErrorResponse(503, "Codex routing state is temporarily unavailable; retry the request.", "codex_auth_missing");
};

type LiveCallAccountSelection = Readonly<{ ok: true; account: RoutingAccount }> | Readonly<{ ok: false; response: Response }>;

/** Strong pool read plus the serial routing classification ordinary inference uses. */
const selectLiveCallAccount = async (attemptedAccountIds: ReadonlySet<string>, model: string | null): Promise<LiveCallAccountSelection> => {
  let pool;
  try {
    pool = (await getAuthPoolEntry(true, true)).pool;
  } catch (error) {
    if (error instanceof CodexError) return { ok: false, response: routingErrorResponse(503, error.message, error.code) };
    return { ok: false, response: routingErrorResponse(503, "Codex routing state is temporarily unavailable; retry the request.", "codex_auth_missing") };
  }
  const selection = await selectCodexRoutingAccountsStrong(pool, pool.accounts, Date.now(), model);
  if (selection.kind !== "eligible") return { ok: false, response: liveRoutingFailureResponse(selection) };
  const account = selection.accounts.find((candidate) => !attemptedAccountIds.has(candidate.auth.account_id));
  if (!account) {
    // An eligible classification with nothing left to try is a routing read that
    // exposed no account at all; the serial selector normally offers exactly one.
    return {
      ok: false,
      response: routingErrorResponse(503, "Codex routing state exposed no account for this realtime call; retry the request.", "codex_auth_missing"),
    };
  }
  return { ok: true, account };
};

type LiveCallAttempt = Readonly<{ ok: true; accountId: string; routing: RoutingAccount; auth: CodexAuthState }> | Readonly<{ ok: false; response: Response }>;

/**
 * Routing selects the account; the credential that is actually dispatched comes
 * from the same coordinated path ordinary inference uses. The selected account
 * is re-read by identity and refreshed if stale, so call creation never sends
 * the expired bearer a cached routing read happened to expose, and an account
 * that disappeared between the routing read and the dispatch fails closed.
 */
const resolveLiveCallAttempt = async (attemptedAccountIds: ReadonlySet<string>, model: string | null): Promise<LiveCallAttempt> => {
  const selection = await selectLiveCallAccount(attemptedAccountIds, model);
  if (!selection.ok) return { ok: false, response: selection.response };
  const accountId = selection.account.auth.account_id;
  try {
    const current = await getCurrentAccountEntry(accountId, true);
    const auth = await getValidAuth(current);
    const routing =
      auth.access_token === selection.account.auth.access_token && auth.refresh_token === selection.account.auth.refresh_token
        ? selection.account
        : await reconcileCodexRoutingAccount(selection.account, auth);
    return { ok: true, accountId, routing, auth };
  } catch (error) {
    if (error instanceof CodexError) {
      const status = error.status === 401 || error.status === 404 || error.status === 429 ? error.status : 503;
      return { ok: false, response: routingErrorResponse(status, error.message, error.code) };
    }
    return { ok: false, response: routingErrorResponse(503, "Codex auth pool is temporarily unavailable; retry the request.", "codex_auth_missing") };
  }
};

const liveCallDispatchFailureResponse = (error: unknown): Response => {
  if (error instanceof CodexError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    return openaiError(status, error.message, error.code);
  }
  return openaiError(502, "Codex upstream request failed: upstream unreachable.", "codex_upstream_unreachable");
};

/** A failed attempt another account may retry: keep its status and body, release the stream. */
const captureLiveCallAttempt = async (response: Response, signal: AbortSignal | undefined): Promise<Response> => {
  const captured = await readBoundedResponseBody(response, {
    maxBytes: LIVE_CALL_CAPTURED_ERROR_MAX_BYTES,
    timeoutMs: 1_000,
    signal,
    cancellationReason: "Live call retry replaced this upstream response",
  });
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  return new Response(captured.bytes, { status: response.status, statusText: response.statusText, headers });
};

/**
 * Relays the upstream status and SDP answer verbatim. A `Location` whose last
 * parseable segment is a call id is rewritten to the gateway's own origin, and
 * the creating account and principal are mapped to that call so the sideband
 * can rejoin it only for the principal that created it.
 */
const relayLiveCallResponse = async (response: Response, accountId: string, principal: string): Promise<Response> => {
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  const upstreamLocation = response.headers.get("location");
  const callId = upstreamLocation === null ? null : parseLiveCallIdFromLocation(upstreamLocation);
  if (upstreamLocation !== null) headers.set("location", callId === null ? upstreamLocation : liveCallLocation(callId));
  if (callId !== null && response.ok) await writeLiveCallAccount(callId, accountId, principal);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

/**
 * Creates one realtime call. The client's multipart offer becomes the backend
 * JSON shape, one eligible Codex account serves it, and a 401/403 admits a
 * single retry with the next eligible account before the upstream answer (or
 * the captured credential failure) is relayed unchanged. The creating
 * principal is persisted with the account so only it can join the sideband.
 */
export const handleLiveCallCreate = async (req: Request, principal: string): Promise<Response> => {
  const parsed = await parseLiveCallCreate(req);
  if (!parsed.ok) return parsed.response;

  const serializedBody = JSON.stringify({ sdp: parsed.parts.sdp, session: parsed.parts.session });
  const headers = liveCallsUpstreamHeaders(req);
  const model = getString(parsed.parts.session.model);
  const attemptedAccountIds = new Set<string>();
  let captured: Response | null = null;

  for (let attempt = 1; attempt <= LIVE_CALL_MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    const resolved = await resolveLiveCallAttempt(attemptedAccountIds, model);
    if (!resolved.ok) return captured ?? resolved.response;
    const { accountId, routing, auth } = resolved;
    attemptedAccountIds.add(accountId);

    let upstream: Response;
    try {
      upstream = await fetchCodexResponseWithAuth(auth, liveCallsUrl(), serializedBody, headers, req.signal);
    } catch (error) {
      await recordCodexThrownHealth(accountId, error);
      return captured ?? liveCallDispatchFailureResponse(error);
    }
    await recordCodexResponseHealth(accountId, upstream, auth, "success");

    const credentialFailure = upstream.status === 401 || upstream.status === 403;
    if (!credentialFailure) return await relayLiveCallResponse(upstream, accountId, principal);
    // Passive provider health does not participate in account eligibility. Fence
    // the credential before the strong reselection so the attempted-account
    // filter does not turn the bounded retry into the captured first failure.
    await markCodexCredentialInvalid(routing);
    if (attempt === LIVE_CALL_MAX_UPSTREAM_ATTEMPTS) return await relayLiveCallResponse(upstream, accountId, principal);
    // The retry re-evaluates durable routing after the credential fence, so any
    // transition it started must be observable first. The serial selector exposes one
    // eligible account at a time, and only a reselection that offers a different
    // one (a credential fence or a pool change) turns this into a real retry.
    await awaitPendingCodexProbeTransitions();
    captured = await captureLiveCallAttempt(upstream, req.signal);
  }
  return captured ?? openaiError(502, "Codex upstream request failed: upstream unreachable.", "codex_upstream_unreachable");
};

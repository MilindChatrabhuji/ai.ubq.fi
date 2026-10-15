import type { Kv, KvEntry, KvKey } from "#kv";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { parseTrustedAuthRelayOrigin } from "./relay.ts";
import { getBearerToken, json, openaiError } from "../http.ts";
import { getKv } from "../kv.ts";
import { readJsonBodyWithLimit } from "../request.ts";
import { base64UrlDecode, base64UrlEncode, getString, isRecord, sha256Hex } from "../utils.ts";

export type PasskeyUserRecord = {
  id: string;
  handle: string;
  is_admin: boolean;
  credential_ids: string[];
  created_at_ms: number;
  updated_at_ms: number;
};

export type PasskeyCredentialRecord = {
  credential_id: string;
  user_id: string;
  public_key: string;
  sign_count: number;
  transports: string[];
  created_at_ms: number;
};

export type PasskeySessionRecord = {
  token: string;
  user_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  audience_origin?: string;
};

type PasskeyChallengeRecord = {
  challenge: string;
  type: "registration" | "authentication";
  origin: string;
  rp_id: string;
  audience_origin?: string;
  user_id?: string;
  handle?: string;
  is_admin?: boolean;
  created_at_ms: number;
  expires_at_ms: number;
};

export type PasskeySession = {
  token: string;
  user: PasskeyUserRecord;
  session: PasskeySessionRecord;
};

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PASSKEY_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PASSKEY_MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const PASSKEY_RELAY_COOKIE_NAME = "__Host-uos_ai_relay_session";
// Anonymous login-start challenge issuance is bounded by a fixed, clock-aligned
// window so the reset instant is deterministic and needs no new secret,
// environment variable, or per-client identifier.
export const PASSKEY_LOGIN_START_WINDOW_MS = 60_000;
export const PASSKEY_LOGIN_START_LIMIT = 10;

const AUTH_PREFIX = ["uos_ai", "auth"] as const;
const PASSKEY_CANONICAL_ORIGIN = "https://ai.ubq.fi";
const RP_NAME = "UbiquityOS AI Gateway";

export const passkeyUserKey = (userId: string): KvKey => [...AUTH_PREFIX, "users", userId];
export const passkeyHandleKey = (handle: string): KvKey => [...AUTH_PREFIX, "handles", handle];
export const passkeyCredentialKey = (credentialId: string): KvKey => [...AUTH_PREFIX, "credentials", credentialId];
export const passkeyChallengeKey = (challenge: string): KvKey => [...AUTH_PREFIX, "challenges", challenge];
export const passkeySessionKey = (token: string): KvKey => [...AUTH_PREFIX, "sessions", token];
export const passkeyLoginStartThrottleKey = (windowStartMs: number): KvKey => [...AUTH_PREFIX, "login-start-throttle", windowStartMs];

const nowMs = () => Date.now();

// Strip leading and trailing separators without a backtracking-prone regex.
// Equivalent to `.replace(/^-+|-+$/g, "")` for every input.
const trimPasskeyHandleSeparators = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
};

export const normalizePasskeyHandle = (value: unknown): string => {
  const text = getString(value)?.trim().toLowerCase() ?? "";
  return trimPasskeyHandleSeparators(text.replace(/[^a-z0-9._-]+/g, "-"))
    .replace(/-{2,}/g, "-")
    .slice(0, 96);
};

export const buildPasskeyHandle = async (seed: string): Promise<string> => {
  const trimmed = seed.trim();
  if (!trimmed) return "";
  const fingerprint = (await sha256Hex(trimmed)).slice(0, 16);
  return `uos-passkey-${fingerprint}`;
};

export const isPasskeyUserAdmin = (user: Pick<PasskeyUserRecord, "is_admin"> | null | undefined): boolean => user?.is_admin === true;

const serializePasskeyUser = (user: PasskeyUserRecord): Record<string, unknown> => ({
  id: user.id,
  handle: user.handle,
  is_admin: isPasskeyUserAdmin(user),
  credential_count: user.credential_ids.length,
  created_at_ms: user.created_at_ms,
  updated_at_ms: user.updated_at_ms,
});

const parseClientChallenge = (encoded: string): string => {
  const decoded = base64UrlDecode(encoded);
  const jsonText = new TextDecoder().decode(decoded);
  const parsed = JSON.parse(jsonText) as { challenge?: unknown };
  return getString(parsed.challenge)?.trim() ?? "";
};

// `null` distinguishes a malformed clientDataJSON payload from a well-formed one
// that carries no usable challenge, which callers report separately.
const parseClientChallengeOrNull = (encoded: string): string | null => {
  try {
    return parseClientChallenge(encoded);
  } catch {
    return null;
  }
};

// The request body is untrusted JSON: only a non-null object can carry the
// WebAuthn response shape that the server verifier validates field by field.
const isWebauthnResponseObject = (value: unknown): boolean => typeof value === "object" && value !== null;

// Deno types a listed value as present, but a stored record can still be absent.
// Widening the read keeps the storage-boundary guard meaningful, so a missing
// record is dropped instead of serialized.
const readStoredPasskeyUser = (entry: KvEntry<PasskeyUserRecord>): PasskeyUserRecord | null => entry.value;

const firstHeaderValue = (value: string | null): string | null => {
  const first = value?.split(",")[0]?.trim() ?? "";
  return first || null;
};

const parseOrigin = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "null") return null;
  try {
    const origin = new URL(trimmed).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};

const parseOriginFromHost = (host: string | null, protocol: string): string | null => {
  if (!host) return null;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
};

const isLoopbackHost = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";

const isTrustedPasskeyOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    if (url.origin === PASSKEY_CANONICAL_ORIGIN) return true;
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
};

const firstTrustedPasskeyOrigin = (origins: (string | null)[]): string => {
  for (const origin of origins) {
    if (origin && isTrustedPasskeyOrigin(origin)) return origin;
  }
  return PASSKEY_CANONICAL_ORIGIN;
};

export const getPasskeyRequestMeta = (req: Request, clientOrigin?: unknown): { origin: string; rpId: string } => {
  const url = new URL(req.url);
  const forwardedProtocol = firstHeaderValue(req.headers.get("x-forwarded-proto"));
  const protocol = forwardedProtocol ?? url.protocol.replace(/:$/, "");
  const forwardedHost = firstHeaderValue(req.headers.get("x-forwarded-host"));
  const host = firstHeaderValue(req.headers.get("host"));
  const origin = firstTrustedPasskeyOrigin([
    parseOrigin(getString(clientOrigin) ?? null),
    parseOrigin(req.headers.get("origin")),
    parseOrigin(req.headers.get("referer")),
    parseOriginFromHost(forwardedHost, protocol),
    parseOriginFromHost(host, protocol),
    url.origin,
  ]);
  const originUrl = new URL(origin);
  return { origin: originUrl.origin, rpId: originUrl.hostname };
};

const getKvOrError = async (): Promise<Kv | Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(503, "Passkey auth requires Deno KV", "server_error");
  return kv;
};

const readPasskeyJson = async (req: Request, options: Readonly<{ allowEmpty?: boolean }> = {}): Promise<Record<string, unknown> | Response> => {
  const result = await readJsonBodyWithLimit(req, PASSKEY_MAX_REQUEST_BODY_BYTES);
  if (!result.ok) {
    if (options.allowEmpty && result.kind === "empty") return {};
    return result.kind === "too_large"
      ? openaiError(413, "Passkey request body is too large", "invalid_request_error")
      : openaiError(400, "Invalid JSON body", "invalid_request_error");
  }
  return isRecord(result.value) ? result.value : openaiError(400, "Invalid JSON body", "invalid_request_error");
};

const getUserByHandle = async (kv: Kv, handle: string): Promise<PasskeyUserRecord | null> => {
  const userIdEntry = await kv.get<string>(passkeyHandleKey(handle));
  if (!userIdEntry.value) return null;
  const userEntry = await kv.get<PasskeyUserRecord>(passkeyUserKey(userIdEntry.value));
  return userEntry.value ?? null;
};

export const hasPasskeyUsers = async (): Promise<boolean> => {
  const kv = await getKv();
  if (!kv) return false;
  // One entry is enough to answer the question, and `limit: 1` keeps the scan
  // bounded; materializing it avoids an unused loop binding.
  const users = await Array.fromAsync(kv.list({ prefix: [...AUTH_PREFIX, "users"] }, { limit: 1 }));
  return users.length > 0;
};

export const updatePasskeyCredentialSignCount = async (
  kv: Kv,
  entry: Readonly<{ key: KvKey; value: PasskeyCredentialRecord; versionstamp: string }>,
  signCount: number
): Promise<boolean> => {
  const commit = await kv
    .atomic()
    .check({ key: entry.key, versionstamp: entry.versionstamp })
    .set(entry.key, { ...entry.value, sign_count: signCount })
    .commit();
  return commit.ok;
};

const saveChallenge = async (kv: Kv, input: Omit<PasskeyChallengeRecord, "created_at_ms" | "expires_at_ms">): Promise<PasskeyChallengeRecord> => {
  const createdAtMs = nowMs();
  const record: PasskeyChallengeRecord = {
    ...input,
    created_at_ms: createdAtMs,
    expires_at_ms: createdAtMs + PASSKEY_CHALLENGE_TTL_MS,
  };
  await kv.set(passkeyChallengeKey(record.challenge), record, { expireIn: PASSKEY_CHALLENGE_TTL_MS });
  return record;
};

const consumeChallenge = async (kv: Kv, challenge: string): Promise<PasskeyChallengeRecord | null> => {
  const key = passkeyChallengeKey(challenge);
  const entry = await kv.get<PasskeyChallengeRecord>(key);
  if (!entry.value) return null;
  if (entry.value.expires_at_ms <= nowMs()) {
    await kv.atomic().check(entry).delete(key).commit();
    return null;
  }
  const commit = await kv.atomic().check(entry).delete(key).commit();
  if (!commit.ok) return null;
  return entry.value;
};

const createSession = async (kv: Kv, userId: string, audienceOrigin?: string): Promise<PasskeySessionRecord> => {
  const createdAtMs = nowMs();
  const token = `uos_ai_session_${crypto.randomUUID()}`;
  const record: PasskeySessionRecord = {
    token,
    user_id: userId,
    created_at_ms: createdAtMs,
    expires_at_ms: createdAtMs + PASSKEY_SESSION_TTL_MS,
    ...(audienceOrigin ? { audience_origin: audienceOrigin } : {}),
  };
  await kv.set(passkeySessionKey(token), record, { expireIn: PASSKEY_SESSION_TTL_MS });
  return record;
};

type SaveVerifiedPasskeyRegistrationInput = {
  userId: string;
  handle: string;
  isAdmin: boolean;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[];
};

export const saveVerifiedPasskeyRegistration = async (
  kv: Kv,
  input: SaveVerifiedPasskeyRegistrationInput
): Promise<{ ok: true; user: PasskeyUserRecord } | { ok: false; response: Response }> => {
  const handleEntry = await kv.get<string>(passkeyHandleKey(input.handle));
  if (handleEntry.value && handleEntry.value !== input.userId) {
    return {
      ok: false,
      response: openaiError(409, "A passkey account already exists for this username", "invalid_request_error"),
    };
  }

  const createdAtMs = nowMs();
  const credentialRecord: PasskeyCredentialRecord = {
    credential_id: input.credentialId,
    user_id: input.userId,
    public_key: input.publicKey,
    sign_count: input.signCount,
    transports: input.transports,
    created_at_ms: createdAtMs,
  };

  const existingUserEntry = await kv.get<PasskeyUserRecord>(passkeyUserKey(input.userId));
  const userRecord: PasskeyUserRecord = existingUserEntry.value
    ? {
        ...existingUserEntry.value,
        handle: input.handle,
        is_admin: isPasskeyUserAdmin(existingUserEntry.value),
        credential_ids: Array.from(new Set([...existingUserEntry.value.credential_ids, input.credentialId])),
        updated_at_ms: createdAtMs,
      }
    : {
        id: input.userId,
        handle: input.handle,
        is_admin: input.isAdmin,
        credential_ids: [input.credentialId],
        created_at_ms: createdAtMs,
        updated_at_ms: createdAtMs,
      };

  let atomic = kv
    .atomic()
    .check(existingUserEntry)
    .check(handleEntry)
    .set(passkeyUserKey(userRecord.id), userRecord)
    .set(passkeyHandleKey(input.handle), userRecord.id)
    .set(passkeyCredentialKey(input.credentialId), credentialRecord);
  if (existingUserEntry.value && existingUserEntry.value.handle !== input.handle) {
    atomic = atomic.delete(passkeyHandleKey(existingUserEntry.value.handle));
  }
  const commit = await atomic.commit();
  if (!commit.ok) {
    return {
      ok: false,
      response: openaiError(409, "Passkey account was modified concurrently; retry", "invalid_request_error"),
    };
  }

  return { ok: true, user: userRecord };
};

export const getPasskeySession = async (token: string): Promise<PasskeySession | null> => {
  const kv = await getKv();
  if (!kv) return null;
  const sessionEntry = await kv.get<PasskeySessionRecord>(passkeySessionKey(token));
  if (!sessionEntry.value) return null;
  if (sessionEntry.value.expires_at_ms <= nowMs()) {
    await kv.atomic().check(sessionEntry).delete(passkeySessionKey(token)).commit();
    return null;
  }
  const userEntry = await kv.get<PasskeyUserRecord>(passkeyUserKey(sessionEntry.value.user_id));
  if (!userEntry.value) return null;
  return { token, user: userEntry.value, session: sessionEntry.value };
};

const getCookieValue = (req: Request, name: string): string | null => {
  const cookieHeader = req.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const rawValue = part.slice(separator + 1).trim();
    if (!rawValue) return null;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return null;
    }
  }
  return null;
};

const buildRelayCookie = (token: string, expiresAtMs: number): string => {
  const maxAge = Math.max(0, Math.ceil((expiresAtMs - nowMs()) / 1000));
  return `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;
};

const clearRelayCookie = (): string => `${PASSKEY_RELAY_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`;

export const getPasskeySessionFromRequest = async (req: Request): Promise<PasskeySession | null> => {
  const token = getBearerToken(req) ?? getCookieValue(req, PASSKEY_RELAY_COOKIE_NAME);
  return token ? await getPasskeySession(token) : null;
};

const getRequestAudienceOrigin = (req: Request): string | null => {
  const headerOrigin = req.headers.get("origin");
  if (headerOrigin !== null) return parseTrustedAuthRelayOrigin(headerOrigin);
  return parseTrustedAuthRelayOrigin(new URL(req.url).searchParams.get("cors_origin"));
};

export const getPasskeySessionForRequest = async (req: Request, authenticatedPasskeyToken?: string): Promise<PasskeySession | null> => {
  const session = authenticatedPasskeyToken ? await getPasskeySession(authenticatedPasskeyToken) : await getPasskeySessionFromRequest(req);
  if (!session?.session.audience_origin) return session;
  return getRequestAudienceOrigin(req) === session.session.audience_origin ? session : null;
};

export const handlePasskeyRegisterStart = async (
  req: Request,
  options: { defaultIsAdmin?: boolean; authenticatedPasskeyToken?: string } = {}
): Promise<Response> => {
  const raw = await readPasskeyJson(req);
  if (raw instanceof Response) return raw;
  const kvOrError = await getKvOrError();
  if (kvOrError instanceof Response) return kvOrError;
  const kv = kvOrError;

  const token = options.authenticatedPasskeyToken ?? getBearerToken(req) ?? "";
  const existingSession = token ? await getPasskeySessionForRequest(req, options.authenticatedPasskeyToken) : null;
  if (options.authenticatedPasskeyToken && !existingSession) {
    return openaiError(401, "Unauthorized", "invalid_api_key");
  }
  const requestedHandle = normalizePasskeyHandle(raw.handle);
  const tokenHandle = token ? await buildPasskeyHandle(token) : "";
  const requestedUser = requestedHandle ? await getUserByHandle(kv, requestedHandle) : null;
  const tokenUser = tokenHandle ? await getUserByHandle(kv, tokenHandle) : null;
  if (requestedUser && requestedUser.id !== existingSession?.user.id && requestedUser.id !== tokenUser?.id) {
    return openaiError(409, "A passkey account already exists for this username", "invalid_request_error");
  }
  const existingUser = existingSession?.user ?? tokenUser ?? requestedUser;
  const userId = existingUser?.id ?? crypto.randomUUID();
  // First non-empty candidate wins, so an empty stored or requested handle still
  // falls through to the next source.
  const handleCandidates = [existingSession?.user.handle, requestedHandle, tokenHandle];
  const handle = handleCandidates.find((candidate) => candidate) ?? (await buildPasskeyHandle(userId));
  if (!handle) return openaiError(400, "username is required", "invalid_request_error");
  const isAdmin = existingUser ? isPasskeyUserAdmin(existingUser) : options.defaultIsAdmin === true;
  const { origin, rpId } = getPasskeyRequestMeta(req, raw.client_origin);

  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = base64UrlEncode(challengeBytes);
  await saveChallenge(kv, {
    challenge,
    type: "registration",
    origin,
    rp_id: rpId,
    user_id: userId,
    handle,
    is_admin: isAdmin,
  });

  const userIdBytes = new TextEncoder().encode(userId);
  return json(
    200,
    {
      publicKey: {
        rp: { id: rpId, name: RP_NAME },
        user: {
          id: base64UrlEncode(userIdBytes),
          name: handle,
          displayName: handle,
        },
        challenge,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        timeout: PASSKEY_CHALLENGE_TTL_MS,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "required",
          userVerification: isAdmin ? "required" : "preferred",
        },
        excludeCredentials: existingUser?.credential_ids.map((id) => ({ id, type: "public-key" })) ?? [],
      },
      handle,
    },
    { "Cache-Control": "no-store" }
  );
};

export const handlePasskeyRegisterFinish = async (req: Request): Promise<Response> => {
  const raw = await readPasskeyJson(req);
  if (raw instanceof Response) return raw;
  const kvOrError = await getKvOrError();
  if (kvOrError instanceof Response) return kvOrError;
  const kv = kvOrError;

  const storedResponse: unknown = raw.response;
  const response = isWebauthnResponseObject(storedResponse) ? (storedResponse as RegistrationResponseJSON) : undefined;
  const clientDataJson = response?.response.clientDataJSON;
  if (!clientDataJson) return openaiError(400, "Invalid passkey response", "invalid_request_error");

  const challenge = parseClientChallengeOrNull(clientDataJson);
  if (!challenge) return openaiError(400, "Invalid passkey response", "invalid_request_error");

  const challengeRecord = await consumeChallenge(kv, challenge);
  if (challengeRecord?.type !== "registration" || !challengeRecord.user_id) {
    return openaiError(400, "Invalid passkey challenge", "invalid_request_error");
  }

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: challengeRecord.origin,
      expectedRPID: challengeRecord.rp_id,
      requireUserVerification: challengeRecord.is_admin === true,
    });
    if (!verification.verified) {
      return openaiError(400, "Invalid passkey attestation", "invalid_request_error");
    }

    const registrationInfo = verification.registrationInfo;
    const credentialId = registrationInfo.credential.id;
    const publicKey = base64UrlEncode(new Uint8Array(registrationInfo.credential.publicKey));
    const handle = normalizePasskeyHandle(challengeRecord.handle);
    if (!handle) return openaiError(400, "username is required", "invalid_request_error");

    const saved = await saveVerifiedPasskeyRegistration(kv, {
      userId: challengeRecord.user_id,
      handle,
      isAdmin: challengeRecord.is_admin === true,
      credentialId,
      publicKey,
      signCount: registrationInfo.credential.counter,
      transports: registrationInfo.credential.transports ?? [],
    });
    if (!saved.ok) return saved.response;

    const session = await createSession(kv, saved.user.id);
    return json(
      200,
      {
        token: session.token,
        user_id: saved.user.id,
        handle: saved.user.handle,
        credential_count: saved.user.credential_ids.length,
        expires_at_ms: session.expires_at_ms,
      },
      { "Cache-Control": "no-store" }
    );
  } catch {
    return openaiError(400, "Invalid passkey attestation", "invalid_request_error");
  }
};

type PasskeyLoginStartThrottleRecord = {
  window_start_ms: number;
  count: number;
};

const passkeyLoginStartWindowStartMs = (atMs: number): number => Math.floor(atMs / PASSKEY_LOGIN_START_WINDOW_MS) * PASSKEY_LOGIN_START_WINDOW_MS;

/**
 * Consumes one slot of the current anonymous login-start window. The window is
 * aligned to the epoch so the reset instant depends only on the clock, and a
 * rejected request writes nothing: callers must not issue a challenge.
 */
const consumePasskeyLoginStartBudget = async (kv: Kv, atMs: number): Promise<{ allowed: true } | { allowed: false; retry_after_seconds: number }> => {
  const windowStartMs = passkeyLoginStartWindowStartMs(atMs);
  const resetAtMs = windowStartMs + PASSKEY_LOGIN_START_WINDOW_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - atMs) / 1000));
  const key = passkeyLoginStartThrottleKey(windowStartMs);
  // A losing atomic commit means another request consumed a slot, so the count
  // can rise at most to the limit before this request must fail closed. At most
  // one attempt per slot is enough to let a full concurrent burst resolve
  // exactly like a sequential one without ever exceeding the bound.
  for (let attempt = 0; attempt < PASSKEY_LOGIN_START_LIMIT; attempt += 1) {
    const entry = await kv.get<PasskeyLoginStartThrottleRecord>(key, { consistency: "strong" });
    const count = entry.value?.count ?? 0;
    if (count >= PASSKEY_LOGIN_START_LIMIT) return { allowed: false, retry_after_seconds: retryAfterSeconds };
    const commit = await kv
      .atomic()
      .check(entry)
      .set(key, { window_start_ms: windowStartMs, count: count + 1 }, { expireIn: PASSKEY_LOGIN_START_WINDOW_MS * 2 })
      .commit();
    if (commit.ok) return { allowed: true };
  }
  return { allowed: false, retry_after_seconds: retryAfterSeconds };
};

export const handlePasskeyLoginStart = async (req: Request): Promise<Response> => {
  const raw = await readPasskeyJson(req, { allowEmpty: true });
  if (raw instanceof Response) return raw;
  const kvOrError = await getKvOrError();
  if (kvOrError instanceof Response) return kvOrError;
  const kv = kvOrError;

  const handle = normalizePasskeyHandle(raw.handle);
  const rawAudienceOrigin = getString(raw.relay_origin)?.trim() ?? "";
  const audienceOrigin = rawAudienceOrigin ? parseTrustedAuthRelayOrigin(rawAudienceOrigin) : null;
  if (rawAudienceOrigin && !audienceOrigin) {
    return openaiError(400, "Invalid passkey relay origin", "invalid_request_error");
  }

  const budget = await consumePasskeyLoginStartBudget(kv, nowMs());
  if (!budget.allowed) {
    return openaiError(429, "Too many passkey login attempts; retry after the current window", "rate_limit_exceeded", {
      type: "rate_limit_error",
      headers: { "Cache-Control": "no-store", "Retry-After": String(budget.retry_after_seconds) },
    });
  }

  let allowCredentials: { id: string; type: "public-key" }[] | undefined;
  // Discoverable credentials may belong to an admin; request the verification
  // that the finish handler will require once the account is identified.
  let userVerification: "preferred" | "required" = "required";
  if (handle) {
    const user = await getUserByHandle(kv, handle);
    // Unknown handles and handles without any registered passkey take the same
    // discoverable path as an empty handle, so the response cannot reveal
    // whether the account exists or has passkeys registered.
    if (user?.credential_ids.length) {
      allowCredentials = user.credential_ids.map((id) => ({ id, type: "public-key" }));
      userVerification = isPasskeyUserAdmin(user) ? "required" : "preferred";
    }
  }

  const { origin, rpId } = getPasskeyRequestMeta(req, raw.client_origin);
  const publicKey = await generateAuthenticationOptions({
    rpID: rpId,
    timeout: PASSKEY_CHALLENGE_TTL_MS,
    allowCredentials,
    userVerification,
  });

  await saveChallenge(kv, {
    challenge: publicKey.challenge,
    type: "authentication",
    origin,
    rp_id: rpId,
    ...(audienceOrigin ? { audience_origin: audienceOrigin } : {}),
  });
  return json(200, { publicKey }, { "Cache-Control": "no-store" });
};

// A usable assertion credential needs both its stored record and the versionstamp
// that makes the later sign-count update conditional on an unchanged record.
const readPasskeyAssertionCredential = async (
  kv: Kv,
  credentialId: string
): Promise<Readonly<{ key: KvKey; credential: PasskeyCredentialRecord; versionstamp: string }> | null> => {
  const entry = await kv.get<PasskeyCredentialRecord>(passkeyCredentialKey(credentialId));
  const credential = entry.value;
  if (!credential || !entry.versionstamp) return null;
  return { key: entry.key, credential, versionstamp: entry.versionstamp };
};

export const handlePasskeyLoginFinish = async (req: Request): Promise<Response> => {
  const raw = await readPasskeyJson(req);
  if (raw instanceof Response) return raw;
  const kvOrError = await getKvOrError();
  if (kvOrError instanceof Response) return kvOrError;
  const kv = kvOrError;

  const storedResponse: unknown = raw.response;
  const response = isWebauthnResponseObject(storedResponse) ? (storedResponse as AuthenticationResponseJSON) : undefined;
  const clientDataJson = response?.response.clientDataJSON;
  if (!response?.id || !clientDataJson) return openaiError(400, "Invalid passkey response", "invalid_request_error");

  const challenge = parseClientChallengeOrNull(clientDataJson);
  if (challenge === null) return openaiError(400, "Invalid passkey response", "invalid_request_error");

  const challengeRecord = await consumeChallenge(kv, challenge);
  if (challengeRecord?.type !== "authentication") {
    return openaiError(400, "Invalid passkey challenge", "invalid_request_error");
  }

  const storedCredential = await readPasskeyAssertionCredential(kv, response.id);
  if (!storedCredential) {
    return openaiError(400, "Unknown passkey", "invalid_request_error");
  }
  const { key: credentialKey, credential, versionstamp } = storedCredential;
  const userEntry = await kv.get<PasskeyUserRecord>(passkeyUserKey(credential.user_id));
  if (!userEntry.value) return openaiError(401, "Unauthorized", "invalid_api_key");

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: challengeRecord.origin,
      expectedRPID: challengeRecord.rp_id,
      requireUserVerification: isPasskeyUserAdmin(userEntry.value),
      credential: {
        id: credential.credential_id,
        publicKey: base64UrlDecode(credential.public_key),
        counter: credential.sign_count,
      },
    });
    if (!verification.verified) {
      return openaiError(400, "Invalid passkey assertion", "invalid_request_error");
    }

    const updated = await updatePasskeyCredentialSignCount(
      kv,
      {
        key: credentialKey,
        value: credential,
        versionstamp,
      },
      verification.authenticationInfo.newCounter
    );
    if (!updated) {
      return openaiError(409, "Passkey credential was modified concurrently; retry", "invalid_request_error");
    }

    const session = await createSession(kv, credential.user_id, challengeRecord.audience_origin);
    const relaySession = Boolean(challengeRecord.audience_origin);
    return json(
      200,
      {
        ...(relaySession ? { relay_session: true } : { token: session.token }),
        user_id: userEntry.value.id,
        handle: userEntry.value.handle,
        credential_count: userEntry.value.credential_ids.length,
        expires_at_ms: session.expires_at_ms,
      },
      {
        "Cache-Control": "no-store",
        ...(relaySession ? { "Set-Cookie": buildRelayCookie(session.token, session.expires_at_ms) } : {}),
      }
    );
  } catch (error) {
    console.warn("[ai.ubq.fi] passkey assertion verification failed", {
      message: error instanceof Error ? error.message : String(error),
      expected_origin: challengeRecord.origin,
      expected_rp_id: challengeRecord.rp_id,
      credential_id_prefix: response.id.slice(0, 12),
      has_user_handle: Boolean(userEntry.value.handle),
      require_user_verification: isPasskeyUserAdmin(userEntry.value),
    });
    return openaiError(400, "Invalid passkey assertion", "invalid_request_error");
  }
};

export const handlePasskeySession = async (req: Request, options: { authenticatedPasskeyToken?: string } = {}): Promise<Response> => {
  const session = await getPasskeySessionForRequest(req, options.authenticatedPasskeyToken);
  if (!session) return openaiError(401, "Unauthorized", "invalid_api_key");
  return json(
    200,
    {
      user: {
        id: session.user.id,
        handle: session.user.handle,
        is_admin: isPasskeyUserAdmin(session.user),
        credential_count: session.user.credential_ids.length,
      },
      session: {
        created_at_ms: session.session.created_at_ms,
        expires_at_ms: session.session.expires_at_ms,
      },
    },
    { "Cache-Control": "no-store" }
  );
};

export const handlePasskeyLogout = async (req: Request, options: { authenticatedPasskeyToken?: string } = {}): Promise<Response> => {
  const session = await getPasskeySessionForRequest(req, options.authenticatedPasskeyToken);
  if (session) {
    const kv = await getKv();
    if (kv) await kv.delete(passkeySessionKey(session.token));
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "Set-Cookie": clearRelayCookie(),
    },
  });
};

export const handlePasskeyUsersList = async (): Promise<Response> => {
  const kvOrError = await getKvOrError();
  if (kvOrError instanceof Response) return kvOrError;
  const users: PasskeyUserRecord[] = [];
  for await (const entry of kvOrError.list<PasskeyUserRecord>({ prefix: [...AUTH_PREFIX, "users"] })) {
    const user = readStoredPasskeyUser(entry);
    if (user) users.push(user);
  }
  users.sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  return json(
    200,
    {
      object: "list",
      data: users.map(serializePasskeyUser),
    },
    { "Cache-Control": "no-store" }
  );
};

export const handlePasskeyUsersUpdate = async (req: Request): Promise<Response> => {
  const kvOrError = await getKvOrError();
  if (kvOrError instanceof Response) return kvOrError;
  const kv = kvOrError;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return openaiError(400, "Invalid JSON body", "invalid_request_error");
  }
  if (!isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");

  const id = getString(raw.id)?.trim() ?? "";
  if (!id) return openaiError(400, "id is required", "invalid_request_error");
  if (typeof raw.is_admin !== "boolean") {
    return openaiError(400, "is_admin must be a boolean", "invalid_request_error");
  }

  const key = passkeyUserKey(id);
  const entry = await kv.get<PasskeyUserRecord>(key);
  if (!entry.value) return openaiError(404, "Passkey user not found", "not_found");

  const next: PasskeyUserRecord = {
    ...entry.value,
    is_admin: raw.is_admin,
    updated_at_ms: nowMs(),
  };
  const commit = await kv.atomic().check(entry).set(key, next).commit();
  if (!commit.ok) {
    return openaiError(409, "Passkey user was modified concurrently; retry", "invalid_request_error");
  }

  return json(200, { user: serializePasskeyUser(next) }, { "Cache-Control": "no-store" });
};

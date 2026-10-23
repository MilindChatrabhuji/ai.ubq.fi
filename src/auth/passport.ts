import { getBearerToken, openaiError } from "../http.ts";
import { base64UrlDecode, base64UrlEncode, isRecord } from "../utils.ts";

const ISSUER = "https://passport.ubq.fi";
const ORIGIN = "https://ai.ubq.fi";
const CALLBACK = `${ORIGIN}/auth/callback`;
const SESSION_COOKIE = "__Host-uos_ai_passport_session";
const STATE_COOKIE = "__Host-uos_ai_passport_state";
const JWKS_TTL_MS = 300_000;
const COOKIE_ATTRIBUTES = "; Path=/; HttpOnly; Secure; SameSite=Lax";

type PassportClaims = Readonly<{
  iss: string;
  sub: string;
  handle?: string;
  isAdmin: boolean;
  scopes?: string[];
  aud: string;
  clientId: string;
  auth: string;
  iat: number;
  exp: number;
  jti: string;
  agentTokenId?: string | null;
}>;

export type PassportAuthMethod = Readonly<{
  kind: "passport_session";
  principal: string;
  user: Readonly<{
    sub: string;
    handle: string;
    is_admin: boolean;
    scopes: readonly string[];
    auth: string;
    exp: number;
    jti: string;
    agent_token_id: string | null;
  }>;
}>;

type PassportResult = Readonly<{ ok: true; token: null; method: PassportAuthMethod }> | Readonly<{ ok: false; response: Response }>;
type PassportAdminResult =
  Readonly<{ ok: true; token: string; method: PassportAuthMethod; is_super_admin: false }> | Readonly<{ ok: false; response: Response }>;
let jwksCache: Readonly<{ expiresAt: number; keys: ReadonlyMap<string, CryptoKey> }> | null = null;

export const resetPassportCacheForTest = (): void => {
  jwksCache = null;
};

class PassportError extends Error {
  constructor(readonly status = 401) {
    super(status === 502 ? "Passport verification is unavailable." : "Unauthorized");
  }
}

const errorResponse = (error: unknown): Response => {
  const status = error instanceof PassportError ? error.status : 401;
  return openaiError(
    status,
    status === 502 ? "Passport verification is unavailable." : "Unauthorized",
    status === 502 ? "passport_unavailable" : "invalid_api_key",
    {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    }
  );
};

const cookie = (req: Request, name: string): string | null => {
  const values = (req.headers.get("cookie") ?? "").split(";").map((part) => part.trim());
  const matches = values.filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
};

// node:http receives Caddy's HTTP request with the original Host. Never derive
// the registered client, issuer or callback from forwarded hosts or user input.
const isPassportRequest = (req: Request): boolean => {
  const url = new URL(req.url);
  return url.host === "ai.ubq.fi" && (url.protocol === "https:" || (url.protocol === "http:" && req.headers.get("x-forwarded-proto") === "https"));
};

const boundedJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new PassportError(502);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new PassportError(502);
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

const isRsaSigningKey = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.kty === "RSA" && (value.alg === undefined || value.alg === "RS256") && (value.use === undefined || value.use === "sig");

const loadJwks = async (kid: string): Promise<ReadonlyMap<string, CryptoKey>> => {
  if (jwksCache && jwksCache.expiresAt > Date.now() && jwksCache.keys.has(kid)) return jwksCache.keys;
  try {
    const response = await fetch(`${ISSUER}/api/auth/jwks`, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await boundedJson(response, 262_144);
    if (!isRecord(body) || !Array.isArray(body.keys) || body.keys.length === 0) throw new PassportError(502);
    const keys = new Map<string, CryptoKey>();
    for (const value of body.keys as unknown[]) {
      if (!isRsaSigningKey(value)) continue;
      if (typeof value.kid !== "string" || !value.kid || value.kid.length > 200 || keys.has(value.kid)) throw new PassportError(502);
      if (typeof value.n !== "string" || typeof value.e !== "string") throw new PassportError(502);
      const modulusBytes = base64UrlDecode(value.n).byteLength;
      if (modulusBytes < 256 || modulusBytes > 1024 || base64UrlDecode(value.e).byteLength > 8) throw new PassportError(502);
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: value.n, e: value.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
      keys.set(value.kid, key);
    }
    if (keys.size === 0) throw new PassportError(502);
    jwksCache = { expiresAt: Date.now() + JWKS_TTL_MS, keys };
    return keys;
  } catch {
    throw new PassportError(502);
  }
};

const boundedString = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && value.length <= limit;

const validClaims = (value: unknown): value is PassportClaims => {
  if (!isRecord(value)) return false;
  const now = Math.floor(Date.now() / 1000);
  return (
    value.iss === ISSUER &&
    value.aud === "ai" &&
    value.clientId === "ai" &&
    boundedString(value.sub, 500) &&
    boundedString(value.jti, 500) &&
    boundedString(value.auth, 160) &&
    typeof value.isAdmin === "boolean" &&
    (value.handle === undefined || (typeof value.handle === "string" && value.handle.length <= 500)) &&
    (value.scopes === undefined ||
      (Array.isArray(value.scopes) &&
        value.scopes.length <= 128 &&
        value.scopes.every((scope: unknown) => typeof scope === "string" && scope.length <= 500))) &&
    typeof value.iat === "number" &&
    Number.isSafeInteger(value.iat) &&
    value.iat <= now + 60 &&
    typeof value.exp === "number" &&
    Number.isSafeInteger(value.exp) &&
    value.exp > now &&
    value.exp > value.iat &&
    (value.agentTokenId === undefined || value.agentTokenId === null || boundedString(value.agentTokenId, 500))
  );
};

const verifyToken = async (token: string): Promise<PassportClaims> => {
  if (!token || token.length > 32_768) throw new PassportError();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))) throw new PassportError();
  const header: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
  const claims: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  if (!isRecord(header) || header.alg !== "RS256" || header.typ !== "JWT" || !boundedString(header.kid, 200)) throw new PassportError();
  if (["jku", "x5u", "x5c", "jwk", "crit"].some((name) => Object.hasOwn(header, name)) || !validClaims(claims)) throw new PassportError();
  const keys = await loadJwks(header.kid);
  const key = keys.get(header.kid);
  if (!key || !(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) {
    throw new PassportError();
  }
  return claims;
};

export const authenticatePassportSession = async (req: Request): Promise<PassportResult | null> => {
  const token = cookie(req, SESSION_COOKIE);
  if (token === null) return null;
  if (!isPassportRequest(req)) return { ok: false, response: errorResponse(new PassportError()) };
  try {
    const claims = await verifyToken(token);
    return {
      ok: true,
      token: null,
      method: {
        kind: "passport_session",
        principal: `passport-user:${claims.sub}`,
        user: {
          sub: claims.sub,
          handle: claims.handle ?? "",
          is_admin: claims.isAdmin,
          scopes: claims.scopes ?? [],
          auth: claims.auth,
          exp: claims.exp,
          jti: claims.jti,
          agent_token_id: claims.agentTokenId ?? null,
        },
      },
    };
  } catch (error) {
    return { ok: false, response: errorResponse(error) };
  }
};

const isPassportBearer = (token: string | null): boolean => {
  if (token?.split(".").length !== 3) return false;
  try {
    const header: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(token.split(".")[0])));
    return isRecord(header) && typeof header.alg === "string";
  } catch {
    return false;
  }
};

const passportAdminRejection = (req: Request, method: PassportAuthMethod): Response | null => {
  if (method.user.agent_token_id !== null) return errorResponse(new PassportError());
  if (!method.user.is_admin) return openaiError(403, "Forbidden", "forbidden");
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  return (origin !== null && origin !== ORIGIN) || (site !== null && site !== "same-origin" && site !== "none")
    ? openaiError(403, "Forbidden", "forbidden")
    : null;
};

export const authenticatePassportAdmin = async (req: Request): Promise<PassportAdminResult | null> => {
  if (isPassportBearer(getBearerToken(req))) return { ok: false, response: errorResponse(new PassportError()) };
  const passport = await authenticatePassportSession(req);
  if (!passport?.ok) return passport;
  const rejection = passportAdminRejection(req, passport.method);
  return rejection ? { ok: false, response: rejection } : { ok: true, token: "", method: passport.method, is_super_admin: false };
};

const redirect = (location: string, cookies: readonly string[]): Response => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
};

const clearStateCookie = (): string => `${STATE_COOKIE}=; Max-Age=0${COOKIE_ATTRIBUTES}`;

const callback = async (req: Request): Promise<Response> => {
  try {
    const params = new URL(req.url).searchParams;
    const state = params.get("state");
    const code = params.get("code");
    if (
      !state ||
      !/^[A-Za-z0-9_-]{43}\.(?:admin|chat)$/.test(state) ||
      state !== cookie(req, STATE_COOKIE) ||
      !boundedString(code, 500) ||
      params.getAll("state").length !== 1 ||
      params.getAll("code").length !== 1
    )
      throw new PassportError();
    let response: Response;
    try {
      response = await fetch(`${ISSUER}/api/auth/sso/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code, clientId: "ai", audience: "ai", origin: ORIGIN, redirectUri: CALLBACK }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PassportError(502);
    }
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel();
      throw new PassportError(401);
    }
    const body = await boundedJson(response, 65_536);
    if (!isRecord(body) || typeof body.accessToken !== "string") throw new PassportError();
    const claims = await verifyToken(body.accessToken);
    if (claims.agentTokenId !== undefined && claims.agentTokenId !== null) throw new PassportError();
    const maxAge = claims.exp - Math.floor(Date.now() / 1000);
    return redirect(state.endsWith(".admin") ? "/admin" : "/chat", [
      `${SESSION_COOKIE}=${body.accessToken}; Max-Age=${maxAge}${COOKIE_ATTRIBUTES}`,
      clearStateCookie(),
    ]);
  } catch (error) {
    const response = errorResponse(error);
    response.headers.append("Set-Cookie", clearStateCookie());
    return response;
  }
};

/** Browser Passport routes share the exact registered production client. */
export const handlePassportRoute = async (req: Request, path: string): Promise<Response | null> => {
  if (!["/auth/login", "/auth/callback", "/auth/logout"].includes(path)) return null;
  if (!isPassportRequest(req)) return errorResponse(new PassportError());
  if (req.method !== (path === "/auth/logout" ? "POST" : "GET")) return openaiError(405, "Method not allowed", "method_not_allowed");
  if (path === "/auth/callback") return await callback(req);
  if (path === "/auth/logout") {
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    if ((origin !== null && origin !== ORIGIN) || (site !== null && site !== "same-origin" && site !== "none"))
      return openaiError(403, "Forbidden", "forbidden");
    return new Response(null, { status: 204, headers: { "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0${COOKIE_ATTRIBUTES}`, "Cache-Control": "no-store" } });
  }
  const target = new URL(req.url).searchParams.get("return_to") === "/admin" ? "admin" : "chat";
  const state = `${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}.${target}`;
  const authorize = new URL(`${ISSUER}/authorize`);
  for (const [name, value] of Object.entries({ client_id: "ai", audience: "ai", origin: ORIGIN, redirect_uri: CALLBACK, state }))
    authorize.searchParams.set(name, value);
  return redirect(authorize.toString(), [`${STATE_COOKIE}=${state}; Max-Age=600${COOKIE_ATTRIBUTES}`]);
};

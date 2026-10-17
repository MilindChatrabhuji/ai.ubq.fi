import { parseTrustedAuthRelayOrigin } from "./auth/relay.ts";
import { config, runtimeDeploymentId, runtimeGitSha } from "./config.ts";
import { CEREBRAS_RATE_LIMIT_HEADERS } from "./provider/cerebras-rate-limits.ts";

export const STANDARD_RATE_LIMIT_HEADERS = ["RateLimit", "RateLimit-Policy", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"] as const;

const EXPOSED_RESPONSE_HEADERS = [
  "x-uos-warning",
  "x-uos-request-id",
  "x-uos-provider-request-id",
  "x-uos-upstream",
  "x-uos-router-revision",
  "x-uos-git-sha",
  "x-uos-deployment-id",
  "x-uos-cache",
  "ETag",
  "Retry-After",
  ...STANDARD_RATE_LIMIT_HEADERS,
  ...CEREBRAS_RATE_LIMIT_HEADERS,
  "x-codex-limit-name",
  "x-codex-primary-used-percent",
] as const;

const getRequestOrigin = (req?: Request): string | null => {
  const headerOrigin = req?.headers.get("origin");
  if (headerOrigin !== null && headerOrigin !== undefined) return parseTrustedAuthRelayOrigin(headerOrigin);
  try {
    return parseTrustedAuthRelayOrigin(new URL(req?.url ?? "").searchParams.get("cors_origin"));
  } catch {
    return null;
  }
};

export const corsHeaders = (req?: Request): HeadersInit => {
  const requestOrigin = getRequestOrigin(req);
  const configuredOrigin = config.allowOrigin;
  // Mirrors the previous `canUseCredentials ? requestOrigin : configuredOrigin`:
  // a falsy requestOrigin (empty string) fell back to configuredOrigin there too.
  const credentialsOrigin = requestOrigin && (configuredOrigin === "*" || configuredOrigin === requestOrigin) ? requestOrigin : null;
  return {
    "Access-Control-Allow-Origin": credentialsOrigin ?? configuredOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization,Content-Type,Idempotency-Key,If-None-Match,OpenAI-Beta,OpenAI-Organization,OpenAI-Project,X-GitHub-Owner,X-GitHub-Repo,X-GitHub-Installation-Id,X-Ubiquity-Kernel-Token",
    // Allow browser clients to read quota state, gateway warnings, cache validators, and backoff hints.
    "Access-Control-Expose-Headers": EXPOSED_RESPONSE_HEADERS.join(","),
    "Access-Control-Max-Age": "86400",
    ...(credentialsOrigin ? { "Access-Control-Allow-Credentials": "true", Vary: "Origin" } : {}),
  };
};

const isAdminPath = (req?: Request): boolean => {
  if (!req) return false;
  try {
    const path = new URL(req.url).pathname;
    return path === "/admin" || path === "/admin.html" || path.startsWith("/admin/");
  } catch {
    return false;
  }
};

export const withCors = (response: Response, req?: Request): Response => {
  const headers = new Headers(response.headers);
  if (isAdminPath(req)) headers.set("Cache-Control", "no-store");
  headers.set("x-uos-git-sha", runtimeGitSha());
  headers.set("x-uos-deployment-id", runtimeDeploymentId());
  if (!headers.has("x-uos-request-id")) headers.set("x-uos-request-id", crypto.randomUUID());
  for (const [key, value] of Object.entries(corsHeaders(req))) {
    if (key.toLowerCase() !== "vary") {
      headers.set(key, value);
      continue;
    }
    const varyTokens = new Map<string, string>();
    for (const token of `${headers.get("Vary") ?? ""},${value}`.split(",")) {
      const normalized = token.trim();
      if (normalized) varyTokens.set(normalized.toLowerCase(), normalized);
    }
    headers.set("Vary", varyTokens.has("*") ? "*" : [...varyTokens.values()].join(", "));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const withoutBody = (response: Response): Response =>
  new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

export const json = (status: number, body: unknown, extraHeaders: HeadersInit = {}): Response => {
  const headers = new Headers(extraHeaders);
  // extraHeaders wins over the JSON default, matching the previous object spread.
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
};

export const openaiError = (
  status: number,
  message: string,
  code?: string,
  options: { type?: string; param?: string | null; headers?: HeadersInit } = {}
): Response => {
  const type = (options.type ?? "invalid_request_error").trim() || "invalid_request_error";
  const error: Record<string, unknown> = {
    message,
    type,
    code,
  };
  if (Object.prototype.hasOwnProperty.call(options, "param")) {
    error.param = options.param ?? null;
  }
  return json(
    status,
    {
      error,
    },
    options.headers
  );
};

export const notFound = (): Response =>
  json(404, {
    error: {
      message: "Not found",
      type: "not_found",
      code: "not_found",
    },
  });

export const getBearerToken = (req: Request): string | null => {
  const value = req.headers.get("Authorization");
  if (!value) return null;
  // Equivalent to /^Bearer\s+(.+)$/i but linear: the original had overlapping
  // `\s+`/`.+` quantifiers, so an attacker-supplied value such as
  // "Bearer <N spaces><M chars>\u2028" forced O(N*M) backtracking on every request.
  // Because `\s+` is greedy, the captured token always starts with a
  // non-whitespace character, which makes `\S` an exact, ambiguity-free prefix.
  const match = /^Bearer\s+(\S[^\n\r\u2028\u2029]*)$/i.exec(value);
  const token = match?.[1]?.trim() ?? "";
  return token === "" ? null : token;
};

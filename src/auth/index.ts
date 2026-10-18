import { config, runtimeGitSha } from "../config.ts";
import { apiKeyIdKey, coerceApiKeyExpiresAtMs } from "../api-keys.ts";
import { type ApiKeyPolicy, authenticateApiKeyToken, getApiKeyUsageV3, looksLikeUosApiKey } from "../api-key-policy.ts";
import { json, openaiError } from "../http.ts";
import { getBearerToken } from "../http.ts";
import { resolveKernelQuotaPolicyState } from "../kernel/usage.ts";
import { recordKernelPolicyQueue } from "../kernel/policy-queue.ts";
import { getKv } from "../kv.ts";
import { isAdminAuthDisabledForRequest } from "./local-admin.ts";
import { resolveLocalDevelopmentApiKeyPolicy } from "./local-development-key.ts";
import { getPasskeySessionForRequest, isPasskeyUserAdmin } from "./passkeys.ts";
import { sha256Base64Url, sha256Hex } from "../utils.ts";
import type { ApiKeyRecord } from "../types.ts";
import { getEnv, getGitHubRepoHeaders, verifyKernelAttestation } from "../kernel/attestation.ts";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_TOKEN_CACHE_TTL_MS = 5 * 60_000;
const githubTokenCache = new Map<string, number>();

const looksLikeGitHubToken = (token: string): boolean => {
  const trimmed = token.trim();
  return trimmed.startsWith("gh") || trimmed.startsWith("github_pat_");
};

type GitHubTokenRepoAccessResult = { ok: true } | { ok: false; reason: "rejected" | "upstream_unavailable" };

const verifyGitHubTokenRepoAccess = async (token: string, owner: string, repo: string): Promise<GitHubTokenRepoAccessResult> => {
  const res = await fetch(`${GITHUB_API_BASE_URL}/repos/${owner}/${repo}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ai.ubq.fi",
    },
    redirect: "manual",
  });

  const status = res.status;

  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }

  if (res.ok) return { ok: true };
  if (status === 401 || status === 404) {
    return { ok: false, reason: "rejected" };
  }
  return { ok: false, reason: "upstream_unavailable" };
};

type ClientAuthMethod =
  | { kind: "disabled" }
  | { kind: "github_token"; owner: string; repo: string; state_id: string; limit_scope: "org" | "repo" }
  | { kind: "auth_tokens_allowlist" }
  | { kind: "kv_api_key"; key_id: string; policy: ApiKeyPolicy }
  | { kind: "admin_allowlist" }
  | { kind: "deno_deploy_token" }
  | { kind: "passkey_session"; user_id: string; handle: string; is_admin: boolean; credential_count: number };

type AuthenticateClientResult = { ok: true; token: string | null; method: ClientAuthMethod } | { ok: false; response: Response };

type CheckAdminTokenResult = { ok: true; kind: "admin_allowlist" | "deno_deploy_token" } | { ok: false; response: Response | null };

type AdminAuthMethod =
  | { kind: "disabled" }
  | { kind: "admin_allowlist" }
  | { kind: "deno_deploy_token" }
  | { kind: "passkey_session"; user_id: string; handle: string; is_admin: boolean; credential_count: number };

export type AdminAuthResult = { ok: true; token: string; method: AdminAuthMethod; is_super_admin: boolean } | { ok: false; response: Response };

type GitHubBearerVerification =
  | Readonly<{
      kind: "verified";
      owner: string;
      repo: string;
      stateId: string;
      cacheKey: string;
      cacheHit: boolean;
    }>
  | Readonly<{ kind: "rejected" | "unavailable"; response: Response }>
  | null;

const verifyGitHubBearer = async (req: Request, token: string): Promise<GitHubBearerVerification> => {
  if (!looksLikeGitHubToken(token)) return null;
  // An explicitly configured admin token remains an allowlisted credential,
  // even if its value happens to use a GitHub token prefix. Let the normal
  // admin-token check handle it without attempting GitHub attestation.
  if (config.adminTokens.has(token)) return null;

  const repoHeaders = getGitHubRepoHeaders(req);
  const kernelToken = (req.headers.get("X-Ubiquity-Kernel-Token") ?? "").trim();
  if (!repoHeaders && !kernelToken) {
    return { kind: "rejected", response: openaiError(401, "Unauthorized", "invalid_api_key") };
  }

  const attestation = await verifyKernelAttestation(req, {
    token,
    owner: repoHeaders?.owner,
    repo: repoHeaders?.repo,
  });
  if (!attestation.ok) {
    return {
      kind: attestation.response.status === 401 ? "rejected" : "unavailable",
      response: attestation.response,
    };
  }
  const { owner, repo } = attestation.payload;
  const stateId = attestation.payload.state_id;

  const cacheKey = await sha256Base64Url(`${token}:${owner}/${repo}`);
  const cachedUntil = githubTokenCache.get(cacheKey) ?? 0;
  if (cachedUntil > Date.now()) {
    return { kind: "verified", owner, repo, stateId, cacheKey, cacheHit: true };
  }

  try {
    const access = await verifyGitHubTokenRepoAccess(token, owner, repo);
    if (!access.ok && access.reason === "rejected") {
      return {
        kind: "rejected",
        response: openaiError(401, "Invalid GitHub token for repo", "invalid_auth_for_repo"),
      };
    }
    if (!access.ok) {
      return {
        kind: "unavailable",
        response: openaiError(502, "Failed to verify GitHub token", "bad_gateway"),
      };
    }
    return { kind: "verified", owner, repo, stateId, cacheKey, cacheHit: false };
  } catch (error) {
    console.error("[ai.ubq.fi] GitHub token verification failed:", error);
    return {
      kind: "unavailable",
      response: openaiError(502, "Failed to verify GitHub token", "bad_gateway"),
    };
  }
};

const authenticateGitHubToken = async (
  req: Request,
  token: string
): Promise<{ ok: true; method: ClientAuthMethod } | { ok: false; response: Response } | null> => {
  const verification = await verifyGitHubBearer(req, token);
  if (!verification) return null;
  if (verification.kind !== "verified") return { ok: false, response: verification.response };

  const { owner, repo, stateId } = verification;
  if (!verification.cacheHit) {
    githubTokenCache.set(verification.cacheKey, Date.now() + GITHUB_TOKEN_CACHE_TTL_MS);
  }
  const policyState = await resolveKernelQuotaPolicyState(owner, repo);
  if (!policyState.ok) return { ok: false, response: policyState.response };
  if (!policyState.has_policy) {
    await recordKernelPolicyQueue(owner, repo, getRequestPath(req));
  }
  return {
    ok: true,
    method: { kind: "github_token", owner, repo, state_id: stateId, limit_scope: policyState.limit_scope },
  };
};

const looksLikeUbqAiClientToken = (token: string): boolean => looksLikeUosApiKey(token);

const classifyToken = (token: string): string => {
  const trimmed = token.trim();
  if (!trimmed) return "unset";
  if (trimmed.startsWith("ddw_")) return "deno_deploy_like(ddw_)";
  if (looksLikeGitHubToken(trimmed)) return "github_prefix";
  if (trimmed.startsWith("uos_ai_session_")) return "uos_ai_session_prefix";
  if (looksLikeUosApiKey(trimmed)) return "uos_api_key";
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return "hex64";
  if (trimmed.includes("_")) return "has_underscore";
  return "other";
};

const getRequestPath = (req: Request): string => {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "unknown";
  }
};

/**
 * How a local development request is admitted. `"admin"` is the fully checked
 * listener bypass (a bound loopback peer plus origin checks); `"legacy"` is the
 * hostname-only fallback for a development checkout whose Git revision is
 * unknown, which stays policy-free. `null` means neither applies.
 *
 * The production timeline takes neither: the VPS serves Caddy-proxied public
 * traffic on its loopback listener, so a loopback peer or URL there proves
 * nothing about the caller (#262). It is checked before the listener bypass,
 * which also refuses it on its own.
 */
type LocalClientAuthMode = "admin" | "legacy" | null;

const resolveLocalClientAuthMode = (req: Request): LocalClientAuthMode => {
  if (config.isProductionTimeline) return null;
  if (isAdminAuthDisabledForRequest(req)) return "admin";
  if (config.isDeploy || runtimeGitSha() !== "unknown") return null;
  try {
    const hostname = new URL(req.url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" ? "legacy" : null;
  } catch {
    return null;
  }
};

type AuthLogEntry = Readonly<{
  scope: "client" | "admin";
  ok: boolean;
  method: string;
  status?: number;
  reason?: string;
  token_present: boolean;
  token_shape: string | null;
}>;

const getAuthHeaderSnapshot = (req: Request): Record<string, string | null> => {
  const owner = (req.headers.get("X-GitHub-Owner") ?? "").trim();
  const repo = (req.headers.get("X-GitHub-Repo") ?? "").trim();
  const installationId = (req.headers.get("X-GitHub-Installation-Id") ?? "").trim();
  const kernelTokenPresent = Boolean((req.headers.get("X-Ubiquity-Kernel-Token") ?? "").trim());
  return {
    "x-github-owner": owner || null,
    "x-github-repo": repo || null,
    "x-github-installation-id": installationId || null,
    "x-ubiquity-kernel-token": kernelTokenPresent ? "present" : "missing",
  };
};

const logAuthDecision = (req: Request, entry: AuthLogEntry): void => {
  if (entry.ok) return;
  const payload = {
    ...entry,
    path: getRequestPath(req),
    headers: getAuthHeaderSnapshot(req),
  };
  const line = JSON.stringify(payload);
  console.warn("[ai.ubq.fi] auth", line);
};

const getPasskeyCookieSessionForRequest = (req: Request) => {
  const passkeyHeaders = new Headers(req.headers);
  passkeyHeaders.delete("authorization");
  return getPasskeySessionForRequest(new Request(req.url, { headers: passkeyHeaders }));
};

type ClientAuthLogger = (entry: Omit<AuthLogEntry, "scope" | "token_present" | "token_shape">) => void;

type ClientPasskeySession = NonNullable<Awaited<ReturnType<typeof getPasskeySessionForRequest>>>;

const passkeyClientResult = (token: string | null, passkeySession: ClientPasskeySession): AuthenticateClientResult => ({
  ok: true,
  token,
  method: {
    kind: "passkey_session",
    user_id: passkeySession.user.id,
    handle: passkeySession.user.handle,
    is_admin: isPasskeyUserAdmin(passkeySession.user),
    credential_count: passkeySession.user.credential_ids.length,
  },
});

const authenticateClientWithoutToken = async (req: Request, logClientAuth: ClientAuthLogger): Promise<AuthenticateClientResult> => {
  const passkeySession = await getPasskeySessionForRequest(req);
  if (passkeySession) {
    logClientAuth({ ok: true, method: "passkey_session" });
    return passkeyClientResult(passkeySession.token, passkeySession);
  }
  logClientAuth({ ok: false, method: "missing", status: 401, reason: "missing_token" });
  return { ok: false, response: openaiError(401, "Unauthorized", "invalid_api_key") };
};

const authenticateClientSessionToken = async (req: Request, token: string, logClientAuth: ClientAuthLogger): Promise<AuthenticateClientResult> => {
  const passkeySession = await getPasskeySessionForRequest(req);
  if (!passkeySession) {
    logClientAuth({ ok: false, method: "passkey_session", status: 401, reason: "invalid_api_key" });
    return { ok: false, response: openaiError(401, "Unauthorized", "invalid_api_key") };
  }
  logClientAuth({ ok: true, method: "passkey_session" });
  return passkeyClientResult(token, passkeySession);
};

const authenticateClientGitHubToken = async (req: Request, token: string, logClientAuth: ClientAuthLogger): Promise<AuthenticateClientResult | null> => {
  const githubResult = await authenticateGitHubToken(req, token);
  if (githubResult?.ok) {
    logClientAuth({ ok: true, method: "github_token" });
    return { ok: true, token, method: githubResult.method };
  }
  if (!githubResult) return null;
  // A rejected GitHub credential may still be accompanied by a browser session
  // cookie, which is then accepted as the passkey session.
  if (githubResult.response.status === 401 && req.headers.has("cookie")) {
    const passkeySession = await getPasskeyCookieSessionForRequest(req);
    if (passkeySession) {
      logClientAuth({ ok: true, method: "passkey_session" });
      return passkeyClientResult(passkeySession.token, passkeySession);
    }
  }
  logClientAuth({ ok: false, method: "github_token", status: githubResult.response.status, reason: "github_token_rejected" });
  return { ok: false, response: githubResult.response };
};

const authenticateClientKvApiKey = async (
  token: string,
  kv: Awaited<ReturnType<typeof getKv>>,
  logClientAuth: ClientAuthLogger
): Promise<AuthenticateClientResult | null> => {
  if (!looksLikeUosApiKey(token)) return null;
  const result = await authenticateApiKeyToken(token, { kv });
  if (!result.ok) {
    logClientAuth({ ok: false, method: "kv_api_key", status: result.response.status, reason: "invalid_or_limited" });
    return result;
  }
  logClientAuth({ ok: true, method: "kv_api_key" });
  return {
    ok: true,
    token,
    method: {
      kind: "kv_api_key",
      key_id: result.policy.key_id,
      policy: result.policy,
    },
  };
};

const authenticateClientAdminToken = async (token: string, logClientAuth: ClientAuthLogger): Promise<AuthenticateClientResult | null> => {
  const adminResult = await checkAdminToken(token);
  if (adminResult.ok) {
    logClientAuth({ ok: true, method: adminResult.kind });
    return { ok: true, token, method: { kind: adminResult.kind } };
  }
  if (!adminResult.response) return null;
  logClientAuth({
    ok: false,
    method: "deno_deploy_token",
    status: adminResult.response.status,
    reason: "admin_token_verification_failed",
  });
  return { ok: false, response: adminResult.response };
};

const logUnknownClientAuth = (logClientAuth: ClientAuthLogger, githubCandidate: boolean, githubHeaders: { owner: string; repo: string } | null): void => {
  const method = githubCandidate && !githubHeaders ? "github_token" : "unknown";
  logClientAuth({
    ok: false,
    method,
    status: 401,
    reason: method === "github_token" ? "missing_repo_headers" : "invalid_api_key",
  });
};

const authenticateLocalClient = async (
  mode: Exclude<LocalClientAuthMode, null>,
  kv: Awaited<ReturnType<typeof getKv>>,
  token: string | null,
  logClientAuth: ClientAuthLogger
): Promise<AuthenticateClientResult> => {
  // A loopback development server provisions one unlimited local key so the
  // fully checked listener bypass is a super admin with a real paid-provider
  // policy. The key is optional: without it (or once it is revoked) the
  // principal stays policy-free, exactly as before.
  //
  // The hostname-only legacy fallback never resolves that key: it applies only
  // after the peer/origin checks failed, so a mismatching-Origin request stays
  // policy-free instead of receiving the paid super-admin principal.
  const localDevelopmentPolicy = mode === "admin" ? await resolveLocalDevelopmentApiKeyPolicy(kv) : null;
  if (localDevelopmentPolicy) {
    logClientAuth({ ok: true, method: "local_development_key" });
    return { ok: true, token, method: { kind: "kv_api_key", key_id: localDevelopmentPolicy.key_id, policy: localDevelopmentPolicy } };
  }
  logClientAuth({ ok: true, method: "disabled" });
  return { ok: true, token, method: { kind: "disabled" } };
};

export const authenticateClient = async (req: Request): Promise<AuthenticateClientResult> => {
  const kv = await getKv();
  const localAuthMode = resolveLocalClientAuthMode(req);
  const token = getBearerToken(req);
  const tokenPresent = Boolean(token);
  const tokenShape = token ? classifyToken(token) : null;
  const githubHeaders = token ? getGitHubRepoHeaders(req) : null;
  const githubCandidate = token ? looksLikeGitHubToken(token) : false;
  const logClientAuth: ClientAuthLogger = (entry) => {
    logAuthDecision(req, {
      scope: "client",
      token_present: tokenPresent,
      token_shape: tokenShape,
      ...entry,
    });
  };
  if (localAuthMode !== null) return await authenticateLocalClient(localAuthMode, kv, token, logClientAuth);

  if (!token) return await authenticateClientWithoutToken(req, logClientAuth);

  if (config.authTokens.has(token)) {
    logClientAuth({ ok: true, method: "auth_tokens_allowlist" });
    return { ok: true, token, method: { kind: "auth_tokens_allowlist" } };
  }

  if (token.startsWith("uos_ai_session_")) return await authenticateClientSessionToken(req, token, logClientAuth);

  const githubClient = await authenticateClientGitHubToken(req, token, logClientAuth);
  if (githubClient) return githubClient;

  const kvApiKeyClient = await authenticateClientKvApiKey(token, kv, logClientAuth);
  if (kvApiKeyClient) return kvApiKeyClient;

  const adminTokenClient = await authenticateClientAdminToken(token, logClientAuth);
  if (adminTokenClient) return adminTokenClient;

  if (kv) {
    logUnknownClientAuth(logClientAuth, githubCandidate, githubHeaders);
    return { ok: false, response: openaiError(401, "Unauthorized", "invalid_api_key") };
  }

  if (config.isDeploy && config.authTokens.size === 0) {
    logClientAuth({ ok: false, method: "server", status: 500, reason: "misconfigured" });
    return {
      ok: false,
      response: openaiError(500, "Server misconfigured: set UOS_AI_TOKEN or enable Deno KV", "server_error"),
    };
  }

  logClientAuth({ ok: false, method: "unknown", status: 401, reason: "invalid_api_key" });
  return { ok: false, response: openaiError(401, "Unauthorized", "invalid_api_key") };
};

const DENO_API_V1_BASE_URL = "https://api.deno.com/v1";
const DENO_API_V2_BASE_URL = "https://api.deno.com/v2";
const DENO_CONSOLE_BASE_URL = "https://console.deno.com";
const DEPLOY_TOKEN_ADMIN_CACHE_TTL_MS = 10 * 60_000;
const deployTokenAdminCache = new Map<string, number>();

const looksLikeDenoDeployToken = (token: string): boolean => {
  const trimmed = token.trim();
  if (trimmed.length < 20) return false;
  if (trimmed.length > 500) return false;
  if (/\s/.test(trimmed)) return false;
  if (looksLikeUbqAiClientToken(trimmed)) return false;
  if (trimmed.startsWith("uos_ai_session_")) return false;
  if (!trimmed.includes("_")) return false;
  return true;
};

const fetchDenoApiOk = async (url: string, token: string): Promise<boolean> => {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    redirect: "manual",
  });

  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }

  return res.ok;
};

const fetchDenoConsoleAppOk = async (orgSlug: string, appSlug: string, token: string): Promise<boolean> => {
  const url = `${DENO_CONSOLE_BASE_URL}/${encodeURIComponent(orgSlug)}/${encodeURIComponent(appSlug)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/html",
      Cookie: `token=${token}; deno_auth_ghid=force`,
    },
    redirect: "manual",
  });

  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    return false;
  }

  const body = await res.text();
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] ?? "";
  return title.includes(`| ${appSlug} | Deploy`);
};

const verifyDenoDeployTokenForThisDeployment = async (token: string): Promise<boolean> => {
  const appSlug = (getEnv("DENO_DEPLOY_APP_SLUG") ?? "").trim();
  if (appSlug) {
    const appUrl = `${DENO_API_V2_BASE_URL}/apps/${encodeURIComponent(appSlug)}`;
    if (await fetchDenoApiOk(appUrl, token)) return true;
    const orgSlug = (getEnv("DENO_DEPLOY_ORG_SLUG") ?? "").trim();
    if (orgSlug && (await fetchDenoConsoleAppOk(orgSlug, appSlug, token))) return true;
  }

  const deploymentId = (getEnv("DENO_DEPLOYMENT_ID") ?? "").trim();
  if (!deploymentId) return false;

  const url = `${DENO_API_V1_BASE_URL}/deployments/${deploymentId}`;
  return await fetchDenoApiOk(url, token);
};

const verifyDenoDeployTokenCached = async (token: string): Promise<{ ok: true } | { ok: false; response: Response | null }> => {
  let keyHash: string | null = null;
  try {
    keyHash = await sha256Base64Url(token);
    const cachedUntil = deployTokenAdminCache.get(keyHash) ?? 0;
    if (cachedUntil > Date.now()) return { ok: true };
  } catch {
    // ignore and try network verification
  }

  try {
    const ok = await verifyDenoDeployTokenForThisDeployment(token);
    if (!ok) return { ok: false, response: null };
    if (keyHash) deployTokenAdminCache.set(keyHash, Date.now() + DEPLOY_TOKEN_ADMIN_CACHE_TTL_MS);
    return { ok: true };
  } catch (error) {
    console.error("[ai.ubq.fi] Failed to verify Deno Deploy token:", error);
    return { ok: false, response: openaiError(502, "Failed to verify admin token", "bad_gateway") };
  }
};

const checkAdminToken = async (token: string): Promise<CheckAdminTokenResult> => {
  if (config.adminTokens.has(token)) {
    return { ok: true, kind: "admin_allowlist" };
  }

  // GitHub credentials must be handled by the attested GitHub path. Never
  // treat an unattested GitHub credential as a candidate Deno Deploy token.
  if (looksLikeGitHubToken(token)) return { ok: false, response: null };

  if (!looksLikeDenoDeployToken(token)) return { ok: false, response: null };

  const verified = await verifyDenoDeployTokenCached(token);
  if (verified.ok) return { ok: true, kind: "deno_deploy_token" };
  return verified;
};

type AdminAuthLogger = (entry: Omit<AuthLogEntry, "scope" | "token_present" | "token_shape">) => void;

const adminGitHubVerificationRejection = (githubVerification: GitHubBearerVerification, logAdminAuth: AdminAuthLogger): AdminAuthResult | null => {
  if (githubVerification?.kind === "verified") {
    logAdminAuth({ ok: false, method: "github_token", status: 401, reason: "github_token_not_admin" });
    return { ok: false, response: openaiError(401, "Unauthorized", "invalid_api_key") };
  }
  if (githubVerification?.kind === "unavailable") {
    logAdminAuth({
      ok: false,
      method: "github_token",
      status: githubVerification.response.status,
      reason: "github_token_verification_failed",
    });
    return { ok: false, response: githubVerification.response };
  }
  return null;
};

const adminPasskeyResult = (passkeySession: ClientPasskeySession, logAdminAuth: AdminAuthLogger): AdminAuthResult => {
  if (!isPasskeyUserAdmin(passkeySession.user)) {
    logAdminAuth({ ok: false, method: "passkey_session", status: 403, reason: "passkey_user_not_admin" });
    return { ok: false, response: openaiError(403, "Forbidden", "forbidden") };
  }
  logAdminAuth({ ok: true, method: "passkey_session" });
  return {
    ok: true,
    token: passkeySession.token,
    is_super_admin: false,
    method: {
      kind: "passkey_session",
      user_id: passkeySession.user.id,
      handle: passkeySession.user.handle,
      is_admin: true,
      credential_count: passkeySession.user.credential_ids.length,
    },
  };
};

const authenticateAdminTokenResult = async (token: string, logAdminAuth: AdminAuthLogger): Promise<AdminAuthResult> => {
  if (looksLikeGitHubToken(token) && !config.adminTokens.has(token)) {
    logAdminAuth({ ok: false, method: "github_token", status: 401, reason: "missing_github_attestation" });
    return { ok: false, response: openaiError(401, "Unauthorized", "invalid_api_key") };
  }

  if (config.adminTokens.size === 0 && !looksLikeDenoDeployToken(token)) {
    logAdminAuth({ ok: false, method: "admin_allowlist", status: 401, reason: "admin_tokens_unconfigured" });
    return { ok: false, response: openaiError(401, "Unauthorized", "invalid_api_key") };
  }

  const result = await checkAdminToken(token);
  if (result.ok) {
    logAdminAuth({ ok: true, method: result.kind });
    return { ok: true, token, is_super_admin: true, method: { kind: result.kind } };
  }
  if (result.response) {
    logAdminAuth({
      ok: false,
      method: "deno_deploy_token",
      status: result.response.status,
      reason: "admin_token_verification_failed",
    });
    return { ok: false, response: result.response };
  }
  logAdminAuth({ ok: false, method: "admin_allowlist", status: 401, reason: "invalid_admin_token" });
  return { ok: false, response: openaiError(401, "Unauthorized", "invalid_api_key") };
};

export const authenticateAdmin = async (req: Request): Promise<AdminAuthResult> => {
  const token = getBearerToken(req);
  const tokenPresent = Boolean(token);
  const tokenShape = token ? classifyToken(token) : null;
  const logAdminAuth: AdminAuthLogger = (entry) => {
    logAuthDecision(req, {
      scope: "admin",
      token_present: tokenPresent,
      token_shape: tokenShape,
      ...entry,
    });
  };
  if (isAdminAuthDisabledForRequest(req)) {
    logAdminAuth({ ok: true, method: "disabled" });
    return {
      ok: true,
      token: token ?? "local-dev-admin",
      is_super_admin: true,
      method: { kind: "disabled" },
    };
  }
  let passkeySession = await getPasskeySessionForRequest(req);
  if (!passkeySession && token && looksLikeGitHubToken(token) && !config.adminTokens.has(token) && !config.authTokens.has(token) && req.headers.has("cookie")) {
    const githubVerification = await verifyGitHubBearer(req, token);
    const rejection = adminGitHubVerificationRejection(githubVerification, logAdminAuth);
    if (rejection) return rejection;
    if (githubVerification?.kind === "rejected") {
      passkeySession = await getPasskeyCookieSessionForRequest(req);
    }
  }
  if (passkeySession) return adminPasskeyResult(passkeySession, logAdminAuth);

  if (!token) {
    logAdminAuth({ ok: false, method: "missing", status: 401, reason: "missing_token" });
    return { ok: false, response: openaiError(401, "Unauthorized", "invalid_api_key") };
  }

  return await authenticateAdminTokenResult(token, logAdminAuth);
};

export const requireAdminAuth = async (req: Request): Promise<Response | null> => {
  const result = await authenticateAdmin(req);
  return result.ok ? null : result.response;
};

type ReportedAuthMethod = AdminAuthMethod | ClientAuthMethod;

type V1ApiKeyMethodResult = Readonly<{ ok: true; key: Record<string, unknown> }> | Readonly<{ ok: false; response: Response }>;

const resolveV1AuthMode = (localClientAuthDisabled: boolean, kv: Awaited<ReturnType<typeof getKv>>): "disabled" | "misconfigured" | "required" => {
  if (localClientAuthDisabled) return "disabled";
  if (config.isDeploy && config.authTokens.size === 0 && !kv) return "misconfigured";
  if (config.isDeploy || config.authTokens.size > 0 || Boolean(kv)) return "required";
  return "disabled";
};

const v1AuthTokenInfo = async (token: string | null): Promise<Record<string, unknown>> => {
  if (!token) {
    return {
      present: false,
      length: null,
      shape: null,
      sha256_12: null,
    };
  }
  return {
    present: true,
    length: token.length,
    shape: classifyToken(token),
    sha256_12: (await sha256Hex(token)).slice(0, 12),
  };
};

const v1AdminFlags = (localAdminAuth: AdminAuthResult | null, reportingMethod: ReportedAuthMethod): Readonly<{ isAdmin: boolean; isSuperAdmin: boolean }> => {
  const isAdmin =
    localAdminAuth?.ok === true ||
    reportingMethod.kind === "admin_allowlist" ||
    reportingMethod.kind === "deno_deploy_token" ||
    (reportingMethod.kind === "passkey_session" && reportingMethod.is_admin);
  const isSuperAdmin = localAdminAuth?.ok
    ? localAdminAuth.is_super_admin
    : reportingMethod.kind === "admin_allowlist" || reportingMethod.kind === "deno_deploy_token";
  return { isAdmin, isSuperAdmin };
};

const v1ApiKeyMethodResult = async (
  reportingMethod: Extract<ReportedAuthMethod, { kind: "kv_api_key" }>,
  kv: Awaited<ReturnType<typeof getKv>>
): Promise<V1ApiKeyMethodResult> => {
  const id = reportingMethod.key_id;
  let key: Record<string, unknown> = { id };
  if (kv) {
    const entry = await kv.get<ApiKeyRecord>(apiKeyIdKey(id));
    if (entry.value) {
      let usageRequests: number;
      try {
        usageRequests = await getApiKeyUsageV3(reportingMethod.policy, kv);
      } catch (error) {
        console.warn("[ai.ubq.fi] Failed to read API key quota usage for /uos/auth:", error);
        return { ok: false, response: openaiError(503, "API key quota ledger is unavailable", "server_error", { type: "server_error" }) };
      }
      key = {
        id: entry.value.id,
        name: entry.value.name,
        prefix: entry.value.prefix,
        created_at_ms: entry.value.created_at_ms,
        expires_at_ms: coerceApiKeyExpiresAtMs(entry.value),
        revoked_at_ms: entry.value.revoked_at_ms,
        usage_limit_requests: reportingMethod.policy.usage_limit_requests,
        usage_requests: usageRequests,
        usage_reset_at_ms: reportingMethod.policy.usage_reset_at_ms,
        window_ms: reportingMethod.policy.window_ms,
      };
    }
  }
  return { ok: true, key };
};

export const handleV1Auth = async (req: Request): Promise<Response> => {
  const authResult = await authenticateClient(req);
  if (!authResult.ok) return authResult.response;

  const kv = await getKv();
  const localClientAuthDisabled = resolveLocalClientAuthMode(req) !== null;
  const mode = resolveV1AuthMode(localClientAuthDisabled, kv);

  const token = authResult.token;
  const tokenInfo = await v1AuthTokenInfo(token);

  // Local client auth remains disabled for the development inference surface,
  // but admin access is resolved independently. This keeps localhost from
  // implicitly becoming an admin while still recognizing an explicit admin
  // credential when the CLI bypass is off.
  const localAdminAuth = localClientAuthDisabled ? await authenticateAdmin(req) : null;
  const reportingMethod = localAdminAuth?.ok ? localAdminAuth.method : authResult.method;
  const method: Record<string, unknown> = { kind: reportingMethod.kind };
  const { isAdmin, isSuperAdmin } = v1AdminFlags(localAdminAuth, reportingMethod);

  if (reportingMethod.kind === "github_token") {
    method.repo = { owner: reportingMethod.owner, repo: reportingMethod.repo };
    method.state_id = reportingMethod.state_id;
    method.limit_scope = reportingMethod.limit_scope;
  }

  if (reportingMethod.kind === "kv_api_key") {
    const keyResult = await v1ApiKeyMethodResult(reportingMethod, kv);
    if (!keyResult.ok) return keyResult.response;
    method.key = keyResult.key;
  }

  if (reportingMethod.kind === "passkey_session") {
    method.user = {
      id: reportingMethod.user_id,
      handle: reportingMethod.handle,
      is_admin: reportingMethod.is_admin,
      credential_count: reportingMethod.credential_count,
    };
  }

  return json(
    200,
    {
      ok: true,
      service: "ai.ubq.fi",
      auth: {
        mode,
        is_admin: isAdmin,
        is_super_admin: isSuperAdmin,
        method,
        token: tokenInfo,
      },
    },
    { "Cache-Control": "no-store" }
  );
};

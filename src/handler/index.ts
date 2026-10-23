import { handleAdminCodexResetConsume } from "../admin/codex-reset.ts";
import {
  handleAdminApiKeyChanges,
  handleAdminApiKeysCreate,
  handleAdminApiKeysDelete,
  handleAdminApiKeysList,
  handleAdminApiKeysPaidFallbacks,
  handleAdminApiKeysRevoke,
  handleAdminApiKeysUnrevoke,
  handleAdminApiKeysUpdate,
  handleAdminClaudeCodeAccess,
  handleAdminClaudeCodeAccountActive,
  handleAdminClaudeCodeAuthDelete,
  handleAdminClaudeCodeAuthGet,
  handleAdminClaudeCodeAuthSet,
  handleAdminClaudeCodeQuotaClear,
  handleAdminCodexAuth,
  handleAdminCodexBankedResetShadowDecisions,
  handleAdminCodexCacheScopeExperiment,
  handleAdminCodexCacheScopeExperimentTelemetryBaseline,
  handleAdminCodexModelsGet,
  handleAdminCodexModelsSet,
  handleAdminCodexModelsWhitelistGet,
  handleAdminCodexModelsWhitelistSet,
  handleAdminCodexPromptsPurge,
  handleAdminCodexRecheck,
  handleAdminCodexResetSettings,
  handleAdminCodexOverageUsage,
  handleAdminDebugRouting,
  handleAdminDefaults,
  handleAdminKernelPolicyQueueList,
  handleAdminKernelPubKeysCreate,
  handleAdminKernelPubKeysDelete,
  handleAdminKernelPubKeysList,
  handleAdminKernelUsageDelete,
  handleAdminKernelUsageGet,
  handleAdminKernelUsageSet,
  handleAdminKvMigrationImport,
  handleAdminKvMigrationValidate,
  handleAdminModelsCatalogGet,
  handleAdminModelsRefresh,
  handleAdminPromptCacheAnalytics,
  handleAdminProviderSelectionGet,
  handleAdminProviderSelectionSet,
  handleAdminProvidersQuotaProjection,
  handleAdminProvidersQuotaProjectionBackfill,
} from "../admin/index.ts";
import { handleAdminErrors } from "../admin/error-log.ts";
import { proxyAdminChartSource } from "../admin/chart-source-proxy.ts";
import { handleCapacityObservationIngest } from "../admin/capacity-observation-sync.ts";
import type { ApiKeyAuditContext } from "../admin/api-key-audit.ts";
import { handleAgentMessagesList, handleAgentMessagesPost } from "../agent-messages.ts";
import { authenticateAdmin, authenticateClient, handleV1Auth, requireAdminAuth, type AdminAuthResult } from "../auth/index.ts";
import {} from "../api-key-policy.ts";

import { handleAdminCodexSupervisorOutput, handleAdminCodexSupervisorSessions } from "../codex/supervisor.ts";
import { handleAdminCodexSupervisorBrief } from "../codex/supervisor-brief.ts";
import { handleHealth, handleHealthProviders, handleHealthUpstream } from "../health.ts";
import { corsHeaders, notFound, openaiError, withCors as withCorsHeaders, withoutBody } from "../http.ts";
import {} from "../inference-admission.ts";

import { handleModelCapabilities, handlePublicModelCatalog } from "../models/catalog.ts";
import { handleLiveRoute } from "../live/handler.ts";

import {
  handlePasskeyLoginFinish,
  handlePasskeyLoginStart,
  handlePasskeyLogout,
  handlePasskeyRegisterFinish,
  handlePasskeyRegisterStart,
  handlePasskeySession,
  handlePasskeyUsersList,
  handlePasskeyUsersUpdate,
} from "../auth/passkeys.ts";

import { handleRoot, handleStaticAsset } from "../static.ts";
import { handlePassportRoute } from "../auth/passport.ts";

import { handleProviderCapacity, handleProviderCapacityRollups } from "../provider/capacity.ts";
import {} from "../sentinel/replay-capture.ts";

import { handleAdminSentinelReplayCaptures } from "../sentinel/replay-admin.ts";
import { handleAdminSentinelIncidents } from "../admin/sentinel-incident.ts";

import { type ClientAuthResult, type RequestDeliveryInfo, normalizePath } from "./http.ts";
import { handleTerminalRoute } from "./terminal-route.ts";

type ExactRouteEntry = Readonly<{
  methods: readonly string[];
  path: string;
  run: (req: Request) => Response | Promise<Response>;
}>;

/** The authenticated admin identity and request id handed to key mutations. */
type AdminRouteContext = Readonly<{ auth: AdminAuthResult; requestId: string }>;

/** An authenticated admin route. Every admin credential reaches every route. */
type AdminRouteEntry = Readonly<{
  methods: readonly string[];
  path: string;
  run: (req: Request, context: AdminRouteContext) => Response | Promise<Response>;
}>;

/** The subset a route needs for matching, shared by auth and admin route tables. */
type RouteMatch = Readonly<{ methods: readonly string[]; path: string }>;

/** The first exact-path route matching this request, if any. */
const matchExactRoute = <TRoute extends RouteMatch>(routes: readonly TRoute[], req: Request, path: string): TRoute | undefined =>
  routes.find((entry) => entry.methods.includes(req.method) && entry.path === path);

/** Projects the router auth into the key-audit context. */
const apiKeyAuditContext = (context: AdminRouteContext): ApiKeyAuditContext => ({ auth: context.auth, request_id: context.requestId });

/** Reads the optional client authentication used by the session and logout routes. */
const optionalClientAuth = async (req: Request): Promise<ClientAuthResult | null> =>
  req.headers.has("authorization") && req.headers.has("cookie") ? await authenticateClient(req) : null;

/** The passkey token to relay for an opportunistic client authentication. */
const passkeyTokenFrom = (auth: ClientAuthResult | null): string | undefined => {
  if (!auth?.ok) return undefined;
  return auth.method.kind === "passkey_session" ? (auth.token ?? undefined) : undefined;
};

/** Exact-path passkey routes whose own handlers perform authentication. */
const AUTH_ROUTES: readonly ExactRouteEntry[] = [
  { methods: ["POST"], path: "/api/auth/register/finish", run: (req) => handlePasskeyRegisterFinish(req) },
  { methods: ["POST"], path: "/api/auth/login/start", run: (req) => handlePasskeyLoginStart(req) },
  { methods: ["POST"], path: "/api/auth/login/finish", run: (req) => handlePasskeyLoginFinish(req) },
];

/** Admin API routes in wire order; every one authenticates before dispatch. */
const ADMIN_ROUTES: readonly AdminRouteEntry[] = [
  { methods: ["GET"], path: "/admin/passkey-users", run: () => handlePasskeyUsersList() },
  { methods: ["PATCH"], path: "/admin/passkey-users", run: (req) => handlePasskeyUsersUpdate(req) },
  { methods: ["POST"], path: "/admin/codex/auth", run: (req) => handleAdminCodexAuth(req) },
  { methods: ["GET", "PATCH"], path: "/admin/providers/codex/banked-resets", run: (req) => handleAdminCodexResetSettings(req) },
  { methods: ["GET", "PATCH"], path: "/admin/providers/codex/overage-usage", run: (req) => handleAdminCodexOverageUsage(req) },
  { methods: ["GET"], path: "/admin/providers/codex/banked-resets/shadow-decisions", run: () => handleAdminCodexBankedResetShadowDecisions() },
  {
    methods: ["GET"],
    path: "/admin/providers/codex/cache-scope-experiment",
    run: () => handleAdminCodexCacheScopeExperimentTelemetryBaseline(),
  },
  { methods: ["POST"], path: "/admin/providers/codex/cache-scope-experiment", run: (req) => handleAdminCodexCacheScopeExperiment(req) },
  { methods: ["GET"], path: "/admin/codex/models", run: () => handleAdminCodexModelsGet() },
  { methods: ["POST"], path: "/admin/codex/models", run: (req) => handleAdminCodexModelsSet(req) },
  { methods: ["GET"], path: "/admin/models/whitelist", run: () => handleAdminCodexModelsWhitelistGet() },
  { methods: ["GET"], path: "/admin/models/catalog", run: () => handleAdminModelsCatalogGet() },
  { methods: ["POST"], path: "/admin/models/refresh", run: () => handleAdminModelsRefresh() },
  { methods: ["POST"], path: "/admin/models/whitelist", run: (req) => handleAdminCodexModelsWhitelistSet(req) },
  { methods: ["POST"], path: "/admin/codex/prompts/purge", run: () => handleAdminCodexPromptsPurge() },
  { methods: ["POST"], path: "/admin/kv-migration/import", run: (req) => handleAdminKvMigrationImport(req) },
  { methods: ["GET"], path: "/admin/kv-migration/validate", run: () => handleAdminKvMigrationValidate() },
  { methods: ["GET"], path: "/admin/sentinel/replay-captures", run: (req) => handleAdminSentinelReplayCaptures(req) },
  { methods: ["GET"], path: "/admin/sentinel/incidents", run: (req) => handleAdminSentinelIncidents(req) },
  { methods: ["GET"], path: "/admin/codex/supervisor/sessions", run: () => handleAdminCodexSupervisorSessions() },
  { methods: ["GET"], path: "/admin/codex/supervisor/output", run: (req) => handleAdminCodexSupervisorOutput(req) },
  { methods: ["POST"], path: "/admin/codex/supervisor/brief", run: (req) => handleAdminCodexSupervisorBrief(req) },
  { methods: ["GET"], path: "/admin/errors", run: (req) => proxyAdminChartSource(req, handleAdminErrors(req)) },
  { methods: ["GET", "POST"], path: "/admin/defaults", run: (req) => handleAdminDefaults(req) },
  { methods: ["GET", "POST", "DELETE"], path: "/admin/debug/routing", run: (req) => handleAdminDebugRouting(req) },
  { methods: ["GET"], path: "/admin/providers", run: () => handleHealthProviders({ includeQuota: true }) },
  { methods: ["POST"], path: "/admin/providers/codex/banked-resets/consume", run: (req) => handleAdminCodexResetConsume(req) },
  { methods: ["GET"], path: "/admin/providers/selection", run: () => handleAdminProviderSelectionGet() },
  { methods: ["POST"], path: "/admin/providers/selection", run: (req) => handleAdminProviderSelectionSet(req) },
  { methods: ["GET"], path: "/admin/providers/capacity", run: (req) => proxyAdminChartSource(req, handleProviderCapacity(req)) },
  { methods: ["POST"], path: "/admin/providers/capacity/observations", run: (req) => handleCapacityObservationIngest(req) },
  { methods: ["GET"], path: "/admin/providers/capacity/rollups", run: (req) => handleProviderCapacityRollups(req) },
  { methods: ["GET", "POST"], path: "/admin/providers/claude-code/access", run: (req) => handleAdminClaudeCodeAccess(req) },
  { methods: ["POST"], path: "/admin/providers/claude-code/accounts/active", run: (req) => handleAdminClaudeCodeAccountActive(req) },
  { methods: ["GET"], path: "/admin/providers/claude-code/auth", run: () => handleAdminClaudeCodeAuthGet() },
  { methods: ["POST"], path: "/admin/providers/claude-code/auth", run: (req) => handleAdminClaudeCodeAuthSet(req) },
  { methods: ["DELETE"], path: "/admin/providers/claude-code/auth", run: (req) => handleAdminClaudeCodeAuthDelete(req) },
  { methods: ["POST"], path: "/admin/providers/claude-code/quota/clear", run: (req) => handleAdminClaudeCodeQuotaClear(req) },
  { methods: ["GET"], path: "/admin/providers/quota-projection", run: (req) => handleAdminProvidersQuotaProjection(req) },
  { methods: ["POST"], path: "/admin/providers/quota-projection/backfill", run: (req) => handleAdminProvidersQuotaProjectionBackfill(req) },
  { methods: ["GET"], path: "/admin/prompt-cache-analytics", run: (req) => handleAdminPromptCacheAnalytics(req) },
  { methods: ["POST"], path: "/admin/api-keys", run: (req, context) => handleAdminApiKeysCreate(req, apiKeyAuditContext(context)) },
  { methods: ["GET"], path: "/admin/api-keys", run: (req) => handleAdminApiKeysList(req) },
  { methods: ["GET"], path: "/admin/api-keys/changes", run: (req) => handleAdminApiKeyChanges(req) },
  { methods: ["PATCH"], path: "/admin/api-keys", run: (req, context) => handleAdminApiKeysUpdate(req, apiKeyAuditContext(context)) },
  { methods: ["POST"], path: "/admin/api-keys/revoke", run: (req, context) => handleAdminApiKeysRevoke(req, apiKeyAuditContext(context)) },
  { methods: ["POST"], path: "/admin/api-keys/unrevoke", run: (req, context) => handleAdminApiKeysUnrevoke(req, apiKeyAuditContext(context)) },
  { methods: ["DELETE"], path: "/admin/api-keys", run: (req, context) => handleAdminApiKeysDelete(req, apiKeyAuditContext(context)) },
  { methods: ["GET"], path: "/admin/kernel-usage", run: (req) => handleAdminKernelUsageGet(req) },
  { methods: ["GET"], path: "/admin/kernel-policy-queue", run: () => handleAdminKernelPolicyQueueList() },
  { methods: ["POST"], path: "/admin/kernel-usage", run: (req) => handleAdminKernelUsageSet(req) },
  { methods: ["DELETE"], path: "/admin/kernel-usage", run: (req) => handleAdminKernelUsageDelete(req) },
  { methods: ["GET"], path: "/admin/kernel-pubkeys", run: () => handleAdminKernelPubKeysList() },
  { methods: ["POST"], path: "/admin/kernel-pubkeys", run: (req) => handleAdminKernelPubKeysCreate(req) },
  { methods: ["DELETE"], path: "/admin/kernel-pubkeys", run: (req) => handleAdminKernelPubKeysDelete(req) },
];

/** Serves the root document and static assets; null when nothing matches. */
const handleStaticRoute = async (req: Request, path: string): Promise<Response | null> => {
  if ((req.method === "GET" || req.method === "HEAD") && (path === "/" || path === "/index.html")) {
    const rootResponse = await handleRoot(req);
    return req.method === "HEAD" ? withoutBody(rootResponse) : rootResponse;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const staticResponse = await handleStaticAsset(path);
    if (staticResponse) return req.method === "HEAD" ? withoutBody(staticResponse) : staticResponse;
  }
  return null;
};

/** Serves the liveness endpoints; null when no health path matches. */
const handleHealthRoute = async (req: Request, path: string): Promise<Response | null> => {
  if ((req.method === "GET" || req.method === "HEAD") && path === "/health") {
    const health = handleHealth();
    // Keep HEAD semantically equivalent to public GET liveness while correctly
    // omitting the body.
    return req.method === "HEAD" ? withoutBody(health) : health;
  }
  if (req.method !== "GET") return null;
  if (path === "/health/providers") {
    const authError = await requireAdminAuth(req);
    if (authError) return authError;
    return await handleHealthProviders();
  }
  if (path === "/health/upstream") {
    const authError = await requireAdminAuth(req);
    if (authError) return authError;
    return await handleHealthUpstream();
  }
  return null;
};

/** Serves the passkey and session routes; null when no auth route matches. */
const handleAuthRoute = async (req: Request, path: string): Promise<Response | null> => {
  const passport = await handlePassportRoute(req, path);
  if (passport) return passport;
  if (req.method === "POST" && path === "/api/auth/register/start") {
    const auth = await authenticateAdmin(req);
    if (!auth.ok) return auth.response;
    return await handlePasskeyRegisterStart(req, {
      // Every authenticated admin may register another admin passkey: the
      // console no longer has a super-admin tier.
      defaultIsAdmin: true,
      authenticatedPasskeyToken: auth.method.kind === "passkey_session" ? auth.token : undefined,
    });
  }
  const route = matchExactRoute(AUTH_ROUTES, req, path);
  if (route) return await route.run(req);
  if (req.method === "GET" && path === "/api/auth/session") {
    return await handlePasskeySession(req, { authenticatedPasskeyToken: passkeyTokenFrom(await optionalClientAuth(req)) });
  }
  if (req.method === "POST" && path === "/api/auth/logout") {
    return await handlePasskeyLogout(req, { authenticatedPasskeyToken: passkeyTokenFrom(await optionalClientAuth(req)) });
  }
  return null;
};

/** Serves the API-key paid-fallback routes, including their method-not-allowed reply. */
const handleApiKeyPaidFallbacksRoute = async (req: Request, path: string): Promise<Response | null> => {
  const match = /^\/admin\/api-keys\/([^/]+)\/paid-fallbacks$/.exec(path);
  if (!match) return null;
  if (req.method !== "GET") return openaiError(405, "Method not allowed", "method_not_allowed");
  const authError = await requireAdminAuth(req);
  if (authError) return authError;
  let keyId: string;
  try {
    keyId = decodeURIComponent(match[1]);
  } catch {
    return openaiError(400, "Invalid API key id", "invalid_request_error");
  }
  return await handleAdminApiKeysPaidFallbacks(req, keyId);
};

/** Serves the admin API surface; null when no admin route matches. */
const handleAdminRoute = async (req: Request, path: string, requestId: string): Promise<Response | null> => {
  const route = matchExactRoute(ADMIN_ROUTES, req, path);
  if (route) {
    const auth = await authenticateAdmin(req);
    if (!auth.ok) return auth.response;
    return await route.run(req, { auth, requestId });
  }
  const recheckMatch = /^\/admin\/providers\/codex\/(\d+)\/recheck$/.exec(path);
  if (req.method === "POST" && recheckMatch) {
    const authError = await requireAdminAuth(req);
    if (authError) return authError;
    return await handleAdminCodexRecheck(Number(recheckMatch[1]));
  }
  return await handleApiKeyPaidFallbacksRoute(req, path);
};

/** The actual UOS catalog/message dispatch table, also consumed by the published-contract parity test. */
export const UOS_ROUTES: readonly ExactRouteEntry[] = [
  { methods: ["GET"], path: "/uos/auth", run: handleV1Auth },
  { methods: ["GET"], path: "/uos/models/catalog", run: () => handlePublicModelCatalog() },
  {
    methods: ["GET"],
    path: "/uos/models/capabilities",
    run: async (req) => {
      const authResult = await authenticateClient(req);
      if (!authResult.ok) return authResult.response;
      return await handleModelCapabilities();
    },
  },
  { methods: ["GET"], path: "/uos/agent-messages", run: handleAgentMessagesList },
  { methods: ["POST"], path: "/uos/agent-messages", run: handleAgentMessagesPost },
];

/** Serves the UOS catalog and agent-message routes; null when none matches. */
const handleUosRoute = async (req: Request, path: string): Promise<Response | null> => {
  const route = matchExactRoute(UOS_ROUTES, req, path);
  if (route) return await route.run(req);
  if (path === "/uos/agent-messages") return openaiError(405, "Method not allowed", "method_not_allowed");
  return null;
};

/** True when the path belongs to the authenticated terminal inference surface. */
const isTerminalInferencePath = (path: string): boolean =>
  path.startsWith("/v1/") || path === "/uos/embeddings" || path === "/uos/embedding-jobs" || path.startsWith("/uos/embedding-jobs/");

/** Terminal-logs a response that never reached a provider; a null route skips logging. */

export default async function handler(req: Request, delivery?: RequestDeliveryInfo): Promise<Response> {
  const requestStartedAtMs = Date.now();
  const requestStartedAtMonotonicMs = performance.now();
  const requestId = crypto.randomUUID();
  const withCors = (response: Response): Response => withCorsHeaders(response, req);
  if (req.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204, headers: corsHeaders(req) }));
  }

  const url = new URL(req.url);
  const path = normalizePath(url.pathname);

  const staticResponse = await handleStaticRoute(req, path);
  if (staticResponse) return withCors(staticResponse);
  const healthResponse = await handleHealthRoute(req, path);
  if (healthResponse) return withCors(healthResponse);
  const authRouteResponse = await handleAuthRoute(req, path);
  if (authRouteResponse) return withCors(authRouteResponse);
  const adminResponse = await handleAdminRoute(req, path, requestId);
  if (adminResponse) return withCors(adminResponse);
  const uosResponse = await handleUosRoute(req, path);
  if (uosResponse) return withCors(uosResponse);

  // The realtime voice relay decorates its own JSON responses. Actual WebSocket
  // switching is handled by the separate authenticated transport entry point.
  const liveResponse = await handleLiveRoute(req, requestId);
  if (liveResponse) return liveResponse;

  if (!isTerminalInferencePath(path)) {
    const response = notFound();
    return withCors(req.method === "HEAD" ? withoutBody(response) : response);
  }

  return await handleTerminalRoute(req, path, delivery, requestId, requestStartedAtMs, requestStartedAtMonotonicMs);
}

export { handleLiveUpgrade as upgradeHandler } from "../live/handler.ts";

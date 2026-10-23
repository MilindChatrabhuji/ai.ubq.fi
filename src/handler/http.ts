// Shared HTTP primitives for the request handler, split out of src/handler.ts.

import { authenticateClient } from "../auth/index.ts";
import { type ApiKeyPolicy, apiKeyQuotaUsedPercent, apiKeyRateLimitPolicyHeaders } from "../api-key-policy.ts";
import { type ResponseTelemetry } from "../openai-telemetry.ts";
import { withCodexQuotaHeaders } from "../codex/quota.ts";
import { sha256Hex } from "../utils.ts";

type ClientAuthResult = Awaited<ReturnType<typeof authenticateClient>>;
type AuthenticatedClientResult = Extract<ClientAuthResult, { ok: true }>;
type RequestDeliveryInfo = Readonly<{
  completed: Promise<void>;
  downstreamSignal: AbortSignal;
}>;
type DeliveryOutcome = "delivered" | "interrupted" | "unobserved";
type BodyOutcome = "drained" | "interrupted" | "failed";
type SentinelBackgroundTaskRegistrar = (task: Promise<unknown>) => void;
type SentinelBackgroundRuntime = Readonly<{
  waitUntil?: SentinelBackgroundTaskRegistrar;
}>;

const sentinelBackgroundTaskRegistrar = (): SentinelBackgroundTaskRegistrar | null => {
  const globals = globalThis as unknown as Readonly<{
    EdgeRuntime?: SentinelBackgroundRuntime;
  }>;
  if (typeof globals.EdgeRuntime?.waitUntil === "function") {
    return globals.EdgeRuntime.waitUntil.bind(globals.EdgeRuntime);
  }
  return null;
};

const scheduleSentinelBackgroundTask = (task: Promise<void>, registrar: SentinelBackgroundTaskRegistrar | undefined): boolean => {
  const waitUntil = registrar ?? sentinelBackgroundTaskRegistrar();
  if (!waitUntil) return false;
  try {
    waitUntil(task);
    return true;
  } catch {
    return false;
  }
};

export const shouldSignalSentinelProviderDegradation = (
  input: Readonly<{ status: number; completed: boolean; removedProviderTriggerClass: string | null }>
): boolean => input.status >= 200 && input.status < 400 && input.completed && input.removedProviderTriggerClass !== null;

type PrincipalAuthResult = Readonly<{
  token: string | null;
  method: Readonly<{ kind: "kv_api_key"; key_id: string }> | Exclude<AuthenticatedClientResult["method"], { kind: "kv_api_key" }>;
}>;

/** Exhaustiveness guard for authentication method kinds; unreachable at runtime. */
const assertNeverAuthMethod = (method: never): never => {
  throw new Error(`Unhandled authentication method: ${JSON.stringify(method)}`);
};

export const resolveIdempotencyPrincipal = async (authResult: PrincipalAuthResult): Promise<string> => {
  switch (authResult.method.kind) {
    case "kv_api_key":
      return `api-key:${authResult.method.key_id}`;
    case "github_token":
      return `github-repo:${authResult.method.owner.toLowerCase()}/${authResult.method.repo.toLowerCase()}`;
    case "passkey_session":
      return `passkey-user:${authResult.method.user_id}`;
    case "passport_session":
      return authResult.method.principal;
    case "auth_tokens_allowlist":
    case "admin_allowlist":
    case "deno_deploy_token":
      return `auth-method:${authResult.method.kind}`;
    case "disabled":
      return authResult.token ? `bearer-sha256:${await sha256Hex(authResult.token)}` : "local-auth-disabled";
    default:
      // Every known method kind is handled above; this keeps the switch total.
      return assertNeverAuthMethod(authResult.method);
  }
};

const normalizePath = (path: string): string => {
  if (path === "/") return path;
  // Equivalent to `path.replace(/\/+$/, "")`, without the quadratic
  // backtracking that pattern needs when a request path ends in many slashes.
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
};

const withRequestId = (response: Response, requestId: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("x-uos-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const decorateInferenceQuota = (response: Response, policy: ApiKeyPolicy | null, telemetry: ResponseTelemetry | null): Response => {
  const usedPercent = telemetry?.quotaUsedPercent !== undefined ? telemetry.quotaUsedPercent : apiKeyQuotaUsedPercent(policy);
  const codexDecorated = withCodexQuotaHeaders(response, usedPercent === null ? null : { used_percent: usedPercent });
  const headers = new Headers(codexDecorated.headers);
  for (const [name, value] of Object.entries(apiKeyRateLimitPolicyHeaders(policy))) headers.set(name, value);
  return new Response(codexDecorated.body, {
    status: codexDecorated.status,
    statusText: codexDecorated.statusText,
    headers,
  });
};

const providerRequestIdHeaderValue = (value: string | null): string | null => {
  const requestId = value?.trim();
  if (!requestId || requestId.length > 256) return null;
  for (const character of requestId) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return requestId;
};

/**
 * Provider-native correlation headers. The gateway never reflects them: it
 * exposes one bounded `x-uos-provider-request-id` whose value has already
 * passed the gateway sanitizer.
 *
 * Every header a provider reader accepts must be listed here, or that
 * provider's own spelling can survive to the client.
 * `getCerebrasProviderRequestId` reads the first four spellings and
 * `getDeepSeekProviderRequestId` reads `x-request-id`, `x-ds-request-id` and
 * `x-deepseek-request-id`.
 */
export const PROVIDER_NATIVE_CORRELATION_HEADERS = [
  "x-request-id",
  "x-api-request-id",
  "x-oneapi-request-id",
  "x-cerebras-request-id",
  "x-ds-request-id",
  "x-deepseek-request-id",
  "x-uos-provider-request-id",
] as const;

export const scrubProviderNativeCorrelationHeaders = (headers: Headers): void => {
  for (const header of PROVIDER_NATIVE_CORRELATION_HEADERS) headers.delete(header);
};

const withProviderRequestId = (response: Response, providerRequestId: string | null): Response => {
  const requestId = providerRequestIdHeaderValue(providerRequestId);
  const headers = new Headers(response.headers);
  scrubProviderNativeCorrelationHeaders(headers);
  if (requestId) headers.set("x-uos-provider-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/** Exact-path POST routes; the two readers below add their GET-only cases. */
const POST_TERMINAL_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  "/uos/embeddings": "embeddings",
  "/uos/embedding-jobs": "embeddings.jobs.create",
  "/v1/chat/completions": "chat.completions",
  "/v1/responses": "responses",
  "/v1/systemone": "systemone",
  "/v1/images/generations": "images.generations",
  "/v1/images/edits": "images.edits",
});

const terminalRouteForRequest = (method: string, path: string): string | null => {
  if (method === "POST") return POST_TERMINAL_ROUTES[path] ?? null;
  if (method === "GET" && path.startsWith("/uos/embedding-jobs/")) return "embeddings.jobs.get";
  return null;
};

const kernelQuotaRouteForRequest = (method: string, path: string): string | null => (method === "POST" ? (POST_TERMINAL_ROUTES[path] ?? null) : null);

export type { AuthenticatedClientResult, BodyOutcome, ClientAuthResult, DeliveryOutcome, RequestDeliveryInfo, SentinelBackgroundTaskRegistrar };
export {
  decorateInferenceQuota,
  kernelQuotaRouteForRequest,
  normalizePath,
  scheduleSentinelBackgroundTask,
  terminalRouteForRequest,
  withProviderRequestId,
  withRequestId,
};

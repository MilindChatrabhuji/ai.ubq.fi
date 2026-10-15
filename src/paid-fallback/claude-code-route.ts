/**
 * The owner-only Claude subscription hop. It runs before the paid waterfall
 * for a Claude model when every gate is satisfied, delivers the subscription
 * response directly on success, and otherwise falls through to the unchanged
 * paid route so a broken or exhausted subscription can never remove service.
 * Durable exhaustion is recorded only from the documented unified rate-limit
 * evidence; billing and workspace rejections become bounded, operator-visible
 * configuration states instead of per-request retries.
 */
import { getKv } from "../kv.ts";
import { isProviderEnabled, loadProviderSelectionCached } from "../provider/selection.ts";
import { isSurplusClaudeModel } from "../provider/surplus-claude-request.ts";
import { ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { type RoutedResponsesUpstream, recordFirstProviderDispatch, type UsageContext } from "../openai-telemetry.ts";
import { bestEffortPaidFallbackBookkeeping, codexCacheScopeForUsageContext } from "./health.ts";
import {
  ClaudeCodeError,
  fetchClaudeCodeResponses,
  isClaudeCodeConfigurationKind,
  readClaudeCodeAllowedKeyIds,
  resolveClaudeCodeEligibility,
  type ClaudeCodeEnvLookup,
  type ClaudeCodeFetch,
  type ClaudeCodeResponseClassification,
} from "../provider/claude-code.ts";
import { resolveClaudeCodeCredential, resolveClaudeCodeWorkspace } from "../provider/claude-code-credentials.ts";
import { loadClaudeCodeQuotaState, recordClaudeCodeQuotaOutcome } from "../provider/claude-code-quota.ts";
import { recordClaudeCodeProviderHealth } from "../provider/health.ts";
import { cancelResponseBody } from "../upstream-wire.ts";
import type { ProviderHealthEvent } from "../provider/health.ts";

/** The health event each upstream classification honestly maps to. */
const HEALTH_EVENT_BY_CLASSIFICATION: Readonly<Record<ClaudeCodeResponseClassification["kind"], ProviderHealthEvent>> = {
  ok: "success",
  durable_exhaustion: "quota_exhausted",
  auth_invalid: "auth_invalid",
  // The transport worked and the provider answered; only the request was
  // unacceptable, so the route stays reachable rather than degraded.
  request_rejected: "reachable",
  // Scoping rejections are configuration states: the tier is not serving, and
  // the admin surface carries the exact reason.
  workspace_required: "upstream_error",
  workspace_not_found: "upstream_error",
  billing_blocked: "upstream_error",
  transient_rate_limited: "upstream_error",
  forbidden: "upstream_error",
  upstream_error: "upstream_error",
};

/**
 * Attempt the subscription tier for one Claude model request. Returns the
 * routed upstream only when the subscription itself served the request; null
 * means "not eligible" or "attempt failed", and the caller continues into the
 * paid waterfall exactly as before.
 */
export const attemptClaudeCodeSubscription = async (
  body: Record<string, unknown>,
  options: Readonly<{
    model: string;
    signal?: AbortSignal;
    usageContext?: UsageContext;
    /** Test seam: environment lookup for the credential and the allowlist. */
    env?: ClaudeCodeEnvLookup;
    /** Test seam: transport for the Messages dispatch. */
    fetcher?: ClaudeCodeFetch;
  }>
): Promise<RoutedResponsesUpstream | null> => {
  const selection = await loadProviderSelectionCached();
  const keyId = options.usageContext?.keyId ?? null;
  const allowedKeyIds = readClaudeCodeAllowedKeyIds(options.env);
  // A dormant tier (another principal, no allowlist entry, another model, or
  // an operator switch-off) must cost nothing, so storage is read only after
  // every local gate that needs no credential has already passed.
  if (!isSurplusClaudeModel(options.model)) return null;
  if (!isProviderEnabled("claude_code", selection)) return null;
  if (!keyId || !allowedKeyIds.size || !allowedKeyIds.has(keyId)) return null;

  const quotaKv = await getKv();
  const [credential, workspace, quota] = await Promise.all([
    resolveClaudeCodeCredential(quotaKv, options.env),
    resolveClaudeCodeWorkspace(quotaKv, options.env),
    loadClaudeCodeQuotaState(quotaKv),
  ]);
  const eligibility = resolveClaudeCodeEligibility({
    model: options.model,
    keyId,
    providerEnabled: true,
    allowedKeyIds,
    credential,
    workspace,
    quota,
  });
  if (!eligibility.eligible) return null;
  // The API-key reservation records exactly one pre-transport dispatch per
  // request, so a failed subscription attempt keeps this request's first
  // attribution exactly as a failed Codex primary already does; the paid hop
  // that ultimately serves receives no second dispatch context by design.

  let result: Awaited<ReturnType<typeof fetchClaudeCodeResponses>>;
  try {
    result = await fetchClaudeCodeResponses(body, {
      credential: eligibility.credential,
      workspace: eligibility.workspace,
      kv: quotaKv,
      env: options.env,
      fetcher: options.fetcher,
      signal: options.signal,
      reasoningReplayScope: codexCacheScopeForUsageContext(options.usageContext),
      beforeDispatch: () => options.usageContext?.beforeProviderDispatch?.("claude_code") ?? Promise.resolve(undefined),
      onDispatch: () => {
        recordFirstProviderDispatch(options.usageContext);
      },
      sentinelUpstreamRecorder: options.usageContext?.sentinelUpstreamRecorder,
    });
  } catch (error) {
    if (error instanceof ApiKeyQuotaDispatchError) throw error;
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    // A local build failure never reached the upstream, so it must not record
    // an upstream health event; only real transport failures degrade the route.
    const localRequestFailure =
      error instanceof ClaudeCodeError && (error.code === "claude_code_request_invalid" || error.code === "claude_code_credential_missing");
    if (!localRequestFailure) {
      await bestEffortPaidFallbackBookkeeping("claude_code failure recording", () => recordClaudeCodeProviderHealth("upstream_error", null));
    }
    return null;
  }

  const classification = result.classification;
  const configurationRejection = isClaudeCodeConfigurationKind(classification.kind)
    ? { kind: classification.kind, status: result.response.status, message: classification.detail, retry_after_ms: classification.retry_after_ms }
    : null;
  await bestEffortPaidFallbackBookkeeping("claude_code quota recording", () =>
    recordClaudeCodeQuotaOutcome(quotaKv, {
      observation: result.quota,
      exhaustion: classification.exhaustion,
      transient: classification.kind === "transient_rate_limited" ? { retry_after_ms: classification.retry_after_ms } : null,
      config_error: configurationRejection,
      served: classification.kind === "ok",
    })
  );
  await bestEffortPaidFallbackBookkeeping("claude_code health recording", () =>
    recordClaudeCodeProviderHealth(HEALTH_EVENT_BY_CLASSIFICATION[classification.kind], result.response.status, Date.now, result.request_id)
  );

  if (classification.kind === "ok") {
    if (options.usageContext?.responseTelemetry) options.usageContext.responseTelemetry.provider = "claude_code";
    return { response: result.response, provider: "claude_code", paidFallback: null, gatewayResponse: false, fallbackReason: null };
  }
  // The subscription answered but did not serve this request; its response
  // body is released and the request continues into the paid waterfall.
  cancelResponseBody(result.response);
  return null;
};

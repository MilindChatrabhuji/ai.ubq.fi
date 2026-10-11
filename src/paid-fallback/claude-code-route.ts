/**
 * The owner-only Claude Code subscription hop. It runs before the paid
 * waterfall for a Claude model when every gate is satisfied, delivers the
 * subscription response directly on success, and otherwise falls through to
 * the unchanged paid route so a broken or exhausted subscription can never
 * remove service. Durable exhaustion is recorded only from the documented
 * unified rate-limit evidence; every weaker failure stays request-local.
 */
import { getKv } from "../kv.ts";
import { isProviderEnabled, loadProviderSelectionCached } from "../provider/selection.ts";
import { ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { type RoutedResponsesUpstream, recordFirstProviderDispatch, type UsageContext } from "../openai-telemetry.ts";
import { bestEffortPaidFallbackBookkeeping, codexCacheScopeForUsageContext } from "./health.ts";
import {
  fetchClaudeCodeResponses,
  readClaudeCodeAllowedKeyIds,
  readClaudeCodeToken,
  resolveClaudeCodeEligibility,
  type ClaudeCodeEnvLookup,
  type ClaudeCodeFetch,
  type ClaudeCodeResponseClassification,
} from "../provider/claude-code.ts";
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
  const cheapGates = {
    model: options.model,
    keyId: options.usageContext?.keyId ?? null,
    providerEnabled: isProviderEnabled("claude_code", selection),
    allowedKeyIds: readClaudeCodeAllowedKeyIds(options.env),
    token: readClaudeCodeToken(options.env),
    quota: null,
  } as const;
  // A dormant tier (no credential, no allowlist entry, another model, or an
  // operator switch-off) must cost nothing, so storage is read only after
  // every local gate has passed.
  if (!resolveClaudeCodeEligibility(cheapGates).eligible) return null;
  const quotaKv = await getKv();
  const eligibility = resolveClaudeCodeEligibility({ ...cheapGates, quota: await loadClaudeCodeQuotaState(quotaKv) });
  if (!eligibility.eligible) return null;

  let result: Awaited<ReturnType<typeof fetchClaudeCodeResponses>>;
  try {
    result = await fetchClaudeCodeResponses(body, {
      token: eligibility.token,
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
    await bestEffortPaidFallbackBookkeeping("claude_code failure recording", () => recordClaudeCodeProviderHealth("upstream_error", null));
    return null;
  }

  const classification = result.classification;
  await bestEffortPaidFallbackBookkeeping("claude_code quota recording", () =>
    recordClaudeCodeQuotaOutcome(quotaKv, {
      observation: result.quota,
      exhaustion: classification.exhaustion,
      transient: classification.kind === "transient_rate_limited" ? { retry_after_ms: classification.retry_after_ms } : null,
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

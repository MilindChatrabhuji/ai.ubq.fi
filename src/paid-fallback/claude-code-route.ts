/**
 * The owner-only Claude subscription hop. It runs before the paid waterfall
 * for a Claude model when every gate is satisfied, delivers the subscription
 * response directly on success. Only current exact-model full-pool proof can
 * authorize paid continuation. Transient and configuration errors remain the
 * original subscription failure, not invented capacity exhaustion.
 */
import type { Kv } from "#kv";
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
  type ClaudeCodeEnvLookup,
  type ClaudeCodeFetch,
  type ClaudeCodeResponseClassification,
} from "../provider/claude-code.ts";
import { fetchClaudeCodeModels } from "../provider/claude-code-models.ts";
import { isRecord } from "../utils.ts";
import {
  claudeCodeQuotaCoolingDown,
  claudeCodePoolProofForModel,
  loadClaudeCodeQuotaState,
  recordClaudeCodeQuotaOutcome,
} from "../provider/claude-code-quota.ts";
import { recordClaudeCodeProviderHealth } from "../provider/health.ts";
import { cancelResponseBody } from "../upstream-wire.ts";
import type { ProviderHealthEvent } from "../provider/health.ts";
import {
  isClaudeCodeAccountCurrent,
  loadClaudeCodeAccountStore,
  selectClaudeCodeAccount,
  type ClaudeCodeAccountBinding,
  type ClaudeCodeAccountStore,
} from "../provider/claude-code-accounts.ts";
import { loadClaudeCodeAccessPolicy } from "../provider/claude-code-access.ts";
import { openaiError } from "../http.ts";

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

type SubscriptionOptions = Readonly<{
  model: string;
  signal?: AbortSignal;
  usageContext?: UsageContext;
  env?: ClaudeCodeEnvLookup;
  fetcher?: ClaudeCodeFetch;
}>;
const routedClaudeResponse = (response: Response, gatewayResponse = false): RoutedResponsesUpstream => ({
  response,
  provider: "claude_code",
  paidFallback: null,
  gatewayResponse,
  fallbackReason: null,
});
const requestedEffort = (body: Record<string, unknown>): unknown => (isRecord(body.reasoning) ? body.reasoning.effort : undefined);
const nativeCapabilities = async (kv: Kv, account: ClaudeCodeAccountBinding, body: Record<string, unknown>, options: SubscriptionOptions) => {
  const effort = requestedEffort(body);
  if (effort === undefined) return { supportsNativeDisabledThinking: false, nativeReasoningEfforts: [] as readonly string[] };
  const snapshot = await fetchClaudeCodeModels({
    kv,
    env: options.env,
    accountBinding: account,
    expectedBinding: { credential: account.credential, workspaceId: account.workspace?.id ?? null },
  });
  const model = snapshot && !snapshot.stale ? snapshot.models.find((candidate) => candidate.id === options.model) : null;
  return { supportsNativeDisabledThinking: model?.supports_disabled_thinking === true, nativeReasoningEfforts: model?.supported_reasoning_levels ?? [] };
};
const reasoningProofCurrent = async (
  kv: Kv,
  account: ClaudeCodeAccountBinding,
  body: Record<string, unknown>,
  options: SubscriptionOptions
): Promise<boolean> => {
  if (!(await isClaudeCodeAccountCurrent(kv, account))) return false;
  const effort = requestedEffort(body);
  if (effort === undefined) return true;
  const capability = await nativeCapabilities(kv, account, body, options);
  return effort === "none" ? capability.supportsNativeDisabledThinking : typeof effort === "string" && capability.nativeReasoningEfforts.includes(effort);
};
const recordAccountOutcome = async (
  kv: Kv,
  account: ClaudeCodeAccountBinding,
  result: Awaited<ReturnType<typeof fetchClaudeCodeResponses>>,
  model: string
): Promise<void> => {
  const classification = result.classification;
  const configError = isClaudeCodeConfigurationKind(classification.kind)
    ? { kind: classification.kind, status: result.response.status, message: classification.detail, retry_after_ms: classification.retry_after_ms }
    : null;
  await bestEffortPaidFallbackBookkeeping("claude_code quota recording", () =>
    recordClaudeCodeQuotaOutcome(kv, {
      binding: account,
      model_id: model,
      response_status: result.response.status,
      response_observed_at_ms: result.observed_at_ms,
      observation: result.quota,
      exhaustion: classification.exhaustion,
      auth_invalid: classification.kind === "auth_invalid",
      transient: classification.kind === "transient_rate_limited" ? { retry_after_ms: classification.retry_after_ms } : null,
      config_error: configError,
      served: classification.kind === "ok",
    })
  );
  await bestEffortPaidFallbackBookkeeping("claude_code health recording", () =>
    recordClaudeCodeProviderHealth(HEALTH_EVENT_BY_CLASSIFICATION[classification.kind], result.response.status, Date.now, result.request_id, account)
  );
};
const poolView = async (kv: Kv, model: string, env?: ClaudeCodeEnvLookup) => {
  const roster = await loadClaudeCodeAccountStore(kv, env);
  const states = await Promise.all(roster.accounts.map(async (account) => ({ account, quota: await loadClaudeCodeQuotaState(kv, account) })));
  const identity = (store: ClaudeCodeAccountStore) =>
    JSON.stringify([store.active_account_id, store.accounts.map((account) => [account.account_id, account.account_cohort_id, account.evidence_generation])]);
  const fresh = identity(roster) === identity(await loadClaudeCodeAccountStore(kv, env));
  return { roster, states, fresh, hasProof: (state: (typeof states)[number]) => claudeCodePoolProofForModel(state.quota, state.account, model) !== null };
};

type PoolState = Awaited<ReturnType<typeof poolView>>["states"][number];
type RequestLifetime = { dispatched: boolean; attempted: Set<string>; keyId: string };
type PoolStep = Readonly<{ kind: "retry" }> | Readonly<{ kind: "paid" }> | Readonly<{ kind: "response"; routed: RoutedResponsesUpstream }>;
const claudeLocalError = (error: ClaudeCodeError): RoutedResponsesUpstream =>
  routedClaudeResponse(openaiError(error.status, error.message, error.code, { type: error.status >= 500 ? "server_error" : "invalid_request_error" }), true);
const beforeAccountDispatch = async (
  kv: Kv,
  account: ClaudeCodeAccountBinding,
  body: Record<string, unknown>,
  options: SubscriptionOptions,
  lifetime: RequestLifetime
) => {
  const dispatch = lifetime.dispatched ? undefined : await options.usageContext?.beforeProviderDispatch?.("claude_code");
  const access = await loadClaudeCodeAccessPolicy(kv, options.env);
  if (!access.allowed_key_ids.includes(lifetime.keyId)) {
    await dispatch?.cancelBeforeTransport();
    throw new ClaudeCodeError("The principal is no longer allowed to use the Claude subscription.", "claude_code_request_invalid", 403);
  }
  if (!(await reasoningProofCurrent(kv, account, body, options))) {
    await dispatch?.cancelBeforeTransport();
    throw new ClaudeCodeError("Claude credential/workspace capability proof changed before dispatch.", "claude_code_request_invalid", 400);
  }
  return dispatch;
};
const dispatchAccount = async (
  kv: Kv,
  account: ClaudeCodeAccountBinding,
  body: Record<string, unknown>,
  options: SubscriptionOptions,
  lifetime: RequestLifetime
): Promise<
  Readonly<{ kind: "upstream"; result: Awaited<ReturnType<typeof fetchClaudeCodeResponses>> }> | Readonly<{ kind: "response"; routed: RoutedResponsesUpstream }>
> => {
  try {
    const capabilities = await nativeCapabilities(kv, account, body, options);
    const result = await fetchClaudeCodeResponses(body, {
      credential: account.credential,
      workspace: account.workspace,
      accountBinding: account,
      kv,
      env: options.env,
      fetcher: options.fetcher,
      signal: options.signal,
      reasoningReplayScope: `${codexCacheScopeForUsageContext(options.usageContext)}:${account.account_id}:${account.account_cohort_id}`,
      ...capabilities,
      beforeDispatch: () => beforeAccountDispatch(kv, account, body, options, lifetime),
      onDispatch: () => {
        if (!lifetime.dispatched) {
          recordFirstProviderDispatch(options.usageContext);
        }
        lifetime.dispatched = true;
      },
      sentinelUpstreamRecorder: options.usageContext?.sentinelUpstreamRecorder,
    });
    return { kind: "upstream", result };
  } catch (error) {
    if (error instanceof ApiKeyQuotaDispatchError) throw error;
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (error instanceof ClaudeCodeError && error.code === "claude_code_upstream_unreachable") {
      await bestEffortPaidFallbackBookkeeping("claude_code failure recording", () =>
        recordClaudeCodeProviderHealth("upstream_error", null, Date.now, null, account)
      );
    }
    if (error instanceof ClaudeCodeError) return { kind: "response", routed: claudeLocalError(error) };
    throw error;
  }
};
const choosePoolAccount = async (
  kv: Kv,
  options: SubscriptionOptions
): Promise<Readonly<{ kind: "retry" }> | Readonly<{ kind: "paid" }> | Readonly<{ kind: "account"; state: PoolState }>> => {
  const view = await poolView(kv, options.model, options.env);
  if (!view.fresh) return { kind: "retry" };
  const active = view.states.find((state) => state.account.account_id === view.roster.active_account_id);
  if (!active) return { kind: "paid" };
  if (!view.hasProof(active)) return { kind: "account", state: active };
  const next = view.states.find((state) => !view.hasProof(state));
  if (!next) return { kind: "paid" };
  await selectClaudeCodeAccount(kv, next.account.account_id, "authoritative_unavailability", active.account);
  return { kind: "retry" };
};
const advanceAfterOutcome = async (kv: Kv, account: ClaudeCodeAccountBinding, options: SubscriptionOptions): Promise<"retry" | "paid" | "preserve"> => {
  const proof = claudeCodePoolProofForModel(await loadClaudeCodeQuotaState(kv, account), account, options.model);
  if (!proof) return "preserve";
  const latest = await poolView(kv, options.model, options.env);
  if (!latest.fresh) return "preserve";
  if (latest.states.every(latest.hasProof)) return "paid";
  const next = latest.states.find((state) => !latest.hasProof(state));
  if (!next || !(await selectClaudeCodeAccount(kv, next.account.account_id, "authoritative_unavailability", account))) return "preserve";
  return "retry";
};
const servePoolAccount = async (
  kv: Kv,
  state: PoolState,
  body: Record<string, unknown>,
  options: SubscriptionOptions,
  lifetime: RequestLifetime
): Promise<PoolStep> => {
  const account = state.account;
  if (lifetime.attempted.has(account.account_id))
    return {
      kind: "response",
      routed: claudeLocalError(new ClaudeCodeError("Claude account selection changed during the request.", "claude_code_upstream_unreachable", 409)),
    };
  lifetime.attempted.add(account.account_id);
  if (claudeCodeQuotaCoolingDown(state.quota)) {
    const status = state.quota?.last_error?.status ?? 429;
    return {
      kind: "response",
      routed: routedClaudeResponse(
        openaiError(
          status,
          state.quota?.last_error?.message ?? "The Claude subscription is cooling down after an upstream rejection.",
          "claude_code_cooling_down"
        ),
        true
      ),
    };
  }
  const attempted = await dispatchAccount(kv, account, body, options, lifetime);
  if (attempted.kind === "response") return attempted;
  const result = attempted.result;
  const outcomeAccount = result.account_binding ?? account;
  await recordAccountOutcome(kv, outcomeAccount, result, options.model);
  if (result.classification.kind === "ok") {
    if (options.usageContext?.responseTelemetry) options.usageContext.responseTelemetry.provider = "claude_code";
    return { kind: "response", routed: routedClaudeResponse(result.response) };
  }
  const advance = await advanceAfterOutcome(kv, outcomeAccount, options);
  if (advance === "preserve") return { kind: "response", routed: routedClaudeResponse(result.response) };
  cancelResponseBody(result.response);
  return { kind: advance };
};
const runClaudePool = async (kv: Kv, body: Record<string, unknown>, options: SubscriptionOptions, keyId: string): Promise<RoutedResponsesUpstream | null> => {
  const lifetime: RequestLifetime = { keyId, dispatched: false, attempted: new Set() };
  for (let iteration = 0; iteration < 34; iteration++) {
    const choice = await choosePoolAccount(kv, options);
    if (choice.kind === "retry") continue;
    if (choice.kind === "paid") return null;
    const result = await servePoolAccount(kv, choice.state, body, options, lifetime);
    if (result.kind === "response") return result.routed;
    if (result.kind === "paid") return null;
  }
  return claudeLocalError(new ClaudeCodeError("Claude account selection did not settle.", "claude_code_upstream_unreachable", 409));
};
/** One durable active subscription; only exact-current full-pool proof authorizes paid continuation. */
export const attemptClaudeCodeSubscription = async (body: Record<string, unknown>, options: SubscriptionOptions): Promise<RoutedResponsesUpstream | null> => {
  const selection = await loadProviderSelectionCached();
  if (!isSurplusClaudeModel(options.model) || !isProviderEnabled("claude_code", selection)) return null;
  const kv = await getKv();
  if (!kv) return claudeLocalError(new ClaudeCodeError("Claude account storage is unavailable.", "claude_code_upstream_unreachable", 503));
  const access = await loadClaudeCodeAccessPolicy(kv, options.env);
  const keyId = options.usageContext?.keyId;
  if (!keyId || !access.allowed_key_ids.includes(keyId)) return null;
  return await runClaudePool(kv, body, options, keyId);
};

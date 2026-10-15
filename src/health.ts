import { config, runtimeDeploymentId, runtimeGitSha } from "./config.ts";
import { readCerebrasApiKey } from "./provider/cerebras.ts";
import { CODEX_AUTH_POOL_KV_KEY, fetchCodexModels, getJwtExpMs, parseCodexAuthFromAuthJson, parseCodexAuthPool } from "./codex/index.ts";
import { readDeepSeekApiKey } from "./deepseek/index.ts";
import { json } from "./http.ts";
import { getKv } from "./kv.ts";
import { readLithosApiKey } from "./provider/lithos.ts";
import { claudeCodeRequestHeaders, CLAUDE_CODE_MODELS_URL, readClaudeCodeAllowedKeyIds } from "./provider/claude-code.ts";
import {
  CLAUDE_CODE_WORKSPACE_ID_ENV,
  resolveClaudeCodeCredential,
  resolveClaudeCodeWorkspace,
  loadClaudeCodeWorkspaceState,
  type ClaudeCodeResolvedCredential,
  type ClaudeCodeResolvedWorkspace,
} from "./provider/claude-code-credentials.ts";
import { loadClaudeCodeQuotaState, type ClaudeCodeQuotaState } from "./provider/claude-code-quota.ts";
import { isProviderEnabled, loadProviderSelectionCached } from "./provider/selection.ts";
import {
  getCerebrasProviderHealth,
  getClaudeCodeProviderHealth,
  getCodexProviderHealth,
  getDeepSeekProviderHealth,
  getLithosProviderHealth,
  getMeteredProviderHealth,
  getOpenRouterProviderHealth,
  getSurplusProviderHealth,
  PROVIDER_HEALTH_STALE_AFTER_MS,
  type ProviderHealthView,
  type ProviderHealthState,
} from "./provider/health.ts";
import { decodeBase64ToString, sha256Hex } from "./utils.ts";
import type { CodexAuthPoolState } from "./types.ts";
import { readMeteredApiKey } from "./provider/metered.ts";
import { readOpenRouterApiKey } from "./provider/openrouter.ts";
import { readSurplusApiKey } from "./provider/surplus.ts";
import { deepSeekWaterfallCatalogEnabled } from "./deepseek/waterfall.ts";
import {
  fetchMeteredQuotaObservation,
  getCachedConfiguredMeteredQuotaSnapshot,
  type MeteredAccountCredentials,
  type MeteredQuotaSnapshot,
  readMeteredAccountCredentials,
} from "./metered-quota.ts";

const AUTH_REFRESH_WINDOW_MS = 2 * 60_000;
const ACTIVE_UPSTREAM_HEALTH_TIMEOUT_MS = 3_000;
let activeUpstreamHealthTimeoutMs = ACTIVE_UPSTREAM_HEALTH_TIMEOUT_MS;
const AUTH_NOT_CONFIGURED = "No Codex auth configured (CODEX_AUTH_JSON_B64 or KV entry missing).";

type HealthAuthMetaBase = {
  source: "kv" | "env" | "none";
  updated_at_ms: number | null;
  access_token_exp_ms: number | null;
  account_count: number;
  accounts: {
    slot: number;
    updated_at_ms: number | null;
    access_token_exp_ms: number | null;
    /**
     * SHA-256 of the slot's refresh token. A digest only: it lets a local watchdog compare
     * the pool against credential files without exposing token material.
     */
    refresh_sha256: string | null;
    /**
     * The bound native-owner home, when the slot delegates its refresh. A digest matching a
     * credential file is expected for a slot bound to that home; without a binding it means
     * two independent refreshers share one lineage.
     */
    native_owner_codex_home: string | null;
  }[];
};

type HealthAuthMeta = HealthAuthMetaBase & {
  access_token_expired: boolean | null;
  refresh_recommended: boolean | null;
  accounts: {
    slot: number;
    updated_at_ms: number | null;
    access_token_exp_ms: number | null;
    access_token_expired: boolean | null;
    refresh_recommended: boolean | null;
  }[];
};

type CodexAuthContext = Readonly<{
  meta: HealthAuthMetaBase;
  account_ids: string[];
}>;

type ActiveProviderProbe = {
  status: number;
  provider: "chatgpt_codex" | "metered_quota" | "claude_subscription";
  content_type: string | null;
  error?: string;
};

type HealthUpstreamProbe = {
  status: number;
  auth: HealthAuthMeta | null;
  probes: {
    codex: ActiveProviderProbe;
    metered_quota: ActiveProviderProbe | null;
    /**
     * The Claude subscription credential probe. It reports independently so a
     * billing or workspace rejection on that tier never masquerades as a Codex
     * upstream outage in the aggregate status.
     */
    claude_subscription: ActiveProviderProbe | null;
    claude_workspace: {
      id: string | null;
      name: string | null;
      source: string | null;
      pinned_by_env: boolean;
    } | null;
  };
};

type HealthProbeProgress = {
  auth: HealthAuthMeta | null;
  codex: ActiveProviderProbe | undefined;
  metered_quota: ActiveProviderProbe | null | undefined;
  claude_subscription: ActiveProviderProbe | null | undefined;
  claude_workspace: HealthUpstreamProbe["probes"]["claude_workspace"] | undefined;
};

let upstreamProbeInFlight: Promise<HealthUpstreamProbe> | null = null;

export const setActiveUpstreamHealthTimeoutMsForTest = (timeoutMs: number | null): void => {
  activeUpstreamHealthTimeoutMs = timeoutMs ?? ACTIVE_UPSTREAM_HEALTH_TIMEOUT_MS;
};

const nowMs = (): number => Date.now();

const enrichAuthMeta = (meta: HealthAuthMetaBase): HealthAuthMeta => {
  const now = nowMs();
  const expMs = meta.access_token_exp_ms;
  return {
    ...meta,
    access_token_expired: typeof expMs === "number" ? expMs <= now : null,
    refresh_recommended: typeof expMs === "number" ? expMs - now < AUTH_REFRESH_WINDOW_MS : null,
    accounts: meta.accounts.map((account) => ({
      ...account,
      access_token_expired: typeof account.access_token_exp_ms === "number" ? account.access_token_exp_ms <= now : null,
      refresh_recommended: typeof account.access_token_exp_ms === "number" ? account.access_token_exp_ms - now < AUTH_REFRESH_WINDOW_MS : null,
    })),
  };
};

const loadEnvCodexAuth = async (): Promise<CodexAuthContext | null> => {
  if (!config.codexAuthJsonB64) return null;
  try {
    const decoded = decodeBase64ToString(config.codexAuthJsonB64);
    const parsed = JSON.parse(decoded);
    const auth = parseCodexAuthFromAuthJson(parsed);
    if (!auth) return null;
    const accessTokenExpMs = getJwtExpMs(auth.access_token);
    return {
      meta: {
        source: "env",
        updated_at_ms: null,
        access_token_exp_ms: accessTokenExpMs,
        account_count: 1,
        accounts: [
          {
            slot: 1,
            updated_at_ms: null,
            access_token_exp_ms: accessTokenExpMs,
            refresh_sha256: await sha256Hex(auth.refresh_token),
            native_owner_codex_home: null,
          },
        ],
      },
      account_ids: [auth.account_id],
    };
  } catch {
    return null;
  }
};

const getCodexAuthContext = async (): Promise<CodexAuthContext> => {
  const kv = await getKv();
  if (kv) {
    const entry = await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY);
    const pool = parseCodexAuthPool(entry.value);
    if (pool) {
      const accounts = await Promise.all(
        pool.accounts.map(async (account, index) => ({
          slot: index + 1,
          updated_at_ms: account.updated_at_ms,
          access_token_exp_ms: getJwtExpMs(account.access_token),
          refresh_sha256: await sha256Hex(account.refresh_token),
          native_owner_codex_home: account.native_owner?.codex_home ?? null,
        }))
      );
      const expirations = accounts.map((account) => account.access_token_exp_ms).filter((value): value is number => typeof value === "number");
      return {
        meta: {
          source: "kv",
          updated_at_ms: pool.updated_at_ms,
          access_token_exp_ms: expirations.length > 0 ? Math.min(...expirations) : null,
          account_count: accounts.length,
          accounts,
        },
        account_ids: pool.accounts.map((account) => account.account_id),
      };
    }
  }

  const envMeta = await loadEnvCodexAuth();
  if (envMeta) return envMeta;

  return {
    meta: {
      source: "none",
      updated_at_ms: null,
      access_token_exp_ms: null,
      account_count: 0,
      accounts: [],
    },
    account_ids: [],
  };
};

const getCodexAuthMeta = async (): Promise<HealthAuthMetaBase> => (await getCodexAuthContext()).meta;

const aggregateProviderStates = (states: readonly ProviderHealthState[]): ProviderHealthState => {
  if (states.length === 0 || states.every((state) => state === "unknown")) return "unknown";
  if (states.some((state) => state === "healthy")) return "healthy";
  if (states.every((state) => state === "invalid")) return "invalid";
  if (states.every((state) => state === "exhausted")) return "exhausted";
  return "degraded";
};

const unknownProviderHealth = (): ProviderHealthView => ({
  state: "unknown",
  stale: null,
  last_event: null,
  last_status: null,
  last_observed_at_ms: null,
  last_provider_request_id: null,
  last_provider_request_id_at_ms: null,
  last_success_at_ms: null,
  last_401_at_ms: null,
  last_429_at_ms: null,
  last_error_at_ms: null,
  last_refresh_at_ms: null,
  last_refresh_succeeded: null,
});

const providerHealthOrUnknown = async (health: Promise<ProviderHealthView>): Promise<ProviderHealthView> => {
  try {
    return await health;
  } catch {
    return unknownProviderHealth();
  }
};

const quotaView = (snapshot: MeteredQuotaSnapshot | null) => {
  if (!snapshot) {
    return {
      available: false,
      cache_state: null,
      balance_credits: null,
      baseline_credits: null,
      remaining_percent: null,
      used_percent: null,
      observed_at_ms: null,
      confidence: null,
      cycle_started_at_ms: null,
      last_credit_at_ms: null,
      unlimited_quota: null,
      total_available: null,
      total_granted: null,
      total_used: null,
    };
  }
  const tokenUsage = snapshot.unlimited_quota || snapshot.total_available !== null || snapshot.total_used !== null;
  return {
    available: true,
    cache_state: snapshot.cache_state,
    balance_credits: snapshot.balance_credits,
    baseline_credits: snapshot.baseline_credits,
    remaining_percent: snapshot.remaining_percent,
    used_percent: snapshot.used_percent,
    observed_at_ms: snapshot.state.observed_at_ms,
    confidence: tokenUsage ? null : snapshot.state.confidence,
    cycle_started_at_ms: tokenUsage ? null : snapshot.state.cycle_started_at_ms,
    last_credit_at_ms: tokenUsage ? null : snapshot.state.last_credit_at_ms,
    unlimited_quota: snapshot.unlimited_quota,
    total_available: snapshot.total_available,
    total_granted: snapshot.total_granted,
    total_used: snapshot.total_used,
  };
};

/**
 * The gateway-owned waterfall identity: "at least one hop is configured" is the
 * whole state, because this route owns no upstream observations of its own.
 */
const gatewayProviderHealthSubtree = (): Record<string, unknown> => {
  const configured = deepSeekWaterfallCatalogEnabled(null);
  return {
    configured,
    health: {
      state: configured ? "healthy" : "unknown",
      stale: false,
      last_event: null,
      last_status: null,
      last_observed_at_ms: null,
      last_provider_request_id: null,
      last_provider_request_id_at_ms: null,
      last_success_at_ms: null,
      last_401_at_ms: null,
      last_429_at_ms: null,
      last_error_at_ms: null,
      last_refresh_at_ms: null,
      last_refresh_succeeded: null,
    },
  };
};

/**
 * Workspace readback for the Claude subscription tier. The resolved selection
 * (KV pin, environment pin, or discovery) is reported together with the last
 * verification and the last workspace-resolution failure, so an operator sees
 * which workspace the gateway will name and whether it was ever accepted.
 */
const claudeWorkspaceView = (
  resolved: ClaudeCodeResolvedWorkspace | null,
  stored: Awaited<ReturnType<typeof loadClaudeCodeWorkspaceState>>,
  pinnedByEnv: boolean
): Record<string, unknown> | null => {
  const id = resolved?.id ?? stored?.id ?? null;
  if (!id) return null;
  return {
    id,
    name: resolved?.name ?? stored?.name ?? null,
    source: resolved?.source ?? stored?.source ?? null,
    pinned_by_env: pinnedByEnv,
    discovered_at_ms: stored?.discovered_at_ms ?? null,
    verified_at_ms: stored?.verified_at_ms ?? null,
    last_error: stored?.last_error ?? null,
  };
};

/** Quota and configuration-state readback for the Claude subscription tier. */
const claudeCodeQuotaView = (quota: ClaudeCodeQuotaState | null): Record<string, unknown> | null => {
  if (!quota) return null;
  return {
    windows: quota.windows,
    standard: quota.standard,
    representative_claim: quota.representative_claim,
    blocked_until_ms: quota.blocked_until_ms,
    block_window: quota.block_window,
    cooldown_until_ms: quota.cooldown_until_ms,
    last_error: quota.last_error,
    updated_at_ms: quota.updated_at_ms,
  };
};

const readClaudeCodeWorkspacePinnedByEnv = (): boolean => {
  try {
    return (Deno.env.get(CLAUDE_CODE_WORKSPACE_ID_ENV) ?? "").trim().length > 0;
  } catch {
    return false;
  }
};

/**
 * The admin/health readback for the Claude subscription tier: credential
 * provenance, workspace selection, gates, and quota state, never secret
 * material. Shared by the passive provider snapshot and the admin status
 * route so both always agree.
 */
export const getClaudeSubscriptionStatusSnapshot = async (): Promise<Record<string, unknown>> => {
  const kv = await getKv();
  const [credential, workspace, workspaceState, quota, selection] = await Promise.all([
    resolveClaudeCodeCredential(kv).catch(() => null),
    resolveClaudeCodeWorkspace(kv).catch(() => null),
    loadClaudeCodeWorkspaceState(kv).catch(() => null),
    loadClaudeCodeQuotaState(kv).catch(() => null),
    loadProviderSelectionCached().catch(() => null),
  ]);
  return {
    // Configured means a credential exists; the principal allowlist and the
    // operator switch are reported separately because either one keeps the
    // route inert even with a credential.
    configured: credential !== null,
    credential: credential
      ? {
          kind: credential.kind,
          source: credential.source,
          hint: credential.hint,
          label: credential.label,
          updated_at_ms: credential.updated_at_ms,
        }
      : null,
    workspace: claudeWorkspaceView(workspace, workspaceState, readClaudeCodeWorkspacePinnedByEnv()),
    principal_allowlist_configured: readClaudeCodeAllowedKeyIds().size > 0,
    enabled: isProviderEnabled("claude_code", selection),
    quota: claudeCodeQuotaView(quota),
  };
};

export const getPassiveProviderHealthSnapshot = async (options: Readonly<{ includeQuota?: boolean }> = {}): Promise<Record<string, unknown>> => {
  const context = await getCodexAuthContext();
  const auth = enrichAuthMeta(context.meta);
  const claudeStatus = await getClaudeSubscriptionStatusSnapshot();
  const [cerebrasHealth, claudeCodeHealth, codexHealth, deepseekHealth, lithosHealth, meteredHealth, openRouterHealth, surplusHealth, meteredQuota] =
    await Promise.all([
      providerHealthOrUnknown(getCerebrasProviderHealth()),
      providerHealthOrUnknown(getClaudeCodeProviderHealth()),
      Promise.all(context.account_ids.map((accountId) => providerHealthOrUnknown(getCodexProviderHealth(accountId)))),
      providerHealthOrUnknown(getDeepSeekProviderHealth()),
      providerHealthOrUnknown(getLithosProviderHealth()),
      providerHealthOrUnknown(getMeteredProviderHealth()),
      providerHealthOrUnknown(getOpenRouterProviderHealth()),
      providerHealthOrUnknown(getSurplusProviderHealth()),
      getCachedConfiguredMeteredQuotaSnapshot().catch(() => null),
    ]);
  const codexAccounts = auth.accounts.map((account, index) => ({
    ...account,
    health: codexHealth[index],
  }));
  const quotaMonitoringConfigured = readMeteredAccountCredentials() !== null;
  return {
    mode: "passive",
    generated_at_ms: Date.now(),
    stale_after_ms: PROVIDER_HEALTH_STALE_AFTER_MS,
    codex: {
      configured: auth.source !== "none",
      source: auth.source,
      account_count: auth.account_count,
      state: aggregateProviderStates(codexHealth.map((health) => health.state)),
      accounts: codexAccounts,
    },
    cerebras: {
      configured: readCerebrasApiKey() !== null,
      health: cerebrasHealth,
    },
    claude_code: {
      ...claudeStatus,
      health: claudeCodeHealth,
    },
    deepseek: {
      configured: readDeepSeekApiKey() !== null,
      health: deepseekHealth,
    },
    lithos: {
      configured: readLithosApiKey() !== null,
      health: lithosHealth,
    },
    metered: {
      configured: readMeteredApiKey() !== null,
      quota_monitoring_configured: quotaMonitoringConfigured,
      health: meteredHealth,
      ...(options.includeQuota
        ? { quota: quotaView(meteredQuota) }
        : {
            quota: {
              available: meteredQuota !== null,
              cache_state: meteredQuota?.cache_state ?? null,
              observed_at_ms: meteredQuota?.state.observed_at_ms ?? null,
            },
          }),
    },
    openrouter: {
      configured: readOpenRouterApiKey() !== null,
      health: openRouterHealth,
    },
    surplus: {
      configured: readSurplusApiKey() !== null,
      quota_monitoring_configured: false,
      health: surplusHealth,
      ...(options.includeQuota
        ? {
            quota: {
              ...quotaView(null),
              source: "not_reported",
            },
          }
        : {
            quota: {
              available: false,
              observed_at_ms: null,
            },
          }),
    },
    ubiquity: gatewayProviderHealthSubtree(),
  };
};

export const handleHealthProviders = async (options: Readonly<{ includeQuota?: boolean }> = {}): Promise<Response> =>
  json(200, await getPassiveProviderHealthSnapshot(options), {
    "Cache-Control": "no-store",
    "x-uos-git-sha": runtimeGitSha(),
    "x-uos-deployment-id": runtimeDeploymentId(),
  });

const codexProbe = async (auth: HealthAuthMeta, signal: AbortSignal): Promise<ActiveProviderProbe> => {
  if (auth.source === "none") {
    return { status: 503, provider: "chatgpt_codex", content_type: null, error: AUTH_NOT_CONFIGURED };
  }
  try {
    const res = await fetchCodexModels({ signal });
    const contentType = res.headers.get("Content-Type");
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { status: 200, provider: "chatgpt_codex", content_type: contentType };
    return {
      status: res.status === 401 ? 401 : 503,
      provider: "chatgpt_codex",
      content_type: contentType,
      error: "Codex models probe returned an error status.",
    };
  } catch {
    return {
      status: 503,
      provider: "chatgpt_codex",
      content_type: null,
      error: signal.aborted ? "Codex models probe timed out." : "Codex models probe failed.",
    };
  }
};

/**
 * The Claude subscription probe lists models with the exact credential and
 * workspace the tier would use for inference. A listing is free, so a green
 * probe proves credential, workspace, and transport without spending quota on
 * a completion; the tier's own billing or workspace rejections stay visible in
 * the passive snapshot instead of failing this probe.
 */
const claudeSubscriptionProbe = async (
  credential: ClaudeCodeResolvedCredential | null,
  workspace: ClaudeCodeResolvedWorkspace | null,
  signal: AbortSignal
): Promise<ActiveProviderProbe | null> => {
  if (!credential) return null;
  try {
    const response = await fetch(CLAUDE_CODE_MODELS_URL, {
      method: "GET",
      headers: claudeCodeRequestHeaders(credential, { stream: false, workspaceId: workspace?.id ?? null }),
      redirect: "manual",
      signal,
    });
    const contentType = response.headers.get("Content-Type");
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: 200, provider: "claude_subscription", content_type: contentType };
    }
    const detail = (await response.text().catch(() => "")).trim();
    return {
      status: response.status === 401 ? 401 : 503,
      provider: "claude_subscription",
      content_type: contentType,
      error: detail ? detail.slice(0, 240) : "Claude models probe returned an error status.",
    };
  } catch {
    return {
      status: 503,
      provider: "claude_subscription",
      content_type: null,
      error: signal.aborted ? "Claude models probe timed out." : "Claude models probe failed.",
    };
  }
};

// This non-billable endpoint authenticates the monitoring account, which is
// intentionally distinct from the inference API key. Name it accordingly so
// a green quota check is never mistaken for paid-fallback availability.
const meteredQuotaProbe = async (credentials: MeteredAccountCredentials | null, signal: AbortSignal): Promise<ActiveProviderProbe | null> => {
  if (!credentials) return null;
  try {
    await fetchMeteredQuotaObservation(credentials, { signal });
    return { status: 200, provider: "metered_quota", content_type: "application/json" };
  } catch {
    return {
      status: 503,
      provider: "metered_quota",
      content_type: null,
      error: signal.aborted ? "Metered quota probe timed out." : "Metered quota probe failed.",
    };
  }
};

const aggregateUpstreamProbe = (
  auth: HealthAuthMeta | null,
  codex: ActiveProviderProbe,
  meteredQuota: ActiveProviderProbe | null,
  claudeSubscription: ActiveProviderProbe | null = null,
  claudeWorkspace: HealthUpstreamProbe["probes"]["claude_workspace"] = null
): HealthUpstreamProbe => {
  // The aggregate status stays about the Codex and metered upstreams: the
  // Claude subscription reports its own state without failing this roll-up.
  const failures = [codex, meteredQuota].filter((probe): probe is ActiveProviderProbe => probe !== null && probe.status >= 400);
  const probes = { codex, metered_quota: meteredQuota, claude_subscription: claudeSubscription, claude_workspace: claudeWorkspace };
  if (failures.length === 0) return { status: 200, auth, probes };
  const status = failures.some((probe) => probe.status === 401) ? 401 : 503;
  return { status, auth, probes };
};

const probeUpstream = async (
  signal: AbortSignal,
  meteredCredentials: MeteredAccountCredentials | null,
  progress: HealthProbeProgress
): Promise<HealthUpstreamProbe> => {
  let auth: HealthAuthMeta;
  try {
    auth = enrichAuthMeta(await getCodexAuthMeta());
  } catch {
    return {
      status: 503,
      auth: null,
      probes: {
        codex: {
          status: 503,
          provider: "chatgpt_codex",
          content_type: null,
          error: "Codex auth metadata could not be read.",
        },
        metered_quota: null,
        claude_subscription: null,
        claude_workspace: null,
      },
    };
  }
  progress.auth = auth;
  const kv = await getKv();
  const [credential, workspace] = await Promise.all([resolveClaudeCodeCredential(kv).catch(() => null), resolveClaudeCodeWorkspace(kv).catch(() => null)]);
  progress.claude_workspace = credential
    ? { id: workspace?.id ?? null, name: workspace?.name ?? null, source: workspace?.source ?? null, pinned_by_env: readClaudeCodeWorkspacePinnedByEnv() }
    : null;
  const codexPromise = codexProbe(auth, signal).then((probe) => (progress.codex = probe));
  const meteredPromise = meteredQuotaProbe(meteredCredentials, signal).then((probe) => (progress.metered_quota = probe));
  const claudePromise = claudeSubscriptionProbe(credential, workspace, signal).then((probe) => (progress.claude_subscription = probe));
  const [codex, meteredQuota, claudeSubscription] = await Promise.all([codexPromise, meteredPromise, claudePromise]);
  return aggregateUpstreamProbe(auth, codex, meteredQuota, claudeSubscription, progress.claude_workspace);
};

const timedOutProviderProbe = (provider: ActiveProviderProbe["provider"]): ActiveProviderProbe => ({
  status: 503,
  provider,
  content_type: null,
  error:
    provider === "chatgpt_codex"
      ? "Codex models probe timed out."
      : provider === "claude_subscription"
        ? "Claude models probe timed out."
        : "Metered quota probe timed out.",
});

const timeoutProbe = (progress: HealthProbeProgress): HealthUpstreamProbe =>
  aggregateUpstreamProbe(
    progress.auth,
    progress.codex ?? timedOutProviderProbe("chatgpt_codex"),
    progress.metered_quota === undefined ? timedOutProviderProbe("metered_quota") : progress.metered_quota,
    progress.claude_subscription === undefined ? timedOutProviderProbe("claude_subscription") : progress.claude_subscription,
    progress.claude_workspace ?? null
  );

const probeUpstreamCoalesced = async (): Promise<HealthUpstreamProbe> => {
  if (upstreamProbeInFlight) return await upstreamProbeInFlight;
  const controller = new AbortController();
  const meteredCredentials = readMeteredAccountCredentials();
  const progress: HealthProbeProgress = {
    auth: null,
    codex: undefined,
    metered_quota: meteredCredentials ? undefined : null,
    claude_subscription: undefined,
    claude_workspace: undefined,
  };
  let timeoutId: Parameters<typeof clearTimeout>[0];
  const timeout = new Promise<HealthUpstreamProbe>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort(new DOMException("Active upstream health probe timed out.", "TimeoutError"));
      resolve(timeoutProbe(progress));
    }, activeUpstreamHealthTimeoutMs);
  });
  upstreamProbeInFlight = Promise.race([probeUpstream(controller.signal, meteredCredentials, progress), timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    upstreamProbeInFlight = null;
  });
  return await upstreamProbeInFlight;
};

export const handleHealth = (): Response => {
  const gitSha = runtimeGitSha();
  const deploymentId = runtimeDeploymentId();
  // This endpoint is deliberately a release liveness signal, not an active
  // dependency check. It must remain available during provider/KV incidents.
  return json(
    200,
    {
      status: "available",
      release: {
        git_sha: gitSha,
        deployment_id: deploymentId,
      },
    },
    {
      "Cache-Control": "no-store",
      "x-uos-git-sha": gitSha,
      "x-uos-deployment-id": deploymentId,
    }
  );
};

export const handleHealthUpstream = async (): Promise<Response> => {
  const probe = await probeUpstreamCoalesced();
  return json(
    probe.status,
    {
      status: probe.status,
      probes: probe.probes,
      auth: probe.auth,
    },
    { "x-uos-git-sha": runtimeGitSha(), "x-uos-deployment-id": runtimeDeploymentId() }
  );
};

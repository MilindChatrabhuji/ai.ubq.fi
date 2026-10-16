// Admin kernel, quota projection and reset settings handlers, split out of src/admin.ts.

import { config } from "../config.ts";
import { readCodexResetAvailableCount, readCodexResetCredits } from "../codex/banked-reset-provider.ts";
import type { CodexResetCreditDiagnostic } from "../codex/banked-reset-provider.ts";
import { codexUsageUrl, parseCodexOverageUsage } from "../provider/capacity-parse.ts";
import type { ProviderCapacityOverageUsage } from "../provider/capacity-parse.ts";
import { codexResetUsageKey, readCodexResetUsage } from "../codex/reset-settings.ts";
import { loadOverageUsageSettings, readOverageUsage, writeOverageUsage } from "../codex/overage-settings.ts";
import { getAuthPoolEntry } from "../codex/auth.ts";
import { getCodexCapacityAccounts } from "../codex/index.ts";
import { json, openaiError } from "../http.ts";
import { reloadKernelPublicKeys } from "../kernel/attestation.ts";
import { backfillPaidFallbackUsageRollups, backfillPaidFallbackWindowTtls } from "../paid-fallback/ledger-backfill.ts";
import { PAID_FALLBACK_REQUEST_LOG_RETENTION_MS } from "../paid-fallback/ledger-state.ts";
import { readPaidFallbackLedgerGrowth, recordPaidFallbackLedgerProjectionStats } from "../paid-fallback/ledger-stats.ts";
import {
  deleteKernelOrgUsageLimit,
  deleteKernelUsageLimit,
  getKernelOrgUsage,
  getKernelOrgUsageLimitSnapshot,
  getKernelUsage,
  getKernelUsageLimitSnapshot,
  kernelLimitKey,
  kernelOrgLimitKey,
  listKernelOrgUsageLimits,
  listKernelOrgUsageRecords,
  listKernelUsageLimits,
  listKernelUsageRecords,
  setKernelOrgUsageLimit,
  setKernelUsageLimit,
} from "../kernel/usage.ts";
import { listKernelPolicyQueue } from "../kernel/policy-queue.ts";
import { getKv } from "../kv.ts";
import { readJsonBody } from "../request.ts";
import { getString, isRecord, sha256Hex } from "../utils.ts";
import {
  getConfiguredMeteredQuotaSnapshot,
  METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS,
  meterQuotaAccountFingerprint,
  normalizeMeteredQuotaBalanceWindowDays,
  readMeteredAccountCredentials,
  readMeteredQuotaBalanceHistory,
  resampleMeteredQuotaBalanceHistory,
} from "../metered-quota.ts";
import { listPaidFallbackUsageRollups, PAID_FALLBACK_SETTLED_PROVIDERS, PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS } from "../paid-fallback/rollups.ts";
import { groupPaidFallbackUsageRollups, meteredQuotaRunwayView, projectPaidFallbackRunway, summarizePaidFallbackUsage } from "../quota-projection.ts";
import {
  normalizeKernelExpiresAtMsInput,
  normalizeKernelRepoPart,
  normalizeKernelScope,
  normalizeKernelUsageLimitInput,
  normalizeKernelWindowMsInput,
  shouldIncludeUsage,
} from "./api-keys.ts";
import { UOS_KERNEL_PUBKEYS_KEY } from "./codex.ts";

const normalizePem = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const pem = raw.trim();
  if (!pem.startsWith("-----BEGIN PUBLIC KEY-----") || !pem.endsWith("-----END PUBLIC KEY-----")) return null;
  return pem;
};

export const handleAdminKernelPubKeysList = async (): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available", "server_error");
  const kvEntry = await kv.get<{ app_id: number; pem: string; owner: string; added_at_ms: number }[]>(UOS_KERNEL_PUBKEYS_KEY);
  return json(200, { data: kvEntry.value ?? [] });
};

export const handleAdminKernelPubKeysCreate = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available", "server_error");

  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");

  const appId = typeof raw.app_id === "number" ? raw.app_id : null;
  if (appId === null) return openaiError(400, "app_id is required and must be a number", "invalid_request_error");

  const pem = normalizePem(raw.pem);
  if (!pem) return openaiError(400, "pem must be a valid RS256 public PEM", "invalid_request_error");

  const owner = getString(raw.owner) ?? "unknown";

  const entry = await kv.get<{ app_id: number; pem: string; owner: string; added_at_ms: number }[]>(UOS_KERNEL_PUBKEYS_KEY);
  const existing = entry.value ?? [];
  if (existing.some((p) => p.app_id === appId)) {
    return openaiError(409, `Public key for App ID ${appId} already exists`, "invalid_request_error");
  }

  const record = { app_id: appId, pem, owner, added_at_ms: Date.now() };
  const updated = [...existing, record];

  const commit = await kv.atomic().check(entry).set(UOS_KERNEL_PUBKEYS_KEY, updated).commit();
  if (!commit.ok) return openaiError(409, "Concurrent modification; retry", "invalid_request_error");

  await reloadKernelPublicKeys();
  return json(200, { ok: true, data: record });
};

export const handleAdminKernelPubKeysDelete = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available", "server_error");

  const url = new URL(req.url);
  const appIdStr = url.searchParams.get("app_id");
  const appId = appIdStr ? parseInt(appIdStr, 10) : null;
  if (appId === null || isNaN(appId)) {
    return openaiError(400, "app_id query parameter is required and must be a number", "invalid_request_error");
  }

  const entry = await kv.get<{ app_id: number; pem: string; owner: string; added_at_ms: number }[]>(UOS_KERNEL_PUBKEYS_KEY);
  const existing = entry.value ?? [];
  const updated = existing.filter((p) => p.app_id !== appId);

  if (updated.length === existing.length) return openaiError(404, "Not found", "not_found");

  const commit = await kv.atomic().check(entry).set(UOS_KERNEL_PUBKEYS_KEY, updated).commit();
  if (!commit.ok) return openaiError(409, "Concurrent modification; retry", "invalid_request_error");

  await reloadKernelPublicKeys();
  return json(200, { ok: true, deleted_app_id: appId });
};

export const handleAdminKernelPolicyQueueList = async (): Promise<Response> => {
  const records = await listKernelPolicyQueue();
  if (!records) return openaiError(500, "Deno KV is not available", "server_error");
  if (records.length === 0) return json(200, { data: records });

  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available", "server_error");

  // This queue is meant to surface *current* gaps. Once an org/repo rate limit policy exists,
  // the corresponding queue entries should disappear automatically.
  const orgPolicyOwners = new Set<string>();
  const owners = [...new Set(records.map((record) => record.owner))];
  await Promise.all(
    owners.map(async (owner) => {
      const entry = await kv.get(kernelOrgLimitKey(owner));
      if (entry.value) orgPolicyOwners.add(owner);
    })
  );

  const repoPolicyPairs = new Set<string>();
  await Promise.all(
    records
      .filter((record) => !orgPolicyOwners.has(record.owner))
      .map(async (record) => {
        const entry = await kv.get(kernelLimitKey(record.owner, record.repo));
        if (entry.value) repoPolicyPairs.add(`${record.owner}/${record.repo}`);
      })
  );

  const pending = records.filter((record) => {
    if (orgPolicyOwners.has(record.owner)) return false;
    return !repoPolicyPairs.has(`${record.owner}/${record.repo}`);
  });

  return json(200, { data: pending });
};

const KERNEL_USAGE_DAILY_DAYS = 30;

const kernelUsageInventoryResponse = async (scope: "repo" | "org"): Promise<Response> => {
  if (scope === "org") {
    const orgRecords = await listKernelOrgUsageRecords({ includeDaily: true, dailyDays: KERNEL_USAGE_DAILY_DAYS });
    if (!orgRecords) {
      return openaiError(500, "Failed to load kernel org usage inventory", "server_error");
    }
    return json(200, { ok: true, scope, usage: orgRecords });
  }

  const records = await listKernelUsageRecords({ includeDaily: true, dailyDays: KERNEL_USAGE_DAILY_DAYS });
  if (!records) {
    return openaiError(500, "Failed to load kernel usage inventory", "server_error");
  }
  return json(200, { ok: true, scope, usage: records });
};

const kernelOrgUsageLimitsResponse = async (scope: "repo" | "org", includeUsage: boolean): Promise<Response> => {
  const limits = await listKernelOrgUsageLimits();
  if (!limits) {
    return openaiError(500, "Failed to load kernel org usage limits", "server_error");
  }
  const usageByOwner = new Map<string, Awaited<ReturnType<typeof getKernelOrgUsage>>>();
  if (includeUsage) {
    await Promise.all(
      limits.map(async (record) => {
        usageByOwner.set(record.owner, await getKernelOrgUsage(record.owner, { includeDaily: true, dailyDays: KERNEL_USAGE_DAILY_DAYS }));
      })
    );
  }
  return json(200, {
    ok: true,
    scope,
    limits: limits.map((record) => ({
      ...record,
      ...(includeUsage ? { usage: usageByOwner.get(record.owner) ?? null } : {}),
    })),
  });
};

const kernelRepoUsageLimitsResponse = async (scope: "repo" | "org", includeUsage: boolean): Promise<Response> => {
  const limits = await listKernelUsageLimits();
  if (!limits) {
    return openaiError(500, "Failed to load kernel usage limits", "server_error");
  }
  const usageByRepo = new Map<string, Awaited<ReturnType<typeof getKernelUsage>>>();
  if (includeUsage) {
    await Promise.all(
      limits.map(async (record) => {
        const key = `${record.owner}/${record.repo}`;
        usageByRepo.set(key, await getKernelUsage(record.owner, record.repo, { includeDaily: true, dailyDays: KERNEL_USAGE_DAILY_DAYS }));
      })
    );
  }
  return json(200, {
    ok: true,
    scope,
    limits: limits.map((record) => ({
      ...record,
      ...(includeUsage ? { usage: usageByRepo.get(`${record.owner}/${record.repo}`) ?? null } : {}),
    })),
  });
};

const kernelUsageListResponse = async (scope: "repo" | "org", includeUsage: boolean): Promise<Response> =>
  scope === "org" ? await kernelOrgUsageLimitsResponse(scope, includeUsage) : await kernelRepoUsageLimitsResponse(scope, includeUsage);

const kernelOrgUsageSnapshotResponse = async (owner: string, includeUsage: boolean): Promise<Response> => {
  const limitSnapshot = await getKernelOrgUsageLimitSnapshot(owner);
  if (!limitSnapshot) {
    return openaiError(500, "Failed to load kernel org usage limit", "server_error");
  }
  const usage = await getKernelOrgUsage(owner, { includeDaily: includeUsage, dailyDays: KERNEL_USAGE_DAILY_DAYS });
  return json(200, {
    ok: true,
    org: { owner },
    limit: { ...limitSnapshot.record, source: limitSnapshot.source },
    usage: usage ?? null,
  });
};

const kernelRepoUsageSnapshotResponse = async (owner: string, repo: string, includeUsage: boolean): Promise<Response> => {
  const limitSnapshot = await getKernelUsageLimitSnapshot(owner, repo);
  if (!limitSnapshot) {
    return openaiError(500, "Failed to load kernel usage limit", "server_error");
  }
  const usage = await getKernelUsage(owner, repo, { includeDaily: includeUsage, dailyDays: KERNEL_USAGE_DAILY_DAYS });
  return json(200, {
    ok: true,
    repo: { owner, repo },
    limit: { ...limitSnapshot.record, source: limitSnapshot.source },
    usage: usage ?? null,
  });
};

export const handleAdminKernelUsageGet = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available", "server_error");

  const url = new URL(req.url);
  const scope = normalizeKernelScope(url.searchParams.get("scope"));
  const listRequested = shouldIncludeUsage(url.searchParams.get("list"));
  const inventoryRequested = shouldIncludeUsage(url.searchParams.get("inventory"));
  const includeUsage = shouldIncludeUsage(url.searchParams.get("include_usage"));
  if (inventoryRequested) return await kernelUsageInventoryResponse(scope);
  if (listRequested) return await kernelUsageListResponse(scope, includeUsage);

  const owner = normalizeKernelRepoPart(url.searchParams.get("owner"));
  if (!owner) {
    return openaiError(400, "owner query parameter is required", "invalid_request_error");
  }

  if (scope === "org") return await kernelOrgUsageSnapshotResponse(owner, includeUsage);

  const repo = normalizeKernelRepoPart(url.searchParams.get("repo"));
  if (!repo) {
    return openaiError(400, "repo query parameter is required", "invalid_request_error");
  }

  return await kernelRepoUsageSnapshotResponse(owner, repo, includeUsage);
};

type KernelUsageTarget = { ok: true; scope: "org"; owner: string; repo: null } | { ok: true; scope: "repo"; owner: string; repo: string };

/** The shared `owner`/`repo`/`scope` validation for the Kernel usage writers. */
const resolveKernelUsageTarget = (raw: Record<string, unknown>): KernelUsageTarget | { ok: false; response: Response } => {
  const owner = normalizeKernelRepoPart(raw.owner);
  const repo = normalizeKernelRepoPart(raw.repo);
  if (!owner) return { ok: false, response: openaiError(400, "owner is required", "invalid_request_error") };
  const scope = normalizeKernelScope(raw.scope ?? (repo ? "repo" : "org"));
  if (scope === "repo") {
    if (!repo) return { ok: false, response: openaiError(400, "repo is required for scope=repo", "invalid_request_error") };
    return { ok: true, scope: "repo", owner, repo };
  }
  if (repo) return { ok: false, response: openaiError(400, "repo must be omitted for scope=org", "invalid_request_error") };
  return { ok: true, scope: "org", owner, repo: null };
};

type KernelUsageLimits = Readonly<{ usageLimitRequests: number; windowMs: number | null; expiresAtMs: number | null; resetUsage: boolean }>;

const resolveKernelUsageLimits = (raw: Record<string, unknown>): { ok: true; limits: KernelUsageLimits } | { ok: false; response: Response } => {
  const usageLimitRequests = normalizeKernelUsageLimitInput(raw.usage_limit_requests);
  if (usageLimitRequests === null) {
    return { ok: false, response: openaiError(400, "usage_limit_requests must be a non-negative number, -1, or 'unlimited'", "invalid_request_error") };
  }

  const windowMs = normalizeKernelWindowMsInput(raw.window_ms);
  if (raw.window_ms !== undefined && windowMs === null) {
    return { ok: false, response: openaiError(400, "window_ms must be a positive number", "invalid_request_error") };
  }

  const nowMs = Date.now();
  const expiresAtMs = normalizeKernelExpiresAtMsInput(raw.expires_at_ms, nowMs);
  if (raw.expires_at_ms !== undefined && expiresAtMs === null) {
    return { ok: false, response: openaiError(400, "expires_at_ms must be a Unix epoch ms timestamp in the future, or -1", "invalid_request_error") };
  }

  if (Object.prototype.hasOwnProperty.call(raw, "reset_usage") && typeof raw.reset_usage !== "boolean") {
    return { ok: false, response: openaiError(400, "reset_usage must be a boolean", "invalid_request_error") };
  }

  return { ok: true, limits: { usageLimitRequests, windowMs, expiresAtMs, resetUsage: raw.reset_usage === true } };
};

const kernelOrgUsageLimitSetResponse = async (owner: string, limits: KernelUsageLimits): Promise<Response> => {
  const updated = await setKernelOrgUsageLimit(owner, limits.usageLimitRequests, {
    windowMs: limits.windowMs ?? undefined,
    expiresAtMs: limits.expiresAtMs ?? undefined,
    resetUsage: limits.resetUsage,
  });
  if (!updated) {
    return openaiError(409, "Concurrent modification; retry", "invalid_request_error");
  }
  return json(200, { ok: true, scope: "org", org: { owner }, limit: { ...updated, source: "kv" } });
};

export const handleAdminKernelUsageSet = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available", "server_error");

  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");

  const target = resolveKernelUsageTarget(raw);
  if (!target.ok) return target.response;

  const resolved = resolveKernelUsageLimits(raw);
  if (!resolved.ok) return resolved.response;

  if (target.scope === "org") return await kernelOrgUsageLimitSetResponse(target.owner, resolved.limits);

  const updated = await setKernelUsageLimit(target.owner, target.repo, resolved.limits.usageLimitRequests, {
    windowMs: resolved.limits.windowMs ?? undefined,
    expiresAtMs: resolved.limits.expiresAtMs ?? undefined,
    resetUsage: resolved.limits.resetUsage,
  });
  if (!updated) {
    return openaiError(409, "Concurrent modification; retry", "invalid_request_error");
  }

  return json(200, { ok: true, scope: target.scope, repo: { owner: target.owner, repo: target.repo }, limit: { ...updated, source: "kv" } });
};

const kernelOrgUsageLimitDeleteResponse = async (owner: string): Promise<Response> => {
  const deleted = await deleteKernelOrgUsageLimit(owner);
  if (deleted === "conflict") {
    return openaiError(409, "Active Kernel quota reservations must settle before deletion", "invalid_request_error");
  }
  if (deleted === null) {
    return openaiError(500, "Failed to delete kernel org usage limit", "server_error");
  }
  if (!deleted) {
    return openaiError(404, "Kernel org usage limit not found", "not_found");
  }
  return json(200, { ok: true, scope: "org", org: { owner }, deleted: true });
};

const kernelRepoUsageLimitDeleteResponse = async (owner: string, repo: string): Promise<Response> => {
  const deleted = await deleteKernelUsageLimit(owner, repo);
  if (deleted === "conflict") {
    return openaiError(409, "Active Kernel quota reservations must settle before deletion", "invalid_request_error");
  }
  if (deleted === null) {
    return openaiError(500, "Failed to delete kernel usage limit", "server_error");
  }
  if (!deleted) {
    return openaiError(404, "Kernel usage limit not found", "not_found");
  }
  return json(200, { ok: true, scope: "repo", repo: { owner, repo }, deleted: true });
};

export const handleAdminKernelUsageDelete = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available", "server_error");

  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");

  const target = resolveKernelUsageTarget(raw);
  if (!target.ok) return target.response;

  if (target.scope === "org") return await kernelOrgUsageLimitDeleteResponse(target.owner);
  return await kernelRepoUsageLimitDeleteResponse(target.owner, target.repo);
};

const QUOTA_PROJECTION_ALLOWED_WINDOWS = new Set([7, 30, 90] as const);
const QUOTA_PROJECTION_DEFAULT_WINDOW_DAYS = 30 as const;
const QUOTA_PROJECTION_MAX_BALANCE_SAMPLES = 365;

/**
 * Admin quota-runway view: per-model consumption from retained rollups plus
 * exhaustion estimates against the current Metered balance. Reads only the
 * compact stores; never scans raw request rows. The `window_days` parameter
 * bounds the rollup scan (default 30): the UI poll is cheap and does not pull
 * the full 90-day rollup history on every refresh. The same response carries
 * `ledger_growth`, the measured daily settled-row/rollup size counters and the
 * per-window read units this view cost, and records one projection sample.
 */
export const handleAdminProvidersQuotaProjection = async (
  request: Request = new Request("https://ai.ubq.fi/admin/providers/quota-projection")
): Promise<Response> => {
  const kv = await getKv();
  const nowMs = Date.now();
  const rawWindowDays = Number.parseInt(new URL(request.url).searchParams.get("window_days") ?? "", 10);
  const windowDays =
    Number.isInteger(rawWindowDays) && QUOTA_PROJECTION_ALLOWED_WINDOWS.has(rawWindowDays as 7 | 30 | 90)
      ? (rawWindowDays as 7 | 30 | 90)
      : QUOTA_PROJECTION_DEFAULT_WINDOW_DAYS;
  const balanceWindowDays = normalizeMeteredQuotaBalanceWindowDays(new URL(request.url).searchParams.get("balance_window_days"));
  const windowMs = windowDays * 24 * 60 * 60 * 1_000;
  const balanceWindowMs = balanceWindowDays * 24 * 60 * 60 * 1_000;
  // Keep the complete requested range while bounding every response to 365
  // points. Seven days remains hourly; longer ranges use the smallest whole-
  // hour UTC bucket that can represent the range within the response cap.
  const balanceHistoryBucketMs = Math.max(
    METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS,
    // A closed interval can intersect one more aligned bucket than its
    // duration alone implies. Reserve one response slot for that partial
    // boundary bucket so neither end of a 365-day range is truncated.
    Math.ceil((balanceWindowDays * 24) / (QUOTA_PROJECTION_MAX_BALANCE_SAMPLES - 1)) * METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS
  );
  const accountFingerprint = await meterQuotaAccountFingerprint(readMeteredAccountCredentials()).catch(() => null);
  const [snapshot, rollups, sourceBalanceHistory, ledgerGrowth] = await Promise.all([
    getConfiguredMeteredQuotaSnapshot({ kv }).catch(() => null),
    kv ? listPaidFallbackUsageRollups(kv, { sinceMs: nowMs - windowMs, nowMs }).catch(() => null) : Promise.resolve(null),
    kv
      ? readMeteredQuotaBalanceHistory(kv, {
          sinceMs: nowMs - balanceWindowMs,
          nowMs,
          accountFingerprint,
        }).catch(() => null)
      : Promise.resolve(null),
    readPaidFallbackLedgerGrowth(kv, { nowMs, retentionMs: PAID_FALLBACK_REQUEST_LOG_RETENTION_MS }),
  ]);
  // Measure this view's own KV cost: one read unit per operation plus one per
  // returned entry, including the retention-stats scan and the counter
  // read-modify-write that records this view. Small rows stay far below a 4 KiB
  // read unit, so this over-counts rather than under-counts, and a failed scan
  // still counted its list call.
  const rollupRows = rollups?.length ?? 0;
  const balanceSamples = sourceBalanceHistory?.length ?? 0;
  const projectionReadUnits = (kv ? 2 : 0) + (kv ? 1 + rollupRows : 0) + (kv ? 1 + balanceSamples : 0) + ledgerGrowth.read_units;
  await recordPaidFallbackLedgerProjectionStats(kv, {
    windowDays,
    readUnits: projectionReadUnits,
    rollupRows,
    nowMs,
  });
  const quota = meteredQuotaRunwayView(snapshot);
  const balanceHistory =
    sourceBalanceHistory === null
      ? null
      : resampleMeteredQuotaBalanceHistory(sourceBalanceHistory, balanceHistoryBucketMs, QUOTA_PROJECTION_MAX_BALANCE_SAMPLES);
  const usage = summarizePaidFallbackUsage(groupPaidFallbackUsageRollups(rollups ?? []), nowMs);
  const models = usage.map((entry) => ({
    model: entry.model,
    provider: entry.provider,
    quota_source: entry.provider === "metered" ? "metered" : null,
    // `paid_fallback` rows come from settlement, carry quota and spend, and are
    // the only ones with balance-runway estimates. `observability` rows are the
    // terminal accounting for the rest of the waterfall (Codex subscription
    // capacity first): request and token history that never moves the balance.
    usage_source: PAID_FALLBACK_SETTLED_PROVIDERS.has(entry.provider) ? "paid_fallback" : "observability",
    usage: entry.windows.filter((window) => window.window_days === windowDays),
    estimates: projectPaidFallbackRunway(entry, quota, nowMs, sourceBalanceHistory).filter((estimate) => estimate.window_days === windowDays),
  }));
  return json(
    200,
    {
      snapshot_at_ms: nowMs,
      window_days: windowDays,
      balance_window_days: balanceWindowDays,
      retention: {
        rollup_bucket_ms: PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS,
        rollup_window_ms: windowMs,
        balance_history_source_bucket_ms: METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS,
        balance_history_bucket_ms: balanceHistoryBucketMs,
        balance_history_window_ms: balanceWindowMs,
      },
      quota,
      models,
      // A failed scan must not masquerade as zero history: operators need to
      // distinguish "nothing settled" from "history could not be read".
      rollup_scan: rollups === null ? "unavailable" : "ok",
      balance_history_scan: balanceHistory === null ? "unavailable" : "ok",
      balance_history: balanceHistory ?? [],
      // Measured growth of the paid-fallback raw-row store and rollups, plus
      // the read units admin projection views consume per window. Returns the
      // counters as of before this view was itself recorded.
      ledger_growth: ledgerGrowth,
    },
    { "Cache-Control": "no-store" }
  );
};

/**
 * Admin-triggered one-time backfill of settled V3 rows into usage rollups,
 * including the anchored raw-row TTL for rows that predate it. Run with a
 * `limit` and repeat until `truncated` is false; the run is idempotent and
 * resumable.
 */
export const handleAdminProvidersQuotaProjectionBackfill = async (
  request: Request = new Request("https://ai.ubq.fi/admin/providers/quota-projection/backfill")
): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(503, "KV is unavailable", "server_error");
  const limitRaw = Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "", 10);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 10_000) : 5_000;
  try {
    const requests = await backfillPaidFallbackUsageRollups(kv, { limit });
    const windows = await backfillPaidFallbackWindowTtls(kv, { limit });
    return json(200, {
      requests,
      windows,
      completed: !requests.truncated && !windows.truncated,
    });
  } catch (error) {
    return openaiError(500, error instanceof Error ? error.message : "Paid fallback rollup backfill failed", "server_error");
  }
};

export const handleAdminCodexResetSettings = async (request: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(503, "Settings storage unavailable", "server_error");
  const accounts = await getCodexCapacityAccounts();
  const identities = await Promise.all(
    accounts.map(async (account) => ({
      slot: account.slot,
      account_id_hash: await sha256Hex(account.account_id),
      account_cohort_id: await sha256Hex(`uos-prompt-cache-account-cohort-v1\u0000${account.account_id}`),
    }))
  );
  if (request.method === "PATCH") {
    const raw: unknown = await request.json().catch(() => null);
    if (!isRecord(raw) || typeof raw.account_id_hash !== "string" || typeof raw.enabled !== "boolean") {
      return openaiError(400, "account_id_hash and boolean enabled are required", "invalid_request_error");
    }
    if (!identities.some((account) => account.account_id_hash === raw.account_id_hash)) {
      return openaiError(409, "Subscription changed. Reload Providers.", "invalid_request_error");
    }
    await kv.set(codexResetUsageKey(raw.account_id_hash), { enabled: raw.enabled });
    return json(200, { account_id_hash: raw.account_id_hash, enabled: raw.enabled }, { "Cache-Control": "no-store" });
  }
  const data = await Promise.all(
    identities.map(async (account, index) => {
      const enabled = (await readCodexResetUsage(kv, account.account_id_hash)).allowed;
      let availableCount: number | null = null;
      let credits: readonly CodexResetCreditDiagnostic[] | null = null;
      const credentials = accounts.at(index);
      const diagnosticsSignal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
      const inventoryOptions = credentials && {
        codexBaseUrl: config.codexBaseUrl,
        accountId: credentials.account_id,
        accessToken: credentials.access_token,
        userAgent: "codex_cli_rs/0.100.0 (ai.ubq.fi)",
      };
      try {
        if (!inventoryOptions) throw new Error("codex reset settings account disappeared");
        availableCount = await readCodexResetAvailableCount(inventoryOptions, diagnosticsSignal);
      } catch {
        /* An unavailable count must not appear as zero or block the switch. */
      }
      try {
        if (!inventoryOptions) throw new Error("codex reset settings account disappeared");
        credits = await readCodexResetCredits(inventoryOptions, diagnosticsSignal);
      } catch {
        /* Expiries are diagnostics only: an unavailable list reads as null. */
      }
      return { ...account, enabled, available_count: availableCount, credits };
    })
  );
  return json(200, { data }, { "Cache-Control": "no-store" });
};

export const handleAdminCodexOverageUsage = async (request: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(503, "Settings storage unavailable", "server_error");
  const accounts = await getCodexCapacityAccounts();
  const identities = await Promise.all(
    accounts.map(async (account) => ({
      slot: account.slot,
      account_id_hash: await sha256Hex(account.account_id),
      account_cohort_id: await sha256Hex(`uos-prompt-cache-account-cohort-v1\u0000${account.account_id}`),
    }))
  );
  if (request.method === "PATCH") {
    const raw: unknown = await request.json().catch(() => null);
    if (!isRecord(raw) || typeof raw.account_id_hash !== "string" || typeof raw.allow !== "boolean") {
      return openaiError(400, "account_id_hash and boolean allow are required", "invalid_request_error");
    }
    if (!identities.some((account) => account.account_id_hash === raw.account_id_hash)) {
      return openaiError(409, "Subscription changed. Reload Providers.", "invalid_request_error");
    }
    await writeOverageUsage(kv, raw.account_id_hash, raw.allow);
    await refreshOverageUsageRoutingCache();
    return json(200, { account_id_hash: raw.account_id_hash, allow: raw.allow }, { "Cache-Control": "no-store" });
  }
  // The admin read doubles as a cache refresh so the routing path sees a
  // just-confirmed change without waiting for its bounded revalidation.
  await refreshOverageUsageRoutingCache();
  const data = await Promise.all(
    identities.map(async (account, index) => ({
      ...account,
      allow: await readOverageUsage(kv, account.account_id_hash),
      overage: await readOverageUsageDiagnostics(accounts.at(index), AbortSignal.any([request.signal, AbortSignal.timeout(5000)])),
    }))
  );
  return json(200, { data }, { "Cache-Control": "no-store" });
};

/**
 * Diagnostics-only read of the upstream usage endpoint with the capacity
 * sampler's exact headers and user agent. Any failure (HTTP, malformed body,
 * timeout) reads as null so the switch still renders; no other field is kept.
 */
const readOverageUsageDiagnostics = async (
  account: Readonly<{ account_id: string; access_token: string }> | undefined,
  signal: AbortSignal
): Promise<ProviderCapacityOverageUsage | null> => {
  if (!account) return null;
  try {
    const response = await fetch(codexUsageUrl(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + account.access_token,
        "ChatGPT-Account-ID": account.account_id,
        "User-Agent": "codex_cli_rs/0.100.0 (ai.ubq.fi)",
      },
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return parseCodexOverageUsage(await response.json());
  } catch {
    return null;
  }
};

/** Best-effort refresh of the routing-facing cache from the live auth pool. */
const refreshOverageUsageRoutingCache = async (): Promise<void> => {
  try {
    await loadOverageUsageSettings((await getAuthPoolEntry(true)).pool, true);
  } catch {
    // The switch remains durable; the next routing request refreshes the cache.
  }
};

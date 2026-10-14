import type { Kv, KvEntryMaybe } from "#kv";
// Admin Codex auth, model and provider handlers, split out of src/admin.ts.

import {
  cacheCodexAuthPool,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_MODELS_KV_KEY,
  CodexError,
  type CodexModelsSnapshot,
  getCodexCapacityAccounts,
  getJwtExpMs,
  loadFullCodexModelsSnapshot,
  parseCodexAuthFromAuthJson,
  parseCodexAuthPool,
  preserveCodexDefaultModel,
  storeCodexModelsSnapshot,
  upsertCodexAuthAccount,
  validateCodexAuthJson,
} from "../codex/index.ts";
import { recheckCodexRoutingSlot } from "../codex/account-routing.ts";
import { codexAccountLabel } from "../provider/capacity.ts";
import { mergeCodexModelPromptCacheCapabilities, normalizeCodexModelsPayload } from "../models/codex-models.ts";
import { CODEX_CATALOG_AUTH_GENERATION_KEY, storeCodexCatalog } from "../catalog/store.ts";
import { json, openaiError } from "../http.ts";
import { getKv } from "../kv.ts";
import { loadCodexModelsWhitelist, normalizeWhitelistModelIds, storeCodexModelsWhitelist } from "../models/codex-models-whitelist.ts";
import {
  codexSubscriptionHash,
  codexSubscriptionSelectionId,
  isProviderSelectionId,
  loadProviderSelection,
  providerSelectionIsActive,
  SELECTABLE_PROVIDER_IDS,
  storeProviderSelection,
} from "../provider/selection.ts";
import { GATEWAY_PROVIDER_ID, GATEWAY_PROVIDER_PRESENTATION, PROVIDER_TIERS, providerPresentation } from "../provider/presentation.ts";
import { deepSeekWaterfallCatalogEnabled } from "../deepseek/waterfall.ts";
import { readOpenRouterApiKey } from "../provider/openrouter.ts";
import { buildModelCatalogSnapshot, type ModelCatalogSource } from "../models/catalog.ts";
import { listCodexResetShadowDecisions } from "../codex/banked-reset-pool.ts";
import {
  assertPromptCacheScopeExperimentTelemetryBaseline,
  PromptCacheScopeExperimentBusyError,
  PromptCacheScopeExperimentFailedError,
  PromptCacheScopeExperimentUnavailableError,
  readPromptCacheScopeExperimentTelemetryBaseline,
  runPromptCacheScopeExperiment,
} from "../cache/scope-experiment.ts";
import {
  isValidPromptCacheAnalyticsGroupBy,
  type PromptCacheAnalyticsReadOptions,
  type PromptCacheAnalyticsView,
  readPromptCacheAnalytics,
} from "../cache/prompt-analytics.ts";
import { buildRuntimeConfig, cacheRuntimeConfig, normalizeRuntimeConfig, RUNTIME_CONFIG_V2_KEY, RuntimeConfigError } from "../runtime-config.ts";
import { readJsonBody } from "../request.ts";
import { getString, isRecord } from "../utils.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../types.ts";
import { fetchMeteredModels } from "../provider/metered.ts";
import { fetchSurplusModels } from "../provider/surplus.ts";
import { fetchOpenRouterModels, openRouterModelsSnapshot, type OpenRouterModelsSnapshot } from "../models/openrouter-models.ts";
import { DEBUG_ROUTING_MAX_DURATION_MS, type DebugRoutingScenario, loadDebugRoutingConfig, setDebugRoutingConfig } from "../debug-routing.ts";
import { MAX_KV_BYTES, SAFE_KV_BYTES, estimateJsonSize } from "./api-keys.ts";

const UOS_KERNEL_PUBKEYS_KEY = ["uos_ai", "kernel_pubkeys"];
const UOS_CODEX_PROMPTS_KEY = ["uos_ai", "codex_instructions"] as const;
const UOS_CODEX_PROMPTS_CHUNK_PREFIX = ["uos_ai", "codex_instructions_chunk"] as const;
const MAX_KV_MIGRATION_BODY_BYTES = 5 * 1024 * 1024;

const runtimeConfigErrorResponse = (error: unknown): Response | null => {
  if (!(error instanceof RuntimeConfigError)) return null;
  const status = error.message.includes("too large") || error.message.includes("4 KiB") ? 413 : 409;
  return openaiError(status, error.message, "runtime_config_invalid", { type: "invalid_request_error" });
};

export const handleAdminDebugRouting = async (req: Request): Promise<Response> => {
  if (req.method === "GET") {
    return json(200, { routing: await loadDebugRoutingConfig() }, { "Cache-Control": "no-store" });
  }
  if (req.method === "DELETE") {
    return json(200, { routing: await setDebugRoutingConfig("normal", 0) }, { "Cache-Control": "no-store" });
  }
  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const scenario = getString(raw.scenario)?.trim() as DebugRoutingScenario | undefined;
  const durationMs = raw.duration_ms === undefined ? 15 * 60_000 : Number(raw.duration_ms);
  if (!scenario) return openaiError(400, "scenario is required", "invalid_request_error", { param: "scenario" });
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > DEBUG_ROUTING_MAX_DURATION_MS) {
    return openaiError(400, "duration_ms must be between 0 and 3600000", "invalid_request_error", {
      param: "duration_ms",
    });
  }
  try {
    return json(200, { routing: await setDebugRoutingConfig(scenario, durationMs) }, { "Cache-Control": "no-store" });
  } catch (error) {
    return openaiError(400, error instanceof Error ? error.message : "Invalid debug routing scenario", "invalid_request_error");
  }
};

/**
 * Does not issue inference. It merely makes an operator-redeemed quota reset
 * eligible for the next single, coordinated half-open request.
 */
export const handleAdminCodexRecheck = async (slot: number): Promise<Response> => {
  if (!Number.isInteger(slot) || slot < 1 || slot > 2) {
    return openaiError(404, "Codex account slot not found", "not_found");
  }
  const accepted = await recheckCodexRoutingSlot(slot);
  if (!accepted) return openaiError(404, "Codex account slot is not configured", "not_found");
  return new Response(null, { status: 204 });
};

/** Returns only the redacted shadow-decision ledger, without redeeming. */
export const handleAdminCodexBankedResetShadowDecisions = async (): Promise<Response> => {
  const decisions = await listCodexResetShadowDecisions();
  if (decisions === null) {
    return openaiError(503, "Codex banked-reset shadow decisions are unavailable", "codex_banked_reset_shadow_unavailable", {
      type: "server_error",
      headers: { "Cache-Control": "no-store" },
    });
  }
  return json(200, { decisions }, { "Cache-Control": "no-store" });
};

/**
 * The three-cycle scope probe owns every input. In particular, callers cannot
 * select a model, account, prompt-cache key, or conversation partition.
 */
export const handleAdminCodexCacheScopeExperiment = async (req: Request): Promise<Response> => {
  if ((await req.text()).trim()) {
    return openaiError(400, "Prompt-cache scope experiment does not accept request fields", "invalid_request_error");
  }
  try {
    const telemetryBaseline = await assertPromptCacheScopeExperimentTelemetryBaseline();
    const result = await runPromptCacheScopeExperiment(telemetryBaseline);
    return json(result.status === "in_progress" ? 202 : 200, result);
  } catch (error) {
    if (error instanceof PromptCacheScopeExperimentBusyError) {
      return openaiError(409, error.message, "prompt_cache_scope_experiment_busy");
    }
    if (error instanceof PromptCacheScopeExperimentUnavailableError) {
      return openaiError(503, error.message, "prompt_cache_scope_experiment_unavailable", { type: "server_error" });
    }
    if (error instanceof PromptCacheScopeExperimentFailedError) {
      return openaiError(503, error.message, "prompt_cache_scope_experiment_failed", { type: "server_error" });
    }
    // The experiment reads provider streams and OAuth responses; an unknown
    // thrown value might contain upstream/request material, so never log it.
    console.error("[ai.ubq.fi] Prompt-cache scope experiment could not run.");
    return openaiError(503, "Prompt-cache scope experiment could not run.", "prompt_cache_scope_experiment_failed", { type: "server_error" });
  }
};

/**
 * This diagnostic has no caller-controlled target selector. It reads the
 * same server-selected cohort that a future POST would fence again, but does
 * not expose its model/hash or start any paid scope-probe work.
 */
export const handleAdminCodexCacheScopeExperimentTelemetryBaseline = async (
  readBaseline: () => ReturnType<typeof readPromptCacheScopeExperimentTelemetryBaseline> = readPromptCacheScopeExperimentTelemetryBaseline
): Promise<Response> => {
  try {
    const baseline = await readBaseline();
    const { status, reason, release, provider, aggregate, routes } = baseline;
    return json(200, { status, reason, release, provider, aggregate, routes }, { "Cache-Control": "no-store" });
  } catch {
    // Target-selection and KV failures can carry sensitive durable-key
    // material. This route is diagnostic-only, so return no thrown detail.
    console.error("[ai.ubq.fi] Prompt-cache Stage 0 telemetry baseline could not be read.");
    return openaiError(503, "Prompt-cache Stage 0 telemetry baseline could not be read.", "prompt_cache_scope_experiment_unavailable", {
      type: "server_error",
      headers: { "Cache-Control": "no-store" },
    });
  }
};

/**
 * Read-only, bounded cache analytics. The query deliberately accepts no raw
 * cache key, model, request, account, or general filter value.
 */
export const handleAdminPromptCacheAnalytics = async (
  req: Request,
  readAnalytics: (options: PromptCacheAnalyticsReadOptions) => Promise<PromptCacheAnalyticsView> = readPromptCacheAnalytics
): Promise<Response> => {
  const url = new URL(req.url);
  for (const key of url.searchParams.keys()) {
    if (key !== "group_by") {
      return openaiError(400, "Only group_by is supported for prompt-cache analytics", "invalid_request_error", {
        param: key,
      });
    }
  }
  const groupByParameters = url.searchParams.getAll("group_by");
  if (groupByParameters.length > 1) {
    return openaiError(400, "group_by may appear only once", "invalid_request_error", { param: "group_by" });
  }
  const groupBy = (groupByParameters[0] ?? "key_presence").split(",").map((value) => value.trim());
  if (!isValidPromptCacheAnalyticsGroupBy(groupBy)) {
    return openaiError(
      400,
      "group_by must contain up to two distinct values from provider, model, route, key_presence, mode, or fallback",
      "invalid_request_error",
      { param: "group_by" }
    );
  }
  try {
    return json(200, await readAnalytics({ groupBy }), { "Cache-Control": "no-store" });
  } catch {
    console.error("[ai.ubq.fi] Prompt-cache analytics could not be read.");
    return openaiError(503, "Prompt-cache analytics are unavailable", "prompt_cache_analytics_unavailable", {
      type: "server_error",
      headers: { "Cache-Control": "no-store" },
    });
  }
};

type CodexAuthValidation = Awaited<ReturnType<typeof validateCodexAuthJson>>;
type ValidatedCodexAuth = Extract<CodexAuthValidation, { ok: true }>;

/** Runs upstream validation and maps every failure mode to its original response. */
const validateUploadedCodexAuth = async (
  seed: CodexAuthState,
  clientVersion: string | null
): Promise<{ ok: true; validated: CodexAuthValidation } | { ok: false; response: Response }> => {
  try {
    return { ok: true, validated: await validateCodexAuthJson(seed, { clientVersion }) };
  } catch (error) {
    console.error("[ai.ubq.fi] Codex auth validation failed:", error);
    if (error instanceof CodexError) {
      return { ok: false, response: openaiError(error.status, error.message, error.code) };
    }
    const detail = error instanceof Error ? error.message : String(error);
    const message = detail ? `Upstream validation request failed: ${detail}` : "Upstream validation request failed.";
    return { ok: false, response: openaiError(502, message, "codex_upstream_unreachable") };
  }
};

/**
 * Normalizes the upstream catalog and mints the auth generation that fences the
 * stored snapshot. `crypto.randomUUID()` is called only for a valid snapshot,
 * after the size thresholds have passed.
 */
const prepareCodexAuthSnapshot = (
  validated: ValidatedCodexAuth
): { ok: true; snapshot: CodexModelsSnapshot; authGeneration: string } | { ok: false; response: Response } => {
  const snapshot = normalizeCodexModelsPayload(validated.models, {
    source: "chatgpt_codex",
    clientVersion: validated.clientVersion,
  });
  if (!snapshot) {
    return { ok: false, response: openaiError(502, "Codex upstream models response did not include a non-empty model catalog", "codex_upstream_unreachable") };
  }
  const snapshotSize = estimateJsonSize(snapshot);
  if (snapshotSize === null) {
    return { ok: false, response: openaiError(400, "models payload could not be serialized", "invalid_request_error") };
  }
  if (snapshotSize > SAFE_KV_BYTES) {
    return { ok: false, response: openaiError(413, `models snapshot too large (${snapshotSize} bytes; max ${MAX_KV_BYTES}).`, "invalid_request_error") };
  }
  return { ok: true, snapshot, authGeneration: crypto.randomUUID() };
};

/** Builds the runtime config that accompanies a new model snapshot. */
const buildCodexAuthRuntimeConfig = (
  snapshot: CodexModelsSnapshot,
  existingRuntime: unknown
): { ok: true; runtime: ReturnType<typeof buildRuntimeConfig> } | { ok: false; response: Response } => {
  const currentRuntime = normalizeRuntimeConfig(existingRuntime);
  try {
    return {
      ok: true,
      runtime: buildRuntimeConfig(snapshot, {
        defaultModel: preserveCodexDefaultModel(snapshot, currentRuntime?.default_model),
        defaultReasoningEffort: currentRuntime?.default_reasoning_effort,
      }),
    };
  } catch (error) {
    const response = runtimeConfigErrorResponse(error);
    if (response) return { ok: false, response };
    throw error;
  }
};

/** Commits the account pool, and — only for a full snapshot — the catalog keys. */
const commitCodexAuthState = async (
  kv: Kv,
  input: Readonly<{
    poolEntry: KvEntryMaybe<CodexAuthPoolState>;
    snapshotEntry: KvEntryMaybe<CodexModelsSnapshot>;
    runtimeEntry: KvEntryMaybe<unknown>;
    pool: CodexAuthPoolState;
    snapshot: CodexModelsSnapshot;
    runtime: ReturnType<typeof buildRuntimeConfig> | null;
    authGeneration: string | null;
    hasSnapshot: boolean;
  }>
): Promise<boolean> => {
  let atomic = kv.atomic().check(input.poolEntry).check(input.snapshotEntry).set(CODEX_AUTH_POOL_KV_KEY, input.pool);
  if (input.hasSnapshot && input.runtime && input.authGeneration) {
    atomic = atomic
      .check(input.runtimeEntry)
      .set(CODEX_CATALOG_AUTH_GENERATION_KEY, input.authGeneration)
      .set(CODEX_MODELS_KV_KEY, input.snapshot)
      .set(RUNTIME_CONFIG_V2_KEY, input.runtime);
  }
  return (await atomic.commit()).ok;
};

type CodexAuthPersistAttempt =
  | { kind: "stored"; pool: CodexAuthPoolState; snapshot: CodexModelsSnapshot; runtimeConfig: ReturnType<typeof buildRuntimeConfig> | null }
  | { kind: "retry" }
  | { kind: "response"; response: Response };

const persistCodexAuthStateAttempt = async (
  kv: Kv,
  input: Readonly<{ validatedAuth: CodexAuthState; snapshot: CodexModelsSnapshot | null; authGeneration: string | null }>
): Promise<CodexAuthPersistAttempt> => {
  const [existingPoolEntry, existingSnapshot, existingRuntimeEntry] = await Promise.all([
    kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY),
    kv.get<CodexModelsSnapshot>(CODEX_MODELS_KV_KEY),
    kv.get(RUNTIME_CONFIG_V2_KEY),
  ]);
  const existingPool = parseCodexAuthPool(existingPoolEntry.value);
  const nextPool = upsertCodexAuthAccount(existingPool, input.validatedAuth);
  if (!nextPool) {
    return {
      kind: "response",
      response: openaiError(
        409,
        "Codex auth pool already contains two accounts; upload an auth.json for an existing account to rotate it",
        "codex_auth_pool_full"
      ),
    };
  }
  const nextSnapshot = input.snapshot ? mergeCodexModelPromptCacheCapabilities(input.snapshot, existingSnapshot.value) : existingSnapshot.value;
  if (!nextSnapshot) {
    return { kind: "response", response: openaiError(409, "Cannot store rate-limited Codex auth without an existing model catalog", "codex_catalog_required") };
  }
  const built = input.snapshot && input.authGeneration ? buildCodexAuthRuntimeConfig(nextSnapshot, existingRuntimeEntry.value) : null;
  if (built && !built.ok) return { kind: "response", response: built.response };
  const stored = await commitCodexAuthState(kv, {
    poolEntry: existingPoolEntry,
    snapshotEntry: existingSnapshot,
    runtimeEntry: existingRuntimeEntry,
    pool: nextPool,
    snapshot: nextSnapshot,
    runtime: built?.ok ? built.runtime : null,
    authGeneration: input.authGeneration,
    hasSnapshot: input.snapshot !== null,
  });
  if (!stored) return { kind: "retry" };
  return { kind: "stored", pool: nextPool, snapshot: nextSnapshot, runtimeConfig: built?.ok ? built.runtime : null };
};

const persistCodexAuthState = async (
  kv: Kv,
  input: Readonly<{ validatedAuth: CodexAuthState; snapshot: CodexModelsSnapshot | null; authGeneration: string | null }>
): Promise<
  | { ok: true; pool: CodexAuthPoolState; snapshot: CodexModelsSnapshot; runtimeConfig: ReturnType<typeof buildRuntimeConfig> | null }
  | { ok: false; response: Response }
> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let attemptResult: CodexAuthPersistAttempt;
    try {
      attemptResult = await persistCodexAuthStateAttempt(kv, input);
    } catch (error) {
      if (!(error instanceof CodexError)) throw error;
      return { ok: false, response: openaiError(error.status, error.message, error.code) };
    }
    if (attemptResult.kind === "retry") continue;
    if (attemptResult.kind === "response") return { ok: false, response: attemptResult.response };
    return { ok: true, pool: attemptResult.pool, snapshot: attemptResult.snapshot, runtimeConfig: attemptResult.runtimeConfig };
  }
  return { ok: false, response: openaiError(500, "Deno KV could not persist Codex auth and models", "server_error") };
};

/**
 * Seeds the versioned upstream catalog. A seed failure is reported as `false`
 * and never fails the upload itself.
 */
const seedCodexAuthCatalog = async (kv: Kv, validated: CodexAuthValidation, authGeneration: string | null): Promise<boolean> => {
  if (!validated.ok || !authGeneration) return false;
  return await storeCodexCatalog(kv, {
    clientVersion: validated.clientVersion,
    authGeneration,
    body: validated.modelsBody,
    etag: validated.etag,
    contentType: validated.contentType,
    fetchedAtMs: Date.now(),
  }).catch((error: unknown) => {
    console.error("[ai.ubq.fi] Codex catalog seed failed:", error);
    return false;
  });
};

type CodexAuthUpload = Readonly<{ seed: CodexAuthState; clientVersion: string | null }>;

/** Accepts either the wrapped `{ auth, models }` upload or a bare auth.json. */
const parseCodexAuthUpload = (body: unknown): CodexAuthUpload | null => {
  const authPayload = isRecord(body) && "auth" in body ? (body.auth as unknown) : body;
  const modelsPayload = isRecord(body) && "models" in body ? (body.models as unknown) : undefined;
  const tokenData = parseCodexAuthFromAuthJson(authPayload);
  if (!tokenData) return null;
  const seed: CodexAuthState = { ...tokenData, updated_at_ms: Date.now() };
  const clientVersion = isRecord(modelsPayload) ? (getString(modelsPayload.client_version) ?? getString(modelsPayload.clientVersion)) : null;
  return { seed, clientVersion };
};

/** Maps an upstream validation result to its original 401, or `null` when acceptable. */
const codexAuthUpstreamErrorResponse = (validated: CodexAuthValidation): Response | null => {
  const authenticatedButLimited = !validated.ok && validated.status === 429;
  if (validated.ok || authenticatedButLimited) return null;
  return openaiError(401, `Invalid Codex auth.json (upstream ${validated.status}): ${validated.body}`, "invalid_api_key");
};

export const handleAdminCodexAuth = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot persist Codex auth", "server_error");
  }

  const upload = parseCodexAuthUpload(await readJsonBody(req));
  if (!upload) {
    return openaiError(400, "Body does not look like a Codex auth.json", "invalid_request_error");
  }

  const validation = await validateUploadedCodexAuth(upload.seed, upload.clientVersion);
  if (!validation.ok) return validation.response;
  const validated = validation.validated;

  const upstreamError = codexAuthUpstreamErrorResponse(validated);
  if (upstreamError) return upstreamError;

  const validatedAuth = validated.ok ? validated.auth : upload.seed;
  let snapshot: CodexModelsSnapshot | null = null;
  let authGeneration: string | null = null;
  if (validated.ok) {
    const prepared = prepareCodexAuthSnapshot(validated);
    if (!prepared.ok) return prepared.response;
    snapshot = prepared.snapshot;
    authGeneration = prepared.authGeneration;
  }

  const persisted = await persistCodexAuthState(kv, { validatedAuth, snapshot, authGeneration });
  if (!persisted.ok) return persisted.response;
  cacheCodexAuthPool(persisted.pool);
  if (persisted.runtimeConfig) cacheRuntimeConfig(persisted.runtimeConfig);

  const catalogSeeded = await seedCodexAuthCatalog(kv, validated, authGeneration);

  const modelsStored = {
    count: persisted.snapshot.models.length,
    source: persisted.snapshot.source,
    updated_at_ms: persisted.snapshot.updated_at_ms,
    client_version: persisted.snapshot.client_version ?? null,
  };

  const expMs = getJwtExpMs(validatedAuth.access_token);
  return json(
    200,
    {
      stored: true,
      refreshed: validated.ok ? validated.refreshed : false,
      account_id: validatedAuth.account_id,
      account_count: persisted.pool.accounts.length,
      account_ids: persisted.pool.accounts.map((account) => account.account_id),
      access_token_expires_at_ms: expMs,
      updated_at_ms: validatedAuth.updated_at_ms,
      upstream_status: validated.status,
      upstream_content_type: validated.ok ? validated.contentType : null,
      models: modelsStored,
      catalog_seeded: catalogSeeded,
      normalized_snapshot_updated: validated.ok,
    },
    { "x-uos-upstream": "chatgpt_codex" }
  );
};

export const handleAdminCodexModelsGet = async (): Promise<Response> => {
  const snapshot = await loadFullCodexModelsSnapshot();
  if (!snapshot) return json(200, { ok: true, data: null });
  return json(200, { ok: true, data: snapshot });
};

export const handleAdminCodexModelsSet = async (req: Request): Promise<Response> => {
  const raw = await readJsonBody(req);
  if (!raw) return openaiError(400, "Invalid JSON body", "invalid_request_error");

  const snapshot = normalizeCodexModelsPayload(raw);
  if (!snapshot) {
    return openaiError(400, "models must include a non-empty models array", "invalid_request_error");
  }
  const size = estimateJsonSize(snapshot);
  if (size === null) {
    return openaiError(400, "models payload could not be serialized", "invalid_request_error");
  }
  if (size > SAFE_KV_BYTES) {
    return openaiError(413, `models snapshot too large (${size} bytes; max ${MAX_KV_BYTES}).`, "invalid_request_error");
  }

  let stored: boolean;
  try {
    stored = await storeCodexModelsSnapshot(snapshot);
  } catch (error) {
    const response = runtimeConfigErrorResponse(error);
    if (response) return response;
    throw error;
  }
  if (!stored) {
    return openaiError(500, "Deno KV is not available; cannot persist Codex models", "server_error");
  }

  return json(200, {
    ok: true,
    stored: true,
    count: snapshot.models.length,
    source: snapshot.source,
    updated_at_ms: snapshot.updated_at_ms,
    client_version: snapshot.client_version ?? null,
  });
};

export const handleAdminCodexPromptsPurge = async (): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot purge Codex prompts", "server_error");
  }

  let deleted = 0;
  const entry = await kv.get(UOS_CODEX_PROMPTS_KEY);
  if (entry.value !== null) {
    await kv.delete(UOS_CODEX_PROMPTS_KEY);
    deleted++;
  }

  for await (const item of kv.list({ prefix: UOS_CODEX_PROMPTS_CHUNK_PREFIX })) {
    await kv.delete(item.key);
    deleted++;
  }

  return json(200, { deleted });
};

export const handleAdminCodexModelsWhitelistGet = async (): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot read model whitelist", "server_error", { type: "server_error" });
  }
  const whitelist = await loadCodexModelsWhitelist(kv);
  if (!whitelist) {
    return json(200, { ok: true, data: { model_ids: [], updated_at_ms: 0 } });
  }
  return json(200, { ok: true, data: { model_ids: [...whitelist.model_ids], updated_at_ms: whitelist.updated_at_ms } });
};

/**
 * Operator-facing model picker data: the complete discovered catalog (including
 * every model the whitelist currently hides) plus the stored whitelist, so the
 * admin console can render one consistent checkbox list from a single read.
 *
 * `buildCatalog` is injectable for tests, matching the other admin handlers.
 */
export const handleAdminModelsCatalogGet = async (dependencies: Readonly<{ buildCatalog?: typeof buildModelCatalogSnapshot }> = {}): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot read the model catalog", "server_error", { type: "server_error" });
  }
  const buildCatalog = dependencies.buildCatalog ?? buildModelCatalogSnapshot;
  const [catalog, whitelist] = await Promise.all([buildCatalog(), loadCodexModelsWhitelist(kv)]);
  const modelIds = whitelist ? [...whitelist.model_ids] : [];
  return json(
    200,
    {
      ok: true,
      data: {
        models: catalog.models,
        sources: catalog.sources,
        whitelist: { model_ids: modelIds, updated_at_ms: whitelist?.updated_at_ms ?? 0 },
        // An empty (or absent) whitelist applies no filter at all, which is the
        // documented behaviour the picker has to explain to the operator.
        filter_active: modelIds.length > 0,
      },
    },
    { "Cache-Control": "no-store" }
  );
};

/**
 * Force a metadata refresh from every upstream the catalog draws on, so the
 * operator can make the picker current on demand instead of waiting for a TTL or
 * for the next request to warm a cache.
 *
 * The refreshers are injectable for tests, matching the other admin handlers.
 */
export const handleAdminModelsRefresh = async (
  dependencies: Readonly<{
    refreshEnrichment?: () => Promise<OpenRouterModelsSnapshot | null>;
    refreshOpenlux?: typeof fetchMeteredModels;
    refreshSurplus?: typeof fetchSurplusModels;
  }> = {}
): Promise<Response> => {
  const before = openRouterModelsSnapshot();
  const refreshEnrichment = dependencies.refreshEnrichment ?? (() => fetchOpenRouterModels({ force: true }));
  const refreshOpenlux = dependencies.refreshOpenlux ?? fetchMeteredModels;
  const refreshSurplus = dependencies.refreshSurplus ?? fetchSurplusModels;
  const [enrichment, openlux, surplus] = await Promise.all([refreshEnrichment(), refreshOpenlux({ force: true }), refreshSurplus({ force: true })]);
  const enrichmentUpdatedAt = enrichment?.updated_at_ms ?? null;
  return json(
    200,
    {
      ok: true,
      data: {
        // A failed refresh keeps the last good snapshot, so the caller is told
        // both what is now cached and whether this call actually changed it.
        openrouter: {
          upstream_models: enrichment?.models.length ?? 0,
          updated_at_ms: enrichmentUpdatedAt,
          refreshed: enrichmentUpdatedAt !== (before?.updated_at_ms ?? null),
        },
        openlux: { models: openlux?.models.length ?? 0, updated_at_ms: openlux?.updated_at_ms ?? null },
        surplus: { models: surplus?.models.length ?? 0, updated_at_ms: surplus?.updated_at_ms ?? null },
      },
    },
    { "Cache-Control": "no-store" }
  );
};

export const handleAdminCodexModelsWhitelistSet = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot store model whitelist", "server_error", { type: "server_error" });
  }
  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const rawIds = raw.model_ids;
  if (!Array.isArray(rawIds)) {
    return openaiError(400, "model_ids must be an array", "invalid_request_error");
  }
  // Every entry has to be a string: silently dropping a bad entry would store a
  // selection the operator never made, and the console would show it as saved.
  if (rawIds.some((id: unknown) => typeof id !== "string")) {
    return openaiError(400, "model_ids must contain only strings", "invalid_request_error");
  }
  const modelIds = normalizeWhitelistModelIds(rawIds);
  const size = estimateJsonSize({ model_ids: modelIds });
  if (size === null || size > SAFE_KV_BYTES) {
    return openaiError(413, `model_ids payload too large (max ${MAX_KV_BYTES} bytes).`, "invalid_request_error");
  }
  const stored = await storeCodexModelsWhitelist(kv, modelIds);
  if (!stored) {
    return openaiError(500, "Deno KV is not available; cannot persist model whitelist", "server_error", { type: "server_error" });
  }
  return json(200, { ok: true, stored: true, model_ids: modelIds, updated_at_ms: Date.now() });
};

/**
 * The configured Codex subscriptions, each under the opaque account hash the
 * picker stores. A missing or unreadable auth pool is not an error here: the
 * provider roster still reports the Codex tier, just without selectable
 * subscriptions.
 */
const codexSubscriptionRoster = async (): Promise<readonly { id: string; label: string; slot: number }[]> => {
  try {
    const accounts = await getCodexCapacityAccounts();
    return await Promise.all(
      accounts.map(async (account) => ({
        id: codexSubscriptionSelectionId(await codexSubscriptionHash(account.account_id)),
        label: codexAccountLabel(account.slot, account.email),
        slot: account.slot,
      }))
    );
  } catch {
    return [];
  }
};

/**
 * Provider picker data: the fixed provider roster with the catalog entry count
 * each provider currently contributes, the selectable Codex subscriptions, and
 * the stored selection, so the admin console can render one consistent
 * checkbox list from a single read.
 *
 * `buildCatalog` is injectable for tests, matching the other admin handlers.
 */
/** A credential-gated row reflects its key; a discovered source keeps its own status. */
const providerStatusFor = (configured: boolean | null, source: ModelCatalogSource | undefined): string => {
  if (configured === null) return source?.status ?? "unavailable";
  return configured ? "available" : "unavailable";
};

export const handleAdminProviderSelectionGet = async (dependencies: Readonly<{ buildCatalog?: typeof buildModelCatalogSnapshot }> = {}): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot read the provider selection", "server_error", { type: "server_error" });
  }
  const buildCatalog = dependencies.buildCatalog ?? buildModelCatalogSnapshot;
  const [catalog, selection, subscriptions] = await Promise.all([buildCatalog(), loadProviderSelection(kv), codexSubscriptionRoster()]);
  const counts = new Map<string, number>(SELECTABLE_PROVIDER_IDS.map((id) => [id, 0]));
  for (const entry of catalog.models) {
    for (const provider of entry.providers) {
      const count = counts.get(provider.id);
      if (count !== undefined) counts.set(provider.id, count + 1);
    }
  }
  // A provider can be selectable before its catalog source is published: the
  // roster is the routing vocabulary and the catalog is discovered separately,
  // so an absent source is reported as unavailable and unconfigured instead of
  // taking the picker down with it.
  const sources = new Map<string, ModelCatalogSource>(Object.entries(catalog.sources));
  return json(
    200,
    {
      ok: true,
      data: {
        providers: [
          ...SELECTABLE_PROVIDER_IDS.filter((id) => id !== GATEWAY_PROVIDER_ID).map((id) => {
            const source = sources.get(id);
            const presentation = providerPresentation(id);
            // OpenRouter's catalog source is metadata enrichment, not dispatch
            // readiness: whether this gateway can serve /v1/systemone is the
            // credential alone, so its row reports the key, not the source.
            const credentialConfigured = id === "openrouter" ? readOpenRouterApiKey() !== null : null;
            return {
              id,
              label: presentation.label,
              tier: presentation.tier,
              tier_label: PROVIDER_TIERS.find((tier) => tier.id === presentation.tier)?.label ?? presentation.tier,
              detail: presentation.detail,
              endpoints: [...presentation.endpoints],
              health_key: presentation.health_key,
              model_count: counts.get(id) ?? 0,
              status: providerStatusFor(credentialConfigured, source),
              // Only credential-gated providers report this; for the discovered
              // sources the status already says whether they answered.
              configured: credentialConfigured ?? (source ? (source.configured ?? source.status === "available") : false),
              // Only the Codex tier can be narrowed to individual subscriptions.
              ...(id === "codex" ? { subscriptions } : {}),
            };
          }),
          // The gateway identity is a selectable provider like every other row:
          // checking it allows the synthetic waterfall route, and an active
          // selection without it switches the route off. Its catalog count and
          // credential readiness come from state, never from the checkbox.
          {
            id: GATEWAY_PROVIDER_ID,
            label: GATEWAY_PROVIDER_PRESENTATION.label,
            tier: GATEWAY_PROVIDER_PRESENTATION.tier,
            tier_label: PROVIDER_TIERS.find((tier) => tier.id === GATEWAY_PROVIDER_PRESENTATION.tier)?.label ?? GATEWAY_PROVIDER_PRESENTATION.tier,
            detail: GATEWAY_PROVIDER_PRESENTATION.detail,
            endpoints: [...GATEWAY_PROVIDER_PRESENTATION.endpoints],
            health_key: GATEWAY_PROVIDER_PRESENTATION.health_key,
            model_count: counts.get(GATEWAY_PROVIDER_ID) ?? 0,
            status: deepSeekWaterfallCatalogEnabled(null) ? "available" : "unavailable",
            configured: deepSeekWaterfallCatalogEnabled(null),
          },
        ],
        // The picker renders its tier filter from this list, in this order.
        tiers: PROVIDER_TIERS.map((tier) => ({ id: tier.id, label: tier.label })),
        selection: { provider_ids: selection ? [...selection.provider_ids] : [], updated_at_ms: selection?.updated_at_ms ?? 0 },
        // An empty (or absent) selection applies no filter at all, which is the
        // documented behaviour the picker has to explain to the operator.
        filter_active: providerSelectionIsActive(selection),
      },
    },
    { "Cache-Control": "no-store" }
  );
};

export const handleAdminProviderSelectionSet = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot store the provider selection", "server_error", { type: "server_error" });
  }
  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const rawIds = raw.provider_ids;
  if (!Array.isArray(rawIds)) {
    return openaiError(400, "provider_ids must be an array", "invalid_request_error");
  }
  // Every entry has to be a string naming a provider on the roster or one
  // configured subscription: silently dropping an unknown id would store a
  // selection the operator never made, and the console would show it as saved.
  if (rawIds.some((id: unknown) => typeof id !== "string")) {
    return openaiError(400, "provider_ids must contain only strings", "invalid_request_error");
  }
  const submittedIds = (rawIds as string[]).map((id) => id.trim());
  const unknownIds = submittedIds.filter((id) => !isProviderSelectionId(id));
  if (unknownIds.length) {
    return openaiError(400, `unknown provider ids: ${unknownIds.join(", ")}`, "invalid_request_error", { param: "provider_ids" });
  }
  const stored = await storeProviderSelection(kv, submittedIds.filter(isProviderSelectionId));
  if (!stored) {
    return openaiError(500, "Deno KV is not available; cannot persist the provider selection", "server_error", { type: "server_error" });
  }
  return json(200, { ok: true, stored: true, provider_ids: [...stored.provider_ids], updated_at_ms: stored.updated_at_ms });
};

export { MAX_KV_MIGRATION_BODY_BYTES, UOS_KERNEL_PUBKEYS_KEY, runtimeConfigErrorResponse };

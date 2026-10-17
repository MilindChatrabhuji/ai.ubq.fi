import type { Kv, KvEntryMaybe } from "#kv";
// Admin KV migration and defaults handlers, split out of src/admin.ts.

import { loadCodexModelsSnapshot } from "../codex/index.ts";
import {
  DEFAULT_KERNEL_POLICY_LIMIT_KEY,
  DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS,
  DEFAULT_KERNEL_POLICY_WINDOW_KEY,
  DEFAULT_KERNEL_POLICY_WINDOW_MS,
  DEFAULT_REASONING_EFFORT,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "../defaults.ts";
import { json, openaiError } from "../http.ts";
import { acquireKernelDefaultWindowCutover, type KernelDefaultWindowCutoverGuard, releaseKernelDefaultWindowCutover } from "../kernel/quota-v2.ts";
import { defaultIncludeLegacyForProfile, importKvMigrationLines, type KvMigrationProfile, validateKvMigrationTarget } from "../cache/kv-migration.ts";
import { getKv } from "../kv.ts";
import { buildRuntimeConfig, cacheRuntimeConfig, loadRuntimeConfig, normalizeRuntimeConfig, RUNTIME_CONFIG_V2_KEY } from "../runtime-config.ts";
import { readJsonBody } from "../request.ts";
import { getString, isRecord } from "../utils.ts";
import { getMeteredQuotaDiagnostics } from "../metered-quota.ts";
import { extractModelReasoningLevels, normalizeDefaultModel, normalizeKernelUsageLimitInput, normalizeKernelWindowMsInput } from "./api-keys.ts";
import { MAX_KV_MIGRATION_BODY_BYTES, runtimeConfigErrorResponse } from "./codex.ts";

const parseBooleanParam = (url: URL, name: string): boolean | null => {
  const value = url.searchParams.get(name);
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
};

const parseMigrationProfile = (url: URL): KvMigrationProfile | null => {
  // A missing, blank, or whitespace-only profile must still select "prod", so
  // this is an explicit comparison instead of a `||` default.
  const profile = url.searchParams.get("profile")?.trim();
  if (profile === "local") return "local";
  if (profile === undefined || profile === "" || profile === "prod") return "prod";
  return null;
};

function* splitNdjsonLines(text: string): Iterable<string> {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) yield line;
  }
}

export const handleAdminKvMigrationImport = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available; cannot import migration", "server_error");

  const url = new URL(req.url);
  const profile = parseMigrationProfile(url);
  if (!profile) return openaiError(400, "profile must be local or prod", "invalid_request_error");

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_KV_MIGRATION_BODY_BYTES) {
    return openaiError(413, "Migration body is too large", "invalid_request_error");
  }

  const body = await req.text();
  if (new TextEncoder().encode(body).length > MAX_KV_MIGRATION_BODY_BYTES) {
    return openaiError(413, "Migration body is too large", "invalid_request_error");
  }

  const includeCache = parseBooleanParam(url, "include_cache") === true;
  const includeLegacy = parseBooleanParam(url, "include_legacy") ?? defaultIncludeLegacyForProfile(profile);
  const overwrite = parseBooleanParam(url, "overwrite") === true;
  const write = parseBooleanParam(url, "write") === true;
  const dryRunParam = parseBooleanParam(url, "dry_run");
  if (write && dryRunParam === true) {
    return openaiError(400, "dry_run and write are mutually exclusive", "invalid_request_error");
  }
  const dryRun = !write;

  const result = await importKvMigrationLines(kv, splitNdjsonLines(body), {
    profile,
    includeCache,
    includeLegacy,
    overwrite,
    dryRun,
  });

  const summary = {
    profile,
    include_cache: includeCache,
    include_legacy: includeLegacy,
    overwrite,
    dry_run: dryRun,
    ...result,
  };
  // Import is intentionally allowed to apply valid rows before reporting
  // malformed ones, but callers must receive a non-success status whenever
  // the summary contains any errors.
  return json(result.errors > 0 ? 422 : 200, summary);
};

export const handleAdminKvMigrationValidate = async (): Promise<Response> => {
  const kv = await getKv();
  if (!kv) return openaiError(500, "Deno KV is not available; cannot validate migration", "server_error");
  return json(200, await validateKvMigrationTarget(kv));
};

type AdminDefaultsDependencies = Readonly<{
  getMeteredQuotaDiagnostics?: typeof getMeteredQuotaDiagnostics;
}>;

type AdminDefaultsIntent = Readonly<{
  writesModel: boolean;
  writesReasoning: boolean;
  wantsModelUpdate: boolean;
  writesKernelLimit: boolean;
  writesKernelWindow: boolean;
  requestedKernelLimit: number | null | undefined;
  requestedKernelWindow: number | null | undefined;
}>;

const defaultsBody = (model: string, reasoningEffort: ReasoningEffort, kernelPolicyLimit: number, kernelPolicyWindow: number) => ({
  defaults: {
    model,
    reasoning_effort: reasoningEffort,
    kernel_policy_limit_requests: kernelPolicyLimit,
    kernel_policy_window_ms: kernelPolicyWindow,
  },
});

/** Single shared response builder so every defaults JSON response stays byte-identical. */
const defaultsJson = (model: string, reasoningEffort: ReasoningEffort, kernelPolicyLimit: number, kernelPolicyWindow: number): Response =>
  json(200, defaultsBody(model, reasoningEffort, kernelPolicyLimit, kernelPolicyWindow));

const adminDefaultsGetResponse = async (kv: Kv, dependencies: AdminDefaultsDependencies): Promise<Response> => {
  const [runtime, kernelLimitEntry, kernelWindowEntry, meteredQuota] = await Promise.all([
    loadRuntimeConfig(kv),
    kv.get<number>(DEFAULT_KERNEL_POLICY_LIMIT_KEY),
    kv.get<number>(DEFAULT_KERNEL_POLICY_WINDOW_KEY),
    (dependencies.getMeteredQuotaDiagnostics ?? getMeteredQuotaDiagnostics)(),
  ]);
  const model = runtime?.default_model ?? "";
  const reasoningEffort = runtime?.default_reasoning_effort ?? DEFAULT_REASONING_EFFORT;
  const kernelPolicyLimit = normalizeKernelUsageLimitInput(kernelLimitEntry.value) ?? DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS;
  const kernelPolicyWindow = normalizeKernelWindowMsInput(kernelWindowEntry.value) ?? DEFAULT_KERNEL_POLICY_WINDOW_MS;
  return json(200, { ...defaultsBody(model, reasoningEffort, kernelPolicyLimit, kernelPolicyWindow), metered_quota: meteredQuota });
};

/** Resolves the model/reasoning pair and its runtime config, or the original error response. */
const resolveDefaultsModelUpdate = async (
  raw: Record<string, unknown>,
  intent: AdminDefaultsIntent,
  runtime: ReturnType<typeof normalizeRuntimeConfig>,
  currentModel: string
): Promise<
  { ok: true; model: string; reasoningEffort: ReasoningEffort; nextRuntime: ReturnType<typeof buildRuntimeConfig> | null } | { ok: false; response: Response }
> => {
  if (!runtime) return { ok: false, response: openaiError(503, "Runtime configuration is unavailable", "server_error") };
  const nextModel = intent.writesModel ? normalizeDefaultModel(raw.model) : currentModel;
  if (!nextModel) return { ok: false, response: openaiError(400, "model must be a non-empty string", "invalid_request_error") };

  const snapshot = await loadCodexModelsSnapshot();
  if (!snapshot || !Array.isArray(snapshot.models) || snapshot.models.length === 0) {
    return { ok: false, response: openaiError(409, "No Codex model snapshot stored", "invalid_request_error") };
  }
  const modelRecord = snapshot.models.find((entry) => isRecord(entry) && getString(entry.slug) === nextModel) ?? null;
  if (!modelRecord) {
    return { ok: false, response: openaiError(400, "model is not in the stored Codex model list", "invalid_request_error") };
  }

  const modelDefault = modelRecord.default_reasoning_level === null ? "none" : normalizeReasoningEffort(modelRecord.default_reasoning_level);
  const levels = extractModelReasoningLevels(modelRecord);
  const nextReasoning = intent.writesReasoning ? normalizeReasoningEffort(raw.reasoning_effort) : (modelDefault ?? levels.at(0) ?? "none");
  if (!nextReasoning) {
    return { ok: false, response: openaiError(400, "reasoning_effort must be a non-empty string", "invalid_request_error") };
  }

  try {
    const nextRuntime = buildRuntimeConfig(snapshot, { defaultModel: nextModel, defaultReasoningEffort: nextReasoning });
    return { ok: true, model: nextModel, reasoningEffort: nextReasoning, nextRuntime };
  } catch (error) {
    const response = runtimeConfigErrorResponse(error);
    if (response) return { ok: false, response };
    throw error;
  }
};

type AdminDefaultsCutover =
  { kind: "none" } | { kind: "guard"; guard: KernelDefaultWindowCutoverGuard } | { kind: "retry" } | { kind: "response"; response: Response };

/** Acquires the default-window cutover guard when (and only when) it is required. */
const resolveDefaultsCutover = async (
  kv: Kv,
  kernelLimitEntry: KvEntryMaybe<number>,
  kernelWindowEntry: KvEntryMaybe<number>,
  intent: AdminDefaultsIntent,
  kernelPolicyWindow: number
): Promise<AdminDefaultsCutover> => {
  const currentKernelWindow = normalizeKernelWindowMsInput(kernelWindowEntry.value) ?? DEFAULT_KERNEL_POLICY_WINDOW_MS;
  if (!intent.writesKernelWindow || kernelPolicyWindow === currentKernelWindow) return { kind: "none" };
  const cutover = await acquireKernelDefaultWindowCutover(kv, kernelLimitEntry, kernelWindowEntry);
  if (cutover.ok) return { kind: "guard", guard: cutover.guard };
  if (cutover.reason === "active_reservations") {
    return {
      kind: "response",
      response: openaiError(409, "Active Kernel quota reservations must settle before changing the default window", "invalid_request_error"),
    };
  }
  if (cutover.reason === "concurrent_change") return { kind: "retry" };
  return { kind: "response", response: openaiError(503, "Kernel quota ledger is unavailable", "server_error") };
};

const commitDefaultsUpdate = async (
  kv: Kv,
  input: Readonly<{
    runtimeEntry: KvEntryMaybe<unknown>;
    kernelLimitEntry: KvEntryMaybe<number>;
    kernelWindowEntry: KvEntryMaybe<number>;
    cutoverGuard: KernelDefaultWindowCutoverGuard | null;
    nextRuntime: ReturnType<typeof buildRuntimeConfig> | null;
    writesKernelLimit: boolean;
    kernelPolicyLimit: number;
    writesKernelWindow: boolean;
    kernelPolicyWindow: number;
  }>
): Promise<{ ok: boolean }> => {
  let atomic = kv.atomic().check(input.runtimeEntry).check(input.kernelLimitEntry).check(input.kernelWindowEntry);
  if (input.cutoverGuard) {
    atomic = atomic.check(input.cutoverGuard.entry).delete(input.cutoverGuard.key);
  }
  if (input.nextRuntime) atomic = atomic.set(RUNTIME_CONFIG_V2_KEY, input.nextRuntime);
  if (input.writesKernelLimit) atomic = atomic.set(DEFAULT_KERNEL_POLICY_LIMIT_KEY, input.kernelPolicyLimit);
  if (input.writesKernelWindow) atomic = atomic.set(DEFAULT_KERNEL_POLICY_WINDOW_KEY, input.kernelPolicyWindow);
  try {
    if ((await atomic.commit()).ok) return { ok: true };
  } catch (error) {
    if (input.cutoverGuard) await releaseKernelDefaultWindowCutover(kv, input.cutoverGuard);
    throw error;
  }
  if (input.cutoverGuard) await releaseKernelDefaultWindowCutover(kv, input.cutoverGuard);
  return { ok: false };
};

/** One read-modify-write attempt; the caller owns the three-attempt retry bound. */
const applyDefaultsUpdateAttempt = async (
  kv: Kv,
  raw: Record<string, unknown>,
  intent: AdminDefaultsIntent
): Promise<{ kind: "retry" } | { kind: "response"; response: Response }> => {
  const [runtimeEntry, kernelLimitEntry, kernelWindowEntry] = await Promise.all([
    kv.get(RUNTIME_CONFIG_V2_KEY, { consistency: "strong" }),
    kv.get<number>(DEFAULT_KERNEL_POLICY_LIMIT_KEY, { consistency: "strong" }),
    kv.get<number>(DEFAULT_KERNEL_POLICY_WINDOW_KEY, { consistency: "strong" }),
  ]);
  const runtime = normalizeRuntimeConfig(runtimeEntry.value);
  let model = runtime?.default_model ?? "";
  let reasoningEffort = runtime?.default_reasoning_effort ?? DEFAULT_REASONING_EFFORT;
  const kernelPolicyLimit = intent.requestedKernelLimit ?? normalizeKernelUsageLimitInput(kernelLimitEntry.value) ?? DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS;
  const kernelPolicyWindow = intent.requestedKernelWindow ?? normalizeKernelWindowMsInput(kernelWindowEntry.value) ?? DEFAULT_KERNEL_POLICY_WINDOW_MS;
  let nextRuntime = null as ReturnType<typeof buildRuntimeConfig> | null;

  if (intent.wantsModelUpdate) {
    const resolved = await resolveDefaultsModelUpdate(raw, intent, runtime, model);
    if (!resolved.ok) return { kind: "response", response: resolved.response };
    model = resolved.model;
    reasoningEffort = resolved.reasoningEffort;
    nextRuntime = resolved.nextRuntime;
  }

  if (!nextRuntime && !intent.writesKernelLimit && !intent.writesKernelWindow) {
    return { kind: "response", response: defaultsJson(model, reasoningEffort, kernelPolicyLimit, kernelPolicyWindow) };
  }

  const cutover = await resolveDefaultsCutover(kv, kernelLimitEntry, kernelWindowEntry, intent, kernelPolicyWindow);
  if (cutover.kind === "retry") return { kind: "retry" };
  if (cutover.kind === "response") return { kind: "response", response: cutover.response };

  const committed = await commitDefaultsUpdate(kv, {
    runtimeEntry,
    kernelLimitEntry,
    kernelWindowEntry,
    cutoverGuard: cutover.kind === "guard" ? cutover.guard : null,
    nextRuntime,
    writesKernelLimit: intent.writesKernelLimit,
    kernelPolicyLimit,
    writesKernelWindow: intent.writesKernelWindow,
    kernelPolicyWindow,
  });
  if (!committed.ok) return { kind: "retry" };
  if (nextRuntime) cacheRuntimeConfig(nextRuntime);
  return { kind: "response", response: defaultsJson(model, reasoningEffort, kernelPolicyLimit, kernelPolicyWindow) };
};

/**
 * Everything is parsed and every candidate is built before the one atomic
 * commit. In particular, a late kernel field error or a runtime-size error
 * cannot leave a model/defaults half-update behind, so a lost race simply
 * re-reads and rebuilds.
 */
const applyDefaultsUpdate = async (kv: Kv, raw: Record<string, unknown>, intent: AdminDefaultsIntent): Promise<Response> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attemptResult = await applyDefaultsUpdateAttempt(kv, raw, intent);
    if (attemptResult.kind === "retry") continue;
    return attemptResult.response;
  }
  return openaiError(409, "Defaults were modified concurrently; retry", "invalid_request_error");
};

const adminDefaultsPostResponse = async (kv: Kv, req: Request): Promise<Response> => {
  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const allowedFields = new Set(["model", "reasoning_effort", "kernel_policy_limit_requests", "kernel_policy_window_ms"]);
  for (const field of Object.keys(raw)) {
    if (!allowedFields.has(field)) {
      return openaiError(400, `Unknown defaults field: ${field}`, "invalid_request_error", { param: field });
    }
  }
  const writesModel = Object.prototype.hasOwnProperty.call(raw, "model");
  const writesReasoning = Object.prototype.hasOwnProperty.call(raw, "reasoning_effort");
  const writesKernelLimit = Object.prototype.hasOwnProperty.call(raw, "kernel_policy_limit_requests");
  const writesKernelWindow = Object.prototype.hasOwnProperty.call(raw, "kernel_policy_window_ms");
  const requestedKernelLimit = writesKernelLimit ? normalizeKernelUsageLimitInput(raw.kernel_policy_limit_requests) : undefined;
  if (writesKernelLimit && requestedKernelLimit === null) {
    return openaiError(400, "kernel_policy_limit_requests must be a non-negative number or -1 for unlimited", "invalid_request_error");
  }
  const requestedKernelWindow = writesKernelWindow ? normalizeKernelWindowMsInput(raw.kernel_policy_window_ms) : undefined;
  if (writesKernelWindow && requestedKernelWindow === null) {
    return openaiError(400, "kernel_policy_window_ms must be a positive number", "invalid_request_error");
  }
  return await applyDefaultsUpdate(kv, raw, {
    writesModel,
    writesReasoning,
    wantsModelUpdate: writesModel || writesReasoning,
    writesKernelLimit,
    writesKernelWindow,
    requestedKernelLimit,
    requestedKernelWindow,
  });
};

export const handleAdminDefaults = async (
  req: Request,
  dependencies: Readonly<{
    getMeteredQuotaDiagnostics?: typeof getMeteredQuotaDiagnostics;
  }> = {}
): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot manage defaults", "server_error");
  }

  if (req.method === "GET") return await adminDefaultsGetResponse(kv, dependencies);
  if (req.method === "POST") return await adminDefaultsPostResponse(kv, req);

  return openaiError(405, "Method not allowed", "method_not_allowed");
};

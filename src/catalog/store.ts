import type { Kv, KvEntry, KvKey } from "#kv";
// Codex catalog KV storage, leases and loading, split out of src/codex_catalog.ts.

import { parseCodexClientVersion } from "../models/codex-models.ts";
import { getString, isRecord, sha256Hex } from "../utils.ts";
import { openRouterMetadataFor } from "../models/openrouter-models.ts";
import {
  CODEX_CATALOG_AUTH_GENERATION_KEY,
  CODEX_CATALOG_CHUNK_BYTES,
  CODEX_CATALOG_CHUNK_PREFIX,
  CODEX_CATALOG_COLD_WAIT_MS,
  CODEX_CATALOG_LEASE_PREFIX,
  CODEX_CATALOG_MAX_VERSIONS,
  CODEX_CATALOG_PREFIX,
  CODEX_CATALOG_REFRESH_LEASE_MS,
  CODEX_CATALOG_RETENTION_MS,
} from "./types.ts";
import type { CodexCatalogMetadata, LoadedCodexCatalog, RefreshLease } from "./types.ts";

const catalogMemo = new Map<string, LoadedCodexCatalog>();

const catalogMemoKey = (metadata: CodexCatalogMetadata): string => `${metadata.client_version}:${metadata.auth_generation}:${metadata.body_generation}`;

const deleteCatalogMemoVersion = (version: string): void => {
  for (const [key, catalog] of catalogMemo) {
    if (catalog.metadata.client_version === version) catalogMemo.delete(key);
  }
};

const memoizeCatalog = (catalog: LoadedCodexCatalog): void => {
  const key = catalogMemoKey(catalog.metadata);
  // Map insertion order is the LRU order. Reinsert hits and replacements so
  // the first entry is always the least recently used catalog.
  catalogMemo.delete(key);
  catalogMemo.set(key, catalog);
  while (catalogMemo.size > CODEX_CATALOG_MAX_VERSIONS) {
    const leastRecentlyUsed = catalogMemo.keys().next().value;
    if (leastRecentlyUsed === undefined) break;
    catalogMemo.delete(leastRecentlyUsed);
  }
};

export const resetCodexCatalogMemoForTest = (): void => {
  catalogMemo.clear();
};

export const getCodexCatalogMemoVersionsForTest = (): string[] => [...catalogMemo.values()].map((catalog) => catalog.metadata.client_version);

const metadataKey = (version: string): KvKey => [...CODEX_CATALOG_PREFIX, version];
const chunkKey = (version: string, generation: string, index: number): KvKey => [...CODEX_CATALOG_CHUNK_PREFIX, version, generation, index];
const leaseKey = (version: string): KvKey => [...CODEX_CATALOG_LEASE_PREFIX, version];

const deleteCatalogChunks = async (kv: Kv, version: string, generation: string, chunkCount: number): Promise<void> => {
  for (let index = 0; index < chunkCount; index += 1) {
    await kv.delete(chunkKey(version, generation, index));
  }
};

const pruneCatalogVersions = async (kv: Kv, currentVersion: string): Promise<void> => {
  const catalogs: { entry: KvEntry<CodexCatalogMetadata>; metadata: CodexCatalogMetadata }[] = [];
  for await (const entry of kv.list<CodexCatalogMetadata>({ prefix: CODEX_CATALOG_PREFIX })) {
    if (isCatalogMetadata(entry.value)) catalogs.push({ entry, metadata: entry.value });
  }
  if (catalogs.length <= CODEX_CATALOG_MAX_VERSIONS) return;

  catalogs.sort((left, right) => left.metadata.fetched_at_ms - right.metadata.fetched_at_ms);
  let remaining = catalogs.length;
  for (const { entry, metadata } of catalogs) {
    if (remaining <= CODEX_CATALOG_MAX_VERSIONS) break;
    if (metadata.client_version === currentVersion) continue;
    const deleted = await kv.atomic().check(entry).delete(entry.key).commit();
    if (!deleted.ok) continue;
    deleteCatalogMemoVersion(metadata.client_version);
    await deleteCatalogChunks(kv, metadata.client_version, metadata.body_generation, metadata.chunk_count);
    remaining -= 1;
  }
};

const gzip = async (body: string): Promise<Uint8Array> => {
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const gunzip = async (bytes: Uint8Array): Promise<string> => {
  const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
};

const parseCatalogBody = (body: string): Record<string, unknown> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0) return null;
  if (
    !parsed.models.every((model) => {
      if (!isRecord(model)) return false;
      const id = getString(model.slug) ?? getString(model.id) ?? getString(model.model) ?? getString(model.name);
      return Boolean(id?.trim());
    })
  )
    return null;
  return parsed;
};

const isCatalogMetadata = (value: unknown): value is CodexCatalogMetadata =>
  isRecord(value) &&
  typeof value.client_version === "string" &&
  typeof value.auth_generation === "string" &&
  typeof value.body_generation === "string" &&
  typeof value.content_type === "string" &&
  (value.etag === null || typeof value.etag === "string") &&
  typeof value.fetched_at_ms === "number" &&
  Number.isFinite(value.fetched_at_ms) &&
  typeof value.chunk_count === "number" &&
  Number.isSafeInteger(value.chunk_count) &&
  value.chunk_count > 0 &&
  typeof value.compressed_bytes === "number" &&
  typeof value.body_bytes === "number" &&
  typeof value.sha256 === "string";

const loadCatalog = async (kv: Kv, version: string, authGeneration: string, nowMs: number): Promise<LoadedCodexCatalog | null> => {
  const entry = await kv.get<CodexCatalogMetadata>(metadataKey(version));
  const metadata = entry.value;
  if (!isCatalogMetadata(metadata) || metadata.auth_generation !== authGeneration) return null;
  if (nowMs - metadata.fetched_at_ms >= CODEX_CATALOG_RETENTION_MS) return null;
  const memoKey = catalogMemoKey(metadata);
  const cached = catalogMemo.get(memoKey);
  if (cached) {
    memoizeCatalog(cached);
    return cached;
  }

  const entries = await Promise.all(
    Array.from({ length: metadata.chunk_count }, (_, index) => kv.get<Uint8Array>(chunkKey(version, metadata.body_generation, index)))
  );
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const chunk = entry.value;
    if (!(chunk instanceof Uint8Array)) return null;
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }
  if (totalBytes !== metadata.compressed_bytes) return null;
  const compressed = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const body = await gunzip(compressed);
    if (new TextEncoder().encode(body).byteLength !== metadata.body_bytes) return null;
    if ((await sha256Hex(body)) !== metadata.sha256) return null;
    const parsed = parseCatalogBody(body);
    if (!parsed) return null;
    const loaded = { metadata, body, parsed };
    memoizeCatalog(loaded);
    return loaded;
  } catch {
    return null;
  }
};

/**
 * Trim an optional header value, treating a missing or blank value as absent.
 * A non-empty value is returned verbatim, so blank input can never be stored as
 * if it were a real header.
 */
const trimmedHeaderValue = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return null;
  return trimmed;
};

/**
 * Widen a Codex-facing catalog record to the model's real window when a source
 * states a larger one.
 *
 * The endpoint's catalog understates what it accepts: on 2026-09-17, direct
 * Codex-endpoint requests with coding headers were accepted at 916,463 input
 * tokens for `gpt-6-astra` and 918,450 for `gpt-5.6-luna`, while that catalog
 * advertises `context_window` 272,000 capped at `max_context_window` 872,000, and
 * Codex clamps an explicit `model_context_window` override to that maximum.
 * Advertising the model's actual window lets any client use it, and a client that
 * wants to stay inside a cheaper tier sets its own window or compaction limit.
 *
 * Enrichment supplies the wider window when it knows the id; ids no source widens
 * keep the endpoint's own numbers, so nothing unverified is inflated. Applied when
 * a catalog is stored, so every read path - including the verbatim-body fast path -
 * serves the widened values with matching integrity metadata.
 */
const widenCodexModelWindows = (record: Record<string, unknown>): boolean => {
  const id = getString(record.slug) ?? getString(record.id) ?? getString(record.model) ?? getString(record.name);
  if (!id) return false;
  const enrichment = openRouterMetadataFor(id);
  if (!enrichment) return false;
  const endpointWindow = positiveWindowCount(record.context_window);
  const endpointCeiling = positiveWindowCount(record.max_context_window);
  const widest = widestWindowCount(endpointWindow, endpointCeiling, enrichment.context_window_tokens, enrichment.max_context_window_tokens);
  if (widest === null) return false;
  let changed = false;
  if (endpointWindow === null || widest > endpointWindow) {
    record.context_window = widest;
    changed = true;
  }
  if (endpointCeiling === null || widest > endpointCeiling) {
    record.max_context_window = widest;
    changed = true;
  }
  return changed;
};

const widenCodexCatalogWindows = (body: string): string | null => {
  const parsed = parseCatalogBody(body);
  if (!parsed) return null;
  let changed = false;
  for (const model of parsed.models as unknown[]) {
    if (!isRecord(model)) continue;
    if (widenCodexModelWindows(model)) changed = true;
  }
  return changed ? JSON.stringify(parsed) : null;
};

const positiveWindowCount = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

const widestWindowCount = (...values: readonly (number | null)[]): number | null => {
  let widest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (widest === null || value > widest) widest = value;
  }
  return widest;
};

export const storeCodexCatalog = async (
  kv: Kv,
  input: Readonly<{
    clientVersion: string;
    authGeneration: string;
    body: string;
    etag?: string | null;
    contentType?: string | null;
    fetchedAtMs?: number;
  }>
): Promise<boolean> => {
  if (!parseCodexClientVersion(input.clientVersion) || !parseCatalogBody(input.body)) return false;
  const fetchedAtMs = input.fetchedAtMs ?? Date.now();
  const body = widenCodexCatalogWindows(input.body) ?? input.body;
  const compressed = await gzip(body);
  const bodyGeneration = crypto.randomUUID();
  const chunkCount = Math.ceil(compressed.byteLength / CODEX_CATALOG_CHUNK_BYTES);
  const expireIn = Math.max(1, fetchedAtMs + CODEX_CATALOG_RETENTION_MS - Date.now());

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * CODEX_CATALOG_CHUNK_BYTES;
    await kv.set(chunkKey(input.clientVersion, bodyGeneration, index), compressed.slice(start, start + CODEX_CATALOG_CHUNK_BYTES), { expireIn });
  }

  const metadata: CodexCatalogMetadata = {
    client_version: input.clientVersion,
    auth_generation: input.authGeneration,
    body_generation: bodyGeneration,
    content_type: trimmedHeaderValue(input.contentType) ?? "application/json",
    etag: trimmedHeaderValue(input.etag),
    fetched_at_ms: fetchedAtMs,
    chunk_count: chunkCount,
    compressed_bytes: compressed.byteLength,
    // Integrity metadata describes the bytes actually stored, which carry the
    // raised override ceiling, not the upstream response verbatim.
    body_bytes: new TextEncoder().encode(body).byteLength,
    sha256: await sha256Hex(body),
  };
  const metadataEntry = await kv.get<CodexCatalogMetadata>(metadataKey(input.clientVersion));
  const generation = await kv.get<string>(CODEX_CATALOG_AUTH_GENERATION_KEY);
  if (generation.value !== input.authGeneration) {
    await deleteCatalogChunks(kv, input.clientVersion, bodyGeneration, chunkCount);
    return false;
  }
  const published = (await kv.atomic().check(generation).check(metadataEntry).set(metadataKey(input.clientVersion), metadata, { expireIn }).commit()).ok;
  if (!published) {
    await deleteCatalogChunks(kv, input.clientVersion, bodyGeneration, chunkCount);
    return false;
  }
  deleteCatalogMemoVersion(input.clientVersion);
  const previous = metadataEntry.value;
  if (isCatalogMetadata(previous) && previous.body_generation !== bodyGeneration) {
    await deleteCatalogChunks(kv, input.clientVersion, previous.body_generation, previous.chunk_count);
  }
  await pruneCatalogVersions(kv, input.clientVersion).catch((error: unknown) => {
    console.error("[ai.ubq.fi] Codex catalog version pruning failed:", error);
  });
  return true;
};

const getAuthGeneration = async (kv: Kv): Promise<string> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await kv.get<string>(CODEX_CATALOG_AUTH_GENERATION_KEY);
    if (entry.value) return entry.value;
    const generation = crypto.randomUUID();
    const commit = await kv.atomic().check(entry).set(CODEX_CATALOG_AUTH_GENERATION_KEY, generation).commit();
    if (commit.ok) return generation;
  }
  const entry = await kv.get<string>(CODEX_CATALOG_AUTH_GENERATION_KEY);
  if (entry.value) return entry.value;
  throw new Error("Deno KV could not initialize the Codex catalog auth generation");
};

const acquireRefreshLease = async (kv: Kv, version: string, owner: string, nowMs: number): Promise<boolean> => {
  const key = leaseKey(version);
  const entry = await kv.get<RefreshLease>(key);
  if (entry.value && entry.value.lease_until_ms > nowMs) return false;
  const lease: RefreshLease = { owner, lease_until_ms: nowMs + CODEX_CATALOG_REFRESH_LEASE_MS };
  return (
    await kv
      .atomic()
      .check(entry)
      .set(key, lease, { expireIn: CODEX_CATALOG_REFRESH_LEASE_MS * 2 })
      .commit()
  ).ok;
};

const renewRefreshLease = async (kv: Kv, version: string, owner: string): Promise<boolean> => {
  const key = leaseKey(version);
  const entry = await kv.get<RefreshLease>(key);
  if (entry.value?.owner !== owner) return false;
  const lease: RefreshLease = { owner, lease_until_ms: Date.now() + CODEX_CATALOG_REFRESH_LEASE_MS };
  return (
    await kv
      .atomic()
      .check(entry)
      .set(key, lease, { expireIn: CODEX_CATALOG_REFRESH_LEASE_MS * 2 })
      .commit()
  ).ok;
};

const startRefreshLeaseHeartbeat = (
  kv: Kv,
  version: string,
  owner: string
): {
  lost: () => boolean;
  stop: () => Promise<void>;
} => {
  let stopped = false;
  let lost = false;
  let timer: Parameters<typeof clearTimeout>[0];
  let renewal: Promise<void> | null = null;
  const schedule = (): void => {
    timer = setTimeout(
      () => {
        renewal = renewRefreshLease(kv, version, owner)
          .then((renewed) => {
            if (!renewed) lost = true;
          })
          .catch((error: unknown) => {
            lost = true;
            console.error(`[ai.ubq.fi] Codex catalog lease renewal failed for ${version}:`, error);
          })
          .finally(() => {
            renewal = null;
            if (!stopped && !lost) schedule();
          });
      },
      Math.floor(CODEX_CATALOG_REFRESH_LEASE_MS / 3)
    );
  };
  schedule();
  return {
    lost: () => lost,
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await renewal;
    },
  };
};

const releaseRefreshLease = async (kv: Kv, version: string, owner: string): Promise<void> => {
  try {
    const key = leaseKey(version);
    const entry = await kv.get<RefreshLease>(key);
    if (entry.value?.owner === owner) await kv.atomic().check(entry).delete(key).commit();
  } catch (error) {
    console.error(`[ai.ubq.fi] Codex catalog lease release failed for ${version}:`, error);
  }
};

const authGenerationIsCurrent = async (kv: Kv, expected: string): Promise<boolean> =>
  (await kv.get<string>(CODEX_CATALOG_AUTH_GENERATION_KEY)).value === expected;

const loadCurrentGenerationCatalog = async (kv: Kv, version: string): Promise<LoadedCodexCatalog | null> => {
  const generation = (await kv.get<string>(CODEX_CATALOG_AUTH_GENERATION_KEY)).value;
  return generation ? await loadCatalog(kv, version, generation, Date.now()) : null;
};

const waitForColdCatalog = async (kv: Kv, version: string): Promise<LoadedCodexCatalog | null> => {
  const deadline = Date.now() + CODEX_CATALOG_COLD_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const authGeneration = (await kv.get<string>(CODEX_CATALOG_AUTH_GENERATION_KEY)).value;
    if (!authGeneration) continue;
    const catalog = await loadCatalog(kv, version, authGeneration, Date.now());
    if (catalog) return catalog;
  }
  return null;
};

export {
  acquireRefreshLease,
  authGenerationIsCurrent,
  getAuthGeneration,
  loadCatalog,
  loadCurrentGenerationCatalog,
  parseCatalogBody,
  releaseRefreshLease,
  startRefreshLeaseHeartbeat,
  waitForColdCatalog,
};

export { CODEX_CATALOG_AUTH_GENERATION_KEY };

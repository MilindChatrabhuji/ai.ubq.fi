// Shared Codex catalog constants and record types, split out of src/codex_catalog.ts.

export const CODEX_CATALOG_FRESH_MS = 5 * 60_000;
export const CODEX_CATALOG_RETENTION_MS = 24 * 60 * 60_000;
export const CODEX_CATALOG_REFRESH_LEASE_MS = 15_000;
export const CODEX_CATALOG_COLD_WAIT_MS = 5_000;
export const CODEX_CATALOG_CHUNK_BYTES = 55_000;
export const CODEX_CATALOG_MAX_VERSIONS = 32;
export const PROMPT_CACHE_SCOPE_PROMOTION_LEASE_MS = 120_000;

export const CODEX_CATALOG_AUTH_GENERATION_KEY = ["ubq_ai", "codex_catalog_auth_generation"] as const;
export const CODEX_CATALOG_PREFIX = ["ubq_ai", "codex_catalog"] as const;
export const CODEX_CATALOG_CHUNK_PREFIX = ["ubq_ai", "codex_catalog_chunk"] as const;
export const CODEX_CATALOG_SOURCE_CHUNK_PREFIX = ["ubq_ai", "codex_catalog_source_chunk"] as const;
export const CODEX_CATALOG_LEASE_PREFIX = ["ubq_ai", "codex_catalog_refresh_lease"] as const;

type CodexCatalogMetadata = Readonly<{
  client_version: string;
  auth_generation: string;
  body_generation: string;
  content_type: string;
  etag: string | null;
  fetched_at_ms: number;
  chunk_count: number;
  compressed_bytes: number;
  body_bytes: number;
  sha256: string;
  source_chunk_count?: number;
  source_compressed_bytes?: number;
  source_body_bytes?: number;
  source_sha256?: string;
}>;

type LoadedCodexCatalog = Readonly<{
  metadata: CodexCatalogMetadata;
  body: string;
  parsed: Record<string, unknown>;
  source_body?: string;
}>;

type RefreshLease = Readonly<{ owner: string; lease_until_ms: number }>;

export type { CodexCatalogMetadata, LoadedCodexCatalog, RefreshLease };

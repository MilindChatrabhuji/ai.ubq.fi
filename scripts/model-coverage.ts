/**
 * Report how much of the served model catalog the dynamic sources actually fill.
 *
 * The curated tables are disabled, so a model's capabilities now come from the
 * uploaded Codex catalog, the serving provider's discovery row, or OpenRouter
 * enrichment. This report answers the only question that matters about that
 * change: for the ids the gateway advertises today, does a source describe them,
 * and which ids does nothing describe?
 *
 * Usage:
 *   bun run models:coverage
 *   bun run models:coverage -- --base-url=http://127.0.0.1:8000
 *
 * It reads the live catalog over HTTP and the OpenRouter payload directly, and it
 * reuses the gateway's own matcher for the "could enrichment close this gap?"
 * column, so the report cannot disagree with the resolver.
 */
import { matchOpenRouterModel, openRouterModelsFromPayload, type OpenRouterModelMetadata } from "../src/models/openrouter-models.ts";

const DEFAULT_BASE_URL = "https://ai.ubq.fi";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 30_000;

type CatalogProvider = Readonly<{ id: string }>;

type CatalogRow = Readonly<{
  id: string;
  providers: readonly CatalogProvider[];
  context_window_tokens: number | null;
  max_context_window_tokens: number | null;
  auto_compact_token_limit_tokens: number | null;
  supported_reasoning_levels: readonly string[];
  context_source: string;
  reasoning_source: string;
}>;

type CatalogSource = Readonly<{ status?: string; count?: number }>;

type CatalogPayload = Readonly<{
  data: readonly CatalogRow[];
  sources: Readonly<Record<string, CatalogSource>>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const readString = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

const readTokenCount = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

const readProviders = (value: unknown): CatalogProvider[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (isRecord(entry) ? readString(entry.id) : null))
    .filter((id): id is string => id !== null)
    .map((id) => ({ id }));
};

const readReasoningLevel = (entry: unknown): string | null => {
  if (typeof entry === "string") return entry;
  if (isRecord(entry)) return readString(entry.effort);
  return null;
};

const readReasoningLevels = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map(readReasoningLevel).filter((level): level is string => level !== null);
};

const parseCatalogRow = (value: unknown): CatalogRow | null => {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;
  return {
    id,
    providers: readProviders(value.providers),
    context_window_tokens: readTokenCount(value.context_window_tokens),
    max_context_window_tokens: readTokenCount(value.max_context_window_tokens),
    auto_compact_token_limit_tokens: readTokenCount(value.auto_compact_token_limit_tokens),
    supported_reasoning_levels: readReasoningLevels(value.supported_reasoning_levels),
    context_source: readString(value.context_source) ?? "unknown",
    reasoning_source: readString(value.reasoning_source) ?? "unknown",
  };
};

const parseCatalog = (value: unknown): CatalogPayload | null => {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const sources = isRecord(value.sources) ? value.sources : {};
  const parsedSources: Record<string, CatalogSource> = {};
  for (const [id, source] of Object.entries(sources)) {
    parsedSources[id] = isRecord(source) ? { status: readString(source.status) ?? undefined, count: readTokenCount(source.count) ?? 0 } : {};
  }
  return { data: value.data.map(parseCatalogRow).filter((row): row is CatalogRow => row !== null), sources: parsedSources };
};

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} responded with HTTP ${response.status}`);
  return await response.json();
};

const argValue = (args: readonly string[], name: string): string | null => {
  for (const arg of args) {
    if (arg === `--${name}`) return "true";
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3) || null;
  }
  return null;
};

/** Strip trailing slashes without an anchored quantifier the linter reads as backtracking. */
const withoutTrailingSlash = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
};

const readBaseUrl = (args: readonly string[]): string => {
  const fromArgs = argValue(args, "base-url");
  if (fromArgs) return withoutTrailingSlash(fromArgs);
  try {
    return withoutTrailingSlash(process.env.BASE_URL ?? DEFAULT_BASE_URL);
  } catch {
    return DEFAULT_BASE_URL;
  }
};

const formatTokens = (value: number | null): string => (value === null ? "—" : value.toLocaleString("en-US"));

const pad = (value: string, width: number): string => (value.length >= width ? value : value + " ".repeat(width - value.length));

const table = (rows: readonly (readonly string[])[], widths: readonly number[]): string[] =>
  rows.map((row) =>
    row
      .map((cell, index) => pad(cell, widths[index] ?? 0))
      .join("  ")
      .trimEnd()
  );

const main = async (): Promise<void> => {
  const baseUrl = readBaseUrl(process.argv.slice(2));
  const [catalogPayload, openRouterPayload] = await Promise.all([fetchJson(`${baseUrl}/uos/models/catalog`), fetchJson(OPENROUTER_MODELS_URL)]);
  const catalog = parseCatalog(catalogPayload);
  if (!catalog) throw new Error("the catalog response was not a uos.model_catalog payload");
  const openRouterModels: readonly OpenRouterModelMetadata[] = openRouterModelsFromPayload(openRouterPayload);

  console.log(`catalog:    ${baseUrl}/uos/models/catalog`);
  console.log(`enrichment: ${OPENROUTER_MODELS_URL} (${openRouterModels.length} upstream models)`);
  console.log("");
  for (const [id, source] of Object.entries(catalog.sources)) {
    const count = source.count ?? 0;
    console.log(`source ${pad(id, 11)} ${pad(source.status ?? "unknown", 11)} ${count} models`);
  }
  console.log("");

  const rows = catalog.data.map((row) => {
    const match = matchOpenRouterModel(openRouterModels, row.id);
    return { row, match };
  });

  const header = ["model", "context", "auto-compact", "reasoning", "context source", "reasoning source", "openrouter"];
  const body = rows.map(({ row, match }) => [
    row.id,
    formatTokens(row.context_window_tokens),
    formatTokens(row.auto_compact_token_limit_tokens),
    row.supported_reasoning_levels.length ? row.supported_reasoning_levels.join(",") : "—",
    row.context_source,
    row.reasoning_source,
    match ? `match ${match.id}` : "no match",
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...body.map((row) => row[index].length)));
  for (const line of table([header], widths)) console.log(line);
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const line of table(body, widths)) console.log(line);
  console.log("");

  const withContext = rows.filter(({ row }) => row.context_window_tokens !== null);
  const withReasoning = rows.filter(({ row }) => row.supported_reasoning_levels.length > 0);
  const withBoth = rows.filter(({ row }) => row.context_window_tokens !== null && row.supported_reasoning_levels.length > 0);
  const bare = rows.filter(({ row }) => row.context_window_tokens === null && row.supported_reasoning_levels.length === 0);
  const fillable = bare.filter(({ match }) => match !== null);
  const unfillable = bare.filter(({ match }) => match === null);

  const sourceCounts = new Map<string, number>();
  for (const { row } of rows) {
    for (const source of new Set([row.context_source, row.reasoning_source])) {
      if (source === "unknown") continue;
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    }
  }

  console.log(`models:               ${rows.length}`);
  console.log(`context resolved:     ${withContext.length}`);
  console.log(`reasoning resolved:   ${withReasoning.length}`);
  console.log(`both resolved:        ${withBoth.length}`);
  console.log(`nothing resolved:     ${bare.length}`);
  const idList = (entries: readonly { row: CatalogRow }[]): string => (entries.length ? ` (${entries.map(({ row }) => row.id).join(", ")})` : "");
  console.log(`  fillable by OpenRouter: ${fillable.length}${idList(fillable)}`);
  console.log(`  no source describes it: ${unfillable.length}${idList(unfillable)}`);
  console.log("");
  for (const [source, count] of [...sourceCounts].sort((left, right) => right[1] - left[1])) {
    console.log(`resolved from ${pad(source, 19)} ${count} models`);
  }
};

if (import.meta.main) await main();

import { isLoopbackHostname } from "../src/auth/local-admin.ts";

const DEFAULT_BASE_URL = "http://localhost:8000";
const SPARK_FLAG = "--spark";
const MISSING_TOKEN_MESSAGE = "DENO_DEPLOY_TOKEN_UBIQUITY_DAO (or DENO_DEPLOY_TOKEN) is required for non-loopback admin endpoints.";

type Environment = Readonly<Record<string, string | undefined>>;

type AdminModelsOptions = Readonly<{
  env?: Environment;
  fetcher?: (input: URL, init: RequestInit) => Promise<Response>;
  log?: (message: string) => void;
  error?: (message: string) => void;
}>;

/** An empty variable counts as unset, as the shell `${VAR:-default}` expansions these tasks replaced treated it. */
const firstSet = (...values: (string | undefined)[]): string | undefined => values.find((value) => value !== undefined && value !== "");

/**
 * Parses BASE_URL once and classifies that parsed hostname by the server's own loopback rule (`isLoopbackHostname`),
 * never by a textual prefix such as `http://localhost*`. Only the path changes afterwards, so the requested host is
 * exactly the classified host.
 */
const resolveEndpoint = (env: Environment): Readonly<{ url: URL; token: string }> | Readonly<{ error: string }> => {
  const baseUrl = firstSet(env.BASE_URL) ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { error: `BASE_URL is not a valid URL: ${baseUrl}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: `BASE_URL must use http or https: ${baseUrl}` };
  const token = firstSet(env.DENO_DEPLOY_TOKEN_UBIQUITY_DAO, env.DENO_DEPLOY_TOKEN) ?? "";
  if (!token && !isLoopbackHostname(url.hostname)) return { error: MISSING_TOKEN_MESSAGE };
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}/admin/codex/models`;
  url.search = "";
  url.hash = "";
  return { url, token };
};

const sparkSlugs = (payload: unknown): string[] => {
  const data = payload !== null && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
  const models = data !== null && typeof data === "object" ? (data as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return [];
  return models.flatMap((model: unknown) => {
    const slug = model !== null && typeof model === "object" ? (model as { slug?: unknown }).slug : undefined;
    return typeof slug === "string" && slug.includes("-spark") ? [slug] : [];
  });
};

/** Backs `bun run admin:models` (prints the admin Codex model catalog) and `admin:models:spark` (prints spark slugs). */
export const runAdminModels = async (args: readonly string[], options: AdminModelsOptions = {}): Promise<number> => {
  const log = options.log ?? console.log;
  const logError = options.error ?? console.error;
  const unknown = args.find((arg) => arg !== SPARK_FLAG);
  if (unknown !== undefined) {
    logError(`Unknown argument '${unknown}'. Supported arguments: ${SPARK_FLAG}`);
    return 1;
  }
  const endpoint = resolveEndpoint(options.env ?? process.env);
  if ("error" in endpoint) {
    logError(endpoint.error);
    return 1;
  }

  let response: Response;
  let body: string;
  try {
    response = await (options.fetcher ?? fetch)(endpoint.url, {
      headers: endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {},
      redirect: "manual",
    });
    body = await response.text();
  } catch (error) {
    logError(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!response.ok) {
    const detail = body ? `: ${body}` : "";
    logError(`Admin models request failed with HTTP ${response.status}${detail}`);
    return 1;
  }
  if (!args.includes(SPARK_FLAG)) {
    log(body);
    return 0;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    logError("Admin models response is not JSON.");
    return 1;
  }
  for (const slug of sparkSlugs(payload)) log(slug);
  return 0;
};

if (import.meta.main) {
  process.exitCode = await runAdminModels(process.argv.slice(2));
}

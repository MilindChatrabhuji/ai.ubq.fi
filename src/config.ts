import { RELEASE_GIT_SHA } from "./release.ts";

export type Config = Readonly<{
  isDeploy: boolean;
  allowOrigin: string;
  authTokens: ReadonlySet<string>;
  adminTokens: ReadonlySet<string>;
  codexBaseUrl: string;
  codexAuthJsonB64: string;
}>;

const parseTokens = (raw: string | undefined | null): Set<string> => {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\n,]/g)
      .map((token) => token.trim())
      .filter(Boolean)
  );
};

const getEnv = (key: string): string | undefined => {
  try {
    return process.env[key];
  } catch {
    return undefined;
  }
};

const firstNonEmpty = (...values: readonly (string | undefined)[]): string | undefined => {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
};

const loadConfig = (): Config => {
  const isDeploy = Boolean(getEnv("DENO_DEPLOY") ?? getEnv("DENO_DEPLOYMENT_ID") ?? getEnv("DENO_REGION"));
  const authTokens = parseTokens(getEnv("UOS_AI_TOKEN"));
  const adminTokens = parseTokens(getEnv("DENO_DEPLOY_TOKEN"));
  const allowOrigin = (getEnv("CORS_ALLOW_ORIGIN") ?? "*").trim() || "*";

  const codexBaseUrl = (getEnv("CODEX_BASE_URL") ?? "https://chatgpt.com/backend-api/codex").trim().replace(/\/$/, "");
  const codexAuthJsonB64 = (getEnv("CODEX_AUTH_JSON_B64") ?? "").trim();

  return {
    isDeploy,
    codexBaseUrl,
    codexAuthJsonB64,
    allowOrigin,
    authTokens,
    adminTokens,
  };
};

export const config = loadConfig();

export const runtimeGitSha = (): string => RELEASE_GIT_SHA;
// Deploy 2 exposes the routed revision as DENO_DEPLOY_BUILD_ID. Keep the
// Classic variable as a local/rollback fallback so older rollback artifacts
// still identify themselves truthfully.
export const runtimeDeploymentId = (): string => {
  // A configured-but-blank variable must still fall through to the next
  // source, so this cannot use nullish coalescing.
  const configured = firstNonEmpty(getEnv("DENO_DEPLOY_BUILD_ID")?.trim(), getEnv("DENO_DEPLOYMENT_ID")?.trim());
  if (configured) return configured;
  if (config.isDeploy || runtimeGitSha() === "unknown") return "unknown";
  return `${process.platform === "darwin" ? "mac" : "vps"}-${runtimeGitSha()}`;
};

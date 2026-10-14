const parseArgs = (args: string[]): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
};

const USAGE = `ubq-ai health check

Checks public gateway release liveness and exits non-zero when unreachable.
It does not attest provider or KV health; use authenticated admin health
endpoints for those diagnostics.

Usage:
  bun run scripts/health-check.ts [--url https://ai.ubq.fi] [--json]
`;

type HealthCheckOptions = Readonly<{
  fetcher?: typeof fetch;
  log?: (message: string) => void;
  error?: (message: string) => void;
}>;

export const runHealthCheck = async (args: string[], options: HealthCheckOptions = {}): Promise<number> => {
  const log = options.log ?? console.log;
  const logError = options.error ?? console.error;
  if (args.some((arg) => arg === "--auth" || arg.startsWith("--auth="))) {
    logError(
      "--auth is no longer supported. /health is release liveness only; use authenticated /health/providers or /health/upstream for operational diagnostics."
    );
    return 2;
  }
  if (args.includes("--help") || args.includes("-h")) {
    log(USAGE);
    return 0;
  }

  const parsed = parseArgs(args);
  const baseUrl = (parsed.url as string | undefined) ?? "https://ai.ubq.fi";
  const wantJson = parsed.json === true;
  const endpoint = new URL("/health", baseUrl);

  let res: Response;
  try {
    res = await (options.fetcher ?? fetch)(endpoint, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logError(`Request failed: ${detail}`);
    return 2;
  }

  const contentType = res.headers.get("Content-Type") ?? "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await res.json().catch(() => null) : null;
  const payloadRecord = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const ok = res.ok;

  if (wantJson) {
    log(JSON.stringify({ status: res.status, ok, payload }, null, 2));
  } else if (ok) {
    log(`OK ${res.status} mode=release_liveness`);
  } else {
    const errorText = typeof payloadRecord?.error === "string" ? payloadRecord.error : res.statusText;
    logError(`FAIL ${res.status} mode=release_liveness error=${errorText}`);
  }

  return ok ? 0 : 1;
};

if (import.meta.main) {
  process.exitCode = await runHealthCheck(process.argv.slice(2));
}

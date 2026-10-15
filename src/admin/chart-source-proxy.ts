// The Mac and VPS gateways keep separate KV stores, so their local provider
// analytics histories diverge. The Mac loopback admin is the only request path
// that already proves "this is the local companion gateway": the VPS public
// admin has a non-loopback URL host, and the Mac LAN admin is not a loopback
// peer. For that path, merge the canonical VPS chart payload into the local
// payload so the chart lines, cache bars, reset markers, and five-xx overlay
// match production while local routing, resets, settings, and the account list
// stay local.

import { isAdminAuthDisabledForRequest } from "../auth/local-admin.ts";
import { json } from "../http.ts";

const REMOTE_CHART_ORIGIN = "https://ai.ubq.fi";
const REMOTE_CHART_TIMEOUT_MS = 10_000;

// Cloudflare returns 403 code 1010 to the default fetch user agent. The
// browser-like signature used by the admin page itself is accepted.
const REMOTE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** Chart-only fields replaced from the canonical VPS admin response. */
const REMOTE_CAPACITY_CHART_FIELDS = ["history", "reset_events", "rate_limit_reset_events", "downtime_events", "prompt_cache", "ledger_growth"] as const;

export type ChartSourceProxyDeps = Readonly<{
  fetch?: typeof fetch;
  token?: string | null;
  remoteOrigin?: string;
  isLoopbackAdmin?: (request: Request) => boolean;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readAdminToken = (): string | null => {
  try {
    const raw = Deno.env.get("DENO_DEPLOY_TOKEN");
    const token = raw?.trim();
    if (!token) return null;
    return token;
  } catch {
    return null;
  }
};

const isChartProxyPath = (request: Request): boolean => {
  const url = new URL(request.url);
  if (url.pathname === "/admin/providers/capacity") return true;
  return url.pathname === "/admin/errors" && url.searchParams.get("limit") === "1";
};

const remoteChartUrl = (request: Request, remoteOrigin: string): URL => {
  const source = new URL(request.url);
  return new URL(`${source.pathname}${source.search}`, remoteOrigin);
};

const fetchRemoteChart = async (request: Request, remoteOrigin: string, token: string, fetcher: typeof fetch): Promise<Response | null> => {
  try {
    const response = await fetcher(remoteChartUrl(request, remoteOrigin), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": REMOTE_USER_AGENT,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(REMOTE_CHART_TIMEOUT_MS),
    });
    return response.ok ? response : null;
  } catch {
    return null;
  }
};

const mergeRemoteCapacityChart = (localPayload: unknown, remotePayload: unknown): unknown => {
  if (!isRecord(localPayload) || !isRecord(remotePayload)) return localPayload;
  const merged: Record<string, unknown> = { ...localPayload };
  for (const field of REMOTE_CAPACITY_CHART_FIELDS) {
    if (field in remotePayload) merged[field] = remotePayload[field];
  }
  return merged;
};

/**
 * Serves the canonical VPS chart data to the Mac loopback admin without
 * touching local KV, routing, resets, settings, or the account list. Any
 * non-loopback request, missing token, or failed remote read keeps the local
 * response unchanged.
 */
export const proxyAdminChartSource = async (
  request: Request,
  localResponse: Response | Promise<Response>,
  deps: ChartSourceProxyDeps = {}
): Promise<Response> => {
  const local = await localResponse;
  const isLoopbackAdmin = deps.isLoopbackAdmin ?? isAdminAuthDisabledForRequest;
  if (!isLoopbackAdmin(request) || !isChartProxyPath(request)) return local;
  const token = deps.token === undefined ? readAdminToken() : deps.token;
  if (!token) return local;
  const remote = await fetchRemoteChart(request, deps.remoteOrigin ?? REMOTE_CHART_ORIGIN, token, deps.fetch ?? fetch);
  if (!remote) return local;
  const url = new URL(request.url);
  if (url.pathname === "/admin/errors") return remote;
  if (!local.ok) return local;
  let localPayload: unknown;
  let remotePayload: unknown;
  try {
    localPayload = await local.clone().json();
    remotePayload = await remote.json();
  } catch {
    return local;
  }
  return json(200, mergeRemoteCapacityChart(localPayload, remotePayload), { "Cache-Control": "no-store" });
};

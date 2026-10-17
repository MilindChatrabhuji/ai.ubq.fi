// The Mac and VPS gateways keep separate KV stores, so their local provider
// analytics histories diverge. The Mac loopback admin is the only request path
// that already proves "this is the local companion gateway": the VPS public
// admin has a non-loopback URL host, and the Mac LAN admin is not a loopback
// peer. For that path, merge the canonical VPS chart payload into the local
// response. Local routing, resets, settings, and the account list stay local.
//
// The Mac companion service (and no development server, even one holding the
// production token) also pushes its new local samples to the VPS in the
// background, where they only fill chart buckets the VPS did not observe.

import { isAdminAuthDisabledForRequest, isMacCompanionServiceListener } from "../auth/local-admin.ts";
import { json } from "../http.ts";
import { isRemoteCapacityHostId, MAX_REMOTE_CAPACITY_OBSERVATIONS } from "../provider/capacity-analytics.ts";

const REMOTE_CHART_ORIGIN = "https://ai.ubq.fi";
const REMOTE_CHART_TIMEOUT_MS = 10_000;
/** The push runs beside the chart read; a slow VPS write is abandoned and retried on a later poll. */
const REMOTE_PUSH_TIMEOUT_MS = 5_000;
const REMOTE_CAPACITY_OBSERVATION_PATH = "/admin/providers/capacity/observations";

/** The host id the pushed rows are stored under; the default names the one Mac companion. */
const CAPACITY_OBSERVATION_HOST_ENV = "UOS_CAPACITY_OBSERVATION_HOST_ID";
const DEFAULT_CAPACITY_OBSERVATION_HOST_ID = "mac";

// Cloudflare returns 403 code 1010 to the default fetch user agent. The
// browser-like signature used by the admin page itself is accepted.
const REMOTE_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** Chart-only fields replaced from the canonical VPS admin response. */
const REMOTE_CAPACITY_CHART_FIELDS = ["history", "reset_events", "rate_limit_reset_events", "downtime_events", "prompt_cache", "ledger_growth"] as const;

/** Per-process push progress: the newest local sample the VPS acknowledged, and the push in flight. */
export type CapacityPushState = {
  acknowledgedSampledAtMs: number | null;
  inFlight: Promise<void> | null;
};

const processPushState: CapacityPushState = { acknowledgedSampledAtMs: null, inFlight: null };

export type ChartSourceProxyDeps = Readonly<{
  fetch?: typeof fetch;
  token?: string | null;
  remoteOrigin?: string;
  isLoopbackAdmin?: (request: Request) => boolean;
  /** True only in the Mac companion service process. */
  isMacCompanionService?: () => boolean;
  /** Host id for pushed rows; null or an invalid id disables the push. */
  hostId?: string | null;
  pushState?: CapacityPushState;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// DENO_DEPLOY_TOKEN keeps its historical name under Bun. Like config.ts, it
// may hold a comma- or newline-separated list; the first entry is sent.
const readAdminToken = (): string | null => {
  try {
    const token = process.env.DENO_DEPLOY_TOKEN?.split(/[\n,]/g)
      .map((entry) => entry.trim())
      .find(Boolean);
    return token ?? null;
  } catch {
    return null;
  }
};

/** The configured host id, `mac` when unset, or null when the configured value is not a valid host id. */
const readCapacityObservationHostId = (): string | null => {
  try {
    const configured = process.env[CAPACITY_OBSERVATION_HOST_ENV]?.trim();
    if (!configured) return DEFAULT_CAPACITY_OBSERVATION_HOST_ID;
    return isRemoteCapacityHostId(configured) ? configured : null;
  } catch {
    return null;
  }
};

const isChartProxyPath = (request: Request): boolean => {
  const url = new URL(request.url);
  if (url.pathname === "/admin/providers/capacity") return true;
  return url.pathname === "/admin/errors" && url.searchParams.get("limit") === "1";
};

// Only the chart path and the one parameter the five-xx overlay needs reach the
// VPS. A loopback caller cannot steer the VPS read, for example with
// `?refresh=live`, which forces an upstream probe there.
const remoteChartUrl = (pathname: string, remoteOrigin: string): URL =>
  new URL(pathname === "/admin/errors" ? "/admin/errors?limit=1" : pathname, remoteOrigin);

const releaseBody = async (response: Response): Promise<void> => {
  const cancellation = response.body?.cancel();
  if (cancellation) await cancellation.catch(() => {});
};

const remoteHeaders = (token: string): Record<string, string> => ({
  Accept: "application/json",
  Authorization: `Bearer ${token}`,
  "User-Agent": REMOTE_USER_AGENT,
});

/** The parsed canonical VPS payload, or undefined when the read fails or its body is not JSON. */
const readRemoteChart = async (pathname: string, remoteOrigin: string, token: string, fetcher: typeof fetch): Promise<unknown> => {
  try {
    const response = await fetcher(remoteChartUrl(pathname, remoteOrigin), {
      headers: remoteHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(REMOTE_CHART_TIMEOUT_MS),
    });
    if (!response.ok) {
      await releaseBody(response);
      return undefined;
    }
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
};

type PendingSample = Record<string, unknown> & { sampled_at_ms: number };

/** Local samples newer than the acknowledged one, oldest first, at most one ingest batch. */
const pendingCapacitySamples = (payload: unknown, acknowledgedSampledAtMs: number | null): PendingSample[] => {
  if (!isRecord(payload) || !Array.isArray(payload.history)) return [];
  return payload.history
    .filter(
      (point): point is PendingSample =>
        isRecord(point) &&
        typeof point.sampled_at_ms === "number" &&
        Number.isFinite(point.sampled_at_ms) &&
        (acknowledgedSampledAtMs === null || point.sampled_at_ms > acknowledgedSampledAtMs)
    )
    .sort((left, right) => left.sampled_at_ms - right.sampled_at_ms)
    .slice(0, MAX_REMOTE_CAPACITY_OBSERVATIONS);
};

/**
 * `stored`: the VPS acknowledged the batch for this host. `refused`: the VPS
 * rejected the batch itself (400 or 413), so resending it can never succeed.
 * `retry`: anything else, including auth, timeouts, 5xx, and a body that is
 * not the acknowledgement.
 */
type PushOutcome = "stored" | "refused" | "retry";

const pushCapacitySamples = async (
  samples: readonly PendingSample[],
  hostId: string,
  remoteOrigin: string,
  token: string,
  fetcher: typeof fetch
): Promise<PushOutcome> => {
  try {
    const response = await fetcher(new URL(REMOTE_CAPACITY_OBSERVATION_PATH, remoteOrigin), {
      method: "POST",
      headers: { ...remoteHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ host: hostId, history: samples }),
      cache: "no-store",
      signal: AbortSignal.timeout(REMOTE_PUSH_TIMEOUT_MS),
    });
    if (!response.ok) {
      await releaseBody(response);
      return response.status === 400 || response.status === 413 ? "refused" : "retry";
    }
    const acknowledgement: unknown = await response.json();
    return isRecord(acknowledgement) && acknowledgement.host === hostId && typeof acknowledgement.accepted === "number" ? "stored" : "retry";
  } catch {
    return "retry";
  }
};

/**
 * Starts at most one background push at a time. It sends only samples newer
 * than the last acknowledged one, so an open Analytics tab sends each sample
 * once instead of the whole week on every thirty-second poll. A failed or
 * unacknowledged push leaves the same samples pending for the next poll; a
 * batch the VPS refuses as invalid is skipped so it cannot block later samples.
 * The chart read never waits for it.
 */
const startCapacityPush = (payload: unknown, hostId: string, remoteOrigin: string, token: string, fetcher: typeof fetch, state: CapacityPushState): void => {
  if (state.inFlight) return;
  const samples = pendingCapacitySamples(payload, state.acknowledgedSampledAtMs);
  const newest = samples.at(-1)?.sampled_at_ms;
  if (newest === undefined) return;
  state.inFlight = pushCapacitySamples(samples, hostId, remoteOrigin, token, fetcher)
    .then((outcome) => {
      if (outcome !== "retry") state.acknowledgedSampledAtMs = Math.max(state.acknowledgedSampledAtMs ?? newest, newest);
    })
    .finally(() => {
      state.inFlight = null;
    });
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
 * touching local KV, routing, resets, settings, the account list, or the local
 * error rows. Non-loopback requests, a missing token, a failed local response,
 * or a failed remote read keep the local response unchanged.
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
  if (!token || !local.ok) return local;
  const remoteOrigin = deps.remoteOrigin ?? REMOTE_CHART_ORIGIN;
  const fetcher = deps.fetch ?? fetch;
  const { pathname } = new URL(request.url);
  let localPayload: unknown;
  try {
    localPayload = await local.clone().json();
  } catch {
    return local;
  }
  if (pathname === "/admin/errors") {
    // Bun fetch decodes a compressed body but keeps the upstream
    // Content-Encoding and Content-Length, so the remote Response is never
    // forwarded: only its five-xx buckets are re-serialized with fresh headers.
    const overlay = await readRemoteChart(pathname, remoteOrigin, token, fetcher);
    if (!isRecord(localPayload) || !isRecord(overlay) || !Array.isArray(overlay.five_xx_buckets)) return local;
    return json(200, { ...localPayload, five_xx_buckets: overlay.five_xx_buckets }, { "Cache-Control": "no-store" });
  }
  const isMacCompanionService = deps.isMacCompanionService ?? isMacCompanionServiceListener;
  const hostId = deps.hostId === undefined ? readCapacityObservationHostId() : deps.hostId;
  if (isMacCompanionService() && isRemoteCapacityHostId(hostId)) {
    startCapacityPush(localPayload, hostId, remoteOrigin, token, fetcher, deps.pushState ?? processPushState);
  }
  const remotePayload = await readRemoteChart(pathname, remoteOrigin, token, fetcher);
  if (remotePayload === undefined) return local;
  return json(200, mergeRemoteCapacityChart(localPayload, remotePayload), { "Cache-Control": "no-store" });
};

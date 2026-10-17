import type { Addr } from "#http";
import { config } from "../config.ts";
export type ServeRuntimeOptions = Readonly<{
  disableAdminAuth: boolean;
}>;

const DISABLE_ADMIN_AUTH_FLAG = "--disable-admin-auth";

const formatArgumentError = (argument: string): Error =>
  new Error(`[ai.ubq.fi] Unknown server argument '${argument}'. Supported arguments: ${DISABLE_ADMIN_AUTH_FLAG}`);

export const parseServeRuntimeOptions = (
  args: readonly string[],
  options: Readonly<{ isDeploy: boolean; isProductionTimeline: boolean }>
): ServeRuntimeOptions => {
  let disableAdminAuth = false;

  for (const argument of args) {
    if (argument !== DISABLE_ADMIN_AUTH_FLAG) throw formatArgumentError(argument);
    if (disableAdminAuth) {
      throw new Error(`[ai.ubq.fi] Server argument '${DISABLE_ADMIN_AUTH_FLAG}' may only be specified once.`);
    }
    disableAdminAuth = true;
  }

  if (disableAdminAuth && options.isDeploy) {
    throw new Error(`[ai.ubq.fi] ${DISABLE_ADMIN_AUTH_FLAG} is unavailable in Deno Deploy.`);
  }
  // The production VPS serves Caddy-proxied public traffic on its loopback listener (#262).
  if (disableAdminAuth && options.isProductionTimeline) {
    throw new Error(`[ai.ubq.fi] ${DISABLE_ADMIN_AUTH_FLAG} is unavailable on the production timeline (DENO_TIMELINE=production).`);
  }

  return Object.freeze({ disableAdminAuth });
};

const normalizeHostname = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
};

const isIpv4Loopback = (hostname: string): boolean => {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  const parsed = octets.map((octet) => Number(octet));
  return parsed.every((octet, index) => Number.isInteger(octet) && octet >= 0 && octet <= 255 && String(octet) === octets[index]) && parsed[0] === 127;
};

export const isLoopbackHostname = (value: string): boolean => {
  const hostname = normalizeHostname(value);
  return hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1" || isIpv4Loopback(hostname);
};

const isNumericLoopbackHostname = (value: string): boolean => {
  const hostname = normalizeHostname(value);
  return hostname === "::1" || hostname === "0:0:0:0:0:0:0:1" || isIpv4Loopback(hostname);
};

const formatListenerAddress = (address: Addr): string => {
  if (address.transport === "tcp" || address.transport === "udp") {
    const hostname = address.hostname.includes(":") ? `[${address.hostname}]` : address.hostname;
    return `${address.transport}://${hostname}:${address.port}`;
  }
  return "path" in address ? `unix://${address.path}` : address.transport;
};

export const shouldDisableAdminAuthForListener = (options: ServeRuntimeOptions, address: Addr): boolean => {
  if (!options.disableAdminAuth) return false;
  if (address.transport !== "tcp" || !isNumericLoopbackHostname(address.hostname)) {
    throw new Error(`[ai.ubq.fi] ${DISABLE_ADMIN_AUTH_FLAG} requires a loopback TCP listener; got ${formatListenerAddress(address)}.`);
  }
  return true;
};

let adminAuthDisabled = false;
let adminAuthPeer: Addr | null = null;
/**
 * Request-scoped peers for a LAN-facing listener. Routing awaits before it
 * authenticates, so a single process-wide slot can be overwritten by a
 * concurrent request: a LAN request could then observe a loopback peer that
 * belongs to someone else's connection. A peer bound to the request object
 * itself cannot be moved to another request.
 */
const adminAuthRequestPeers = new WeakMap<Request, Addr>();

export const configureAdminAuthForListener = (options: ServeRuntimeOptions, address: Addr): boolean => {
  const disabled = shouldDisableAdminAuthForListener(options, address);
  adminAuthDisabled = disabled;
  adminAuthPeer = null;
  return disabled;
};

/**
 * Records the TCP peer of a request being handled by the server. The optional
 * `request` binds the peer to that exact request object (used by the LAN-facing
 * Mac listener); without it the peer is the process-wide binding the loopback
 * development server has always used.
 */
export const configureAdminAuthPeerForRequest = (peer: Addr | null, request?: Request): void => {
  if (request) {
    if (peer === null) adminAuthRequestPeers.delete(request);
    else adminAuthRequestPeers.set(request, peer);
    return;
  }
  adminAuthPeer = peer;
};

/**
 * The only non-loopback listener that may enable the loopback-peer-gated local
 * bypass: the Mac companion's LAN-facing wildcard TCP listener. This stays a
 * separate, narrowly named entry point so the generic `--disable-admin-auth`
 * path keeps rejecting a non-loopback listener for every other caller, and it
 * never weakens `isAdminAuthDisabledForRequest`, which still requires an actual
 * numeric loopback TCP peer plus a loopback request URL and same-origin checks.
 */
const MAC_LAN_LISTENER_HOSTNAME = "0.0.0.0";

export const configureMacLocalAdminAuthBypassForListener = (address: Addr): boolean => {
  if (address.transport !== "tcp" || address.hostname !== MAC_LAN_LISTENER_HOSTNAME) {
    throw new Error(`[ai.ubq.fi] the Mac local admin bypass requires the ${MAC_LAN_LISTENER_HOSTNAME} TCP listener; got ${formatListenerAddress(address)}.`);
  }
  adminAuthDisabled = true;
  adminAuthPeer = null;
  return true;
};

const isLoopbackPeer = (peer: Addr): boolean => peer.transport === "tcp" && isNumericLoopbackHostname(peer.hostname);

export const isAdminAuthDisabledForRequest = (request: Request): boolean => {
  // The production timeline never grants a development bypass, however a
  // launcher enabled one: its loopback peers are the public proxy (#262).
  if (!adminAuthDisabled || config.isProductionTimeline) return false;
  // The bypass must be granted only to an actual loopback peer, never to a
  // forwarded, tunneled, or port-forwarded request whose URL hostname is
  // client-controlled. Fail closed when the peer is unknown (for example a
  // request constructed outside a Deno serve listener).
  const peer = adminAuthRequestPeers.get(request) ?? adminAuthPeer;
  if (!peer || !isLoopbackPeer(peer)) return false;
  try {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return false;
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") return false;
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
};

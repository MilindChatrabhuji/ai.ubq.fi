// `/v1/live` dispatch: authenticate once, then route to call creation or the
// sideband bridge.

import { authenticateClient } from "../auth/index.ts";
import type { ServeUpgradeHandler } from "#http";
import { openaiError, withCors } from "../http.ts";
import { normalizePath, resolveIdempotencyPrincipal, withRequestId } from "../handler/http.ts";
import { handleLiveCallCreate } from "./calls.ts";
import { liveRouteForRequest } from "./routes.ts";
import { handleLiveSideband, prepareLiveSidebandUpgrade } from "./sideband.ts";

/**
 * Serves the Codex realtime voice relay; null when the request is not a
 * `/v1/live` route.
 *
 * JSON arms receive the standard `withCors`/`withRequestId` decorations here.
 * The separate transport upgrade entry point reads only headers and authenticates
 * before accepting a WebSocket. The
 * resolved principal is passed to both arms so the call is bound to the one
 * credential that created it and only that principal may join its sideband.
 */
export const handleLiveRoute = async (req: Request, requestId: string): Promise<Response | null> => {
  const route = liveRouteForRequest(req.method, normalizePath(new URL(req.url).pathname));
  if (route === null) return null;

  const authResult = await authenticateClient(req);
  if (!authResult.ok) return withRequestId(withCors(authResult.response, req), requestId);

  const principal = await resolveIdempotencyPrincipal(authResult);
  const response = route.kind === "call" ? await handleLiveCallCreate(req, principal) : await handleLiveSideband(req, route.callId, principal);
  return withRequestId(withCors(response, req), requestId);
};

/** Authenticated upgrade entry point, invoked only by the real HTTP transport. */
export const handleLiveUpgrade: ServeUpgradeHandler = async (req) => {
  const requestId = crypto.randomUUID();
  const decorate = (response: Response): Response => withRequestId(withCors(response, req), requestId);
  const route = liveRouteForRequest(req.method, normalizePath(new URL(req.url).pathname));
  if (route?.kind !== "sideband") return decorate(openaiError(404, "Unknown WebSocket endpoint.", "not_found"));
  const authResult = await authenticateClient(req);
  if (!authResult.ok) return decorate(authResult.response);
  const principal = await resolveIdempotencyPrincipal(authResult);
  const prepared = await prepareLiveSidebandUpgrade(req, route.callId, principal);
  return prepared instanceof Response ? decorate(prepared) : prepared;
};

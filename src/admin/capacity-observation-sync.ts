// Authenticated ingest for another gateway's capacity observations.
//
// The Mac service pushes its new local samples here; the VPS stores them in the
// analytics-only namespace and uses them only to fill chart buckets it did not
// observe itself (see capacity-analytics.ts). The operational history, leases,
// reset events, and routing keys are untouched.

import type { Kv } from "#kv";
import { json, openaiError } from "../http.ts";
import { getKv } from "../kv.ts";
import { isRemoteCapacityHostId, parseRemoteCapacityObservations, storeRemoteCapacityObservations } from "../provider/capacity-analytics.ts";

const MAX_OBSERVATION_BODY_BYTES = 4 * 1024 * 1024;

const readBoundedBody = async (request: Request): Promise<string | null> => {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_OBSERVATION_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OBSERVATION_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

/**
 * POST /admin/providers/capacity/observations
 *
 * Body: { "host": "mac", "history": ProviderCapacityHistoryPoint[] }
 *
 * The route is inside the authenticated admin table. A malformed envelope, more
 * than MAX_REMOTE_CAPACITY_OBSERVATIONS rows, or any malformed, unaligned, or
 * out-of-bucket observation rejects the whole batch instead of storing partial
 * evidence. A failed write answers 503 so the pusher keeps the rows pending.
 */
export const handleCapacityObservationIngest = async (request: Request, options: Readonly<{ kv?: Kv | null; now?: () => number }> = {}): Promise<Response> => {
  const kv = options.kv === undefined ? await getKv() : options.kv;
  if (!kv) return openaiError(503, "KV unavailable", "server_error");
  const body = await readBoundedBody(request);
  if (body === null) return openaiError(413, "Capacity observation payload too large", "invalid_request_error");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return openaiError(400, "Invalid capacity observation JSON", "invalid_request_error");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return openaiError(400, "Invalid capacity observation envelope", "invalid_request_error");
  }
  const envelope = parsed as { host?: unknown; history?: unknown };
  if (!isRemoteCapacityHostId(envelope.host)) return openaiError(400, "Invalid capacity observation host", "invalid_request_error");
  const points = parseRemoteCapacityObservations(envelope.history);
  if (!points) return openaiError(400, "Invalid capacity observations", "invalid_request_error");
  const nowMs = Math.trunc((options.now ?? Date.now)());
  let accepted: number;
  try {
    accepted = await storeRemoteCapacityObservations(kv, envelope.host, points, nowMs);
  } catch {
    return openaiError(503, "Capacity observation storage unavailable", "server_error");
  }
  return json(200, { accepted, host: envelope.host }, { "Cache-Control": "no-store" });
};

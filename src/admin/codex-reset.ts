import { json, openaiError } from "../http.ts";
import { consumeManualCodexReset, ManualResetError, type ManualResetDependencies } from "../codex/manual-reset.ts";
import { isRecord } from "../utils.ts";

/** Admin authentication is owned by the route table, as for the existing reset settings. */
export const handleAdminCodexResetConsume = async (request: Request, dependencies: ManualResetDependencies = {}): Promise<Response> => {
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.account_id_hash !== "string" || !/^[a-f0-9]{64}$/.test(body.account_id_hash))
    return openaiError(400, "Only account_id_hash is accepted.", "invalid_request_error");
  try {
    const result = await consumeManualCodexReset(body.account_id_hash, dependencies, request.signal);
    return json(200, result, { "Cache-Control": "no-store" });
  } catch (error) {
    if (error instanceof ManualResetError)
      return json(
        error.status,
        {
          error: { type: "invalid_request_error", code: error.code, message: error.message },
          ...(error.resetStatus ? { reset_status: error.resetStatus } : {}),
        },
        { "Cache-Control": "no-store" }
      );
    return openaiError(503, "Banked reset is unavailable; no account priority is confirmed.", "codex_reset_unavailable");
  }
};

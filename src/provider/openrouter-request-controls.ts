import { openaiError } from "../http.ts";
import { getString, isRecord } from "../utils.ts";
import { resolveOpenRouterUpstreamModel } from "./openrouter.ts";
import { isProviderEnabled, loadProviderSelectionCached } from "./selection.ts";

export const OPENROUTER_CLAUDE_REQUEST_EXTENSION_KEYS = new Set(["cache_control"]);

/** Provider extensions stay separate from the official OpenAI request allowlists. */
export const openRouterPromptCacheRequestExtensions = async (body: Record<string, unknown>): Promise<ReadonlySet<string> | undefined> => {
  if (!Object.prototype.hasOwnProperty.call(body, "cache_control")) return undefined;
  const model = getString(body.model)?.trim();
  if (!model || !/^~?anthropic\/claude-/.test(model)) return undefined;
  if (!isProviderEnabled("openrouter", await loadProviderSelectionCached())) return undefined;
  return (await resolveOpenRouterUpstreamModel(model)) === null ? undefined : OPENROUTER_CLAUDE_REQUEST_EXTENSION_KEYS;
};

export const validateOpenRouterPromptCacheRequestControl = (body: Record<string, unknown>): Response | null => {
  const control = body.cache_control;
  const invalid = (message: string, param: string): Response => openaiError(400, message, "invalid_request_error", { param });
  if (!isRecord(control) || Array.isArray(control)) return invalid("cache_control must be an object", "cache_control");
  const unknown = Object.keys(control).find((key) => key !== "type" && key !== "ttl");
  if (unknown) return invalid(`Unknown cache control field: ${unknown}`, `cache_control.${unknown}`);
  if (control.type !== "ephemeral") return invalid("cache_control.type must be ephemeral", "cache_control.type");
  if (control.ttl !== undefined && control.ttl !== "5m" && control.ttl !== "1h") {
    return invalid("cache_control.ttl must be 5m or 1h", "cache_control.ttl");
  }
  return null;
};

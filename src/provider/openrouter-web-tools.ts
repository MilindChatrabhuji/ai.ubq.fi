import { isRecord } from "../utils.ts";

const DEFAULT_WEB_TOOLS = [{ type: "openrouter:web_search" }, { type: "openrouter:web_fetch" }] as const;

const existingWebTool = (tool: unknown, type: string): boolean => {
  if (!isRecord(tool) || typeof tool.type !== "string") return false;
  const nativeType = type.slice("openrouter:".length);
  return tool.type === type || tool.type === nativeType || tool.type.startsWith(`${nativeType}_`);
};

/** Supply OpenRouter-operated web tools without overriding explicit client tool controls. */
export const withOpenRouterOpenAiWebTools = (body: Record<string, unknown>, model: string): Record<string, unknown> => {
  if (!/^~?openai\//.test(model) || model.split(":").includes("batch")) return body;
  if (body.tool_choice !== undefined && body.tool_choice !== "auto") return body;
  if (body.functions !== undefined || body.function_call !== undefined) return body;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length === 0)) return body;

  const tools: unknown[] = Array.isArray(body.tools) ? body.tools : [];
  const missing = DEFAULT_WEB_TOOLS.filter(({ type }) => !tools.some((tool) => existingWebTool(tool, type)));
  return missing.length > 0 ? { ...body, tools: [...tools, ...missing] } : body;
};

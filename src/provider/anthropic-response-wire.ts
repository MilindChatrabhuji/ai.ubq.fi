// Pure Responses envelopes and lifecycles: no provider routing imports.
type JsonRecord = Record<string, unknown>;
export type ClaudeToolName = Readonly<{ name: string; namespace: string | null }>;
export type ClaudeResponseEcho = Readonly<{ instructions: string | null; tools: unknown; tool_choice: unknown; parallel_tool_calls: unknown }>;
const record = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);

export const encodeClaudeResponsesEvent = (event: JsonRecord): string => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
export const claudeResponsesEnvelope = (id: string, model: string, created: number, status: string, echo: ClaudeResponseEcho): JsonRecord => ({
  id,
  object: "response",
  created_at: created,
  status,
  model,
  output: [],
  error: null,
  incomplete_details: null,
  instructions: echo.instructions,
  metadata: {},
  parallel_tool_calls: typeof echo.parallel_tool_calls === "boolean" ? echo.parallel_tool_calls : true,
  tool_choice: echo.tool_choice ?? "auto",
  tools: Array.isArray(echo.tools) ? echo.tools : [],
  temperature: null,
  top_p: null,
  max_output_tokens: null,
  previous_response_id: null,
  reasoning: null,
  store: false,
  truncation: "disabled",
  usage: null,
});

type ActiveItem = { kind: "reasoning" | "message"; id: string; index: number; text: string; refusal: string; textPart: number; refusalPart: number };
type WriterOptions = Readonly<{
  model: string;
  id: string;
  created: number;
  toolNames?: ReadonlyMap<string, ClaudeToolName>;
  customToolNames?: ReadonlySet<string>;
}>;

type PreparedTool = { index: number; id: string; custom: boolean; args: string; input: string; item: JsonRecord };
const customInput = (args: string): string => {
  try {
    const parsed: unknown = JSON.parse(args);
    return record(parsed) && typeof parsed.input === "string" ? parsed.input : args;
  } catch {
    return args;
  }
};
const prepareTool = (call: JsonRecord, index: number, status: string, options: WriterOptions): PreparedTool | null => {
  if (!record(call.function) || typeof call.id !== "string" || typeof call.function.name !== "string" || typeof call.function.arguments !== "string")
    return null;
  const name = call.function.name;
  const original = options.toolNames?.get(name) ?? { name, namespace: null };
  const custom = options.customToolNames?.has(name) === true;
  const id = `${custom ? "ctc" : "fc"}_${options.id}_${index}`;
  const args = call.function.arguments;
  const input = custom ? customInput(args) : args;
  const item: JsonRecord = { id, type: custom ? "custom_tool_call" : "function_call", status, call_id: call.id, name: original.name };
  if (custom) item.input = input;
  else {
    item.arguments = args;
    if (original.namespace) item.namespace = original.namespace;
  }
  return { index, id, custom, args, input, item };
};
const toolLifecycle = (tool: PreparedTool): JsonRecord[] => {
  const { index, id, custom, args, input, item } = tool;
  const empty = { ...item, status: "in_progress", ...(custom ? { input: "" } : { arguments: "" }) };
  const events: JsonRecord[] = [{ type: "response.output_item.added", output_index: index, item: empty }];
  if (custom) events.push({ type: "response.custom_tool_call_input.delta", item_id: id, output_index: index, call_id: item.call_id, delta: input });
  else
    events.push(
      { type: "response.function_call_arguments.delta", item_id: id, output_index: index, delta: args },
      { type: "response.function_call_arguments.done", item_id: id, output_index: index, arguments: args }
    );
  events.push({ type: "response.output_item.done", output_index: index, item });
  return events;
};

/** One active output item, with tools published after their arguments are complete. */
export const createClaudeResponsesWriter = (options: WriterOptions) => {
  const echo: ClaudeResponseEcho = { instructions: null, tools: undefined, tool_choice: undefined, parallel_tool_calls: undefined };
  const output: JsonRecord[] = [];
  let active: ActiveItem | null = null;
  let started = false;
  let pendingReasoning = "";
  let finalResponse: JsonRecord | null = null;
  const envelope = (status: string): JsonRecord => claudeResponsesEnvelope(options.id, options.model, options.created, status, echo);
  const open = (): JsonRecord[] => {
    if (started) return [];
    started = true;
    return [
      { type: "response.created", response: envelope("in_progress") },
      { type: "response.in_progress", response: envelope("in_progress") },
    ];
  };
  const itemFor = (item: ActiveItem): JsonRecord => {
    if (item.kind === "reasoning") return { id: item.id, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: item.text }] };
    return {
      id: item.id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        ...(item.textPart >= 0 ? [{ type: "output_text", text: item.text, annotations: [] }] : []),
        ...(item.refusalPart >= 0 ? [{ type: "refusal", refusal: item.refusal }] : []),
      ],
    };
  };
  const close = (): JsonRecord[] => {
    if (!active) return [];
    const item = active;
    active = null;
    const common = { item_id: item.id, output_index: item.index };
    const events: JsonRecord[] = [];
    if (item.kind === "reasoning") {
      events.push(
        { type: "response.reasoning_summary_text.done", ...common, summary_index: 0, text: item.text },
        { type: "response.reasoning_summary_part.done", ...common, summary_index: 0, part: { type: "summary_text", text: item.text } }
      );
    } else {
      if (item.textPart >= 0)
        events.push(
          { type: "response.output_text.done", ...common, content_index: item.textPart, text: item.text, logprobs: [] },
          { type: "response.content_part.done", ...common, content_index: item.textPart, part: { type: "output_text", text: item.text, annotations: [] } }
        );
      if (item.refusalPart >= 0)
        events.push(
          { type: "response.refusal.done", ...common, content_index: item.refusalPart, refusal: item.refusal },
          { type: "response.content_part.done", ...common, content_index: item.refusalPart, part: { type: "refusal", refusal: item.refusal } }
        );
    }
    const completed = itemFor(item);
    output[item.index] = completed;
    events.push({ type: "response.output_item.done", output_index: item.index, item: completed });
    return events;
  };
  const ensure = (kind: ActiveItem["kind"]): JsonRecord[] => {
    if (active?.kind === kind) return [];
    const events = close();
    const index = output.length;
    const id = `${kind === "reasoning" ? "rs" : "msg"}_${options.id}_${index}`;
    const item: JsonRecord =
      kind === "reasoning" ? { id, type: kind, status: "in_progress", summary: [] } : { id, type: kind, status: "in_progress", role: "assistant", content: [] };
    active = { kind, id, index, text: "", refusal: "", textPart: -1, refusalPart: -1 };
    output.push(item);
    events.push({ type: "response.output_item.added", output_index: index, item });
    if (kind === "reasoning")
      events.push({
        type: "response.reasoning_summary_part.added",
        item_id: id,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    return events;
  };
  const reasoningDelta = (text: string): JsonRecord[] => {
    if (!text) return [];
    if (active?.kind === "message") {
      pendingReasoning += text;
      return [];
    }
    const events = ensure("reasoning");
    if (!active) return events;
    active.text += text;
    events.push({ type: "response.reasoning_summary_text.delta", item_id: active.id, output_index: active.index, summary_index: 0, delta: text });
    return events;
  };
  const messageDelta = (text: string, refusal = false): JsonRecord[] => {
    if (!text) return [];
    const events = ensure("message");
    if (!active) return events;
    const common = { item_id: active.id, output_index: active.index };
    const partKey = refusal ? "refusalPart" : "textPart";
    if (active[partKey] < 0) {
      active[partKey] = (active.textPart >= 0 ? 1 : 0) + (active.refusalPart >= 0 ? 1 : 0);
      const part = refusal ? { type: "refusal", refusal: "" } : { type: "output_text", text: "", annotations: [] };
      events.push({ type: "response.content_part.added", ...common, content_index: active[partKey], part });
    }
    if (refusal) active.refusal += text;
    else active.text += text;
    events.push({
      type: refusal ? "response.refusal.delta" : "response.output_text.delta",
      ...common,
      content_index: active[partKey],
      delta: text,
      ...(refusal ? {} : { logprobs: [] }),
    });
    return events;
  };
  const push = (delta: JsonRecord): JsonRecord[] => [
    ...open(),
    ...reasoningDelta(typeof delta.reasoning_content === "string" ? delta.reasoning_content : ""),
    ...messageDelta(typeof delta.content === "string" ? delta.content : ""),
    ...messageDelta(typeof delta.refusal === "string" ? delta.refusal : "", true),
  ];
  const toolEvents = (calls: readonly JsonRecord[], status: string): JsonRecord[] => {
    const events: JsonRecord[] = [];
    for (const call of calls) {
      const tool = prepareTool(call, output.length, status, options);
      if (!tool) continue;
      output.push(tool.item);
      events.push(...toolLifecycle(tool));
    }
    return events;
  };
  const finish = (calls: readonly JsonRecord[], reason: unknown, usage: unknown): JsonRecord[] => {
    const events = [...open(), ...close()];
    if (pendingReasoning) {
      const pending = pendingReasoning;
      pendingReasoning = "";
      events.push(...reasoningDelta(pending), ...close());
    }
    let status = "failed";
    if (reason === "stop" || reason === "tool_calls") status = "completed";
    if (reason === "length" || reason === "content_filter") status = "incomplete";
    events.push(...toolEvents(calls, status === "completed" ? "completed" : "incomplete"));
    const response: JsonRecord = { ...envelope(status), output, usage };
    if (status === "incomplete") response.incomplete_details = { reason: reason === "content_filter" ? "content_filter" : "max_output_tokens" };
    if (status === "failed") response.error = { code: "claude_chat_finish_reason", message: `Claude Chat stopped with reason ${String(reason)}.` };
    finalResponse = response;
    events.push({ type: `response.${status}`, response });
    return events;
  };
  const observedUsage = (usage: unknown): JsonRecord => ({ type: "response.in_progress", response: { ...envelope("in_progress"), usage } });
  return { open, push, finish, observedUsage, response: (): JsonRecord | null => finalResponse };
};

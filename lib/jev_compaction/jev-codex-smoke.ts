/**
 * Real official-Codex acceptance for the gateway Jev compaction slice.
 *
 * The installed `codex` binary runs its real `app-server`, pointed at the REAL
 * gateway handler over loopback HTTP (real KV, seeded key, quota admission).
 * The gateway's ordinary route forwards to a scripted loopback Chat Completions
 * upstream, so every main-model response is mocked and no paid inference runs.
 * Jev is the only external hop: when the existing `OPENROUTER_API_KEY` is present
 * the gateway's own Jev client is used (live mode); otherwise a deterministic
 * fake asker is injected (fake mode). No flag or new env name selects the mode.
 *
 * The AppServer JSON-RPC driver, the thread runTurn/compact waiting logic, the
 * scripted tool-call chain and the fake-Jev decision table are ported from the
 * recovered 0x4007/fast-jev-compaction `codex/smoke.ts` (MIT, commit
 * c1eab5fdbd6bde7d67f2da070116496558836884), retargeted from the standalone
 * proxy to the real gateway handler and from a Responses upstream to the
 * gateway's Chat Completions upstream. No fresh app-server driver was invented.
 *
 * Run (fake Jev, credential-free; local/VPS Linux; the script sets the existing
 * fixture dummy `DEEPSEEK_API_KEY` in-process for its mocked ordinary provider):
 *   bun --no-env-file run lib/jev_compaction/jev-codex-smoke.ts
 * Run with a scrubbed environment and absent OPENROUTER_API_KEY; --no-env-file
 * prevents dotenv loading but does not remove inherited provider credentials.
 *
 * Run (real Jev, SAME official-client/gateway path; only when the existing key is
 * present, and the only paid calls are the authorized synthetic compactions):
 *   bun run lib/jev_compaction/jev-codex-smoke.ts
 *
 * It exercises: ordinary turns with no Jev, one manual compaction whose summary
 * the next request adopts, one isolated small auto-compaction threshold, and (in
 * fake mode) a Jev outage that must leave the original history intact.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHttp, type HttpServer } from "#http";
import { openKv } from "#kv";
import { PAID_FALLBACK_NO_LIMIT } from "../../src/api-keys.ts";
import { apiKeyPolicyFromHashRecord, resetApiKeyPolicyCacheForTest } from "../../src/api-key-policy.ts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL } from "../../src/deepseek/index.ts";
import { setInferenceAdmissionControllerForTest } from "../../src/handler/admission.ts";
import { createInferenceAdmissionController } from "../../src/inference-admission.ts";
import { setJevCompactionAskerForTest } from "../../src/jev_compaction/compaction.ts";
import { SUMMARY_MARKER } from "./codex_items.ts";
import type { JevAsker, JevQuestions, JevResponse, JevState } from "./types.ts";
import { setKvForTest } from "../../src/kv.ts";
import type { ApiKeyHashRecord, ApiKeyRecord } from "../../src/types.ts";
import { sha256Base64Url } from "../../src/utils.ts";

const CODEX_BIN = "codex";
const DEADLINE_MS = 240_000;
const STEP_TIMEOUT_MS = 30_000;
const STARTED_AT = Date.now();
const GATEWAY_TOKEN = `u_${"d".repeat(64)}`;
const COMPACTION_PROMPT_MARKER = "CONTEXT CHECKPOINT COMPACTION";
/** Existing test-fixture mechanism: a synthetic value for the mocked provider. */
const DUMMY_DEEPSEEK_KEY = "jev-codex-smoke-dummy-deepseek-key";
const JEV_API_ORIGIN = "https://api.typesafe.ai/";

/**
 * The fixture states the semantics real Jev must see: the Gamma release fact is
 * required and must stay verbatim, while the Alpha build probe and the Beta
 * metrics line are obsolete. The goal deliberately names them descriptively, so
 * no probe marker literal appears in prompt text; the markers live only in the
 * generated tool calls and outputs (the Beta tail additionally only in output,
 * via octal escapes), which keeps both the executed-history matcher and the
 * adopted-summary drop/keep assertions meaningful.
 */
const GAMMA_MARKER = "GAMMA_REQUIRED_FACT_KEEP_VERBATIM";
const ALPHA_MARKER = "ALPHA_OBSOLETE_PROBE";
const BETA_HEAD = "BETA_OBSOLETE_SCAN_HEAD";
const BETA_TAIL = "BETA_OBSOLETE_TAIL_MUST_BE_TRUNCATED";
const BETA_FILLER = "beta obsolete filler text ".repeat(120);
const GOAL_TEXT = "Goal: keep the Gamma release fact verbatim; the obsolete Alpha build probe and the obsolete Beta metrics line are no longer needed.";
const POST_TURN = "post-compaction probe";
const FILLER_ONE = "filler turn one";
const FILLER_TWO = "filler turn two";

/**
 * Octal escapes for a marker that must exist only in tool *output*. A
 * `drop_result` decision keeps the call with its input, so the literal tail in
 * the generating command would survive in the summary and defeat the dropped
 * tail assertion; the escapes make `printf` emit it without it appearing in the
 * call arguments.
 */
function octalEscapes(text: string): string {
  return [...text].map((char) => `\\${char.codePointAt(0)?.toString(8).padStart(3, "0") ?? "000"}`).join("");
}

const ALPHA_COMMAND = `printf '%s' '${ALPHA_MARKER}: superseded build probe; obsolete and safe to delete'`;
/** Beta output is head + filler + tail; only the tail is written from escapes. */
const BETA_COMMAND = `printf '${BETA_HEAD}: superseded metrics; ${BETA_FILLER}${octalEscapes(BETA_TAIL)}'`;
const GAMMA_COMMAND = `printf '%s' '${GAMMA_MARKER}: required release fact; keep verbatim'`;

function require_(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remaining(): number {
  return DEADLINE_MS - (Date.now() - STARTED_AT);
}

/** Diagnostics only, and only on synthetic fixture data or structural fields. */
function safeExcerpt(value: string, limit = 400): string {
  return value.replaceAll("\n", " ").slice(0, limit);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The Jev summary Codex adopted, cut out of a provider request body: from the
 * adapter's own marker to the new user turn that follows it.
 */
function adoptedSummary(body: string): string {
  const start = body.indexOf(SUMMARY_MARKER);
  if (start < 0) return "";
  const end = body.indexOf(POST_TURN, start);
  return end < 0 ? body.slice(start) : body.slice(start, end);
}

/** Jev availability, read as a presence boolean only; never logged or echoed. */
function openRouterKeyPresent(): boolean {
  try {
    const key = process.env["OPENROUTER_API_KEY"];
    return key !== undefined && key.length > 0;
  } catch {
    return false;
  }
}

type UpstreamRequest = {
  method: string;
  path: string;
  body: string;
};

type ChatTool = {
  name: string;
  parameters: Record<string, unknown>;
};

type ToolCallSpec = {
  name: string;
  arguments: string;
};

function chatToolFrom(value: unknown): ChatTool | null {
  const tool = record(value);
  const fn = record(tool.function);
  const name = typeof fn.name === "string" ? fn.name : "";
  if (!name) return null;
  const parameters = record(fn.parameters);
  return Object.keys(parameters).length > 0 ? { name, parameters } : null;
}

/** Picks any advertised Chat Completions tool that can run a command. */
function pickShellTool(tools: readonly unknown[]): ChatTool | null {
  const usable: ChatTool[] = [];
  for (const tool of tools) {
    const parsed = chatToolFrom(tool);
    if (!parsed) continue;
    const properties = record(parsed.parameters.properties);
    if ("cmd" in properties || "command" in properties) usable.push(parsed);
  }
  const preferred = ["exec_command", "shell", "local_shell", "unified_exec", "container.exec"];
  for (const name of preferred) {
    const match = usable.find((tool) => tool.name === name);
    if (match) return match;
  }
  return usable[0] ?? null;
}

function buildCallArguments(tool: ChatTool, command: string): Record<string, unknown> | null {
  const properties = record(tool.parameters.properties);
  const argSchema = (key: string): Record<string, unknown> => record(properties[key]);
  const args: Record<string, unknown> = {};
  if ("cmd" in properties) {
    args.cmd = command;
    if ("login" in properties) args.login = false;
    if ("yield_time_ms" in properties) args.yield_time_ms = 10_000;
  } else if ("command" in properties) {
    args.command = argSchema("command").type === "string" ? command : ["bash", "-lc", command];
  } else {
    return null;
  }
  if ("timeout_ms" in properties) args.timeout_ms = 10_000;
  return args;
}

/**
 * Structural counts of one chat request body for fixture diagnostics and
 * assertions: message roles, assistant tool calls and tool results only, never
 * text (the semantic goal contains marker names too).
 */
function structureOf(body: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = record(JSON.parse(body));
  } catch {
    parsed = {};
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const roles = new Set<string>();
  let assistantToolCalls = 0;
  let toolResults = 0;
  for (const raw of messages) {
    const message = record(raw);
    const role = typeof message.role === "string" ? message.role : "unknown";
    roles.add(role);
    if (role === "assistant" && Array.isArray(message.tool_calls)) assistantToolCalls += message.tool_calls.length;
    if (role === "tool") toolResults += 1;
  }
  return `messages=${messages.length} roles=${[...roles].sort().join("|")} assistant_tool_calls=${assistantToolCalls} tool_results=${toolResults}`;
}

const CHAT_ID = "chatcmpl-jev-codex-smoke";

const ALL_PROBES = [ALPHA_MARKER, BETA_HEAD, GAMMA_MARKER] as const;

/**
 * Which fixture calls the official client has actually executed, read from
 * message roles only: an assistant tool call's arguments or a `tool` message's
 * output. The user goal and assistant narration are prompt text and never count,
 * so the semantic goal can name obsolete markers without faking history.
 */
function executedProbes(messages: unknown): Set<string> {
  const found = new Set<string>();
  if (!Array.isArray(messages)) return found;
  for (const raw of messages) {
    const message = record(raw);
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const args = record(record(call).function).arguments;
        if (typeof args !== "string") continue;
        for (const probe of ALL_PROBES) if (args.includes(probe)) found.add(probe);
      }
    }
    if (role === "tool" && typeof message.content === "string") {
      for (const probe of ALL_PROBES) if (message.content.includes(probe)) found.add(probe);
    }
  }
  return found;
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: CHAT_ID,
    object: "chat.completion.chunk",
    created: 1_780_000_010,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

/** Scripted Chat Completions upstream: tool-call chain, then ordinary replies. */
class FakeChatUpstream {
  readonly requests: UpstreamRequest[] = [];
  toolNames: string[] = [];
  /**
   * Test-controlled reported prompt tokens. When set, every mocked completion
   * reports this value so the auto-compaction case can keep the client below its
   * isolated threshold until the fixture has unpinned candidates, then cross it
   * without fabricating a huge conversation.
   */
  reportedPromptTokens: number | null = null;
  /** When true, the next mocked completion uses reportedPromptTokens once, then
   * drops back to the low steady-state value. This lets the client observe a
   * single threshold crossing without making every request in the compaction
   * turn cross it again. */
  reportedPromptTokensOnce = false;
  private script: "chain" | "alpha-only" = "chain";
  /**
   * Latched once every scripted step has been observed in a request. Later
   * turns then get an ordinary reply only: an unlatched reactive script would
   * replay the dropped alpha call and pollute the transcript the adoption
   * assertions inspect.
   */
  private chainServed = false;
  private server: HttpServer | null = null;
  private shellTool: ChatTool | null = null;
  url = "";

  get mode(): "chain" | "alpha-only" {
    return this.script;
  }

  /** Switching scripts starts a fresh history, so the latch resets too. */
  set mode(next: "chain" | "alpha-only") {
    this.script = next;
    this.chainServed = false;
  }

  static async start(): Promise<FakeChatUpstream> {
    const fake = new FakeChatUpstream();
    fake.server = serveHttp({ hostname: "127.0.0.1", port: 0 }, (request) => fake.handle(request));
    const addr = await fake.server.ready;
    fake.url = `http://127.0.0.1:${addr.port}`;
    return fake;
  }

  async close(): Promise<void> {
    await this.server?.shutdown();
  }

  /** A marked compaction that reached the model would carry Codex's prompt. */
  compactionLeaks(): UpstreamRequest[] {
    return this.requests.filter((entry) => entry.body.includes(COMPACTION_PROMPT_MARKER));
  }

  bodiesMatching(needle: string): UpstreamRequest[] {
    return this.requests.filter((entry) => entry.body.includes(needle));
  }

  /**
   * Structural counts of the last mocked request for failure diagnostics:
   * message roles, assistant tool calls and tool results only, never text.
   */
  lastStructure(): string {
    const last = this.requests.at(-1);
    return last ? structureOf(last.body) : "no-requests";
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    this.requests.push({ method: request.method, path: url.pathname + url.search, body });
    if (url.pathname === "/healthz") return new Response("fake chat upstream ready\n");

    let parsed: Record<string, unknown> = {};
    try {
      parsed = record(JSON.parse(body));
    } catch {
      parsed = {};
    }
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    this.toolNames = tools.map((tool) => chatToolFrom(tool)?.name ?? "").filter(Boolean);
    this.shellTool = pickShellTool(tools);

    const next = this.nextCall(executedProbes(parsed.messages));
    const frames: string[] = [];
    if (next) {
      frames.push(chatChunk({ role: "assistant", content: `Normal turn narration before ${next.name}.` }, null));
      frames.push(
        chatChunk(
          {
            tool_calls: [
              {
                index: 0,
                id: `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
                type: "function",
                function: { name: next.name, arguments: next.arguments },
              },
            ],
          },
          null
        )
      );
      frames.push(chatChunk({}, "tool_calls", this.usage(body, 24)));
    } else {
      const reply = this.mode === "chain" ? "NORMAL_REPLY_MARKER_CHAIN_DONE" : "NORMAL_REPLY_MARKER_THREAD_TWO";
      frames.push(chatChunk({ role: "assistant", content: reply }, null));
      frames.push(chatChunk({}, "stop", this.usage(body, 12)));
    }
    frames.push("data: [DONE]\n\n");
    return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }

  /** Chat usage the gateway relays so the official client can track context. */
  private usage(body: string, completionTokens: number): Record<string, number> {
    const promptTokens = this.reportedPromptTokens ?? Math.max(1, Math.ceil(body.length / 4));
    if (this.reportedPromptTokensOnce) {
      this.reportedPromptTokens = 80;
      this.reportedPromptTokensOnce = false;
    }
    return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  }

  /**
   * Reactive script: emit the fixture tool calls until every step has been seen
   * as an executed tool call or tool result in the chat messages, then latch and
   * answer ordinarily forever. Detection reads message roles, never raw request
   * text: the semantic goal legitimately names the markers, and a substring
   * match would treat that prompt text as already-executed history.
   */
  private nextCall(executed: ReadonlySet<string>): ToolCallSpec | null {
    const shellTool = this.shellTool;
    if (!shellTool) return null;
    if (this.chainServed) return null;
    const steps: Array<{ probe: string; command: string }> =
      this.script === "chain"
        ? [
            { probe: ALPHA_MARKER, command: ALPHA_COMMAND },
            { probe: BETA_HEAD, command: BETA_COMMAND },
            { probe: GAMMA_MARKER, command: GAMMA_COMMAND },
          ]
        : [{ probe: ALPHA_MARKER, command: ALPHA_COMMAND }];
    for (const step of steps) {
      if (!executed.has(step.probe)) {
        const args = buildCallArguments(shellTool, step.command);
        if (args) return { name: shellTool.name, arguments: JSON.stringify(args) };
      }
    }
    this.chainServed = true;
    return null;
  }
}

/** Fake Jev: decisions driven by fixture markers in the state history. */
class FakeJev implements JevAsker {
  mode: "decide" | "fail" = "decide";
  calls = 0;
  questions = 0;

  ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    this.calls += 1;
    this.questions += Object.keys(questions).length;
    if (this.mode === "fail") return Promise.reject(new Error("synthetic Jev outage"));
    return Promise.resolve({ model: "fake-jev", answers: answersFor(state, questions) });
  }
}

function answersFor(state: JevState, questions: JevQuestions): Record<string, { noul: number }> {
  const actions = new Map<string, "drop_call" | "drop_result" | "keep">();
  const history = Array.isArray(record(state).history) ? (record(state).history as unknown[]) : [];
  for (const entry of history) {
    const calls = Array.isArray(record(entry).tool_calls) ? (record(entry).tool_calls as unknown[]) : [];
    for (const call of calls) {
      const text = typeof call === "string" ? call : JSON.stringify(call);
      const id = typeof call === "string" ? (call.split(" ")[0] ?? "") : String(record(call).id ?? "");
      if (!id) continue;
      if (text.includes(ALPHA_MARKER)) actions.set(id, "drop_call");
      else if (text.includes(BETA_HEAD)) actions.set(id, "drop_result");
      else if (text.includes(GAMMA_MARKER)) actions.set(id, "keep");
    }
  }
  const answers: Record<string, { noul: number }> = {};
  for (const name of Object.keys(questions)) {
    const action = actions.get(name.replace(/^(call|result)_/, "")) ?? "keep";
    let noul = 0.95;
    if (action === "drop_call") noul = 0.1;
    else if (action === "drop_result") noul = name.startsWith("result_") ? 0.05 : 0.9;
    answers[name] = { noul };
  }
  return answers;
}

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

type PendingWaiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/** Minimal JSON-RPC client for `codex app-server` over stdio. */
class AppServer {
  readonly notifications: RpcMessage[] = [];
  readonly serverRequests: string[] = [];
  stderr = "";
  exited = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingWaiter>();
  private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly pumps: readonly Promise<void>[];

  private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    this.child = child;
    this.pumps = [this.pumpStdout(), this.pumpStderr()];
  }

  static async start(cwd: string, env: Record<string, string>): Promise<AppServer> {
    const child = Bun.spawn([CODEX_BIN, "app-server"], {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const server = new AppServer(child);
    try {
      await server.request("initialize", {
        clientInfo: { name: "ai-ubq-fi-jev-smoke", title: "jev-smoke", version: "0.1.0" },
      });
      server.notify("initialized", {});
    } catch (error) {
      await server.stop();
      throw error;
    }
    return server;
  }

  private async pumpStdout(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) this.handleLine(line);
          index = buffer.indexOf("\n");
        }
      }
    } catch {
      // The child exited; `exited` and pending rejections carry the diagnosis.
    } finally {
      this.exited = true;
      for (const { reject } of this.pending.values()) reject(new Error("codex app-server exited"));
      this.pending.clear();
    }
  }

  private async pumpStderr(): Promise<void> {
    const reader = this.child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderr = (this.stderr + decoder.decode(value, { stream: true })).slice(-4000);
      }
    } catch {
      // Ignore: stdout diagnostics are enough.
    }
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && message.method) {
      // Server-initiated request; this smoke never needs approvals.
      this.serverRequests.push(message.method);
      this.write({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(Number(message.id));
      if (!waiter) return;
      this.pending.delete(Number(message.id));
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error).slice(0, 300)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) this.notifications.push(message);
  }

  private write(payload: unknown): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    void this.child.stdin.flush();
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${method} response`)), STEP_TIMEOUT_MS));
    return await Promise.race([promise, timeout]);
  }

  cursor(): number {
    return this.notifications.length;
  }

  async waitFor(predicate: (message: RpcMessage) => boolean, label: string, timeoutMs = STEP_TIMEOUT_MS, from = 0): Promise<RpcMessage> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const found = this.notifications.slice(from).find(predicate);
      if (found) return found;
      if (this.exited) throw new Error(`codex app-server exited while waiting for ${label}`);
      await delay(50);
    }
    throw new Error(`timed out (${timeoutMs}ms) waiting for ${label}`);
  }

  sawContextCompaction(from: number): boolean {
    return this.notifications.slice(from).some((message) => message.method === "item/completed" && record(message.params?.item).type === "contextCompaction");
  }

  async stop(): Promise<void> {
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    const exited = await Promise.race([this.child.exited.then(() => true), delay(2000).then(() => false)]);
    if (!exited) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await this.child.exited;
    await Promise.allSettled(this.pumps);
    this.exited = true;
  }
}

type CompactionOutcome = {
  ok: boolean;
  detail: string;
};

type ThreadHandle = {
  id: string;
  runTurn(text: string): Promise<RpcMessage[]>;
  compact(): Promise<CompactionOutcome>;
};

function threadIdOf(result: unknown): string {
  const value = record(result);
  const thread = record(value.thread);
  const id = thread.id ?? value.threadId ?? value.id;
  require_(typeof id === "string" && id.length > 0, `thread/start returned no thread id: ${JSON.stringify(result).slice(0, 200)}`);
  return id;
}

function statusOf(message: RpcMessage): string {
  const params = message.params ?? {};
  const turn = record(params.turn);
  return String(turn.status ?? params.status ?? "unknown");
}

function turnIdOf(message: RpcMessage): string | null {
  const params = message.params ?? {};
  const turn = record(params.turn);
  const id = params.turnId ?? turn.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function openThread(rpc: AppServer, cwd: string): Promise<ThreadHandle> {
  const result = await rpc.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only" });
  const id = threadIdOf(result);
  return {
    id,
    async runTurn(text: string): Promise<RpcMessage[]> {
      const from = rpc.cursor();
      await rpc.request("turn/start", { threadId: id, input: [{ type: "text", text }] });
      const completed = await rpc.waitFor(
        (message) => message.method === "turn/completed" && message.params?.threadId === id,
        `turn/completed for ${text.slice(0, 40)}`,
        STEP_TIMEOUT_MS,
        from
      );
      const status = statusOf(completed);
      require_(status === "completed", `turn "${text.slice(0, 40)}" ended with status ${status}`);
      return rpc.notifications.slice(from);
    },
    async compact(): Promise<CompactionOutcome> {
      const from = rpc.cursor();
      try {
        await rpc.request("thread/compact/start", { threadId: id });
      } catch (error) {
        return { ok: false, detail: `compact/start rejected: ${safeExcerpt(String(error), 200)}` };
      }
      // The compact task owns a real turn: the contextCompaction item completes
      // before that turn settles, and a turn/start sent in between is rejected
      // with ActiveTurnNotSteerable { turn_kind: Compact }. So bind events to the
      // compact turn id and report only once that same turn reaches
      // turn/completed; the failure path awaits the same settlement too.
      const end = Date.now() + STEP_TIMEOUT_MS;
      let compactTurnId: string | null = null;
      let compacted = false;
      let failure: string | null = null;
      while (Date.now() < end) {
        for (const message of rpc.notifications.slice(from)) {
          const forThread = message.params?.threadId === id;
          const eventTurnId = turnIdOf(message);
          if (forThread && eventTurnId && compactTurnId === null) compactTurnId = eventTurnId;
          if (forThread && message.method === "item/completed" && record(message.params?.item).type === "contextCompaction") {
            compacted = true;
          }
          if (message.method === "error" && failure === null) {
            failure = `${message.method}: ${safeExcerpt(JSON.stringify(message.params ?? {}), 200)}`;
          }
          if (!forThread || message.method !== "turn/completed") continue;
          if (compactTurnId !== null && eventTurnId !== compactTurnId) continue;
          const status = statusOf(message);
          if (status === "completed" && compacted) {
            return { ok: true, detail: `contextCompaction + turn/completed (${status})` };
          }
          const detail =
            failure ??
            (compacted ? `turn/completed (${status}) after the contextCompaction item` : `turn/completed (${status}) without a contextCompaction item`);
          return { ok: false, detail };
        }
        await delay(50);
      }
      const seen = [...new Set(rpc.notifications.slice(from).map((message) => message.method))].join(", ");
      return { ok: false, detail: failure ?? `timed out waiting for the compaction outcome; methods=${seen || "none"}` };
    },
  };
}

function configToml(port: number, workDir: string, autoCompact: boolean): string {
  // The auto host keeps its threshold clear of the client's own initial context
  // (instructions and catalog text), so the controlled reported usage, not the
  // bootstrap context, is what crosses the limit after actionable history exists.
  const contextWindow = autoCompact ? 20_000 : 120_000;
  const compactLimit = autoCompact ? 12_000 : 100_000;
  return `# Generated by lib/jev_compaction/jev-codex-smoke.ts: isolated real-client acceptance config.
model = "deepseek-flash"
model_provider = "jevtest"
approval_policy = "never"
sandbox_mode = "read-only"
model_context_window = ${contextWindow}
model_auto_compact_token_limit = ${compactLimit}

[model_providers.jevtest]
name = "jevtest"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
requires_openai_auth = false
stream_max_retries = 0
request_max_retries = 0

[projects."${workDir}"]
trust_level = "trusted"
`;
}

type GatewayHandle = {
  url: string;
  port: number;
  stop: () => Promise<void>;
};

/** The real gateway handler over loopback HTTP with a real in-memory KV. */
async function startGateway(): Promise<GatewayHandle> {
  const kv = await openKv(":memory:");
  const keyId = "jev-codex-smoke-key";
  const tokenHash = await sha256Base64Url(GATEWAY_TOKEN);
  const now = Date.now();
  const windowMs = 60 * 60_000;
  const commonPolicy = {
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 500,
    usage_requests: 0,
    usage_reset_at_ms: now + windowMs,
    window_ms: windowMs,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: PAID_FALLBACK_NO_LIMIT,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  } satisfies Omit<ApiKeyHashRecord, "id">;
  const keyRecord: ApiKeyRecord = {
    id: keyId,
    name: "jev codex smoke key",
    prefix: GATEWAY_TOKEN.slice(0, 10),
    hash: tokenHash,
    created_at_ms: now,
    ...commonPolicy,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: now,
  };
  await kv.set(["ubq_ai", "api_keys", "id", keyId], keyRecord);
  await kv.set(["ubq_ai", "api_keys", "hash", tokenHash], { id: keyId, ...commonPolicy } satisfies ApiKeyHashRecord);
  require_(apiKeyPolicyFromHashRecord(tokenHash, { id: keyId, ...commonPolicy }, now), "the seeded key must resolve to a live policy");

  setKvForTest(kv);
  resetApiKeyPolicyCacheForTest();
  setInferenceAdmissionControllerForTest(createInferenceAdmissionController({ maxActive: 8, maxWaiting: 8, maxQueueWaitMs: 500 }));
  const { default: handler } = await import("../../src/handler/index.ts");
  const { createServeHandler } = await import("../../src/handler/serve-handler.ts");
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, createServeHandler(handler));
  const { port } = await server.ready;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stop: async () => {
      setKvForTest(null);
      setInferenceAdmissionControllerForTest(null);
      await server.shutdown();
      kv.close();
    },
  };
}

type Report = {
  status: "PASS" | "FAIL";
  failure_class: string;
  mode: "live" | "fake";
  manual_compaction_ok: boolean;
  adopted_summary_chars: number;
  summary_has_stats_trailer: boolean;
  summary_has_goal: boolean;
  summary_kept_gamma: boolean;
  summary_alpha_provenance_kept: boolean;
  summary_dropped_beta_tail: boolean;
  codex_installed_summary: boolean;
  auto_compaction_observed: boolean;
  auto_summary_adopted: boolean;
  /** Null in live mode: the Jev-outage injection runs only in the fake mode. */
  failure_path_history_preserved: boolean | null;
  ordinary_turns: number;
  upstream_requests: number;
  compaction_leaks: number;
  fake_jev_calls: number;
  fake_jev_questions: number;
  jev_api_requests: number;
  jev_api_requests_manual: number;
  jev_api_requests_auto: number;
  total_ms: number;
};

const report: Report = {
  status: "FAIL",
  failure_class: "not-started",
  mode: openRouterKeyPresent() ? "live" : "fake",
  manual_compaction_ok: false,
  adopted_summary_chars: 0,
  summary_has_stats_trailer: false,
  summary_has_goal: false,
  summary_kept_gamma: false,
  summary_alpha_provenance_kept: false,
  summary_dropped_beta_tail: false,
  codex_installed_summary: false,
  auto_compaction_observed: false,
  auto_summary_adopted: false,
  failure_path_history_preserved: null,
  ordinary_turns: 0,
  upstream_requests: 0,
  compaction_leaks: 0,
  fake_jev_calls: 0,
  fake_jev_questions: 0,
  jev_api_requests: 0,
  jev_api_requests_manual: 0,
  jev_api_requests_auto: 0,
  total_ms: 0,
};

async function main(): Promise<void> {
  // Fixture invariant: the dropped beta tail must not be spelled out in the
  // command that produces it, or the retained call input would keep it alive.
  require_(!BETA_COMMAND.includes(BETA_TAIL), "the beta command must not embed the dropped tail literal");
  require_(BETA_COMMAND.includes(BETA_HEAD), "the beta command must still name the call for the Jev decision");

  const tmp = await mkdtemp(join(tmpdir(), "jev-codex-smoke-"));
  const manualHome = `${tmp}/codex-home-manual`;
  const autoHome = `${tmp}/codex-home-auto`;
  const workDir = `${tmp}/work`;
  await mkdir(manualHome, { recursive: true });
  await mkdir(autoHome, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const fakeJev = new FakeJev();
  const upstream = await FakeChatUpstream.start();
  // Existing test-fixture mechanism: the mocked ordinary provider needs a
  // DeepSeek key present, so set the synthetic value and restore it afterwards.
  // The value is never logged, and no inherited real key is used or forwarded.
  const inheritedDeepSeekKey = process.env["DEEPSEEK_API_KEY"];
  process.env["DEEPSEEK_API_KEY"] = DUMMY_DEEPSEEK_KEY;
  // Live-mode instrumentation: count the real Jev API hop itself, so live runs
  // never report the fake asker's counter as if it were real call evidence.
  let jevApiRequests = 0;
  const originalFetch = globalThis.fetch;
  const fixtureFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;
    if (url.startsWith(JEV_API_ORIGIN)) jevApiRequests += 1;
    if (url === DEEPSEEK_CHAT_COMPLETIONS_URL) return originalFetch(`${upstream.url}/chat/completions`, init);
    return originalFetch(input, init);
  };
  globalThis.fetch = Object.assign(fixtureFetch, { preconnect: originalFetch.preconnect });
  const gateway = await startGateway();
  if (report.mode === "fake") setJevCompactionAskerForTest(fakeJev);

  const childEnv = {
    CODEX_HOME: manualHome,
    HOME: manualHome,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    TMPDIR: tmp,
    TERM: "dumb",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    RUST_LOG: "error",
    NO_PROXY: "127.0.0.1,localhost",
    OPENAI_API_KEY: GATEWAY_TOKEN,
  };

  let rpc: AppServer | null = null;
  let autoRpc: AppServer | null = null;
  try {
    // 1. Ordinary turns: real tool-call history through the official client,
    //    with no Jev invocation and no compaction marker forwarded upstream.
    await writeFile(`${manualHome}/config.toml`, configToml(gateway.port, workDir, false));
    rpc = await AppServer.start(workDir, childEnv);
    require_(rpc.serverRequests.length === 0, `unexpected server requests during startup: ${rpc.serverRequests.join(", ")}`);
    console.log("PASS app-server: initialize handshake accepted");

    const thread = await openThread(rpc, workDir);
    const chain = await thread.runTurn(GOAL_TEXT);
    report.ordinary_turns += 1;
    const streamedText = chain
      .filter((message) => message.method === "item/completed")
      .map((message) => JSON.stringify(message.params ?? {}))
      .join(" ");
    require_(streamedText.includes("NORMAL_REPLY_MARKER_CHAIN_DONE"), "normal assistant content did not stream through the gateway unchanged");
    const chainStructure = upstream.lastStructure();
    require_(
      chainStructure.includes("assistant_tool_calls=3") && chainStructure.includes("tool_results=3"),
      `the fixture chain did not execute three tool calls and results: ${chainStructure} (tools=${upstream.toolNames.join(",")})`
    );
    require_(fakeJev.calls === 0 || report.mode === "live", "an ordinary turn invoked Jev");
    require_(jevApiRequests === 0, "an ordinary turn made a real Jev API request");
    console.log(`PASS ordinary turns: tool-call chain executed (tools advertised: ${upstream.toolNames.slice(0, 4).join(", ") || "none"})`);

    await thread.runTurn(FILLER_ONE);
    await thread.runTurn(FILLER_TWO);
    report.ordinary_turns += 2;
    require_(upstream.compactionLeaks().length === 0, "a compaction request leaked to the model upstream before compaction ran");
    // The manual compaction must see all three fixture calls outside the pinned
    // recent window; this guards the observed defect where only one call was
    // generated and it stayed pinned.
    const preCompactionStructure = upstream.lastStructure();
    require_(
      preCompactionStructure.includes("assistant_tool_calls=3"),
      `the fixture chain did not execute all three calls before compaction: ${preCompactionStructure}`
    );
    require_(
      preCompactionStructure.includes("tool_results=3"),
      `the fixture chain did not return all three tool results before compaction: ${preCompactionStructure}`
    );

    // 2. Manual compaction: the Jev summary replaces the history for the client.
    const jevBefore = fakeJev.calls;
    const jevApiBeforeManual = jevApiRequests;
    const outcome = await thread.compact();
    report.manual_compaction_ok = outcome.ok;
    require_(outcome.ok, `manual compaction did not succeed: ${outcome.detail} [upstream ${upstream.lastStructure()}]`);
    if (report.mode === "fake") {
      const jevCalls = fakeJev.calls - jevBefore;
      require_(jevCalls === 1, `expected exactly one Jev request for the compaction, saw ${jevCalls}`);
      require_(jevApiRequests === jevApiBeforeManual, "the fake-asker compaction made a real Jev API request");
    } else {
      require_(jevApiRequests > jevApiBeforeManual, "the live manual compaction made no Jev API request");
    }
    report.jev_api_requests_manual = jevApiRequests - jevApiBeforeManual;
    const jevApiAfterManual = jevApiRequests;
    require_(upstream.compactionLeaks().length === 0, "the manual compaction request was forwarded to the model upstream");
    console.log(
      `PASS manual compaction: terminal reached (${safeExcerpt(outcome.detail, 60)}), Jev API requests=${report.jev_api_requests_manual}, fake calls=${fakeJev.calls}`
    );

    // 3. The next official-client request carries the adopted memory.
    const after = await thread.runTurn(POST_TURN);
    report.ordinary_turns += 1;
    const postRequests = upstream.requests.filter((entry) => entry.body.includes(POST_TURN));
    require_(postRequests.length > 0, "the post-compaction turn never reached the model upstream");
    const postRequest = postRequests[0];
    require_(postRequest.body.includes(SUMMARY_MARKER), "the next request does not contain the Jev summary marker");
    report.codex_installed_summary = postRequest.body.includes("Another language model started to solve this problem");
    require_(report.codex_installed_summary, "Codex did not install the summary with its own SUMMARY_PREFIX");
    const summary = adoptedSummary(postRequest.body);
    report.adopted_summary_chars = summary.length;
    require_(summary.length > 500, `the adopted summary window is implausibly small (${summary.length} chars)`);
    report.summary_has_stats_trailer = summary.includes("[fast-jev-compaction stats]");
    require_(report.summary_has_stats_trailer, "the adopted summary is missing its structural trailer");
    report.summary_has_goal = summary.includes(GOAL_TEXT);
    require_(report.summary_has_goal, "the real user goal did not survive compaction");
    report.summary_kept_gamma = summary.includes(GAMMA_MARKER);
    require_(report.summary_kept_gamma, "the retained Gamma marker was lost from the compacted memory");
    report.summary_alpha_provenance_kept = summary.includes(ALPHA_MARKER);
    require_(report.summary_alpha_provenance_kept, "the dropped Alpha call/result kept no bounded provenance in the adopted summary");
    report.summary_dropped_beta_tail = !summary.includes(BETA_TAIL);
    require_(report.summary_dropped_beta_tail, "a dropped result tail survived compaction");
    if (report.mode === "fake") {
      require_(summary.includes("results_dropped=1 ") && summary.includes("calls_dropped=1 "), "the adopted summary does not report the fixture decisions");
      require_(summary.includes("drop_result"), "the kept call was not rendered with its drop_result notice");
      require_(summary.includes("fast-jev-compaction truncated"), "the truncated result notice is missing from the compacted memory");
    }
    require_(after.length > 0, "the post-compaction turn produced no notifications");
    require_(jevApiRequests === jevApiAfterManual, "an ordinary turn after compaction made a real Jev API request");
    console.log(`PASS adoption: next request carries the Jev summary (${summary.length} chars), keeps Gamma, drops Alpha and the Beta tail`);

    // 4. Failure path (fake mode): a Jev outage leaves the original history.
    if (report.mode === "fake") {
      fakeJev.mode = "fail";
      upstream.mode = "alpha-only";
      const failing = await openThread(rpc, workDir);
      await failing.runTurn("failure-path fixture history");
      await failing.runTurn("failure-path filler one");
      await failing.runTurn("failure-path filler two");
      await failing.runTurn("failure-path filler three");
      report.ordinary_turns += 4;
      const jevApiBeforeFailure = jevApiRequests;
      const failed = await failing.compact();
      require_(!failed.ok, "compaction reported success although Jev was failing");
      require_(jevApiRequests === jevApiBeforeFailure, "the fake-asker failure path made a real Jev API request");
      require_(upstream.compactionLeaks().length === 0, "the failing compaction was forwarded to the model upstream");
      const survivor = await failing.runTurn("post-failure probe");
      const failureRequest = upstream.bodiesMatching("post-failure probe").pop();
      require_(failureRequest, "the post-failure turn never reached the model upstream");
      const failureStructure = structureOf(failureRequest.body);
      report.failure_path_history_preserved = failureStructure.includes("tool_results=1") && !failureRequest.body.includes(SUMMARY_MARKER);
      require_(
        report.failure_path_history_preserved,
        `original tool output was lost, or a summary was installed, after a failed compaction: ${failureStructure}`
      );
      require_(survivor.length > 0, "the post-failure turn produced no notifications");
      fakeJev.mode = "decide";
      upstream.mode = "chain";
      console.log(`PASS failure: compaction failed (${safeExcerpt(failed.detail, 80)}), original history still present`);
    }

    // 5. Isolated small auto-compaction threshold: a separate config and
    //    CODEX_HOME, same real gateway and same official client. The threshold
    //    sits above the client's bootstrap context; the controlled reported
    //    usage stays low while the first auto turn builds the chain, then jumps
    //    above the limit so the compaction sees actionable history.
    upstream.mode = "chain";
    upstream.reportedPromptTokens = 80;
    const autoEnv = { ...childEnv, CODEX_HOME: autoHome, HOME: autoHome };
    await writeFile(`${autoHome}/config.toml`, configToml(gateway.port, workDir, true));
    autoRpc = await AppServer.start(workDir, autoEnv);
    const autoThread = await openThread(autoRpc, workDir);
    const autoJevBefore = fakeJev.calls;
    const autoJevQuestionsBefore = fakeJev.questions;
    const jevApiBeforeAuto = jevApiRequests;
    let autoObserved = false;
    for (let round = 1; round <= 6 && !autoObserved; round += 1) {
      const from = autoRpc.cursor();
      await autoThread.runTurn(`auto threshold turn ${round}: ${FILLER_ONE}`);
      report.ordinary_turns += 1;
      autoObserved = autoRpc.sawContextCompaction(from) || (report.mode === "fake" && fakeJev.calls > autoJevBefore);
      // Candidates now exist after the first turn; cross the isolated threshold.
      if (!autoObserved && round === 1) {
        upstream.reportedPromptTokens = 13_000;
        upstream.reportedPromptTokensOnce = true;
      }
    }
    report.auto_compaction_observed = autoObserved;
    require_(autoObserved, "the official client never auto-compacted at the isolated small threshold");
    if (report.mode === "fake") {
      require_(fakeJev.questions > autoJevQuestionsBefore, "the auto compaction reached Jev without actionable history");
      require_(jevApiRequests === jevApiBeforeAuto, "the fake-asker auto compaction made a real Jev API request");
    } else {
      require_(jevApiRequests > jevApiBeforeAuto, "the live auto compaction made no Jev API request");
    }
    report.jev_api_requests_auto = jevApiRequests - jevApiBeforeAuto;
    // Drop back below the threshold so the verification turn itself does not
    // immediately compact again (which would add unneeded live Jev calls).
    upstream.reportedPromptTokens = 80;
    const jevApiAfterAuto = jevApiRequests;
    const autoAfter = await autoThread.runTurn("post-auto-compaction probe");
    report.ordinary_turns += 1;
    const autoRequests = upstream.bodiesMatching("post-auto-compaction probe");
    require_(autoRequests.length > 0, "the post-auto-compaction turn never reached the model upstream");
    report.auto_summary_adopted = autoRequests.some((entry) => entry.body.includes(SUMMARY_MARKER));
    require_(report.auto_summary_adopted, "the auto-compaction summary was not adopted by the next request");
    require_(autoAfter.length > 0, "the post-auto-compaction turn produced no notifications");
    require_(jevApiRequests === jevApiAfterAuto, "an ordinary turn after auto compaction made a real Jev API request");
    console.log(`PASS auto compaction: isolated threshold reached, summary adopted, Jev API requests=${report.jev_api_requests_auto}`);

    report.compaction_leaks = upstream.compactionLeaks().length;
    require_(report.compaction_leaks === 0, "a compaction request leaked to the model upstream");
    report.upstream_requests = upstream.requests.length;
    report.fake_jev_calls = fakeJev.calls;
    report.fake_jev_questions = fakeJev.questions;
    report.jev_api_requests = jevApiRequests;
    report.status = "PASS";
    report.failure_class = "none";
  } finally {
    report.total_ms = Math.round(Date.now() - STARTED_AT);
    await autoRpc?.stop();
    await rpc?.stop();
    setJevCompactionAskerForTest(null);
    globalThis.fetch = originalFetch;
    if (inheritedDeepSeekKey === undefined) delete process.env["DEEPSEEK_API_KEY"];
    else process.env["DEEPSEEK_API_KEY"] = inheritedDeepSeekKey;
    await gateway.stop();
    await upstream.close();
    try {
      await rm(tmp, { recursive: true });
    } catch {
      // Best effort; the temp directory is outside the repository.
    }
  }
}

require_(remaining() > 20_000, "the smoke test ran out of its budget before starting");
try {
  await main();
} catch (error) {
  report.status = "FAIL";
  report.failure_class = error instanceof Error ? `${error.name}: ${error.message.slice(0, 240)}` : "unknown";
}
console.log(JSON.stringify(report));
process.exit(report.status === "PASS" ? 0 : 1);

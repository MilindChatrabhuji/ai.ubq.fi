import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
/**
 * Shared deterministic fixtures for the m03 baseline tests.
 *
 * The fake transports here expose the exact wire shapes the baselines are
 * expected to consume:
 *
 * - `gatewayCompletionBody` builds a Cerebras Chat Completion payload as the
 *   gateway's `normalizeCerebrasChatCompletion` accepts it, so adapter A is
 *   exercised through the real gateway normalizer;
 * - `controlCompletionBody` builds the OpenAI-compatible payload adapter D
 *   consumes without gateway normalization.
 */

import type { TaskManifest } from "../../schemas.ts";
import { loadTasks } from "../../manifest.ts";
import type { RunOptions } from "../../runner.ts";
import type { ChatTransport, ChatTransportResponse } from "../transport.ts";

export const TASKS_DIR = `${process.cwd()}/benchmarks/tasks`;
export const FIXTURES_DIR = `${process.cwd()}/benchmarks/fixtures`;

export function freshRunOptions(): RunOptions & { runsRoot: string } {
  mkdirSync(`${process.cwd()}/benchmark-runs`, { recursive: true });
  const runsRoot = mkdtempSync(join(`${process.cwd()}/benchmark-runs`, "fixture-"));
  return {
    configs: [],
    taskSelectors: [],
    runsRoot,
    tasksDir: TASKS_DIR,
    fixturesDir: FIXTURES_DIR,
  };
}

export function nav001(): TaskManifest {
  const task = loadTasks(TASKS_DIR).find((t) => t.id === "nav-001");
  if (task === undefined) throw new Error(`missing nav-001 task fixture in ${TASKS_DIR}`);
  return task;
}

export function jsonResponse(status: number, body: unknown): ChatTransportResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  };
}

export type ScriptToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type GatewayScriptStep = {
  toolCalls?: ScriptToolCall[];
  content?: string;
  usage?: { prompt: number; completion: number };
};

export function gatewayCompletionBody(step: GatewayScriptStep): Record<string, unknown> {
  const calls = step.toolCalls ?? [];
  const message: Record<string, unknown> = {
    role: "assistant",
    content: step.content ?? (calls.length > 0 ? null : ""),
  };
  if (calls.length > 0) {
    message.tool_calls = calls.map((call, index) => ({
      id: `call-${index}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
  }
  const usage = step.usage ?? { prompt: 100, completion: 50 };
  return {
    id: "chatcmpl-baseline-a",
    object: "chat.completion",
    created: 0,
    model: "gpt-oss-120b",
    choices: [
      {
        index: 0,
        message,
        finish_reason: calls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
    },
  };
}

export function controlCompletionBody(step: GatewayScriptStep, model: string): Record<string, unknown> {
  const calls = step.toolCalls ?? [];
  const message: Record<string, unknown> = {
    role: "assistant",
    content: step.content ?? (calls.length > 0 ? null : ""),
  };
  if (calls.length > 0) {
    message.tool_calls = calls.map((call, index) => ({
      id: `call-${index}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
  }
  const usage = step.usage ?? { prompt: 100, completion: 50 };
  return {
    id: "chatcmpl-baseline-d",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: calls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
    },
  };
}

export type ScriptedTransport = {
  transport: ChatTransport;
  /** Every request body in call order (deep copies are not made). */
  requests: Record<string, unknown>[];
};

/**
 * Deterministic scripted transport: replays the scripted steps in order and
 * repeats the final step for any further calls, so a run always terminates.
 */
export function scriptedTransport(steps: GatewayScriptStep[], build: (step: GatewayScriptStep, index: number) => Record<string, unknown>): ScriptedTransport {
  const requests: Record<string, unknown>[] = [];
  let index = 0;
  const transport: ChatTransport = (body) => {
    requests.push(body);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return Promise.resolve(jsonResponse(200, build(step, index - 1)));
  };
  return { transport, requests };
}

export function gatewayEventToolCalls(events: readonly unknown[], tool: string): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = [];
  for (const event of events) {
    const e = event as { type?: string; tool?: string; valid?: boolean; invalid_reason?: string };
    if (e.type === "tool_call" && e.tool === tool) calls.push(event as Record<string, unknown>);
  }
  return calls;
}

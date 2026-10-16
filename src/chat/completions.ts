// Primary Chat Completions translation and delivery, extracted from src/openai.ts.

import { json } from "../http.ts";
import { type PreflightedResponsesStream, ResponsesStreamError, type ResponsesStreamEvent, withSseKeepalive } from "../responses-stream.ts";
import { getString, isRecord } from "../utils.ts";
import {
  type ResponseStreamTerminalType,
  type UpstreamProvider,
  type UsageContext,
  type UsageTokens,
  classifyStreamFailure,
  extractUsageTokens,
  recordErrorUsage,
  recordResponsesEventTelemetry,
  recordResponsesFailureTelemetry,
  recordStreamTerminalType,
  recordTerminalUsage,
  streamErrorResponse,
  toChatUsage,
  type MeteredTransportLifecycle,
} from "../openai-telemetry.ts";
import {
  type ChatFunctionCall,
  ChatFunctionCallAccumulator,
  EMPTY_UPSTREAM_COMPLETION_MESSAGE,
  chatOutputTextPartStorageKey,
  chatToolCallDelta,
  emptyUpstreamCompletionError,
  malformedFunctionCallStream,
  markChatSemanticOutput,
  markFinalizedChatToolOutput,
  reconcileChatContentPart,
  reconcileChatOutputItemContent,
  reconcileChatResponseOutputContent,
  reconcileCompletedOutputText,
  reconcileCompletedRefusal,
  recordEmptyUpstreamCompletion,
  recordSuccessfulChatCompletion,
  translatedChatOutputObserved,
} from "./stream-translation.ts";

export const streamChatCompletions = (
  source: PreflightedResponsesStream,
  model: string,
  includeUsage: boolean,
  usageContext: UsageContext | undefined,
  provider: UpstreamProvider,
  lifecycle: MeteredTransportLifecycle,
  signal: AbortSignal,
  downstreamSignal: AbortSignal,
  onResponseTerminal?: (terminalType: ResponseStreamTerminalType) => void
): Response => {
  const encoder = new TextEncoder();
  const iterator = source.iterator;
  let pending: ResponsesStreamEvent | undefined = source.first;
  let id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  let created = Math.floor(Date.now() / 1000);
  let sentRole = false;
  let closed = false;
  let terminalSettled = false;
  let observedCompletedUsage: UsageTokens | null | undefined;
  let outputText = "";
  let refusal = "";
  const outputTextParts = new Map<string, string>();
  const refusalParts = new Map<string, string>();
  const functionCalls = new ChatFunctionCallAccumulator();
  const observedEvents = new WeakSet<object>();
  const queuedDeltas: (
    | Readonly<{ kind: "content"; content: string }>
    | Readonly<{ kind: "refusal"; refusal: string }>
    | Readonly<{
        kind: "tool";
        call: ChatFunctionCall;
        includeIdentity: boolean;
        argumentsDelta: string;
      }>
  )[] = [];
  const settleInitialTerminalOnCancel = async (): Promise<void> => {
    const event = source.first;
    if (terminalSettled || !event.terminal) return;
    recordResponsesEventTelemetry(usageContext, event);
    const ev = event.value;
    const usageTokens = isRecord(ev.response) ? extractUsageTokens(ev.response.usage) : null;
    if (event.type === "response.completed") {
      if (!isRecord(ev.response) || Array.isArray(ev.response)) {
        const error = new ResponsesStreamError("Upstream response.completed event is missing its response object.", { kind: "malformed_event" });
        recordResponsesFailureTelemetry(usageContext, error);
        onResponseTerminal?.("error");
        lifecycle.ambiguous();
        recordStreamTerminalType(usageContext, "error");
        terminalSettled = true;
        return;
      }
      try {
        const completed = reconcileChatResponseOutputContent(outputTextParts, refusalParts, ev, ev.response.output);
        outputText += completed.outputText;
        refusal += completed.refusal;
        functionCalls.reconcileOutput(ev, ev.response.output);
        functionCalls.assertFinalized();
      } catch (error) {
        recordResponsesFailureTelemetry(usageContext, error);
        onResponseTerminal?.("error");
        lifecycle.terminal("response.failed", usageTokens);
        recordStreamTerminalType(usageContext, "error");
        recordTerminalUsage(usageContext, usageTokens, false);
        terminalSettled = true;
        return;
      }
      terminalSettled = true;
      if (translatedChatOutputObserved(outputText, refusal, functionCalls)) {
        await recordSuccessfulChatCompletion(usageContext, lifecycle, usageTokens, onResponseTerminal);
      } else {
        recordEmptyUpstreamCompletion(usageContext, lifecycle, usageTokens, onResponseTerminal);
      }
      return;
    }
    onResponseTerminal?.(event.type as ResponseStreamTerminalType);
    lifecycle.terminal(event.type, usageTokens);
    recordStreamTerminalType(usageContext, event.type as ResponseStreamTerminalType);
    recordTerminalUsage(usageContext, usageTokens, false);
    terminalSettled = true;
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;

      const emitContent = (content: string): void => {
        const chunk: Record<string, unknown> = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: sentRole ? { content } : { role: "assistant", content },
              finish_reason: null,
            },
          ],
        };
        sentRole = true;
        if (content.length > 0) markChatSemanticOutput(usageContext);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };
      const emitRefusal = (value: string): void => {
        const delta = sentRole ? { refusal: value } : { role: "assistant", refusal: value };
        const chunk: Record<string, unknown> = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: null }],
        };
        sentRole = true;
        if (value.length > 0) markChatSemanticOutput(usageContext);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };
      const emitToolCall = (call: ChatFunctionCall, includeIdentity: boolean, argumentsDelta: string | undefined): void => {
        const toolCall = chatToolCallDelta(call, { includeIdentity, argumentsDelta });
        const delta: Record<string, unknown> = sentRole ? { tool_calls: [toolCall] } : { role: "assistant", tool_calls: [toolCall] };
        const chunk: Record<string, unknown> = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: null }],
        };
        sentRole = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };
      const queueFinalOutput = (event: Record<string, unknown>, output: unknown): void => {
        const completed = reconcileChatResponseOutputContent(outputTextParts, refusalParts, event, output);
        if (completed.outputText) {
          outputText += completed.outputText;
          queuedDeltas.push({ kind: "content", content: completed.outputText });
        }
        if (completed.refusal) {
          refusal += completed.refusal;
          queuedDeltas.push({ kind: "refusal", refusal: completed.refusal });
        }
        const beforeCount = functionCalls.calls.length;
        const reconciled = functionCalls.reconcileOutput(event, output);
        if (reconciled.length > 0) markFinalizedChatToolOutput(usageContext, functionCalls);
        for (const result of reconciled) {
          const includeIdentity = result.call.index >= beforeCount;
          if (includeIdentity || result.suffix) {
            queuedDeltas.push({
              kind: "tool",
              call: result.call,
              includeIdentity,
              argumentsDelta: result.suffix,
            });
          }
        }
      };
      const emitNextQueuedDelta = (): boolean => {
        const queued = queuedDeltas.shift();
        if (!queued) return false;
        if (queued.kind === "content") emitContent(queued.content);
        else if (queued.kind === "refusal") emitRefusal(queued.refusal);
        else emitToolCall(queued.call, queued.includeIdentity, queued.argumentsDelta);
        return true;
      };
      const applyOutputTextDelta = (ev: Record<string, unknown>): void => {
        const delta = getString(ev.delta);
        if (delta === null) {
          return malformedFunctionCallStream("Upstream output-text delta is not a string.");
        }
        const key = chatOutputTextPartStorageKey(ev);
        outputTextParts.set(key, `${outputTextParts.get(key) ?? ""}${delta}`);
        outputText += delta;
        emitContent(delta);
      };
      const applyOutputTextDone = (ev: Record<string, unknown>): "next" | "return" => {
        const completedText = getString(ev.text);
        if (completedText === null) {
          return malformedFunctionCallStream("Upstream completed output text is not a string.");
        }
        const key = chatOutputTextPartStorageKey(ev);
        const partText = outputTextParts.get(key) ?? "";
        const suffix = reconcileCompletedOutputText(partText, completedText);
        outputTextParts.set(key, `${partText}${suffix}`);
        if (suffix) {
          outputText += suffix;
          emitContent(suffix);
          return "return";
        }
        return "next";
      };
      const applyRefusalDelta = (ev: Record<string, unknown>): void => {
        const delta = getString(ev.delta);
        if (delta === null) return malformedFunctionCallStream("Upstream refusal delta is not a string.");
        const key = chatOutputTextPartStorageKey(ev);
        refusalParts.set(key, `${refusalParts.get(key) ?? ""}${delta}`);
        refusal += delta;
        emitRefusal(delta);
      };
      const applyRefusalDone = (ev: Record<string, unknown>): "next" | "return" => {
        const completedRefusal = getString(ev.refusal);
        if (completedRefusal === null) {
          return malformedFunctionCallStream("Upstream completed refusal is not a string.");
        }
        const key = chatOutputTextPartStorageKey(ev);
        const partRefusal = refusalParts.get(key) ?? "";
        const suffix = reconcileCompletedRefusal(partRefusal, completedRefusal);
        refusalParts.set(key, `${partRefusal}${suffix}`);
        if (suffix) {
          refusal += suffix;
          emitRefusal(suffix);
          return "return";
        }
        return "next";
      };
      const applyContentPartDone = (ev: Record<string, unknown>): "next" | "return" => {
        const reconciled = reconcileChatContentPart(outputTextParts, refusalParts, ev, ev.part);
        if (reconciled.outputText) {
          outputText += reconciled.outputText;
          emitContent(reconciled.outputText);
          return "return";
        }
        if (reconciled.refusal) {
          refusal += reconciled.refusal;
          emitRefusal(reconciled.refusal);
          return "return";
        }
        return "next";
      };
      const handleTextEvent = (event: ResponsesStreamEvent): "next" | "return" | "unhandled" => {
        const ev = event.value;
        const type = event.type;
        if (type === "response.output_text.delta") {
          applyOutputTextDelta(ev);
          return "return";
        }
        if (type === "response.output_text.done") return applyOutputTextDone(ev);
        if (type === "response.refusal.delta") {
          applyRefusalDelta(ev);
          return "return";
        }
        if (type === "response.refusal.done") return applyRefusalDone(ev);
        if (type === "response.content_part.done") return applyContentPartDone(ev);
        return "unhandled";
      };
      const handleOutputItemAdded = (ev: Record<string, unknown>): "next" | "return" => {
        const added = functionCalls.add(ev, ev.item);
        if (added && (added.includeIdentity || added.suffix)) {
          emitToolCall(added.call, added.includeIdentity, added.suffix);
          return "return";
        }
        return "next";
      };
      const handleOutputItemDone = (event: ResponsesStreamEvent): "next" | "return" => {
        const ev = event.value;
        const wasKnown = isRecord(ev.item) && !Array.isArray(ev.item) && functionCalls.has(ev, ev.item);
        const reconciled = functionCalls.reconcileItem(ev, ev.item);
        if (reconciled) {
          markFinalizedChatToolOutput(usageContext, functionCalls);
          if (!wasKnown || reconciled.suffix) {
            emitToolCall(reconciled.call, !wasKnown, reconciled.suffix);
            return "return";
          }
        } else {
          const completed = reconcileChatOutputItemContent(outputTextParts, refusalParts, ev, ev.item);
          outputText += completed.outputText;
          refusal += completed.refusal;
          if (completed.outputText) queuedDeltas.push({ kind: "content", content: completed.outputText });
          if (completed.refusal) queuedDeltas.push({ kind: "refusal", refusal: completed.refusal });
          if (emitNextQueuedDelta()) return "return";
        }
        return "next";
      };
      const handleToolEvent = (event: ResponsesStreamEvent): "next" | "return" | "unhandled" => {
        const ev = event.value;
        const type = event.type;
        if (type === "response.output_item.added") return handleOutputItemAdded(ev);
        if (type === "response.function_call_arguments.delta") {
          const { call, delta } = functionCalls.delta(ev);
          emitToolCall(call, false, delta);
          return "return";
        }
        if (type === "response.function_call_arguments.done") {
          const { call, suffix } = functionCalls.done(ev);
          markFinalizedChatToolOutput(usageContext, functionCalls);
          if (suffix) {
            emitToolCall(call, false, suffix);
            return "return";
          }
          return "next";
        }
        if (type === "response.output_item.done") return handleOutputItemDone(event);
        return "unhandled";
      };
      const handleFinalOutputEvent = (event: ResponsesStreamEvent): "next" | "return" => {
        const ev = event.value;
        const output = ev.output ?? (isRecord(ev.response) ? ev.response.output : undefined);
        queueFinalOutput(ev, output);
        if (queuedDeltas.length) {
          pending = event;
          emitNextQueuedDelta();
          return "return";
        }
        return "next";
      };
      const handleCompletedEvent = async (event: ResponsesStreamEvent): Promise<void> => {
        const ev = event.value;
        if (!isRecord(ev.response) || Array.isArray(ev.response)) {
          return malformedFunctionCallStream("Upstream response.completed event is missing its response object.");
        }
        observedCompletedUsage = extractUsageTokens(ev.response.usage);
        const output = ev.response.output;
        queueFinalOutput(ev, output);
        functionCalls.assertFinalized();
        const usageTokens = observedCompletedUsage;
        if (!terminalSettled) {
          terminalSettled = true;
          if (!translatedChatOutputObserved(outputText, refusal, functionCalls)) {
            recordEmptyUpstreamCompletion(usageContext, lifecycle, usageTokens, onResponseTerminal);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(emptyUpstreamCompletionError())}\n\n`));
            closed = true;
            controller.close();
            void iterator.return("Empty Responses completion translated").catch(() => {});
            return;
          }
          await recordSuccessfulChatCompletion(usageContext, lifecycle, usageTokens, onResponseTerminal);
        }
        if (queuedDeltas.length) {
          pending = event;
          emitNextQueuedDelta();
          return;
        }
        const chunk: Record<string, unknown> = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: sentRole ? {} : { role: "assistant" },
              finish_reason: functionCalls.hasCalls ? "tool_calls" : "stop",
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        const usage = toChatUsage(usageTokens);
        if (includeUsage && usage !== null) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        closed = true;
        controller.close();
        void iterator.return("Responses terminal event translated").catch(() => {});
      };
      const handleTerminalEvent = (event: ResponsesStreamEvent): void => {
        const ev = event.value;
        const type = event.type;
        const usageTokens = isRecord(ev.response) ? extractUsageTokens(ev.response.usage) : null;
        onResponseTerminal?.(type as ResponseStreamTerminalType);
        lifecycle.terminal(type, usageTokens);
        recordStreamTerminalType(usageContext, type as ResponseStreamTerminalType);
        recordTerminalUsage(usageContext, usageTokens, false);
        terminalSettled = true;
        const errorValue = {
          error: {
            message: `Upstream terminated with ${type}.`,
            type: "server_error",
            code: "upstream_stream_error",
          },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorValue)}\n\n`));
        closed = true;
        controller.close();
        void iterator.return("Responses terminal error translated").catch(() => {});
      };
      const handleStreamEvent = async (event: ResponsesStreamEvent): Promise<"next" | "return"> => {
        const ev = event.value;
        const type = event.type;
        if (type === "response.created" && isRecord(ev.response)) {
          const upstreamId = getString(ev.response.id);
          const createdAt = typeof ev.response.created_at === "number" ? ev.response.created_at : null;
          if (upstreamId) id = upstreamId;
          if (createdAt) created = createdAt;
          return "next";
        }
        const textOutcome = handleTextEvent(event);
        if (textOutcome !== "unhandled") return textOutcome;
        const toolOutcome = handleToolEvent(event);
        if (toolOutcome !== "unhandled") return toolOutcome;
        if (type === "response.output") return handleFinalOutputEvent(event);
        if (type === "response.completed") {
          await handleCompletedEvent(event);
          return "return";
        }
        if (event.terminal) {
          handleTerminalEvent(event);
          return "return";
        }
        return "next";
      };
      const pumpStream = async (): Promise<void> => {
        if (emitNextQueuedDelta()) return;
        while (!closed) {
          const next = pending ? { done: false as const, value: pending } : await iterator.next();
          pending = undefined;
          if (next.done) {
            throw new ResponsesStreamError("Upstream Responses stream ended before a terminal event.", {
              kind: "premature_eof",
            });
          }
          const event = next.value;
          if (!observedEvents.has(event)) {
            observedEvents.add(event);
            recordResponsesEventTelemetry(usageContext, event);
          }
          const outcome = await handleStreamEvent(event);
          if (outcome === "return") return;
        }
      };
      const settleStreamFailure = async (error: unknown): Promise<void> => {
        if (closed) return;
        await iterator.return(error).catch(() => {});
        if (!terminalSettled) {
          recordResponsesFailureTelemetry(usageContext, error);
          if (observedCompletedUsage !== undefined) {
            onResponseTerminal?.("error");
            lifecycle.terminal("response.failed", observedCompletedUsage);
            recordStreamTerminalType(usageContext, "error");
            recordTerminalUsage(usageContext, observedCompletedUsage, false);
            terminalSettled = true;
          } else {
            const terminalType = classifyStreamFailure(error, signal, downstreamSignal);
            onResponseTerminal?.(terminalType);
            recordStreamTerminalType(usageContext, terminalType);
            if (terminalType === "cancelled") lifecycle.cancelled();
            else lifecycle.ambiguous();
            void recordErrorUsage(usageContext);
          }
        }
        const errorValue = {
          error: {
            message: "The upstream stream ended unexpectedly.",
            type: "server_error",
            code: "upstream_stream_error",
          },
        };
        if (!downstreamSignal.aborted) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorValue)}\n\n`));
        }
        closed = true;
        controller.close();
      };

      try {
        await pumpStream();
      } catch (error) {
        await settleStreamFailure(error);
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      await settleInitialTerminalOnCancel();
      if (!terminalSettled) {
        onResponseTerminal?.("cancelled");
        recordStreamTerminalType(usageContext, "cancelled");
        lifecycle.cancelled();
        void recordErrorUsage(usageContext);
      }
      await source.cancel(reason);
    },
  });

  return new Response(withSseKeepalive(stream), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "x-uos-upstream": provider,
    },
  });
};

export const completeChatCompletions = async (
  source: PreflightedResponsesStream,
  model: string,
  usageContext: UsageContext | undefined,
  provider: UpstreamProvider,
  lifecycle: MeteredTransportLifecycle,
  signal: AbortSignal,
  downstreamSignal: AbortSignal,
  warnings: readonly string[] = [],
  onResponseTerminal?: (terminalType: ResponseStreamTerminalType) => void
): Promise<Response> => {
  let id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  let created = Math.floor(Date.now() / 1000);
  let content = "";
  let refusal = "";
  const outputTextParts = new Map<string, string>();
  const refusalParts = new Map<string, string>();
  let usage: Record<string, unknown> | null = null;
  const functionCalls = new ChatFunctionCallAccumulator();

  let completed = false;
  let terminalType: ResponseStreamTerminalType | null = null;
  let observedCompletedUsage: UsageTokens | null | undefined;
  let emptyCompletion = false;

  const applyTerminalEvent = (event: ResponsesStreamEvent): void => {
    const ev = event.value;
    const type = event.type;
    terminalType = type as ResponseStreamTerminalType;
    const terminalUsage = isRecord(ev.response) ? extractUsageTokens(ev.response.usage) : null;
    onResponseTerminal?.(type as ResponseStreamTerminalType);
    lifecycle.terminal(type, terminalUsage);
    recordStreamTerminalType(usageContext, type as ResponseStreamTerminalType);
    recordTerminalUsage(usageContext, terminalUsage, false);
  };

  const applyCreatedEvent = (event: ResponsesStreamEvent): boolean => {
    const ev = event.value;
    if (event.type !== "response.created" || !isRecord(ev.response)) return false;
    const upstreamId = getString(ev.response.id);
    const createdAt = typeof ev.response.created_at === "number" ? ev.response.created_at : null;
    if (upstreamId) id = upstreamId;
    if (createdAt) created = createdAt;
    return true;
  };

  const applyOutputTextDelta = (ev: Record<string, unknown>): void => {
    const delta = getString(ev.delta);
    if (delta === null) {
      return malformedFunctionCallStream("Upstream output-text delta is not a string.");
    }
    const key = chatOutputTextPartStorageKey(ev);
    outputTextParts.set(key, `${outputTextParts.get(key) ?? ""}${delta}`);
    content += delta;
    if (delta.length > 0) markChatSemanticOutput(usageContext);
  };

  const applyOutputTextDone = (ev: Record<string, unknown>): void => {
    const completedText = getString(ev.text);
    if (completedText === null) {
      return malformedFunctionCallStream("Upstream completed output text is not a string.");
    }
    const key = chatOutputTextPartStorageKey(ev);
    const partText = outputTextParts.get(key) ?? "";
    const suffix = reconcileCompletedOutputText(partText, completedText);
    outputTextParts.set(key, `${partText}${suffix}`);
    content += suffix;
    if (suffix.length > 0) markChatSemanticOutput(usageContext);
  };

  const applyRefusalDelta = (ev: Record<string, unknown>): void => {
    const delta = getString(ev.delta);
    if (delta === null) return malformedFunctionCallStream("Upstream refusal delta is not a string.");
    const key = chatOutputTextPartStorageKey(ev);
    refusalParts.set(key, `${refusalParts.get(key) ?? ""}${delta}`);
    refusal += delta;
    if (delta.length > 0) markChatSemanticOutput(usageContext);
  };

  const applyRefusalDone = (ev: Record<string, unknown>): void => {
    const completedRefusal = getString(ev.refusal);
    if (completedRefusal === null) {
      return malformedFunctionCallStream("Upstream completed refusal is not a string.");
    }
    const key = chatOutputTextPartStorageKey(ev);
    const partRefusal = refusalParts.get(key) ?? "";
    const suffix = reconcileCompletedRefusal(partRefusal, completedRefusal);
    refusalParts.set(key, `${partRefusal}${suffix}`);
    refusal += suffix;
    if (suffix.length > 0) markChatSemanticOutput(usageContext);
  };

  const applyContentPartDone = (ev: Record<string, unknown>): void => {
    const reconciled = reconcileChatContentPart(outputTextParts, refusalParts, ev, ev.part);
    content += reconciled.outputText;
    refusal += reconciled.refusal;
    if (reconciled.outputText.length > 0 || reconciled.refusal.length > 0) {
      markChatSemanticOutput(usageContext);
    }
  };

  const applyTextEvent = (event: ResponsesStreamEvent): boolean => {
    const ev = event.value;
    const type = event.type;
    if (type === "response.output_text.delta") {
      applyOutputTextDelta(ev);
      return true;
    }
    if (type === "response.output_text.done") {
      applyOutputTextDone(ev);
      return true;
    }
    if (type === "response.refusal.delta") {
      applyRefusalDelta(ev);
      return true;
    }
    if (type === "response.refusal.done") {
      applyRefusalDone(ev);
      return true;
    }
    if (type === "response.content_part.done") {
      applyContentPartDone(ev);
      return true;
    }
    return false;
  };

  const applyOutputItemDone = (ev: Record<string, unknown>): void => {
    const functionCall = functionCalls.reconcileItem(ev, ev.item);
    if (functionCall) {
      markFinalizedChatToolOutput(usageContext, functionCalls);
    } else {
      const completed = reconcileChatOutputItemContent(outputTextParts, refusalParts, ev, ev.item);
      content += completed.outputText;
      refusal += completed.refusal;
      if (completed.outputText.length > 0 || completed.refusal.length > 0) {
        markChatSemanticOutput(usageContext);
      }
    }
  };

  const applyResponseOutput = (ev: Record<string, unknown>): void => {
    const output = ev.output ?? (isRecord(ev.response) ? ev.response.output : undefined);
    const completed = reconcileChatResponseOutputContent(outputTextParts, refusalParts, ev, output);
    content += completed.outputText;
    refusal += completed.refusal;
    const reconciled = functionCalls.reconcileOutput(ev, output);
    if (completed.outputText.length > 0 || completed.refusal.length > 0) markChatSemanticOutput(usageContext);
    if (reconciled.length > 0) markFinalizedChatToolOutput(usageContext, functionCalls);
  };

  const applyResponseCompleted = async (ev: Record<string, unknown>, response: Record<string, unknown>): Promise<"complete" | "empty"> => {
    observedCompletedUsage = extractUsageTokens(response.usage);
    const completedOutput = reconcileChatResponseOutputContent(outputTextParts, refusalParts, ev, response.output);
    content += completedOutput.outputText;
    refusal += completedOutput.refusal;
    functionCalls.reconcileOutput(ev, response.output);
    functionCalls.assertFinalized();
    const usageTokens = observedCompletedUsage;
    usage = toChatUsage(usageTokens);
    if (!translatedChatOutputObserved(content, refusal, functionCalls)) {
      recordEmptyUpstreamCompletion(usageContext, lifecycle, usageTokens, onResponseTerminal);
      return "empty";
    }
    completed = true;
    await recordSuccessfulChatCompletion(usageContext, lifecycle, usageTokens, onResponseTerminal);
    return "complete";
  };

  const applyOutputEvent = async (event: ResponsesStreamEvent): Promise<"unhandled" | "next" | "complete" | "empty"> => {
    const ev = event.value;
    const type = event.type;
    if (type === "response.output_item.added") {
      functionCalls.add(ev, ev.item);
      return "next";
    }
    if (type === "response.function_call_arguments.delta") {
      functionCalls.delta(ev);
      return "next";
    }
    if (type === "response.function_call_arguments.done") {
      functionCalls.done(ev);
      markFinalizedChatToolOutput(usageContext, functionCalls);
      return "next";
    }
    if (type === "response.output_item.done") {
      applyOutputItemDone(ev);
      return "next";
    }
    if (type === "response.output") {
      applyResponseOutput(ev);
      return "next";
    }
    if (type === "response.completed" && isRecord(ev.response) && !Array.isArray(ev.response)) {
      return await applyResponseCompleted(ev, ev.response);
    }
    return "unhandled";
  };

  const consumeEvent = async (event: ResponsesStreamEvent): Promise<"next" | "break" | "complete" | "empty"> => {
    recordResponsesEventTelemetry(usageContext, event);
    if (event.terminal && event.type !== "response.completed") applyTerminalEvent(event);
    if (applyCreatedEvent(event)) return "next";
    if (applyTextEvent(event)) return "next";
    const outcome = await applyOutputEvent(event);
    if (outcome !== "unhandled") return outcome;
    if (event.terminal) return "break";
    return "next";
  };

  const settleFailure = (error: unknown): void => {
    recordResponsesFailureTelemetry(usageContext, error);
    if (observedCompletedUsage !== undefined) {
      terminalType = "error";
      onResponseTerminal?.("error");
      lifecycle.terminal("response.failed", observedCompletedUsage);
      recordStreamTerminalType(usageContext, "error");
      recordTerminalUsage(usageContext, observedCompletedUsage, false);
    } else {
      terminalType = classifyStreamFailure(error, signal, downstreamSignal);
      onResponseTerminal?.(terminalType);
      recordStreamTerminalType(usageContext, terminalType);
      if (terminalType === "cancelled") lifecycle.cancelled();
      else lifecycle.ambiguous();
    }
    completed = false;
  };

  const respondIncomplete = async (): Promise<Response> => {
    await recordErrorUsage(usageContext);
    if (terminalType === "cancelled") {
      return streamErrorResponse(499, "Request was cancelled.", "request_cancelled", provider, warnings, "server_error", null);
    }
    if (terminalType === "deadline") {
      return streamErrorResponse(504, "Upstream request exceeded the gateway deadline.", "gateway_timeout", provider, warnings, "server_error", null);
    }
    return streamErrorResponse(502, "Upstream stream ended without response.completed.", "upstream_stream_error", provider, warnings);
  };

  const buildCompletedBody = (): Record<string, unknown> => {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: content || (!functionCalls.hasCalls && !refusal) ? content : null,
    };
    if (refusal) message.refusal = refusal;
    if (functionCalls.hasCalls) {
      message.tool_calls = functionCalls.calls.map((call) => ({
        id: call.callId,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    const body: Record<string, unknown> = {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: functionCalls.hasCalls ? "tool_calls" : "stop",
        },
      ],
    };
    if (usage) body.usage = usage;
    return body;
  };

  try {
    let pending: ResponsesStreamEvent | undefined = source.first;
    for (;;) {
      const next = pending ? { done: false as const, value: pending } : await source.iterator.next();
      pending = undefined;
      if (next.done) break;
      const outcome = await consumeEvent(next.value);
      if (outcome === "break") break;
      if (outcome === "empty") {
        emptyCompletion = true;
        break;
      }
      if (outcome === "complete") {
        completed = true;
        break;
      }
    }
  } catch (error) {
    settleFailure(error);
  } finally {
    // This path consumes the generator manually (rather than through
    // `for await`), so explicitly close it after a terminal event or error.
    // Otherwise the parser can remain suspended at its final `yield` while
    // retaining the upstream reader lock.
    await source.iterator.return("Chat Completions response consumed").catch(() => {});
  }
  if (emptyCompletion) {
    return streamErrorResponse(502, EMPTY_UPSTREAM_COMPLETION_MESSAGE, "empty_upstream_completion", provider, warnings, "server_error", null);
  }
  if (!completed) return await respondIncomplete();

  return json(200, buildCompletedBody(), { "x-uos-upstream": provider });
};

import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import {
  VpsQueryBudgetError,
  VPS_METRICS_MAX_BYTES,
  VPS_METRICS_MAX_ENTRIES,
  VPS_METRICS_SLICE_MS,
  type VpsBoundedJournalCommand,
  type VpsJournalReader,
  type VpsQueryLimits,
} from "./vps-metrics-types.ts";
export function createVpsJournalReader(run: VpsBoundedJournalCommand, root: string, coverage: VpsJournalReader["coverage"]): VpsJournalReader {
  return {
    coverage,
    read: (start, end, limits) => {
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > VPS_METRICS_SLICE_MS)
        throw new Error("VPS journal range is invalid");
      // Without --all, journalctl writes any field over 4 KiB as null, and a long request row would become unreadable.
      return run(["--unit=ai-ubq-fi.service", `--since=@${start / 1000}`, `--until=@${end / 1000}`, "--output=json", "--all", "--no-pager"], limits, root);
    },
  };
}
export type VpsJournalProcess = { stdout: ReadableStream<Uint8Array>; status: Promise<{ success: boolean }>; kill(signal: "SIGTERM" | "SIGKILL"): void };
const validLimits = (limits: VpsQueryLimits, now: number) =>
  Number.isSafeInteger(limits.deadline) &&
  limits.deadline > now &&
  Number.isSafeInteger(limits.maxBytes) &&
  limits.maxBytes > 0 &&
  limits.maxBytes <= VPS_METRICS_MAX_BYTES &&
  Number.isSafeInteger(limits.maxEntries) &&
  limits.maxEntries > 0 &&
  limits.maxEntries <= VPS_METRICS_MAX_ENTRIES;
async function boundedBody(reader: ReadableStreamDefaultReader<Uint8Array>, limits: VpsQueryLimits, interrupted: () => Error | null): Promise<string> {
  let bytes = 0,
    lines = 0,
    text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (;;) {
    const chunk = await reader.read();
    const interruption = interrupted();
    if (interruption) throw interruption;
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    lines += chunk.value.reduce((total, byte) => total + Number(byte === 10), 0);
    if (bytes > limits.maxBytes || lines > limits.maxEntries) throw new Error("VPS journal output exceeds bounds");
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  if (text && !text.endsWith("\n")) lines++;
  if (lines > limits.maxEntries) throw new Error("VPS journal output exceeds bounds");
  return text;
}
/** A complete bounded result or refusal; every owned child settles before return. */
export async function readVpsJournalProcess(child: VpsJournalProcess, limits: VpsQueryLimits, now = Date.now): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
  const stopped = { value: false, budget: false };
  const stop = (budget = false) => {
    stopped.value = true;
    stopped.budget ||= budget;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already settled */
    }
    killTimer ??= setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already settled */
      }
    }, 1000);
  };
  const reader = child.stdout.getReader();
  try {
    if (limits.deadline <= now()) throw new VpsQueryBudgetError();
    if (!validLimits(limits, now())) throw new Error("VPS journal limits are invalid");
    timer = setTimeout(
      () => {
        stop(true);
      },
      Math.max(1, limits.deadline - now())
    );
    const text = await boundedBody(reader, limits, () => (stopped.budget ? new VpsQueryBudgetError() : null));
    const status = await child.status;
    if (stopped.budget) throw new VpsQueryBudgetError();
    if (!status.success || stopped.value) throw new Error("VPS journal command unavailable");
    return text;
  } catch (error) {
    stop();
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await child.status;
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
}
/** Trusted native boundary: only journalctl with the fixed unit and bounded range. */
export const runVpsJournalCommand: VpsBoundedJournalCommand = (args, limits, cwd) => {
  if (
    args.length !== 6 ||
    args[0] !== "--unit=ai-ubq-fi.service" ||
    !/^--since=@\d+(?:\.\d+)?$/.test(args[1]) ||
    !/^--until=@\d+(?:\.\d+)?$/.test(args[2]) ||
    args[3] !== "--output=json" ||
    args[4] !== "--all" ||
    args[5] !== "--no-pager"
  )
    throw new Error("VPS journal command refused");
  // node:child_process keeps this port loadable and runnable under Bun and the Deno bridge alike.
  const child = spawn("/usr/bin/journalctl", [...args], { cwd, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] });
  const status = new Promise<{ success: boolean }>((resolve) => {
    child.once("error", () => {
      resolve({ success: false });
    });
    child.once("close", (code, signal) => {
      resolve({ success: code === 0 && signal === null });
    });
  });
  return readVpsJournalProcess(
    {
      stdout: journalStdout(child.stdout, child),
      status,
      kill: (signal) => {
        child.kill(signal);
      },
    },
    limits
  );
};
/**
 * Adapts the child's stdout pipe to a byte stream. A spawn failure ends the body; the settled status then refuses it.
 * A chunk can still arrive after the body has closed or been cancelled; it destroys the pipe instead of throwing from
 * the pipe's listener.
 */
export function journalStdout(pipe: Readable, spawned: EventEmitter): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const end = () => {
        try {
          controller.close();
        } catch {
          /* already settled */
        }
      };
      pipe.on("data", (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          pipe.destroy();
          return;
        }
        if ((controller.desiredSize ?? 0) <= 0) pipe.pause();
      });
      pipe.once("end", end);
      pipe.once("error", (error) => {
        try {
          controller.error(error);
        } catch {
          /* already settled */
        }
      });
      spawned.once("error", end);
    },
    pull() {
      pipe.resume();
    },
    cancel() {
      pipe.destroy();
    },
  });
}

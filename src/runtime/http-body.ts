import type { IncomingMessage } from "node:http";

export type IncomingBody = Readonly<{
  stream: ReadableStream<Uint8Array>;
  cancelled: boolean;
  consumed: boolean;
  dispose: () => void;
}>;

/** Cancelling application input must leave the socket available for its response. */
export const createIncomingBody = (incoming: IncomingMessage, signal: AbortSignal): IncomingBody => {
  let closed = false;
  let cancelled = false;
  let consumed = false;
  let cleanup: () => void = () => {};
  let dispose: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const stop = (): void => {
          closed = true;
          incoming.pause();
          cleanup();
        };
        const data = (chunk: unknown): void => {
          if (closed) return;
          if (!(chunk instanceof Uint8Array)) {
            failed(new TypeError("HTTP request body did not provide bytes"));
            return;
          }
          controller.enqueue(chunk);
          if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
        };
        const end = (): void => {
          if (closed) return;
          consumed = true;
          stop();
          controller.close();
        };
        const failed = (reason: unknown): void => {
          if (closed) return;
          stop();
          controller.error(reason);
        };
        const abort = (): void => failed(signal.reason);
        cleanup = (): void => {
          incoming.removeListener("data", data);
          incoming.removeListener("end", end);
          incoming.removeListener("error", failed);
          signal.removeEventListener("abort", abort);
        };
        dispose = (): void => failed(new Error("The HTTP response settled before the request body was consumed"));
        incoming.pause();
        incoming.on("data", data);
        incoming.once("end", end);
        incoming.once("error", failed);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else if (incoming.readableEnded) end();
      },
      pull() {
        if (!closed) incoming.resume();
      },
      cancel() {
        cancelled = true;
        closed = true;
        incoming.pause();
        cleanup();
      },
    },
    { highWaterMark: 0 }
  );
  return {
    stream,
    get cancelled() {
      return cancelled;
    },
    get consumed() {
      return consumed;
    },
    dispose: () => dispose(),
  };
};

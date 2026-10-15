import type { ServeHandler, ServeUpgradeHandler } from "#http";
import handler, { upgradeHandler } from "./index.ts";

export const createRequestDeliveryLifecycle = (
  requestSignal: AbortSignal,
  completed: Promise<void>
): Readonly<{ signal: AbortSignal; handoff: () => void }> => {
  const downstream = new AbortController();
  let handedOff = false;
  const abortBeforeHandoff = (): void => {
    if (handedOff || downstream.signal.aborted) return;
    downstream.abort(requestSignal.reason);
  };
  if (requestSignal.aborted) abortBeforeHandoff();
  else requestSignal.addEventListener("abort", abortBeforeHandoff, { once: true });
  void completed.catch((reason: unknown) => {
    if (!downstream.signal.aborted) downstream.abort(reason);
  });
  return {
    signal: downstream.signal,
    handoff: () => {
      if (handedOff) return;
      handedOff = true;
      requestSignal.removeEventListener("abort", abortBeforeHandoff);
    },
  };
};

type DeliveryAwareHandler = (request: Request, delivery: Readonly<{ completed: Promise<void>; downstreamSignal: AbortSignal }>) => Promise<Response>;

export const createServeHandler =
  (requestHandler: DeliveryAwareHandler = handler): ServeHandler =>
  async (request, info) => {
    const delivery = createRequestDeliveryLifecycle(request.signal, info.completed);
    try {
      return await requestHandler(request, {
        completed: info.completed,
        downstreamSignal: delivery.signal,
      });
    } finally {
      delivery.handoff();
    }
  };

export const createServeUpgradeHandler = (): ServeUpgradeHandler => upgradeHandler;

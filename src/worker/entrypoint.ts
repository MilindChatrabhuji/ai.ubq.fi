import type { PortableAuthority } from "../authority/admission-state.ts";
import { AuthorityError, type AdmissionHandle, type AuthorityScope, type DeliveryOutcome, type GatewayRoute } from "../authority/contracts.ts";
import { DeliveryOutbox } from "../authority/delivery-outbox.ts";
import type { UpstreamResult, UpstreamTransport } from "./transport.ts";

export type BoundaryPrincipal = Readonly<{ principalId: string; policyVersion: number }>;
export type BoundaryLifetime = Readonly<{ waitUntil(task: Promise<unknown>): void }>;
export type BoundaryDelivery = Readonly<{ completed: Promise<DeliveryOutcome> }>;
export type WorkerBoundaryDependencies = Readonly<{
  scope: AuthorityScope;
  authority: PortableAuthority;
  upstream: UpstreamTransport;
  authenticate(request: Request): Promise<BoundaryPrincipal | null>;
  now(): number;
}>;
const errorResponse = (code: string, status: number): Response => Response.json({ error: { code, message: code, type: "gateway_error" } }, { status });
const digest = async (body: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), (byte) => byte.toString(16).padStart(2, "0")).join("");
const readBoundedJson = async (request: Request): Promise<Readonly<Record<string, unknown>>> => {
  request.signal.throwIfAborted();
  if (!request.body) throw new AuthorityError("request_body_required", 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  const cancel = (): void => {
    void reader.cancel(request.signal.reason).catch(() => undefined);
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      request.signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1_048_576) {
        await reader.cancel("request_too_large");
        throw new AuthorityError("request_too_large", 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthorityError("invalid_request_body", 400);
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new AuthorityError("invalid_json", 400);
    throw error;
  } finally {
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
};

const deliverResponse = ({
  upstream,
  requestId,
  request,
  abort,
  abortFromRequest,
  outbox,
  lifetime,
  delivery,
}: Readonly<{
  upstream: UpstreamResult;
  requestId: string;
  request: Request;
  abort: AbortController;
  abortFromRequest: () => void;
  outbox: DeliveryOutbox;
  lifetime: BoundaryLifetime;
  delivery?: BoundaryDelivery;
}>): Response => {
  let bodyDone = false;
  let completed: Promise<void> | null = null;
  const finish = (outcome: DeliveryOutcome): Promise<void> => {
    completed ??= outbox.delivery(outcome).finally(() => {
      request.signal.removeEventListener("abort", abortFromRequest);
    });
    return completed;
  };
  if (delivery) lifetime.waitUntil(delivery.completed.then((outcome) => finish(outcome)));
  const reader = upstream.response.body?.getReader();
  const cancel = async (reason: unknown): Promise<void> => {
    if (bodyDone) return;
    bodyDone = true;
    abort.abort(reason);
    try {
      // An already aborted fetch may reject cancellation with the abort reason.
      await reader?.cancel(reason).catch(() => undefined);
    } finally {
      await finish("interrupted");
    }
  };
  const signalCancellation = (): void => {
    lifetime.waitUntil(cancel(abort.signal.reason));
  };
  abort.signal.addEventListener("abort", signalCancellation, { once: true });
  const responseBody = reader
    ? new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                bodyDone = true;
                abort.signal.removeEventListener("abort", signalCancellation);
                if (!delivery) await finish(abort.signal.aborted ? "interrupted" : "unobserved");
                controller.close();
              } else controller.enqueue(chunk.value);
            } catch (error) {
              bodyDone = true;
              abort.signal.removeEventListener("abort", signalCancellation);
              await finish("interrupted");
              controller.error(error);
            }
          },
          async cancel(reason) {
            await cancel(reason);
          },
        },
        { highWaterMark: 0 }
      )
    : null;
  if (!reader) {
    bodyDone = true;
    abort.signal.removeEventListener("abort", signalCancellation);
    if (!delivery) lifetime.waitUntil(finish("unobserved"));
  }
  if (abort.signal.aborted) lifetime.waitUntil(cancel(abort.signal.reason));
  const headers = new Headers(upstream.response.headers);
  headers.set("x-request-id", requestId);
  return new Response(responseBody, { status: upstream.response.status, statusText: upstream.response.statusText, headers });
};

const refuseRequest = async ({
  error,
  request,
  abort,
  abortFromRequest,
  handle,
  dispatchState,
  authority,
}: Readonly<{
  error: unknown;
  request: Request;
  abort: AbortController;
  abortFromRequest: () => void;
  handle: AdmissionHandle | null;
  dispatchState: { intent: boolean };
  authority: PortableAuthority;
}>): Promise<Response> => {
  request.signal.removeEventListener("abort", abortFromRequest);
  try {
    if (handle && !dispatchState.intent) await authority.cancelUndispatched(handle);
    if (handle && dispatchState.intent) await authority.observeDelivery(handle, abort.signal.aborted ? "interrupted" : "unobserved");
  } catch {
    // The durable admission/attempt remains unresolved; cleanup failure cannot replace the original refusal.
  }
  if (error instanceof AuthorityError) return errorResponse(error.code, error.status);
  return errorResponse(abort.signal.aborted ? "request_cancelled" : "upstream_unavailable", abort.signal.aborted ? 499 : 502);
};

/** Native-free factory; no runtime binding, configuration, credential source or live route is installed. */
export const createWorkerBoundary = (dependencies: WorkerBoundaryDependencies) => ({
  async fetch(request: Request, lifetime: BoundaryLifetime, delivery?: BoundaryDelivery): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/v1/responses" && path !== "/v1/chat/completions") return errorResponse("route_not_implemented", 501);
    if (request.method !== "POST") return errorResponse("method_not_allowed", 405);
    const route: GatewayRoute = path;
    let handle: Awaited<ReturnType<PortableAuthority["admit"]>> | null = null;
    const dispatchState = { intent: false };
    const abort = new AbortController();
    const abortFromRequest = (): void => {
      abort.abort(request.signal.reason);
    };
    request.signal.addEventListener("abort", abortFromRequest, { once: true });
    if (request.signal.aborted) abortFromRequest();
    try {
      const principal = await dependencies.authenticate(request);
      if (!principal) {
        request.signal.removeEventListener("abort", abortFromRequest);
        return errorResponse("invalid_api_key", 401);
      }
      const body = await readBoundedJson(request);
      const input = await dependencies.upstream.validate(route, body);
      const requestId = crypto.randomUUID();
      handle = await dependencies.authority.admit({
        scope: dependencies.scope,
        requestId,
        principalId: principal.principalId,
        policyVersion: principal.policyVersion,
        digest: await digest(JSON.stringify(input)),
        route,
        model: input.model,
        nowMs: dependencies.now(),
      });
      const admitted = handle;
      const selection = await dependencies.authority.selection(admitted);
      const selected = await dependencies.upstream.attempt(input, selection.account);
      const dispatchedAttempt = crypto.randomUUID();
      await dependencies.authority.reserveAttempt(admitted, { ...selected, attemptId: dispatchedAttempt }, dependencies.now());
      abort.signal.throwIfAborted();
      const outbox = new DeliveryOutbox(dependencies.authority, admitted);
      const upstream = await dependencies.upstream.dispatch(input, selected, abort.signal, async () => {
        if (dispatchState.intent) throw new AuthorityError("dispatch_callback_repeated");
        if (!(await dependencies.authority.beginDispatch(admitted, dispatchedAttempt, dependencies.now())))
          throw new AuthorityError("dispatch_already_claimed");
        dispatchState.intent = true;
        await dependencies.authority.confirmDispatched(admitted, dispatchedAttempt);
      });
      if (!dispatchState.intent) throw new AuthorityError("upstream_dispatch_unobserved", 502);
      const terminal = upstream.terminal.then((evidence) => outbox.terminal(dispatchedAttempt, evidence));
      // Persist terminal observation through the actual request lifetime, even on client abort.
      lifetime.waitUntil(terminal);
      return deliverResponse({ upstream, requestId, request, abort, abortFromRequest, outbox, lifetime, delivery });
    } catch (error) {
      return await refuseRequest({ error, request, abort, abortFromRequest, handle, dispatchState, authority: dependencies.authority });
    }
  },
});

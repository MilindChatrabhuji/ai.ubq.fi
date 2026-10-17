// Terminal inference route and admission reservations, split out of src/handler.ts.

import { ADMISSION_ROUTES, admissionController, localOverloadResponse } from "./admission.ts";
import {
  type AuthenticatedClientResult,
  decorateInferenceQuota,
  type RequestDeliveryInfo,
  resolveIdempotencyPrincipal,
  scheduleSentinelBackgroundTask,
  type SentinelBackgroundTaskRegistrar,
  kernelQuotaRouteForRequest,
  terminalRouteForRequest,
  withProviderRequestId,
  withRequestId,
} from "./http.ts";
import { warnQuotaAccountingFailure, withRejectionTerminalLog, withTerminalRequestLog } from "./terminal-log.ts";

import { authenticateClient } from "../auth/index.ts";
import { getKernelAttestationContext } from "../kernel/attestation.ts";
import { type ApiKeyPolicy, ApiKeyQuotaDispatchError, type ApiKeyUsageReservation, reserveApiKeyUsageV3 } from "../api-key-policy.ts";
import { runtimeDeploymentId, runtimeGitSha } from "../config.ts";
import { openaiError, withCors as withCorsHeaders, withoutBody } from "../http.ts";
import { type InferenceAdmissionResult } from "../inference-admission.ts";
import { handleJevResponsesCompaction, isJevCompactionRequest } from "../jev_compaction/compaction.ts";
import { type KernelQuotaReservation, reserveEffectiveKernelUsageLimit } from "../kernel/usage.ts";
import { handleResponses } from "../responses-handler.ts";
import { handleChatCompletions } from "../chat/envelope.ts";
import { handleUosEmbeddings } from "../embeddings/handlers.ts";
import { handleEmbeddingsJobCreate, handleEmbeddingsJobGet } from "../embeddings/jobs.ts";
import { getResponseTelemetry } from "../openai-telemetry.ts";
import { handleImages } from "../images.ts";
import { handleModels } from "../models/catalog.ts";
import { handleSystemOne } from "../systemone/handlers.ts";
import {
  type AcceptedSentinelReplayInput,
  captureAcceptedSentinelReplayInput,
  discardSentinelReplayCaptureCandidate,
  disposeSentinelUpstreamRecorder,
  materializeSentinelReplayInput,
  persistSentinelReplayFromEnvironment,
  recordSentinelReplayOmissionFromEnvironment,
  type SentinelFailureObservation,
  type SentinelReplayCaptureOmissionReason,
  snapshotSentinelReplayInput,
  zeroSentinelReplayInput,
} from "../sentinel/replay-capture.ts";
import { createSentinelUpstreamRecorder } from "../sentinel/upstream-capture.ts";

const apiKeyIdFrom = (authResult: AuthenticatedClientResult): string | null => (authResult.method.kind === "kv_api_key" ? authResult.method.key_id : null);

/** The API-key policy that applies to this request, if it authenticated with one. */
const apiKeyPolicyFrom = (authResult: AuthenticatedClientResult): ApiKeyPolicy | null =>
  authResult.method.kind === "kv_api_key" ? authResult.method.policy : null;

/** Resolves the GitHub repository that owns kernel quota for this request. */
const resolveKernelRepo = async (req: Request, authResult: AuthenticatedClientResult): Promise<Readonly<{ owner: string; repo: string }> | null> => {
  if (authResult.method.kind === "github_token") return { owner: authResult.method.owner, repo: authResult.method.repo };
  const attestation = await getKernelAttestationContext(req, authResult.token);
  if (!attestation) return null;
  return { owner: attestation.owner, repo: attestation.repo };
};

/** Signal handed to an inference handler: an active kernel reservation also aborts it. */
const downstreamSignalFor = (req: Request, delivery: RequestDeliveryInfo | undefined, reservation: KernelQuotaReservation | null): AbortSignal | undefined =>
  reservation ? AbortSignal.any([delivery?.downstreamSignal ?? req.signal, reservation.signal]) : delivery?.downstreamSignal;

/** Reserves API-key usage for a terminal route; a refusal is returned as a response. */
const reserveUsageAdmission = async (
  req: Request,
  policy: ApiKeyPolicy,
  requestId: string,
  route: string,
  startedAtMonotonicMs: number,
  delivery: RequestDeliveryInfo | undefined,
  onSettled?: () => void,
  admissionWaitMs?: number | null
): Promise<Readonly<{ reservation: ApiKeyUsageReservation } | { rejection: Response }>> => {
  const admission = await reserveApiKeyUsageV3(policy, requestId, route, { deferWhenFull: true });
  if (admission.ok) return { reservation: admission.reservation };
  const response = withCorsHeaders(withRequestId(admission.response, requestId), req);
  return {
    rejection: await withRejectionTerminalLog(response, route, {
      requestId,
      admissionStage: "pre_admission",
      startedAtMonotonicMs,
      delivery,
      onSettled,
      admissionWaitMs,
    }),
  };
};

/** Reserves kernel usage for a repository-scoped route; a refusal is returned as a response. */
const reserveKernelAdmission = async (
  input: Readonly<{
    req: Request;
    repo: Readonly<{ owner: string; repo: string }>;
    route: string;
    requestId: string;
    startedAtMonotonicMs: number;
    delivery?: RequestDeliveryInfo;
    usageReservation: ApiKeyUsageReservation | null;
    onSettled?: () => void;
    admissionWaitMs?: number | null;
  }>
): Promise<Readonly<{ reservation: KernelQuotaReservation } | { rejection: Response }>> => {
  const admission = await reserveEffectiveKernelUsageLimit(input.repo.owner, input.repo.repo, input.requestId, input.route);
  if (admission.ok) return { reservation: admission.reservation };
  try {
    await input.usageReservation?.release("kernel_quota_rejected");
  } catch (error) {
    warnQuotaAccountingFailure({ route: input.route, requestId: input.requestId }, error);
  }
  const response = withCorsHeaders(withRequestId(admission.response, input.requestId), input.req);
  const rejection = await withRejectionTerminalLog(response, input.route, {
    requestId: input.requestId,
    admissionStage: "pre_admission",
    startedAtMonotonicMs: input.startedAtMonotonicMs,
    delivery: input.delivery,
    onSettled: input.onSettled,
    admissionWaitMs: input.admissionWaitMs,
  });
  return { rejection };
};

/**
 * Persists the Sentinel replay capture for a thrown inference exception.
 * Snapshotting happens before any scheduling, exactly as the inline capture
 * did: a snapshot failure propagates instead of being swallowed as a capture
 * failure. Where the runtime registers background work, the deferred
 * persistence is handed to it so a slow or unavailable replay store cannot
 * delay the original inference error; without a registrar the task is awaited.
 */
export const persistInferenceExceptionReplay = async (
  sentinelReplayInput: AcceptedSentinelReplayInput,
  runError: unknown,
  options: Readonly<{
    /** Test seam for proving a stalled replay write does not delay the error. */
    persistSentinelReplay?: typeof persistSentinelReplayFromEnvironment;
    /** Test seam for the runtime background-task registrar. */
    waitUntil?: SentinelBackgroundTaskRegistrar;
  }> = {}
): Promise<void> => {
  const observation: SentinelFailureObservation = {
    status: 500,
    stream: null,
    completed: false,
    terminal_type: "error",
    failure_kind: runError instanceof Error ? runError.name : "unknown_exception",
    synthetic_terminal_type: null,
    provider_route: "gateway",
  };
  // Snapshot body and upstream recorder together before persistence:
  // the recorder is sealed and disposed here, and the same immutable
  // trace feeds HMAC and encryption.
  const replaySnapshot = snapshotSentinelReplayInput(sentinelReplayInput);
  // The snapshot owns the only remaining copy, so the request-owned original
  // is released before any persistence await or background handoff.
  zeroSentinelReplayInput(sentinelReplayInput);
  const persistence = (options.persistSentinelReplay ?? persistSentinelReplayFromEnvironment)(replaySnapshot, observation)
    .catch(() => {
      // Replay persistence is best effort and cannot replace the original
      // gateway exception or expose its request body in logs.
    })
    .then(() => {
      zeroSentinelReplayInput(replaySnapshot);
    });
  // Deferred where the runtime supports it: the task above already owns its
  // snapshot, so a stalled replay store never delays the propagated error.
  if (!scheduleSentinelBackgroundTask(persistence, options.waitUntil)) await persistence;
};

/**
 * Authenticates, admits, and dispatches one terminal inference request.  Every
 * response that leaves here already carries CORS headers, the request id, quota
 * decoration, and the terminal accounting handoff.
 */
const handleTerminalRoute = async (
  req: Request,
  path: string,
  delivery: RequestDeliveryInfo | undefined,
  requestId: string,
  requestStartedAtMs: number,
  requestStartedAtMonotonicMs: number
): Promise<Response> => {
  const withCors = (response: Response): Response => withCorsHeaders(response, req);
  const terminalRoute = terminalRouteForRequest(req.method, path);
  const authResult = await authenticateClient(req);
  if (!authResult.ok) {
    const response = withCors(withRequestId(authResult.response, requestId));
    return await withRejectionTerminalLog(response, terminalRoute, {
      requestId,
      admissionStage: "pre_admission",
      startedAtMonotonicMs: requestStartedAtMonotonicMs,
      delivery,
    });
  }
  // Authenticated state, not a client header or session id: a caller cannot
  // rename itself to escape the waiting turn its principal was served in.
  const idempotencyPrincipal = await resolveIdempotencyPrincipal(authResult);
  const callerSignal = delivery?.downstreamSignal ?? req.signal;
  let processPermit: Extract<InferenceAdmissionResult, { ok: true }> | null = null;
  let admissionWaitMs: number | null = null;
  /** Idempotent: the guard hands out one permit, and this clears it once. */
  const releaseProcessPermit = (): void => {
    const permit = processPermit;
    processPermit = null;
    permit?.release();
  };
  /** Releases the permit when a step after acquisition throws before dispatch. */
  const releaseOnThrow = async <T>(step: () => T | Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      releaseProcessPermit();
      throw error;
    }
  };
  const admissionRoute = terminalRoute !== null && ADMISSION_ROUTES.has(terminalRoute) ? terminalRoute : null;
  /**
   * Acquires the process-resource permit for an admitted route, or returns the
   * refusal response. A granted permit stays owned until the response settles.
   */
  const acquireProcessPermit = async (): Promise<Response | null> => {
    if (admissionRoute === null) return null;
    // Acquired after authentication and before any quota reservation, so a
    // queued request never holds an expiring API-key or kernel lease. The
    // caller's own signal and the guard's five-second bound conclude the wait.
    const admitted = await admissionController().acquire({ signal: callerSignal, principal: idempotencyPrincipal });
    if (admitted.ok) {
      processPermit = admitted;
      admissionWaitMs = admitted.waitedMs;
      return null;
    }
    // A queued caller that aborted never dispatches; a full queue or an
    // expired wait is this gateway's own bounded overload decision.
    const refusal =
      admitted.kind === "caller_aborted"
        ? openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error", param: null })
        : localOverloadResponse(admitted.cause);
    const response = withCors(withRequestId(refusal, requestId));
    return await withRejectionTerminalLog(response, admissionRoute, {
      requestId,
      admissionStage: "pre_admission",
      startedAtMonotonicMs: requestStartedAtMonotonicMs,
      delivery,
    });
  };
  const admissionRefusal = await acquireProcessPermit();
  if (admissionRefusal) return admissionRefusal;
  let usagePolicy = apiKeyPolicyFrom(authResult);
  let usageReservation: ApiKeyUsageReservation | null = null;
  // The request candidate is created as soon as the caller is authenticated,
  // before quota admission, so every authenticated return path can publish an
  // explicit capture status. An unauthenticated rejection creates nothing, so
  // its zero-KV behavior is preserved. Candidate creation is passive: it only
  // registers the one accepted-body observer, it never touches KV. A capture
  // that throws still returns this request's process permit before dispatch.
  const sentinelReplayCandidate = await releaseOnThrow(() => (terminalRoute ? captureAcceptedSentinelReplayInput(req, requestId) : null));
  let sentinelReplayOmission: SentinelReplayCaptureOmissionReason | null = null;
  /**
   * Publishes the explicit status for an authenticated request rejected before
   * capture setup. Best effort: the rejection response is already final.
   */
  const recordPreCaptureRejection = async (): Promise<void> => {
    discardSentinelReplayCaptureCandidate(sentinelReplayCandidate);
    sentinelReplayOmission ??= "rejected_before_capture";
    const omissionTask = recordSentinelReplayOmissionFromEnvironment(requestId, sentinelReplayOmission, Date.now());
    // Deferred where the runtime supports it so a diagnostic status write can
    // never extend the client-visible rejection latency.
    if (!scheduleSentinelBackgroundTask(omissionTask, undefined)) await omissionTask;
  };
  /** Reserves API-key usage for a policied terminal route, or returns the refusal. */
  const reserveUsageForRequest = async (): Promise<Response | null> => {
    if (usagePolicy === null || terminalRoute === null) return null;
    // Copied out of the mutable bindings so the narrowed policy and route
    // survive into the release-on-throw closure.
    const policy = usagePolicy;
    const route = terminalRoute;
    const admission = await releaseOnThrow(() =>
      reserveUsageAdmission(req, policy, requestId, route, requestStartedAtMonotonicMs, delivery, releaseProcessPermit, admissionWaitMs)
    );
    if ("rejection" in admission) {
      await recordPreCaptureRejection();
      return admission.rejection;
    }
    usageReservation = admission.reservation;
    // Admission re-reads the strict hash policy, so downstream quota headers
    // and paid fallback use the policy that actually reserved this request.
    usagePolicy = admission.reservation.policy;
    return null;
  };
  const usageRefusal = await reserveUsageForRequest();
  if (usageRefusal) return usageRefusal;
  /**
   * Reads the reservation through a call. `reserveUsageForRequest` assigns it,
   * and reading the binding directly would let control-flow analysis keep
   * treating it as its initial `null` here.
   */
  const currentUsageReservation = (): ApiKeyUsageReservation | null => usageReservation;
  /** Same closure-reader reason as `currentUsageReservation`, for the queue wait. */
  const currentAdmissionWaitMs = (): number | null => admissionWaitMs;
  const kernelRepo = await releaseOnThrow(() => resolveKernelRepo(req, authResult));
  const kernelOrg = kernelRepo ? { owner: kernelRepo.owner } : null;
  let kernelReservation: KernelQuotaReservation | null = null;
  const kernelQuotaRoute = kernelQuotaRouteForRequest(req.method, path);
  /** Reserves repository kernel quota for a scoped route, or returns the refusal. */
  const reserveKernelForRequest = async (): Promise<Response | null> => {
    if (kernelRepo === null || kernelQuotaRoute === null) return null;
    const admission = await releaseOnThrow(() =>
      reserveKernelAdmission({
        req,
        repo: kernelRepo,
        route: kernelQuotaRoute,
        requestId,
        startedAtMonotonicMs: requestStartedAtMonotonicMs,
        delivery,
        usageReservation,
        onSettled: releaseProcessPermit,
        admissionWaitMs,
      })
    );
    if ("rejection" in admission) {
      await recordPreCaptureRejection();
      return admission.rejection;
    }
    kernelReservation = admission.reservation;
    return null;
  };
  const kernelRefusal = await reserveKernelForRequest();
  if (kernelRefusal) return kernelRefusal;
  /** Same closure-reader reason as `currentUsageReservation`. */
  const currentKernelReservation = (): KernelQuotaReservation | null => kernelReservation;
  // One request-owned passive upstream recorder for accepted terminal
  // inference requests. It is created only after quota admission, is never
  // global, and is sealed/disposed at the application-terminal handoff.
  const sentinelUpstreamRecorder = terminalRoute ? createSentinelUpstreamRecorder() : null;
  const usageContext = {
    keyId: apiKeyIdFrom(authResult),
    kernelRepo,
    kernelOrg,
    paidFallbackEnabled: usagePolicy?.paid_fallback_enabled === true,
    idempotencyPrincipal,
    requestId,
    startedAtMs: requestStartedAtMs,
    startedAtMonotonicMs: requestStartedAtMonotonicMs,
    downstreamSignal: downstreamSignalFor(req, delivery, currentKernelReservation()),
    beforeProviderDispatch: currentUsageReservation()?.beforeProviderDispatch,
    ...(sentinelUpstreamRecorder ? { sentinelUpstreamRecorder } : {}),
  };
  if (terminalRoute) {
    console.info(
      "[ai.ubq.fi] request_accepted",
      JSON.stringify({
        request_id: requestId,
        route: terminalRoute,
        queue_wait_ms: currentAdmissionWaitMs() ?? 0,
        git_sha: runtimeGitSha(),
        deno_revision: runtimeDeploymentId(),
      })
    );
  }
  const takeSentinelReplayInput = (): AcceptedSentinelReplayInput | null => {
    const materialized = materializeSentinelReplayInput(sentinelReplayCandidate);
    // Read the omission after materializing: a body-less candidate with no
    // recorded reason is classified as `body_unavailable`, never silently
    // dropped. A non-POST terminal route has no body to carry at all.
    const omission = sentinelReplayCandidate?.body_omitted_reason ?? (sentinelReplayCandidate === null && terminalRoute !== null ? "non_post" : null);
    discardSentinelReplayCaptureCandidate(sentinelReplayCandidate);
    if (!materialized) {
      sentinelUpstreamRecorder?.dispose();
      if (omission !== null) sentinelReplayOmission ??= omission;
      return null;
    }
    return sentinelUpstreamRecorder ? { ...materialized, upstreamRecorder: sentinelUpstreamRecorder } : materialized;
  };
  const settleKernelQuota = async (outcome: "completed" | "incomplete", reason = "request_incomplete"): Promise<void> => {
    if (!kernelReservation) return;
    if (outcome === "completed") await kernelReservation.commit();
    else await kernelReservation.release(reason);
  };
  const bestEffortSettleKernelQuota = async (outcome: "completed" | "incomplete", reason = "request_incomplete"): Promise<void> => {
    try {
      await settleKernelQuota(outcome, reason);
    } catch (error) {
      warnQuotaAccountingFailure({ route: terminalRoute ?? "inference", requestId }, error);
    }
  };
  // A provider dispatch settles this reservation as committed; every validation,
  // cache, idempotency, queue, and synthetic-routing path is released. A release
  // failure answers with the quota error instead of the run result, so it stays
  // its own step beside the inference body.
  const releaseUsageReservation = async (runError: unknown): Promise<Response | null> => {
    try {
      await usageReservation?.release();
      return null;
    } catch (error) {
      await bestEffortSettleKernelQuota("incomplete", "api_key_quota_accounting_error");
      if (runError) {
        warnQuotaAccountingFailure({ route: terminalRoute ?? "inference", requestId }, runError);
      }
      const quotaError = error instanceof ApiKeyQuotaDispatchError ? error : new ApiKeyQuotaDispatchError("API key quota reservation is unavailable");
      return openaiError(quotaError.status, quotaError.message, quotaError.code, {
        type: quotaError.errorType,
        headers: quotaError.headers,
      });
    }
  };
  const finishTerminalResponse = async (response: Response, route: string, includeQuota = false, trackKernelTerminal = false): Promise<Response> => {
    const telemetry = getResponseTelemetry(response);
    const correlated = withProviderRequestId(response, telemetry?.providerRequestId ?? null);
    const decorated = includeQuota ? decorateInferenceQuota(correlated, usagePolicy, telemetry) : correlated;
    const sentinelReplayInput = takeSentinelReplayInput();
    try {
      return await withTerminalRequestLog(withCors(withRequestId(decorated, requestId)), {
        route,
        telemetryResponse: response,
        startedAtMonotonicMs: requestStartedAtMonotonicMs,
        requestStartedAtMs,
        requestId,
        admissionStage: "accepted",
        onTerminal: trackKernelTerminal ? settleKernelQuota : undefined,
        onSettled: releaseProcessPermit,
        deliveryCompleted: delivery?.completed,
        deliverySignal: delivery?.downstreamSignal,
        sentinelReplayInput,
        admissionWaitMs,
        sentinelReplayOmission,
      });
    } catch (error) {
      zeroSentinelReplayInput(sentinelReplayInput);
      disposeSentinelUpstreamRecorder(sentinelReplayInput);
      releaseProcessPermit();
      await bestEffortSettleKernelQuota("incomplete", "terminal_wrapper_error");
      throw error;
    }
  };
  const executeInference = async (run: () => Promise<Response>): Promise<Response> => {
    let response: Response | null = null;
    let runError: unknown = null;
    try {
      response = await run();
    } catch (error) {
      runError = error;
    }
    const quotaAccountingFailure = await releaseUsageReservation(runError);
    if (quotaAccountingFailure) return quotaAccountingFailure;
    if (runError instanceof ApiKeyQuotaDispatchError) {
      await bestEffortSettleKernelQuota("incomplete", "api_key_quota_dispatch_error");
      return openaiError(runError.status, runError.message, runError.code, {
        type: runError.errorType,
        headers: runError.headers,
      });
    }
    if (runError) {
      await bestEffortSettleKernelQuota("incomplete", "inference_exception");
      const sentinelReplayInput = takeSentinelReplayInput();
      if (sentinelReplayInput) {
        // Deferred where the runtime registers background work: the task owns
        // its snapshot, so optional replay storage never delays this error.
        await persistInferenceExceptionReplay(sentinelReplayInput, runError);
      } else if (sentinelReplayOmission !== null) {
        // A thrown inference failure with no captured body still publishes its
        // explicit omission status instead of an empty replay history.
        const omissionTask = recordSentinelReplayOmissionFromEnvironment(requestId, sentinelReplayOmission, Date.now());
        // Same deferral as the pre-capture rejection path: a diagnostic status
        // write never extends the propagated inference error latency.
        if (!scheduleSentinelBackgroundTask(omissionTask, undefined)) await omissionTask;
      }
      // `only-throw-error` requires an Error: an Error run failure is rethrown
      // unchanged, and any other value is preserved as the cause.
      throw runError instanceof Error ? runError : new Error("Inference handler threw a non-Error value", { cause: runError });
    }
    if (!response) {
      await bestEffortSettleKernelQuota("incomplete", "missing_inference_response");
      throw new Error("Inference handler completed without a response");
    }
    return response;
  };
  const runModelsRoute = async (): Promise<Response> => withCors(await handleModels(req));
  const runEmbeddingsRoute = async (): Promise<Response> => {
    const response = await executeInference(() => handleUosEmbeddings(req, usageContext));
    if (response.ok && response.headers.get("x-uos-idempotency-replayed") !== "true") {
      await bestEffortSettleKernelQuota("completed");
    } else {
      await bestEffortSettleKernelQuota(
        "incomplete",
        response.headers.get("x-uos-idempotency-replayed") === "true" ? "idempotency_replay" : "embedding_failed"
      );
    }
    return await finishTerminalResponse(response, "embeddings");
  };
  const runEmbeddingJobCreateRoute = async (): Promise<Response> => {
    const response = await executeInference(() => handleEmbeddingsJobCreate(req, authResult.token, usageContext));
    if (response.ok) {
      await bestEffortSettleKernelQuota("completed");
    } else {
      await bestEffortSettleKernelQuota("incomplete", "embedding_job_create_failed");
    }
    return await finishTerminalResponse(response, "embeddings.jobs.create");
  };
  const runEmbeddingJobGetRoute = async (): Promise<Response> => {
    const jobId = path.slice("/uos/embedding-jobs/".length).trim();
    if (!jobId) {
      await bestEffortSettleKernelQuota("incomplete", "missing_embedding_job_id");
      return await finishTerminalResponse(openaiError(404, "Not found", "not_found"), "embeddings.jobs.get");
    }
    const response = await executeInference(() => handleEmbeddingsJobGet(req, authResult.token, jobId, usageContext));
    await bestEffortSettleKernelQuota("incomplete", "embedding_job_read_not_counted");
    return await finishTerminalResponse(response, "embeddings.jobs.get");
  };
  const runImagesRoute = async (): Promise<Response> => {
    const kind = path === "/v1/images/edits" ? "edits" : "generations";
    const response = await executeInference(() => handleImages(req, kind, usageContext));
    return await finishTerminalResponse(response, `images.${kind}`, true, true);
  };
  const runChatCompletionsRoute = async (): Promise<Response> => {
    const response = await executeInference(() => handleChatCompletions(req, usageContext));
    return await finishTerminalResponse(response, "chat.completions", true, true);
  };
  const runResponsesRoute = async (): Promise<Response> => {
    // Header-marked Codex compaction is answered locally by Jev; the body is
    // read only for a recognized request. When Jev cannot serve the session
    // (for example a decision state that stays over its cap after every
    // reduction stage, or a decision failure), fall through to the ordinary
    // provider route so the client still receives a compaction instead of a
    // 502. Both attempts share one inference lifetime: settling a failed local
    // compaction first would release the reservation needed by every fallback
    // provider before any of them can dispatch.
    const response = await executeInference(async () => {
      if (isJevCompactionRequest(req)) {
        const compactionSignal = usageContext.downstreamSignal ?? callerSignal;
        const compaction = await handleJevResponsesCompaction(req.clone(), { signal: compactionSignal });
        if (compaction.ok || compactionSignal.aborted) return compaction;
        await compaction.body?.cancel();
        console.warn("[ai.ubq.fi] jev_compaction_fallback", JSON.stringify({ status: compaction.status }));
      }
      return await handleResponses(req, usageContext);
    });
    return await finishTerminalResponse(response, "responses", true, true);
  };
  const runSystemOneRoute = async (): Promise<Response> => {
    const response = await executeInference(() => handleSystemOne(req, usageContext));
    if (response.ok) {
      await bestEffortSettleKernelQuota("completed");
    } else {
      await bestEffortSettleKernelQuota("incomplete", "systemone_failed");
    }
    return await finishTerminalResponse(response, "systemone", true, true);
  };
  // Terminal routes in wire order. The conditions are pure, so the first match
  // owns the response exactly as the original if/else chain did.
  const dispatchTerminalRoute = async (): Promise<Response> => {
    const terminalRoutes: readonly (readonly [boolean, () => Promise<Response>])[] = [
      [req.method === "GET" && path === "/v1/models", runModelsRoute],
      [req.method === "POST" && path === "/uos/embeddings", runEmbeddingsRoute],
      [req.method === "POST" && path === "/uos/embedding-jobs", runEmbeddingJobCreateRoute],
      [req.method === "GET" && path.startsWith("/uos/embedding-jobs/"), runEmbeddingJobGetRoute],
      [req.method === "POST" && (path === "/v1/images/generations" || path === "/v1/images/edits"), runImagesRoute],
      [req.method === "POST" && path === "/v1/chat/completions", runChatCompletionsRoute],
      [req.method === "POST" && path === "/v1/responses", runResponsesRoute],
      [req.method === "POST" && path === "/v1/systemone", runSystemOneRoute],
    ];
    for (const [matches, run] of terminalRoutes) {
      if (matches) return await run();
    }
    const response = openaiError(404, "Not found", "not_found");
    return withCors(req.method === "HEAD" ? withoutBody(response) : response);
  };
  /**
   * Refuses a request whose caller left while admission waited or quota/setup
   * ran. The permit returns through the terminal wrapper, an acquired API-key
   * reservation is released, and an acquired kernel reservation is settled as
   * released so it stops renewing; a request that never dispatched is not
   * charged.
   */
  const refuseAbortedBeforeDispatch = async (): Promise<Response | null> => {
    if (processPermit === null || !callerSignal.aborted) return null;
    // No provider dispatch happened, so settle exactly the pre-dispatch
    // resources `executeInference` settles: releasing the API-key reservation
    // is idempotent (a deferred reservation releases nothing), and releasing an
    // acquired kernel reservation is the existing no-dispatch settlement that
    // stops its lease renewal. A settlement fault cannot replace the 499.
    const abortReason = "caller_aborted_before_dispatch";
    try {
      await usageReservation?.release(abortReason);
    } catch (error) {
      warnQuotaAccountingFailure({ route: terminalRoute ?? "inference", requestId }, error);
    }
    await bestEffortSettleKernelQuota("incomplete", abortReason);
    const refusal = openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error", param: null });
    const response = withCors(withRequestId(refusal, requestId));
    return await withRejectionTerminalLog(response, terminalRoute, {
      requestId,
      admissionStage: "accepted",
      startedAtMonotonicMs: requestStartedAtMonotonicMs,
      delivery,
      onSettled: releaseProcessPermit,
      admissionWaitMs,
    });
  };
  const abortedRefusal = await refuseAbortedBeforeDispatch();
  if (abortedRefusal) return abortedRefusal;
  return await releaseOnThrow(dispatchTerminalRoute);
};

export { handleTerminalRoute };

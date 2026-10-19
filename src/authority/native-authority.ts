import { apiKeyHashKey, API_KEY_NO_EXPIRATION_MS, API_KEY_NO_USAGE_LIMIT } from "../api-keys.ts";
import { kernelScopedPolicyKey } from "./native-kernel.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
} from "./native-codex-contracts.ts";
import { classifyCodex429 } from "./native-codex-429.ts";
import * as paid from "./native-paid.ts";
import {
  NativeAuthorityError,
  nativeObject,
  type NativeAuthorityInitial,
  type NativeArguments,
  type NativeCapability,
  type NativeCommand,
  type NativeCodexAuthorization,
  type NativeReply,
  type NativeRequest,
  type NativeRows,
  type NativeSqlStorage,
} from "./native-authority-contracts.ts";
import { NativeAuthoritySql } from "./native-authority-sql.ts";
import { NativeAuthorityApi } from "./native-authority-api.ts";
import { NativeAuthorityKernel } from "./native-authority-kernel.ts";
import { NativeAuthorityCodex } from "./native-authority-codex.ts";
import { NativeAuthorityPaid } from "./native-authority-paid.ts";
import { NativeAuthorityRuntime } from "./native-authority-runtime.ts";
import type {
  NativeRetainedHistoryBinding,
  NativeRuntimeInitial,
  NativeRuntimeBinding,
  NativeRuntimeAuthorization,
  NativeTrustedRoutingDecision,
} from "./native-runtime-contracts.ts";
import type { NativeBoundRuntimePort } from "./native-authority-rpc.ts";
import { NativeAuthorityPrincipals } from "./native-authority-principals.ts";
import type { NativeControlBinding, NativeControlCommand, NativeControlReply, NativePrincipalControlInitial } from "./native-principal-contracts.ts";
import { NATIVE_METHOD_ROLES, nativeCommandBytes, parseNativeCommand } from "./native-authority-rpc.ts";

/** All families share this single injected SQLite transaction domain. Provider and credential I/O stay outside it. */
export class NativeAuthority {
  private readonly _sql: NativeAuthoritySql;
  private readonly _api: NativeAuthorityApi;
  private readonly _kernel: NativeAuthorityKernel;
  private readonly _codex: NativeAuthorityCodex;
  private readonly _paid: NativeAuthorityPaid;
  private readonly _principals: NativeAuthorityPrincipals | null;
  private readonly _runtime: NativeAuthorityRuntime | null;
  constructor(
    storage: NativeSqlStorage,
    initial: NativeAuthorityInitial,
    private readonly _clock: () => number = Date.now,
    control?: NativePrincipalControlInitial,
    runtime?: NativeRuntimeInitial
  ) {
    if (initial.kernelConstants.noUsageLimit !== API_KEY_NO_USAGE_LIMIT || initial.kernelConstants.noExpirationMs !== API_KEY_NO_EXPIRATION_MS)
      throw new NativeAuthorityError("native_constants_mismatch", 500);
    this._sql = new NativeAuthoritySql(storage, initial.namespace, initial.epoch);
    this._api = new NativeAuthorityApi(this._sql);
    this._kernel = new NativeAuthorityKernel(this._sql, this._api, initial);
    this._codex = new NativeAuthorityCodex(this._sql, this._api);
    this._paid = new NativeAuthorityPaid(this._sql, this._api);
    this._runtime = runtime ? new NativeAuthorityRuntime(this._sql, this._api, runtime) : null;
    this._principals = control ? new NativeAuthorityPrincipals(this._sql, this._api, this._paid, control, _clock) : null;
    this._sql.initialize(() => {
      this._sql.write("authority_config", ["config"], { providerHops: structuredClone(initial.providerHops) });
      this._sql.write("kernel_default", ["default", "kernel_policy_limit_requests"], initial.kernelDefaults.limit);
      this._sql.write("kernel_default", ["default", "kernel_policy_window_ms"], initial.kernelDefaults.windowMs);
      for (const key of initial.keys) this._sql.write("api_policy", apiKeyHashKey(key.api.token_hash), key);
      for (const policy of initial.kernelPolicies) this._sql.write("kernel_policy", kernelScopedPolicyKey(policy.scope, policy.owner, policy.repo), policy);
      this._sql.write("codex_pool", CODEX_AUTH_POOL_KV_KEY, initial.pool);
      if (initial.routing) this._sql.write("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, initial.routing);
      if (initial.active) this._sql.write("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, initial.active);
      this._sql.write("codex_capacity", CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, initial.capacity);
      for (const owner of initial.owners) this._sql.write("codex_owner", [owner.routingAccountIdHash], owner);
      for (const proof of initial.resetProofs) this._sql.write("codex_reset", [proof.id], proof);
      this._principals?.initialize();
      this._runtime?.initialize();
    });
  }
  async control(binding: NativeControlBinding, command: NativeControlCommand): Promise<NativeControlReply> {
    if (!this._principals) throw new NativeAuthorityError("principal_control_unavailable", 503);
    return await this._principals.control(binding, command);
  }
  bindAuthenticatedRuntime(binding: NativeRuntimeBinding): NativeBoundRuntimePort {
    if (!this._runtime) throw new NativeAuthorityError("native_runtime_unavailable", 503);
    if (
      !nativeObject(binding) ||
      Object.keys(binding).length !== 3 ||
      typeof binding.grantId !== "string" ||
      typeof binding.contextBinding !== "string" ||
      !Object.hasOwn(binding, "privateContext")
    )
      throw new NativeAuthorityError("invalid_private_runtime_binding", 403);
    const privateBinding = Object.freeze({ ...binding });
    return {
      execute: (command) => this._execute(privateBinding, command),
      bindTrustedRoutingDecision: (handle, operationId) => this._bindTrustedRoutingDecision(privateBinding, handle, operationId),
    };
  }
  bindRetainedHistory(binding: unknown): Readonly<{ execute(command: NativeCommand): Promise<NativeReply> }> {
    if (
      !nativeObject(binding) ||
      Object.keys(binding).length !== 4 ||
      binding.kind !== "retained_history" ||
      typeof binding.grantId !== "string" ||
      typeof binding.contextBinding !== "string" ||
      !Object.hasOwn(binding, "privateContext")
    )
      throw new NativeAuthorityError("invalid_retained_history_binding", 403);
    const privateBinding: NativeRetainedHistoryBinding = Object.freeze({
      kind: "retained_history",
      grantId: binding.grantId,
      contextBinding: binding.contextBinding,
      privateContext: binding.privateContext,
    });
    return { execute: (command) => this._executeRetained(privateBinding, command) };
  }
  private async _executeRetained(binding: NativeRetainedHistoryBinding, input: NativeCommand): Promise<NativeReply> {
    const runtime = this._runtime;
    if (!runtime) throw new NativeAuthorityError("retained_history_unavailable", 503);
    const command = parseNativeCommand(input);
    const canonical = nativeCommandBytes(command);
    const verified = await runtime.verifyRetained(binding, canonical, this._clock());
    return this._sql.transaction(() => {
      const now = this._clock();
      const cap = runtime.authorizeRetained(binding, verified, command, now);
      if (!cap.roles.includes(NATIVE_METHOD_ROLES[command.method])) throw new NativeAuthorityError("authority_capability_denied", 403);
      const scope = nativeCommandBytes({ ...verified, intentDigest: null });
      const key = [this._sql.epoch, "retained-history", binding.grantId, cap.id, command.operationId];
      const prior = this._sql.read("operation_receipt", key, now).value;
      if (prior) {
        if (prior.command !== canonical || prior.retainedScope !== scope) throw new NativeAuthorityError("retained_operation_replay_conflict");
        return structuredClone(prior.reply);
      }
      let reply: NativeReply;
      switch (command.method) {
        case "releaseApiUndispatched":
          reply = this._api.release(cap, command.args, now);
          break;
        case "releasePaidBeforeFetch":
          reply = this._paid.release(cap, command.args.attemptHandle, now);
          break;
        case "recordPaidAttemptLifecycle":
          reply = this._paid.lifecycle(cap, command.args, now);
          break;
        case "recordVerifiedPaidBilling":
          reply = this._paid.billing(cap, command.args, now);
          break;
        case "deferPaidReconciliation":
          reply = this._paid.defer(cap, command.args.attemptHandle, now);
          break;
        case "claimPaidReconciliation":
          reply = this._paid.claim(cap, command.args, now);
          break;
        case "finishPaidReconciliation":
          reply = this._paid.finish(cap, command.args.lease, now);
          break;
        default:
          throw new NativeAuthorityError("retained_operation_denied", 403);
      }
      this._sql.write("operation_receipt", key, { command: canonical, reply, retainedScope: scope }, null, { scope: cap.keyId ?? cap.id });
      return structuredClone(reply);
    });
  }
  private _authorize(auth: NativeRuntimeAuthorization, command: NativeCommand, now: number): NativeCapability {
    this._sql.assertEpoch();
    if (command.epoch !== this._sql.epoch) throw new NativeAuthorityError("authority_epoch_mismatch", 403);
    if (!this._runtime) throw new NativeAuthorityError("native_runtime_unavailable", 503);
    const cap = this._runtime.authorize(auth, now);
    if (!cap.roles.includes(NATIVE_METHOD_ROLES[command.method])) throw new NativeAuthorityError("authority_capability_denied", 403);
    if (["bindValidatedRequestMetadata", "reserveKernelUsage", "selectCodexAccount", "electCodexResetProbe", "refreshCodexAdmission"].includes(command.method))
      this._runtime.assertCurrentApi(cap, now);
    if ("handle" in command.args) this._api.request(cap, command.args.handle, now);
    if ("attemptHandle" in command.args && command.args.attemptHandle !== undefined) this._paid.attempt(cap, command.args.attemptHandle, now);
    return cap;
  }
  private async _bindTrustedRoutingDecision(binding: NativeRuntimeBinding, handle: string, operationId: string): Promise<NativeReply> {
    const runtime = this._runtime;
    if (!runtime) throw new NativeAuthorityError("native_runtime_unavailable", 503);
    const intent = nativeCommandBytes({ revision: 3, method: "privateRouting", handle, operationId, epoch: this._sql.epoch });
    const auth = await runtime.verify(binding, intent, this._clock());
    const request = this._sql.transaction(() => this._api.validated(runtime.authorize(auth, this._clock()), handle, this._clock()));
    const decision = await runtime.routing(binding, request, intent, this._clock());
    return this._sql.transaction(() => {
      const now = this._clock(),
        cap = runtime.authorize(auth, now);
      if (!cap.roles.includes("inference")) throw new NativeAuthorityError("authority_capability_denied", 403);
      const current = this._api.validated(cap, handle, now);
      const key = [this._sql.epoch, cap.principalId, cap.id, "private-routing", operationId];
      const prior = this._sql.read("operation_receipt", key, now).value;
      if (prior && prior.command !== intent) throw new NativeAuthorityError("authority_operation_replay_conflict");
      const reply = runtime.bindRouting(cap, current, decision, now);
      if (prior) return structuredClone(prior.reply);
      this._sql.write("operation_receipt", key, { command: intent, reply }, null, { scope: cap.keyId ?? cap.principalId });
      return reply;
    });
  }
  private _requestForDispatch(cap: NativeCapability, handle: string, provider: string, now: number): NativeRequest {
    const request = this._api.validated(cap, handle, now);
    this._runtime?.assertCurrentApi(cap, now);
    if (!request.routingDecision) throw new NativeAuthorityError("trusted_routing_missing");
    if (!request.routingDecision.providers.includes(provider as NativeArguments["markApiDispatch"]["provider"]))
      throw new NativeAuthorityError("request_provider_not_authorized", 403);
    if (provider === "chatgpt_codex") this._codex.fence(cap, handle, now);
    return request;
  }
  private _terminalUsage(
    request: NativeRequest,
    provider: string | null,
    observations: NonNullable<NativeArguments["recordSemanticTerminal"]["usage"]>,
    now: number
  ): void {
    if (request.model === null) throw new NativeAuthorityError("validated_metadata_missing");
    const input = {
      ...observations,
      model: request.model,
      provider,
      request_id: request.requestId,
      request_created_at_ms: request.createdAtMs,
    };
    const usage = paid.paidFallbackTerminalUsageV3(input);
    if (usage) {
      const row = paid.paidFallbackTerminalRollupV3(input, usage, request.requestId, now),
        key = paid.paidFallbackUsageRollupKey(row.bucket_start_at_ms, row.model, row.provider, paid.paidFallbackUsageRollupShard(request.requestId)),
        prior = this._sql.read("paid_rollup", key, now).value;
      this._sql.write("paid_rollup", key, paid.mergePaidFallbackUsageRollup(paid.isPaidFallbackUsageRollup(prior) ? prior : null, row), null);
    }
  }
  private _observation(
    cap: NativeCapability,
    command: Extract<NativeCommand, { method: "recordSemanticTerminal" | "recordDeliveryObservation" }>,
    now: number
  ): NativeReply {
    const request = this._api.request(cap, command.args.handle, now);
    if (command.method === "recordDeliveryObservation") {
      if (request.delivery !== null)
        return { kind: request.delivery === command.args.observation ? "unchanged" : "observation_conflict", detail: request.delivery };
      this._api.save({ ...request, delivery: command.args.observation });
      return { kind: "recorded" };
    }
    if (request.semantic !== null) return { kind: request.semantic === command.args.outcome ? "unchanged" : "terminal_mismatch", detail: request.semantic };
    const responding = command.args.attemptHandle ? this._paid.response(cap, command.args.attemptHandle, now) : null;
    if (responding && responding.attempt.requestHandle !== request.handle) throw new NativeAuthorityError("terminal_attempt_mismatch", 403);
    const responseOwner = responding ? { provider: responding.provider, attemptHandle: responding.attempt.handle } : (request.responding ?? null);
    this._api.save({ ...request, semantic: command.args.outcome, responding: responseOwner });
    if (command.args.usage) this._terminalUsage(request, responseOwner?.provider ?? null, command.args.usage, now);
    return { kind: "recorded" };
  }
  private _status(cap: NativeCapability, args: Extract<NativeCommand, { method: "readRequestStatus" }>["args"], now: number): NativeReply {
    const request = this._api.request(cap, args.handle, now);
    let after = "";
    if (args.cursor) {
      const cursor = this._sql.read("cursor", [args.cursor], now).value;
      if (cursor?.capabilityId !== cap.id || cursor.family !== "request_attempts" || cursor.parent !== request.handle)
        throw new NativeAuthorityError("cursor_ownership_mismatch", 403);
      after = cursor.after;
    }
    const page = this._sql.page("attempt_lifetime", now, after, args.limit, { parent: request.handle });
    let cursor: string | null = null;
    if (page.length === args.limit) {
      cursor = crypto.randomUUID();
      this._sql.write("cursor", [cursor], {
        id: cursor,
        capabilityId: cap.id,
        family: "request_attempts",
        parent: request.handle,
        after: page[page.length - 1].encoded,
        lease: null,
      });
    }
    const attempts = page.map((entry) => {
      const attempt = entry.row.value;
      if (!attempt) throw new NativeAuthorityError("attempt_malformed", 503);
      return {
        attemptHandle: attempt.handle,
        hopId: attempt.hopId,
        row: this._sql.read("paid_request", paid.paidFallbackRequestV3Key(attempt.keyId, attempt.billingRequestId), now).value,
      };
    });
    const status = this._api.status(cap, request.handle, now);
    return {
      kind: "status",
      handle: request.handle,
      cursor,
      detail: {
        lifetime: { requestId: request.requestId, route: request.route, model: request.model, semantic: request.semantic, delivery: request.delivery },
        api: status.detail,
        attempts,
      },
    };
  }
  private _validateReceipt(cap: NativeCapability, command: NativeCommand, receipt: NativeRows["operation_receipt"], canonical: string, now: number): void {
    if (receipt.command !== canonical) throw new NativeAuthorityError("authority_operation_replay_conflict");
    if (["openAuthenticatedRequest", "reserveApiUsage", "reservePaidAttempt", "bindValidatedRequestMetadata"].includes(command.method))
      this._runtime?.assertCurrentApi(cap, now);
    if (command.method === "markApiDispatch" && receipt.reply.kind === "dispatched") this._api.assertDispatchReceipt(cap, command.args.handle, now);
    if (command.method === "refreshCodexAdmission" && receipt.reply.kind === "current") {
      if (!receipt.codexAuthorization) throw new NativeAuthorityError("cached_codex_authorization_missing");
      this._codex.fence(cap, command.args.handle, now, receipt.codexAuthorization);
    }
    if (command.method === "recordTransportStarted") {
      this._requestForDispatch(cap, command.args.handle, command.args.provider, now);
      this._paid.assertStart(cap, command.args, now);
      if (receipt.reply.kind === "started") this._api.assertTransportReceipt(cap, command.args.handle, command.operationId, now);
      else this._api.assertDispatchReceipt(cap, command.args.handle, now);
    }
  }
  private async _execute(binding: NativeRuntimeBinding, input: NativeCommand): Promise<NativeReply> {
    const command = parseNativeCommand(input),
      observedAt = this._clock();
    const runtime = this._runtime;
    if (!runtime) throw new NativeAuthorityError("native_runtime_unavailable", 503);
    const canonical = nativeCommandBytes(command);
    const auth = await runtime.verify(binding, canonical, observedAt);
    this._sql.transaction(() => this._authorize(auth, command, observedAt));
    let routing: NativeTrustedRoutingDecision | null = null;
    if (
      ["selectCodexAccount", "reservePaidAttempt", "markApiDispatch", "recordTransportStarted", "refreshCodexAdmission"].includes(command.method) &&
      "handle" in command.args
    ) {
      const handle = command.args.handle;
      const request = this._sql.transaction(() => this._api.validated(this._authorize(auth, command, this._clock()), handle, this._clock()));
      routing = await runtime.routing(binding, request, canonical, this._clock());
    }
    // Classification consumes the actual bounded response outside the synchronous storage transaction.
    const parsed =
      command.method === "recordCodexAttemptSignal" && command.args.signal === "quota" && command.args.response
        ? await classifyCodex429(
            new Response(command.args.response.body, {
              status: command.args.response.status,
              headers: command.args.response.headers.map(([key, value]): [string, string] => [key, value]),
            }),
            observedAt
          )
        : null;
    return this._sql.transaction(() => {
      const now = this._clock(),
        cap = this._authorize(auth, command, now);
      if (routing && "handle" in command.args) runtime.assertRouting(cap, this._api.validated(cap, command.args.handle, now), routing, now);
      // Current dispatch/owner/epoch checks precede receipt lookup; a lost reply cannot revive revoked authority.
      if (command.method === "markApiDispatch") this._requestForDispatch(cap, command.args.handle, command.args.provider, now);
      const key = [this._sql.epoch, cap.principalId, cap.id, command.operationId] as const,
        receipt = this._sql.read("operation_receipt", key, now).value;
      if (receipt) {
        this._validateReceipt(cap, command, receipt, canonical, now);
        return structuredClone(receipt.reply);
      }
      let reply: NativeReply;
      switch (command.method) {
        case "openAuthenticatedRequest":
          reply = runtime.open(cap, command.args, now);
          break;
        case "bindValidatedRequestMetadata":
          reply = runtime.metadata(cap, command.args, now);
          break;
        case "reserveApiUsage":
          reply = this._api.reserve(cap, command.args, now);
          break;
        case "recordTransportStarted":
          this._requestForDispatch(cap, command.args.handle, command.args.provider, now);
          this._paid.start(cap, command.args, now);
          reply = this._api.start(cap, command.args, command.operationId, now);
          break;
        case "markApiDispatch":
          reply = this._api.dispatch(cap, command.args, now);
          break;
        case "releaseApiUndispatched":
          reply = this._api.release(cap, command.args, now);
          break;
        case "recordApiDispatchCancellation":
          reply = this._api.cancel(cap, command.args.handle, now);
          break;
        case "reserveKernelUsage":
          reply = this._kernel.reserve(cap, command.args.handle, now);
          break;
        case "recordKernelTerminalIntent":
          reply = this._kernel.intent(cap, command.args, now);
          break;
        case "settleKernelUsage":
          reply = this._kernel.settle(cap, command.args, now);
          break;
        case "renewKernelReservation":
          reply = this._kernel.renew(cap, command.args.handle, now);
          break;
        case "reclaimExpiredKernelReservations":
          reply = this._kernel.reclaim(cap, command.args, now);
          break;
        case "setKernelQuota":
        case "deleteKernelQuota":
          reply = this._kernel.policy(cap, command.args, now);
          break;
        case "acquireKernelDefaultCutover":
          reply = this._kernel.cutover(now);
          break;
        case "selectCodexAccount":
          if (this._api.validated(cap, command.args.handle, now).routingDecision?.codex !== "eligible")
            throw new NativeAuthorityError("request_codex_not_authorized", 403);
          reply = this._codex.select(cap, command.args.handle, now);
          break;
        case "recordCodexAttemptSignal":
          reply = this._codex.signal(cap, command.args, parsed, now);
          break;
        case "releaseCodexProbe":
          reply = this._codex.release(cap, command.args.handle, now);
          break;
        case "electCodexResetProbe":
          reply = this._codex.elect(cap, command.args, now);
          break;
        case "refreshCodexAdmission":
          reply = this._codex.refresh(cap, command.args.handle, now);
          break;
        case "reservePaidAttempt":
          reply = this._paid.reserve(cap, command.args, now);
          break;
        case "recordPaidAttemptLifecycle":
          reply = this._paid.lifecycle(cap, command.args, now);
          break;
        case "releasePaidBeforeFetch":
          reply = this._paid.release(cap, command.args.attemptHandle, now);
          break;
        case "recordVerifiedPaidBilling":
          reply = this._paid.billing(cap, command.args, now);
          break;
        case "deferPaidReconciliation":
          reply = this._paid.defer(cap, command.args.attemptHandle, now);
          break;
        case "claimPaidReconciliation":
          reply = this._paid.claim(cap, command.args, now);
          break;
        case "finishPaidReconciliation":
          reply = this._paid.finish(cap, command.args.lease, now);
          break;
        case "foldPaidBackfillPage":
          reply = this._paid.backfill(cap, command.args, now);
          break;
        case "beginPaidKeyDeletion":
          reply = this._paid.deletion(cap, now);
          break;
        case "recordSemanticTerminal":
        case "recordDeliveryObservation":
          reply = this._observation(cap, command, now);
          break;
        case "readRequestStatus":
          reply = this._status(cap, command.args, now);
          break;
        default:
          throw new NativeAuthorityError("invalid_authority_operation", 400);
      }
      const committed = JSON.parse(JSON.stringify(reply)) as NativeReply;
      let codexAuthorization: NativeCodexAuthorization | undefined;
      if (command.method === "refreshCodexAdmission" && committed.kind === "current")
        codexAuthorization = this._codex.authorization(cap, command.args.handle, now);
      this._sql.write("operation_receipt", key, { command: canonical, reply: committed, ...(codexAuthorization ? { codexAuthorization } : {}) }, null, {
        scope: cap.keyId ?? cap.principalId,
      });
      return structuredClone(committed);
    });
  }
}

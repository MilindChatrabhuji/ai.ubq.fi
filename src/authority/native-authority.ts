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
  type NativeAuthorityInitial,
  type NativeCapability,
  type NativeCommand,
  type NativeReply,
  type NativeRequest,
  type NativeSqlStorage,
} from "./native-authority-contracts.ts";
import { NativeAuthoritySql } from "./native-authority-sql.ts";
import { NativeAuthorityApi } from "./native-authority-api.ts";
import { NativeAuthorityKernel } from "./native-authority-kernel.ts";
import { NativeAuthorityCodex } from "./native-authority-codex.ts";
import { NativeAuthorityPaid } from "./native-authority-paid.ts";
import { NATIVE_METHOD_ROLES, nativeCommandBytes, parseNativeCommand } from "./native-authority-rpc.ts";

/** All families share this single injected SQLite transaction domain. Provider and credential I/O stay outside it. */
export class NativeAuthority {
  private readonly _sql: NativeAuthoritySql;
  private readonly _api: NativeAuthorityApi;
  private readonly _kernel: NativeAuthorityKernel;
  private readonly _codex: NativeAuthorityCodex;
  private readonly _paid: NativeAuthorityPaid;
  constructor(
    storage: NativeSqlStorage,
    initial: NativeAuthorityInitial,
    private readonly _clock: () => number = Date.now
  ) {
    if (initial.kernelConstants.noUsageLimit !== API_KEY_NO_USAGE_LIMIT || initial.kernelConstants.noExpirationMs !== API_KEY_NO_EXPIRATION_MS)
      throw new NativeAuthorityError("native_constants_mismatch", 500);
    this._sql = new NativeAuthoritySql(storage, initial.namespace, initial.epoch);
    this._sql.initialize(() => {
      this._sql.write("authority_config", ["config"], { providerHops: structuredClone(initial.providerHops) });
      this._sql.write("kernel_default", ["default", "kernel_policy_limit_requests"], initial.kernelDefaults.limit);
      this._sql.write("kernel_default", ["default", "kernel_policy_window_ms"], initial.kernelDefaults.windowMs);
      for (const capability of initial.capabilities) {
        if (
          capability.epoch !== initial.epoch ||
          !initial.keys.some((key) => key.api.key_id === capability.keyId && key.api.token_hash === capability.tokenHash)
        )
          throw new NativeAuthorityError("invalid_initial_capability", 500);
        this._sql.write("capability", [capability.id], capability);
      }
      for (const key of initial.keys) this._sql.write("api_policy", apiKeyHashKey(key.api.token_hash), key);
      for (const policy of initial.kernelPolicies) this._sql.write("kernel_policy", kernelScopedPolicyKey(policy.scope, policy.owner, policy.repo), policy);
      this._sql.write("codex_pool", CODEX_AUTH_POOL_KV_KEY, initial.pool);
      if (initial.routing) this._sql.write("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, initial.routing);
      if (initial.active) this._sql.write("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, initial.active);
      this._sql.write("codex_capacity", CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, initial.capacity);
      for (const owner of initial.owners) this._sql.write("codex_owner", [owner.routingAccountIdHash], owner);
      for (const proof of initial.resetProofs) this._sql.write("codex_reset", [proof.id], proof);
    });
    this._api = new NativeAuthorityApi(this._sql);
    this._kernel = new NativeAuthorityKernel(this._sql, this._api, initial);
    this._codex = new NativeAuthorityCodex(this._sql, this._api);
    this._paid = new NativeAuthorityPaid(this._sql, this._api);
  }
  private _authorize(capabilityId: string, command: NativeCommand, now: number): NativeCapability {
    this._sql.assertEpoch();
    if (command.epoch !== this._sql.epoch) throw new NativeAuthorityError("authority_epoch_mismatch", 403);
    const cap = this._sql.capability(capabilityId, now);
    if (!cap.roles.includes(NATIVE_METHOD_ROLES[command.method])) throw new NativeAuthorityError("authority_capability_denied", 403);
    if ("handle" in command.args) this._api.request(cap, command.args.handle, now);
    if ("attemptHandle" in command.args) this._paid.attempt(cap, command.args.attemptHandle, now);
    return cap;
  }
  private _requestForDispatch(cap: NativeCapability, handle: string, now: number): NativeRequest {
    const request = this._api.request(cap, handle, now),
      policy = this._sql.read("api_policy", apiKeyHashKey(cap.tokenHash), now).value;
    if (!policy || policy.revoked || policy.api.key_id !== cap.keyId || (policy.api.expires_at_ms !== -1 && policy.api.expires_at_ms <= now))
      throw new NativeAuthorityError("api_policy_revoked", 403);
    if (request.codex) this._codex.fence(cap, handle, now);
    return request;
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
    this._api.save({ ...request, semantic: command.args.outcome });
    if (command.args.usage) {
      const input = {
        ...command.args.usage,
        model: request.model,
        provider: request.dispatch?.provider ?? null,
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
  async execute(capabilityId: string, input: NativeCommand): Promise<NativeReply> {
    const command = parseNativeCommand(input),
      observedAt = this._clock();
    this._sql.transaction(() => this._authorize(capabilityId, command, observedAt));
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
    const canonical = nativeCommandBytes(command);
    return this._sql.transaction(() => {
      const now = this._clock(),
        cap = this._authorize(capabilityId, command, now);
      // Current dispatch/owner/epoch checks precede receipt lookup; a lost reply cannot revive revoked authority.
      if (command.method === "markApiDispatch") this._requestForDispatch(cap, command.args.handle, now);
      const key = [this._sql.epoch, cap.principalId, cap.id, command.operationId] as const,
        receipt = this._sql.read("operation_receipt", key, now).value;
      if (receipt) {
        if (receipt.command !== canonical) throw new NativeAuthorityError("authority_operation_replay_conflict");
        if (command.method === "refreshCodexAdmission") this._codex.fence(cap, command.args.handle, now);
        return structuredClone(receipt.reply);
      }
      let reply: NativeReply;
      switch (command.method) {
        case "reserveApiUsage":
          reply = this._api.reserve(cap, command.args, now);
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
      this._sql.write("operation_receipt", key, { command: canonical, reply: committed }, null, { scope: cap.keyId });
      return structuredClone(committed);
    });
  }
}

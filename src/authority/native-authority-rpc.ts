import { API_KEY_USAGE_PROVIDERS } from "./native-api-key.ts";
import {
  NativeAuthorityError,
  nativeObject,
  type NativeArguments,
  type NativeCommand,
  type NativeMethod,
  type NativeReply,
  type NativeRole,
} from "./native-authority-contracts.ts";

type Guard = (value: unknown) => boolean;
const text: Guard = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 1000 && Array.from(value).every((character) => character.charCodeAt(0) >= 32);
const integer: Guard = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite: Guard = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const boolean: Guard = (value) => typeof value === "boolean";
const oneOf =
  (...values: readonly unknown[]): Guard =>
  (value) =>
    values.includes(value);
const nullable =
  (guard: Guard): Guard =>
  (value) =>
    value === null || guard(value);
const optional =
  (guard: Guard): Guard =>
  (value) =>
    value === undefined || guard(value);
const shape =
  (fields: Readonly<Record<string, Guard>>): Guard =>
  (value) =>
    nativeObject(value) && Object.keys(value).every((key) => Object.hasOwn(fields, key)) && Object.entries(fields).every(([key, guard]) => guard(value[key]));
const handle = { handle: text };
const attempt = { attemptHandle: text };
const page = { cursor: optional(text), limit: (value: unknown) => integer(value) && Number(value) >= 1 && Number(value) <= 100 };
const terminal = oneOf("committed", "released");
const scope = oneOf("repo", "org");
const signedInteger: Guard = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= -1;
const usage = shape({ input_tokens: nullable(integer), cached_input_tokens: nullable(integer), output_tokens: nullable(integer) });
const headerPair: Guard = (value) => Array.isArray(value) && value.length === 2 && text(value[0]) && typeof value[1] === "string" && value[1].length <= 4000;
const response = shape({
  status: oneOf(429),
  headers: (value) => Array.isArray(value) && value.length <= 64 && value.every(headerPair),
  body: (value) => typeof value === "string" && value.length <= 48_000,
});
const GUARDS: Readonly<Record<NativeMethod, Guard>> = {
  reserveApiUsage: shape({ requestId: text, route: text, model: text, stream: boolean, reasoning: optional(nullable(text)) }),
  markApiDispatch: shape({ ...handle, provider: oneOf(...API_KEY_USAGE_PROVIDERS) }),
  releaseApiUndispatched: shape({ ...handle, reason: text }),
  recordApiDispatchCancellation: shape(handle),
  reserveKernelUsage: shape(handle),
  recordKernelTerminalIntent: shape({ ...handle, terminalState: terminal }),
  settleKernelUsage: shape({ ...handle, terminalState: terminal, reason: text }),
  renewKernelReservation: shape(handle),
  reclaimExpiredKernelReservations: shape(page),
  setKernelQuota: shape({
    scope,
    usageLimitRequests: signedInteger,
    options: shape({ resetUsage: optional(boolean), windowMs: optional((value) => integer(value) && Number(value) > 0), expiresAtMs: optional(signedInteger) }),
  }),
  deleteKernelQuota: shape({ scope }),
  acquireKernelDefaultCutover: shape({}),
  selectCodexAccount: shape(handle),
  recordCodexAttemptSignal: shape({
    ...handle,
    signal: oneOf("success", "credential_invalid", "upstream_timeout", "quota"),
    response: optional(response),
    recoveryProbe: optional(boolean),
  }),
  releaseCodexProbe: shape(handle),
  electCodexResetProbe: shape({ ...handle, proofId: text }),
  refreshCodexAdmission: shape(handle),
  reservePaidAttempt: shape({ ...handle, hopId: text }),
  recordPaidAttemptLifecycle: shape({
    ...attempt,
    patch: shape({
      provider_request_id: optional(nullable(text)),
      dispatch_state: optional(oneOf("reserved", "dispatched", "not_dispatched")),
      terminal_state: optional(oneOf("pending", "completed", "incomplete", "failed", "cancelled")),
    }),
    fetchStarted: optional(oneOf(true)),
  }),
  releasePaidBeforeFetch: shape(attempt),
  recordVerifiedPaidBilling: shape({
    ...attempt,
    log: shape({
      request_id: text,
      quota: finite,
      prompt_tokens: integer,
      cached_prompt_tokens: optional(integer),
      cache_write_prompt_tokens: optional(integer),
      completion_tokens: integer,
      model: text,
      created_at: finite,
    }),
    surplusBuyerCostMicro: optional(integer),
  }),
  deferPaidReconciliation: shape(attempt),
  claimPaidReconciliation: shape(page),
  finishPaidReconciliation: shape({ lease: text }),
  foldPaidBackfillPage: shape(page),
  beginPaidKeyDeletion: shape({}),
  recordSemanticTerminal: shape({ ...handle, outcome: oneOf("completed", "incomplete", "failed", "cancelled"), usage: optional(usage) }),
  recordDeliveryObservation: shape({ ...handle, observation: oneOf("delivered", "interrupted", "unobserved") }),
  readRequestStatus: shape({ ...handle, ...page }),
};
export const NATIVE_METHOD_ROLES: Readonly<Record<NativeMethod, NativeRole>> = {
  reserveApiUsage: "inference",
  markApiDispatch: "transport",
  releaseApiUndispatched: "transport",
  recordApiDispatchCancellation: "transport",
  reserveKernelUsage: "inference",
  recordKernelTerminalIntent: "terminal",
  settleKernelUsage: "terminal",
  renewKernelReservation: "terminal",
  reclaimExpiredKernelReservations: "reconcile",
  setKernelQuota: "quota_admin",
  deleteKernelQuota: "quota_admin",
  acquireKernelDefaultCutover: "quota_admin",
  selectCodexAccount: "inference",
  recordCodexAttemptSignal: "transport",
  releaseCodexProbe: "transport",
  electCodexResetProbe: "reset",
  refreshCodexAdmission: "transport",
  reservePaidAttempt: "inference",
  recordPaidAttemptLifecycle: "transport",
  releasePaidBeforeFetch: "transport",
  recordVerifiedPaidBilling: "billing",
  deferPaidReconciliation: "reconcile",
  claimPaidReconciliation: "reconcile",
  finishPaidReconciliation: "reconcile",
  foldPaidBackfillPage: "reconcile",
  beginPaidKeyDeletion: "quota_admin",
  recordSemanticTerminal: "terminal",
  recordDeliveryObservation: "transport",
  readRequestStatus: "observer",
};

/** Stable bytes are receipts, not native snapshots or client-selected mutation plans. */
export const nativeCommandBytes = (value: unknown): string => {
  const canonical = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(canonical);
    if (nativeObject(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort((left, right) => left.localeCompare(right))
          .map((key) => [key, canonical(item[key])])
      );
    throw new NativeAuthorityError("invalid_command_value", 400);
  };
  return JSON.stringify(canonical(value));
};
export const parseNativeCommand = (value: unknown): NativeCommand => {
  if (
    !nativeObject(value) ||
    Object.keys(value).length !== 4 ||
    !text(value.epoch) ||
    !text(value.operationId) ||
    typeof value.method !== "string" ||
    !Object.hasOwn(GUARDS, value.method)
  )
    throw new NativeAuthorityError("invalid_authority_operation", 400);
  if (!Object.keys(value).every((key) => ["epoch", "operationId", "method", "args"].includes(key)) || !GUARDS[value.method as NativeMethod](value.args))
    throw new NativeAuthorityError("invalid_authority_arguments", 400);
  if (new TextEncoder().encode(nativeCommandBytes(value)).byteLength > 65_536) throw new NativeAuthorityError("authority_command_too_large", 413);
  return value as NativeCommand;
};
export type NativeOperationRunner = Readonly<{ execute(capabilityId: string, command: NativeCommand): Promise<NativeReply> }>;
export type NativeRpcResult = Readonly<{ result: NativeReply }> | Readonly<{ error: Readonly<{ code: string; status: number }> }>;
export type NativeRpcTransport = Readonly<{ execute(command: unknown): Promise<NativeRpcResult> }>;
export class NativeAuthorityRpcServer implements NativeRpcTransport {
  constructor(
    private readonly _authority: NativeOperationRunner,
    private readonly _capabilityId: string
  ) {}
  async execute(command: unknown): Promise<NativeRpcResult> {
    try {
      return { result: await this._authority.execute(this._capabilityId, parseNativeCommand(command)) };
    } catch (error) {
      if (error instanceof NativeAuthorityError) return { error: { code: error.code, status: error.status } };
      throw error;
    }
  }
}
/** The same semantic client is used over an actual Worker binding or the Bun HTTP fixture transport. */
export class NativeAuthorityClient {
  constructor(
    private readonly _transport: NativeRpcTransport,
    private readonly _epoch: string
  ) {}
  async call<TMethod extends NativeMethod>(method: TMethod, args: NativeArguments[TMethod], operationId: string = crypto.randomUUID()): Promise<NativeReply> {
    const command = parseNativeCommand({ epoch: this._epoch, operationId, method, args });
    const reply = await this._transport.execute(command);
    if ("error" in reply) throw new NativeAuthorityError(reply.error.code, reply.error.status);
    if (!nativeObject(reply.result) || typeof reply.result.kind !== "string") throw new NativeAuthorityError("invalid_authority_reply", 503);
    return reply.result;
  }
}

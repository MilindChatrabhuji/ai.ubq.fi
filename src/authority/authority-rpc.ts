import type { PortableAuthority } from "./admission-state.ts";
import {
  AuthorityError,
  type AdmissionHandle,
  type AdmitInput,
  type AttemptInput,
  type AccountProof,
  type DeliveryOutcome,
  type TerminalEvidence,
} from "./contracts.ts";

/** Public operations only. Storage, policy, publication and seed capabilities stay server-owned. */
export type AuthorityOperations = Pick<PortableAuthority, keyof PortableAuthority>;
type Operation = keyof AuthorityOperations;
export type AuthorityCommand = { [TMethod in Operation]: { operation: TMethod; arguments: Parameters<AuthorityOperations[TMethod]> } }[Operation];
type Result = Awaited<ReturnType<AuthorityOperations[Operation]>>;
export type AuthorityReply<TValue = Result> = { value: TValue } | { error: { code: string; status: number } };
export type AuthorityRpc = {
  invoke<TCommand extends AuthorityCommand>(command: TCommand): Promise<AuthorityReply<Awaited<ReturnType<AuthorityOperations[TCommand["operation"]]>>>>;
};
type Guard = (value: unknown) => boolean;
const text: Guard = (value) => typeof value === "string";
const providerRequestId: Guard = (value) => typeof value === "string" && value.trim().length > 0;
const integer: Guard = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const boolean: Guard = (value) => typeof value === "boolean";
const oneOf =
  (...values: unknown[]): Guard =>
  (value) =>
    values.includes(value);
const nullable =
  (guard: Guard): Guard =>
  (value) =>
    value === null || guard(value);
const array =
  (guard: Guard): Guard =>
  (value) =>
    Array.isArray(value) && value.every(guard);
const fields =
  (shape: Readonly<Record<string, Guard>>): Guard =>
  (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
      Object.keys(record).length === Object.keys(shape).length &&
      Object.entries(shape).every(([key, guard]) => Object.hasOwn(record, key) && guard(record[key]))
    );
  };
const tuple =
  (...guards: Guard[]): Guard =>
  (value) =>
    Array.isArray(value) && value.length === guards.length && guards.every((guard, index) => guard(value[index]));
const scope = fields({ namespace: text, epoch: integer });
const handle = fields({ scope, requestId: text, fence: integer });
const proof = fields({
  kind: oneOf("quota_exhausted", "credential_invalid", "transient"),
  model: text,
  fingerprint: text,
  observedAtMs: integer,
  validUntilMs: integer,
});
const account = fields({
  accountId: text,
  fingerprint: text,
  credentialGeneration: integer,
  routingGeneration: integer,
  resetGeneration: integer,
  overageVersion: integer,
  overageEnabled: boolean,
  enabled: boolean,
  models: array(text),
  proof: nullable(proof),
});
const attempt = fields({ attemptId: text, provider: oneOf("codex", "surplus", "openlux"), maximumExposureMicrocredits: integer, account: nullable(account) });
const terminal = fields({
  outcome: oneOf("completed", "incomplete", "failed", "cancelled"),
  providerRequestId: nullable(text),
  spendMicrocredits: nullable(integer),
  fallback: oneOf(null, "quota_exhausted", "capacity_exhausted"),
});
const ARGUMENTS: Readonly<Record<Operation, Guard>> = {
  admit: tuple(
    fields({
      scope,
      requestId: text,
      principalId: text,
      policyVersion: integer,
      digest: text,
      route: oneOf("/v1/responses", "/v1/chat/completions"),
      model: text,
      nowMs: integer,
    })
  ),
  reserveAttempt: tuple(handle, attempt, integer),
  beginDispatch: tuple(handle, text, integer),
  selection: tuple(handle),
  reselectSubscription: tuple(handle, integer),
  confirmDispatched: tuple(handle, text),
  releaseBeforeDispatch: tuple(handle, text),
  observeProof: tuple(handle, text, proof),
  observeTerminal: (value) => tuple(handle, text, terminal)(value) || tuple(handle, text, terminal, (flag) => flag === undefined || boolean(flag))(value),
  observeDelivery: tuple(handle, oneOf("delivered", "interrupted", "unobserved")),
  observeUsage: tuple(handle, text, fields({ providerRequestId, spendMicrocredits: integer })),
  resetEligible: tuple(handle, integer),
  settle: tuple(handle),
  cancelUndispatched: tuple(handle),
};
const isCommand = (value: unknown): value is AuthorityCommand => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  return (
    Object.keys(command).length === 2 &&
    typeof command.operation === "string" &&
    Object.hasOwn(ARGUMENTS, command.operation) &&
    Object.hasOwn(command, "arguments") &&
    ARGUMENTS[command.operation as Operation](command.arguments)
  );
};

/** This is a constructor capability, not a public HTTP endpoint or generic proxy. */
export class AuthorityRpcServer implements AuthorityRpc {
  constructor(
    private readonly _authority: AuthorityOperations,
    private readonly _maximumCommandBytes: number
  ) {
    if (!Number.isSafeInteger(_maximumCommandBytes) || _maximumCommandBytes < 1) throw new AuthorityError("invalid_authority_command_bound", 400);
  }

  async invoke<TCommand extends AuthorityCommand>(command: TCommand): Promise<AuthorityReply<Awaited<ReturnType<AuthorityOperations[TCommand["operation"]]>>>>;
  async invoke(command: unknown): Promise<AuthorityReply> {
    try {
      if (!isCommand(command)) throw new AuthorityError("invalid_authority_operation", 400);
      if (new TextEncoder().encode(JSON.stringify(command)).byteLength > this._maximumCommandBytes)
        throw new AuthorityError("authority_command_too_large", 413);
      return { value: await this._execute(command) };
    } catch (error) {
      return { error: error instanceof AuthorityError ? { code: error.code, status: error.status } : { code: "authority_unavailable", status: 503 } };
    }
  }

  private async _execute(command: AuthorityCommand): Promise<Result> {
    switch (command.operation) {
      case "admit":
        return await this._authority.admit(...command.arguments);
      case "reserveAttempt":
        await this._authority.reserveAttempt(...command.arguments);
        return;
      case "beginDispatch":
        return await this._authority.beginDispatch(...command.arguments);
      case "selection":
        return await this._authority.selection(...command.arguments);
      case "reselectSubscription":
        return await this._authority.reselectSubscription(...command.arguments);
      case "confirmDispatched":
        await this._authority.confirmDispatched(...command.arguments);
        return;
      case "releaseBeforeDispatch":
        await this._authority.releaseBeforeDispatch(...command.arguments);
        return;
      case "observeProof":
        await this._authority.observeProof(...command.arguments);
        return;
      case "observeTerminal":
        await this._authority.observeTerminal(...command.arguments);
        return;
      case "observeDelivery":
        await this._authority.observeDelivery(...command.arguments);
        return;
      case "observeUsage":
        await this._authority.observeUsage(...command.arguments);
        return;
      case "resetEligible":
        return await this._authority.resetEligible(...command.arguments);
      case "settle":
        return await this._authority.settle(...command.arguments);
      case "cancelUndispatched":
        await this._authority.cancelUndispatched(...command.arguments);
        return;
      default:
        throw new AuthorityError("invalid_authority_operation", 400);
    }
  }
}

const unwrap = <TValue>(reply: AuthorityReply<TValue>): TValue => {
  if ("error" in reply) throw new AuthorityError(reply.error.code, reply.error.status);
  return reply.value;
};

export class AuthorityRpcClient implements AuthorityOperations {
  constructor(private readonly _rpc: AuthorityRpc) {}
  async admit(input: AdmitInput) {
    return unwrap(await this._rpc.invoke({ operation: "admit", arguments: [input] }));
  }
  async reserveAttempt(handle: AdmissionHandle, input: AttemptInput, nowMs: number) {
    unwrap(await this._rpc.invoke({ operation: "reserveAttempt", arguments: [handle, input, nowMs] }));
  }
  async beginDispatch(handle: AdmissionHandle, attemptId: string, nowMs: number) {
    return unwrap(await this._rpc.invoke({ operation: "beginDispatch", arguments: [handle, attemptId, nowMs] }));
  }
  async selection(handle: AdmissionHandle) {
    return unwrap(await this._rpc.invoke({ operation: "selection", arguments: [handle] }));
  }
  async reselectSubscription(handle: AdmissionHandle, nowMs: number) {
    return unwrap(await this._rpc.invoke({ operation: "reselectSubscription", arguments: [handle, nowMs] }));
  }
  async confirmDispatched(handle: AdmissionHandle, attemptId: string) {
    unwrap(await this._rpc.invoke({ operation: "confirmDispatched", arguments: [handle, attemptId] }));
  }
  async releaseBeforeDispatch(handle: AdmissionHandle, attemptId: string) {
    unwrap(await this._rpc.invoke({ operation: "releaseBeforeDispatch", arguments: [handle, attemptId] }));
  }
  async observeProof(handle: AdmissionHandle, attemptId: string, proof: AccountProof) {
    unwrap(await this._rpc.invoke({ operation: "observeProof", arguments: [handle, attemptId, proof] }));
  }
  async observeTerminal(handle: AdmissionHandle, attemptId: string, evidence: TerminalEvidence, finalAttempt = true) {
    unwrap(await this._rpc.invoke({ operation: "observeTerminal", arguments: [handle, attemptId, evidence, finalAttempt] }));
  }
  async observeDelivery(handle: AdmissionHandle, outcome: DeliveryOutcome) {
    unwrap(await this._rpc.invoke({ operation: "observeDelivery", arguments: [handle, outcome] }));
  }
  async observeUsage(handle: AdmissionHandle, attemptId: string, usage: { providerRequestId: string; spendMicrocredits: number }) {
    unwrap(await this._rpc.invoke({ operation: "observeUsage", arguments: [handle, attemptId, usage] }));
  }
  async resetEligible(handle: AdmissionHandle, nowMs: number) {
    return unwrap(await this._rpc.invoke({ operation: "resetEligible", arguments: [handle, nowMs] }));
  }
  async settle(handle: AdmissionHandle) {
    return unwrap(await this._rpc.invoke({ operation: "settle", arguments: [handle] }));
  }
  async cancelUndispatched(handle: AdmissionHandle) {
    unwrap(await this._rpc.invoke({ operation: "cancelUndispatched", arguments: [handle] }));
  }
}

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
const ARGUMENT_COUNTS: Readonly<Record<Operation, readonly number[]>> = {
  admit: [1],
  reserveAttempt: [3],
  beginDispatch: [3],
  selection: [1],
  reselectSubscription: [2],
  confirmDispatched: [2],
  releaseBeforeDispatch: [2],
  observeProof: [3],
  observeTerminal: [3, 4],
  observeDelivery: [2],
  observeUsage: [3],
  resetEligible: [2],
  settle: [1],
  cancelUndispatched: [1],
};
const isCommand = (value: unknown): value is AuthorityCommand => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  return (
    Object.keys(command).length === 2 &&
    typeof command.operation === "string" &&
    Object.hasOwn(ARGUMENT_COUNTS, command.operation) &&
    Array.isArray(command.arguments) &&
    ARGUMENT_COUNTS[command.operation as Operation].includes(command.arguments.length)
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

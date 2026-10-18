import type { PortableAuthority } from "./admission-state.ts";
import type { AdmissionHandle, DeliveryOutcome, TerminalEvidence } from "./contracts.ts";

/** Durable observations are individually replayable after a lost response/acknowledgment. */
export class DeliveryOutbox {
  constructor(
    private readonly _authority: PortableAuthority,
    private readonly _handle: AdmissionHandle
  ) {}

  async terminal(attemptId: string, evidence: TerminalEvidence, finalAttempt = true): Promise<void> {
    await this._authority.observeTerminal(this._handle, attemptId, evidence, finalAttempt);
    await this._authority.settle(this._handle);
  }

  async delivery(outcome: DeliveryOutcome): Promise<void> {
    await this._authority.observeDelivery(this._handle, outcome);
    await this._authority.settle(this._handle);
  }
}

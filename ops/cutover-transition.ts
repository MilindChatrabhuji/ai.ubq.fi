export type CutoverPhase =
  | "prepared"
  | "stopping"
  | "stopped"
  | "converted"
  | "starting"
  | "candidate_ready"
  | "accepted"
  | "recovering"
  | "legacy_starting"
  | "rolled_back"
  | "recovery_unproved";
export type CutoverTransition = {
  record: (phase: CutoverPhase) => Promise<void>;
  preflight: () => Promise<void>;
  stop: () => Promise<void>;
  preserve: () => Promise<void>;
  convert: () => Promise<void>;
  start: () => Promise<void>;
  verify: () => Promise<void>;
  recover: (startupAttempted: boolean) => Promise<void>;
};

/** Only the artifact-bound operator supplies real effects; this state machine grants no source authority. */
export async function executeCutoverTransition(effects: CutoverTransition, signal?: AbortSignal): Promise<CutoverPhase> {
  let stopping = false,
    startupAttempted = false;
  const record = async (phase: CutoverPhase) => {
    signal?.throwIfAborted();
    await effects.record(phase);
  };
  await record("prepared");
  try {
    await effects.preflight();
    await record("stopping");
    stopping = true;
    await effects.stop();
    await effects.preserve();
    await record("stopped");
    await effects.convert();
    await record("converted");
    await record("starting");
    // Persist before the first possible start. Even a rejected start may have executed application code.
    startupAttempted = true;
    await effects.start();
    await record("candidate_ready");
    await effects.verify();
    await record("accepted");
    return "accepted";
  } catch {
    if (!stopping) throw new Error("Cutover refused before service interruption");
    // Recovery deliberately ignores the cancellation signal that triggered it.
    await effects.record("recovering");
    try {
      await effects.recover(startupAttempted);
      await effects.record("rolled_back");
      return "rolled_back";
    } catch {
      await effects.record("recovery_unproved");
      throw new Error("Cutover recovery could not prove latest state; retained copies and service identity require reconciliation");
    }
  }
}

// Native Codex 429 I/O and CAS orchestration over the source-owned portable decisions.

import { classifyCodex429, nonBlockingQuotaProbeSlot, quotaBlockedSlot, type Codex429Classification } from "../authority/native-codex-429.ts";
import { nativeCodexAccountMetadata, type RoutingAccount } from "./routing-state.ts";
import { updateRoutingState, withSlot } from "./capacity-routing.ts";

export { type Codex429Classification, type CodexKnownProbeLease } from "../authority/native-codex-429.ts";

export const readCodex429 = (response: Response, now = Date.now()): Promise<Codex429Classification> => classifyCodex429(response, now);

const releaseNonBlockingQuotaProbe = async (account: RoutingAccount): Promise<void> => {
  if (account.probeGeneration === null || !account.probeToken) return;
  await updateRoutingState((state) => {
    const slot = nonBlockingQuotaProbeSlot(state, nativeCodexAccountMetadata(account));
    return slot === null ? null : withSlot(state, account.slot, slot);
  });
};

export const markCodexQuotaBlockedWithMode = async (
  account: RoutingAccount,
  response: Response,
  now = Date.now(),
  recoveryProbe = false
): Promise<Codex429Classification> => {
  const parsed = await readCodex429(response, now);
  if (!parsed.usageLimitReached || parsed.retryAtMs === null || parsed.quotaBlockSource === null) {
    await releaseNonBlockingQuotaProbe(account);
  } else {
    await updateRoutingState((state) => {
      const slot = quotaBlockedSlot(state, nativeCodexAccountMetadata(account), parsed, now, recoveryProbe);
      return slot === null ? null : withSlot(state, account.slot, slot);
    });
  }
  return parsed;
};

export const markCodexQuotaBlocked = async (account: RoutingAccount, response: Response, now = Date.now()): Promise<Codex429Classification> =>
  await markCodexQuotaBlockedWithMode(account, response, now, false);

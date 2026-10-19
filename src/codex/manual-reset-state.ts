import { isRecord } from "../utils.ts";
import type { KvKey } from "#kv";

/** Retained without TTL: an uncertain consume and a completed promotion must never become spendable by expiry. */
export const CODEX_MANUAL_RESET_PREFIX = ["uos_ai", "codex_manual_reset", "v1"] as const;
export const intentKey = (accountIdHash: string): KvKey => [...CODEX_MANUAL_RESET_PREFIX, accountIdHash];
export type ManualIntent = Readonly<{
  v: 1;
  account_id_hash: string;
  credential_version: string;
  quota_reset_at_ms: number;
  routing_generation: number;
  created_at_ms: number;
  promoted_at_ms: number | null;
  quota_signal_at_ms: number | null;
}>;
export const parseManualResetIntent = (value: unknown): ManualIntent | null => {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    Object.keys(value).length !== 8 ||
    typeof value.account_id_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.account_id_hash) ||
    typeof value.credential_version !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.credential_version)
  )
    return null;
  for (const key of ["quota_reset_at_ms", "routing_generation", "created_at_ms"] as const)
    if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0) return null;
  for (const key of ["promoted_at_ms", "quota_signal_at_ms"] as const)
    if (value[key] !== null && (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  if (typeof value.promoted_at_ms === "number" && typeof value.created_at_ms === "number" && value.promoted_at_ms < value.created_at_ms) return null;
  return value as ManualIntent;
};

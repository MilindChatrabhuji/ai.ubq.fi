// Codex 429 classification and quota-block transitions, split out of src/codex_account_routing.ts.

import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { getString, isRecord } from "../utils.ts";
import {
  CODEX_HALF_OPEN_LEASE_MS,
  type CodexAccountRoutingState,
  type CodexProbeCircuit,
  type CodexQuotaBlockSource,
  type CodexQuotaClass,
  type CodexQuotaClassBlock,
  type CodexRoutingSlot,
  type RoutingAccount,
} from "./routing-state.ts";
import {
  parseFinitePercent,
  probeLeaseMatchesRoutingAccount,
  quotaBlockForClass,
  quotaBlocksIncludingLegacy,
  quotaClass,
  releaseQuotaClassProbe,
  routingProbeCircuit,
  slotFor,
  slotMatchesRoutingAccount,
  updateRoutingState,
  withSlot,
} from "./capacity-routing.ts";

const IMF_FIXDATE_PATTERN = /^([A-Za-z]{3}), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/;
const IMF_FIXDATE_WEEKDAYS: ReadonlySet<string> = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
const IMF_FIXDATE_MONTHS: ReadonlySet<string> = new Set(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);

const isImfFixdate = (value: string): boolean => {
  const match = IMF_FIXDATE_PATTERN.exec(value);
  return match !== null && IMF_FIXDATE_WEEKDAYS.has(match[1]) && IMF_FIXDATE_MONTHS.has(match[3]);
};

type RetryAfterDeadline = Readonly<{
  deadlineMs: number;
  /** A delta timeout is useful for routing, but not a durable reset identity. */
  isStable: boolean;
}>;

export const futureRetryAfterDeadline = (headers: Headers, now: number): RetryAfterDeadline | null => {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    const deltaMs = seconds * 1_000;
    const deadline = now + deltaMs;
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(deltaMs) && Number.isSafeInteger(deadline) && deadline > now
      ? { deadlineMs: deadline, isStable: false }
      : null;
  }
  if (!isImfFixdate(value)) return null;
  const deadline = Date.parse(value);
  return Number.isSafeInteger(deadline) && deadline > now && new Date(deadline).toUTCString() === value ? { deadlineMs: deadline, isStable: true } : null;
};

export type Codex429Classification = Readonly<{
  response: Response;
  usageLimitReached: boolean;
  retryAtMs: number | null;
  quotaBlockSource: CodexQuotaBlockSource | null;
  /** Whether `retryAtMs` is a canonical absolute deadline (not a provider generation by itself). */
  resetDeadlineIsStable: boolean;
  /** Conflicting deadline signals permanently fence this observation from redemption. */
  resetDeadlineConflict: boolean;
}>;

type JsonObjectKeyScanResult = "valid" | "invalid" | "duplicate";

/**
 * JSON.parse intentionally accepts repeated object keys and keeps only the
 * last one. A quota decision cannot rely on that ambiguous interpretation, so
 * scan the complete JSON grammar first and reject any repeated key.
 */
const hasDuplicateJsonObjectKeys = (source: string): boolean => {
  let index = 0;
  const skipWhitespace = (): void => {
    while (index < source.length && /[\t\n\r ]/.test(source[index])) index += 1;
  };
  const parseString = (): string | null => {
    if (source[index] !== '"') return null;
    const start = index;
    index += 1;
    while (index < source.length) {
      const code = source.charCodeAt(index);
      if (code <= 0x1f) return null;
      if (code === 0x5c) {
        index += 2;
        continue;
      }
      index += 1;
      if (code !== 0x22) continue;
      try {
        const value: unknown = JSON.parse(source.slice(start, index));
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    }
    return null;
  };
  const parseLiteral = (literal: string): boolean => {
    if (!source.startsWith(literal, index)) return false;
    index += literal.length;
    return true;
  };
  const parseNumber = (): boolean => {
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(index));
    if (!match) return false;
    index += match[0].length;
    return true;
  };
  function parseValue(): JsonObjectKeyScanResult {
    skipWhitespace();
    switch (source[index]) {
      case "{":
        return parseObject();
      case "[":
        return parseArray();
      case '"':
        return parseString() === null ? "invalid" : "valid";
      case "t":
        return parseLiteral("true") ? "valid" : "invalid";
      case "f":
        return parseLiteral("false") ? "valid" : "invalid";
      case "n":
        return parseLiteral("null") ? "valid" : "invalid";
      default:
        return parseNumber() ? "valid" : "invalid";
    }
  }
  function parseArray(): JsonObjectKeyScanResult {
    index += 1;
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return "valid";
    }
    while (index < source.length) {
      const value = parseValue();
      if (value !== "valid") return value;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return "valid";
      }
      if (source[index] !== ",") return "invalid";
      index += 1;
    }
    return "invalid";
  }
  function parseObject(): JsonObjectKeyScanResult {
    index += 1;
    skipWhitespace();
    if (source[index] === "}") {
      index += 1;
      return "valid";
    }
    const keys = new Set<string>();
    while (index < source.length) {
      const key = parseString();
      if (key === null) return "invalid";
      if (keys.has(key)) return "duplicate";
      keys.add(key);
      skipWhitespace();
      if (source[index] !== ":") return "invalid";
      index += 1;
      const value = parseValue();
      if (value !== "valid") return value;
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return "valid";
      }
      if (source[index] !== ",") return "invalid";
      index += 1;
      skipWhitespace();
    }
    return "invalid";
  }

  return parseValue() === "duplicate";
};

type Codex429BodyClassification = Readonly<{
  usageLimitReached: boolean;
  bodyResetAtMs: number | null;
}>;

/**
 * Classify a bounded 429 body. An incomplete read, a malformed byte sequence or
 * JSON.parse's last-key-wins behavior must never turn an ambiguous upstream
 * body into a durable reset signal, so all three mean "no signal".
 */
const classifyCodex429Body = (bytes: Uint8Array, complete: boolean, now: number): Codex429BodyClassification => {
  const noSignal: Codex429BodyClassification = { usageLimitReached: false, bodyResetAtMs: null };
  if (!complete) return noSignal;
  try {
    const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (hasDuplicateJsonObjectKeys(bodyText)) return noSignal;
    const body = JSON.parse(bodyText);
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    const usageLimitReached = getString(error?.type) === "usage_limit_reached";
    const resetsAtSeconds = error?.resets_at;
    if (!usageLimitReached || typeof resetsAtSeconds !== "number" || !Number.isSafeInteger(resetsAtSeconds) || resetsAtSeconds < 0) {
      // A valid UTF-8, unambiguous, fully parsed OpenAI error is required
      // before routing can persist a block.
      return { usageLimitReached, bodyResetAtMs: null };
    }
    const deadlineMs = resetsAtSeconds * 1_000;
    return { usageLimitReached, bodyResetAtMs: Number.isSafeInteger(deadlineMs) && deadlineMs > now ? deadlineMs : null };
  } catch {
    // A valid UTF-8, unambiguous, fully parsed OpenAI error is required
    // before routing can persist a block.
    return noSignal;
  }
};

type Codex429RetryDeadlines = Readonly<{
  retryAtMs: number | null;
  quotaBlockSource: CodexQuotaBlockSource | null;
  resetDeadlineIsStable: boolean;
  resetDeadlineConflict: boolean;
}>;

const resolveQuotaBlockSource = (bodyResetAtMs: number | null, retryAfter: RetryAfterDeadline | null): CodexQuotaBlockSource | null => {
  if (bodyResetAtMs !== null) return "body_resets_at";
  return retryAfter === null ? null : "header_retry_after";
};

const resolveCodex429RetryDeadlines = (bodyResetAtMs: number | null, retryAfter: RetryAfterDeadline | null): Codex429RetryDeadlines => {
  const absoluteHeaderConflict = bodyResetAtMs !== null && retryAfter?.isStable === true && retryAfter.deadlineMs !== bodyResetAtMs;
  const relativeHeaderExtendsPastBody = bodyResetAtMs !== null && retryAfter?.isStable === false && retryAfter.deadlineMs > bodyResetAtMs;
  const resetDeadlineConflict = absoluteHeaderConflict || relativeHeaderExtendsPastBody;
  return {
    retryAtMs: resolveResetDeadlineMs(bodyResetAtMs, retryAfter, resetDeadlineConflict),
    quotaBlockSource: resolveQuotaBlockSource(bodyResetAtMs, retryAfter),
    resetDeadlineIsStable: bodyResetAtMs !== null ? !resetDeadlineConflict : retryAfter?.isStable === true,
    resetDeadlineConflict,
  };
};

/** The OpenAI-compatible replacement body for a truncated or oversized 429. */
const truncatedCodex429Response = (response: Response, headers: Headers): Response =>
  new Response(
    JSON.stringify({
      error: {
        message: "Codex returned an oversized or incomplete rate-limit response.",
        type: "rate_limit_error",
        code: "codex_rate_limit_response_truncated",
        param: null,
      },
    }),
    { status: response.status, statusText: response.statusText, headers }
  );

/**
 * Read a bounded error body and replace the response so callers retain the
 * OpenAI-compatible upstream payload after routing has classified it.
 */
export const readCodex429 = async (response: Response, now = Date.now()): Promise<Codex429Classification> => {
  const headers = new Headers(response.headers);
  // Preserve a complete upstream body for the final response while refusing
  // to classify or forward an incomplete body.
  const { bytes, complete } = await readBoundedResponseBody(response, {
    cancellationReason: "Codex 429 classified",
  });
  const { usageLimitReached, bodyResetAtMs } = classifyCodex429Body(bytes, complete, now);
  const deadlines = resolveCodex429RetryDeadlines(bodyResetAtMs, futureRetryAfterDeadline(headers, now));
  if (!complete) {
    headers.set("Content-Type", "application/json");
    return {
      response: truncatedCodex429Response(response, headers),
      usageLimitReached: false,
      ...deadlines,
    };
  }
  return {
    response: new Response(bytes, { status: response.status, statusText: response.statusText, headers }),
    usageLimitReached,
    ...deadlines,
  };
};

/**
 * Absolute reset deadline for a 429: the body value when the body carries one,
 * the larger of the two when a conflicting Retry-After header is present, and
 * the relative Retry-After delta otherwise.
 */
const resolveResetDeadlineMs = (bodyResetAtMs: number | null, retryAfter: RetryAfterDeadline | null, resetDeadlineConflict: boolean): number | null => {
  if (bodyResetAtMs === null) return retryAfter?.deadlineMs ?? null;
  if (resetDeadlineConflict && retryAfter !== null) return Math.max(bodyResetAtMs, retryAfter.deadlineMs);
  return bodyResetAtMs;
};

/** A probe lease minted by this isolate: unlike a stored legacy record, every field is present. */
export type CodexKnownProbeLease = Readonly<{
  token: string;
  expires_at_ms: number;
  generation: number;
  circuit: CodexProbeCircuit;
  quota_class: CodexQuotaClass | null;
}>;

/**
 * An expired circuit is represented by a fenced half-open probe. A
 * non-blocking 429 must release that old circuit, while the generation and
 * token checks prevent a stale probe from clearing a newer claim.
 */
const releaseNonBlockingQuotaProbe = async (account: RoutingAccount): Promise<void> => {
  if (account.probeGeneration === null || !account.probeToken) return;
  await updateRoutingState((state) => {
    const current = slotFor(state, account);
    if (!slotMatchesRoutingAccount(current, account) || !probeLeaseMatchesRoutingAccount(current, account)) return null;
    const released = routingProbeCircuit(account) === "quota" ? releaseQuotaClassProbe(current, quotaClass(account.requestedModel)) : current;
    return withSlot(state, account.slot, {
      ...released,
      account_id_hash: account.accountIdHash,
      upstream_timeout_blocked_until_ms: routingProbeCircuit(account) === "upstream_timeout" ? null : current.upstream_timeout_blocked_until_ms,
      banked_reset_recovery_probe_pending:
        routingProbeCircuit(account) === "quota" ? released.banked_reset_recovery_probe_pending : current.banked_reset_recovery_probe_pending,
      probe_lease: null,
    });
  });
};

/** A quota lease that belongs to another account's claim must survive an ordinary request. */
const isForeignQuotaProbeLease = (current: CodexRoutingSlot, account: RoutingAccount, blockedQuotaClass: CodexQuotaClass): boolean => {
  const lease = current.probe_lease;
  if (account.probeGeneration !== null || lease?.circuit !== "quota") return false;
  if (lease.quota_class === null || lease.quota_class === undefined) return false;
  return lease.quota_class !== blockedQuotaClass;
};

type CodexQuotaClassResetIdentity = Readonly<{
  observedResetAtMs: number | null;
  observedResetAtIsStable: boolean;
  generationAmbiguous: boolean;
}>;

/**
 * Resolve the reset identity a class block records. A stable absolute deadline
 * is not by itself a provider-proven new quota-window generation: once a stable
 * observation exists, a changed date *or any later relative delay* cannot prove
 * a new provider quota generation, so the first stable observation stays
 * lookup-only and fences claims until a successful half-open probe clears it.
 * Expiry and administrative rechecks are not proof that the provider advanced
 * the quota generation.
 */
const resolveQuotaClassResetIdentity = (
  current: CodexRoutingSlot,
  priorClassBlock: CodexQuotaClassBlock | null,
  parsed: Codex429Classification,
  retryAtMs: number,
  priorDeadline: number,
  hasClassBlocks: boolean,
  boundedRecoveryProbe: boolean,
  now: number
): CodexQuotaClassResetIdentity => {
  const priorObservedResetAtMs = priorClassBlock?.observed_reset_at_ms ?? (!hasClassBlocks ? current.observed_reset_at_ms : null);
  const priorObservedResetIsStable = priorClassBlock?.observed_reset_at_is_stable ?? (!hasClassBlocks && current.observed_reset_at_is_stable);
  const hasStableObservation = priorObservedResetAtMs !== null && priorObservedResetIsStable;
  // A carried ambiguity only protects against re-reading an old window while
  // that window could still describe the current block. Once its deadline has
  // passed (or no observation was ever recorded), a fresh live 429 with a
  // stable future deadline is the current window: refusing here would strand
  // the reset fences forever, because every later observation inherits the
  // same flag. The durable redemption ledger still makes each window
  // spend-once, so a superseded observation cannot double-spend.
  const priorWindowRuledOut = priorObservedResetAtMs === null || priorObservedResetAtMs <= now;
  const liveDeadlineSupersedes = !hasClassBlocks && priorWindowRuledOut && parsed.resetDeadlineIsStable && retryAtMs > now;
  const generationAmbiguous =
    boundedRecoveryProbe ||
    priorClassBlock?.banked_reset_generation_ambiguous === true ||
    (!hasClassBlocks && current.banked_reset_generation_ambiguous && !liveDeadlineSupersedes) ||
    parsed.resetDeadlineConflict ||
    (hasStableObservation && (!parsed.resetDeadlineIsStable || retryAtMs !== priorObservedResetAtMs));
  const preserveStableObservation = hasStableObservation && generationAmbiguous;
  // The reset observation must describe the actual circuit deadline. A shorter
  // later Retry-After cannot overwrite the identity of an earlier, longer block
  // and thereby let a stale reset clear that longer circuit.
  const extendsPriorDeadline = retryAtMs >= priorDeadline;
  const observedResetAtMs = !preserveStableObservation && extendsPriorDeadline ? retryAtMs : priorObservedResetAtMs;
  const observedResetAtIsStable = !preserveStableObservation && extendsPriorDeadline ? parsed.resetDeadlineIsStable : priorObservedResetIsStable;
  return { observedResetAtMs, observedResetAtIsStable, generationAmbiguous };
};

/**
 * Build the class-scoped quota circuit for a 429 that proves exhaustion. A
 * verified reset can take a short time to propagate to the inference endpoint,
 * so a failed recovery probe must not turn that transient 429 into the old,
 * week-long circuit: it stays fenced and retries a bounded probe after the
 * normal half-open lease interval, and the verified redemption record prevents
 * this path from spending another reset for the same quota episode.
 */
const buildQuotaBlockedSlot = (
  current: CodexRoutingSlot,
  account: RoutingAccount,
  parsed: Codex429Classification,
  quotaBlockSource: CodexQuotaBlockSource,
  retryAtMs: number,
  now: number,
  recoveryProbe: boolean,
  foreignQuotaProbe: boolean
): CodexRoutingSlot => {
  const blockedQuotaClass = quotaClass(account.requestedModel);
  const quotaBlocksBeforeUpdate = quotaBlocksIncludingLegacy(current);
  const classAwareCurrent = { ...current, quota_blocks_by_class: quotaBlocksBeforeUpdate };
  const priorClassBlock = quotaBlockForClass(classAwareCurrent, blockedQuotaClass);
  const priorDeadline = priorClassBlock?.blocked_until_ms ?? 0;
  const hasClassBlocks = Object.keys(quotaBlocksBeforeUpdate).length > 0;
  const priorTimeout = current.upstream_timeout_blocked_until_ms ?? 0;
  const boundedRecoveryProbe = recoveryProbe || (current.banked_reset_recovery_probe_pending && account.probeGeneration !== null);
  const deadline = boundedRecoveryProbe ? now + CODEX_HALF_OPEN_LEASE_MS : Math.max(priorDeadline, retryAtMs);
  const identity = resolveQuotaClassResetIdentity(current, priorClassBlock, parsed, retryAtMs, priorDeadline, hasClassBlocks, boundedRecoveryProbe, now);
  const blockedClassBlock: CodexQuotaClassBlock = {
    blocked_until_ms: deadline,
    source: quotaBlockSource,
    legacy_fallback: false,
    quota_signal_observed_at_ms: now,
    observed_reset_at_ms: identity.observedResetAtMs,
    observed_reset_at_is_stable: identity.observedResetAtIsStable,
    banked_reset_generation_ambiguous: identity.generationAmbiguous,
    banked_reset_recovery_probe_pending: priorClassBlock?.banked_reset_recovery_probe_pending === true || recoveryProbe,
  };
  const quotaBlocksByClass: Partial<Record<CodexQuotaClass, CodexQuotaClassBlock>> = {
    ...quotaBlocksBeforeUpdate,
    [blockedQuotaClass]: blockedClassBlock,
  };
  // The block for this class was written into the map directly above, so the
  // reducer's seed entry is present; a missing one is a broken invariant.
  const latestClassBlock = Object.values(quotaBlocksByClass).reduce<CodexQuotaClassBlock>(
    (latest, block) => (block.blocked_until_ms > latest.blocked_until_ms ? block : latest),
    quotaBlocksByClass[blockedQuotaClass] ?? blockedClassBlock
  );
  return {
    ...current,
    account_id_hash: account.accountIdHash,
    quota_blocked_until_ms: latestClassBlock.blocked_until_ms,
    quota_block_source: latestClassBlock.source,
    quota_blocked_classes: Object.keys(quotaBlocksByClass),
    quota_blocks_by_class: quotaBlocksByClass,
    upstream_timeout_blocked_until_ms: priorTimeout > now ? priorTimeout : null,
    quota_signal_observed_at_ms: now,
    primary_used_percent: parseFinitePercent(parsed.response.headers.get("x-codex-primary-used-percent")) ?? current.primary_used_percent,
    secondary_used_percent: parseFinitePercent(parsed.response.headers.get("x-codex-secondary-used-percent")) ?? current.secondary_used_percent,
    observed_reset_at_ms: latestClassBlock.observed_reset_at_ms,
    observed_reset_at_is_stable: latestClassBlock.observed_reset_at_is_stable,
    banked_reset_generation_ambiguous: Object.values(quotaBlocksByClass).some((block) => block.banked_reset_generation_ambiguous),
    banked_reset_recovery_probe_pending: Object.values(quotaBlocksByClass).some((block) => block.banked_reset_recovery_probe_pending),
    generation: foreignQuotaProbe ? current.generation : current.generation + 1,
    probe_lease: foreignQuotaProbe ? current.probe_lease : null,
  };
};

/**
 * Persist the class-scoped quota block for a 429 that proves exhaustion. The
 * account stays fenced, and an ordinary request that predates a foreign
 * half-open claim must not replace that lease or admit a parallel probe.
 */
const quotaBlockTransition = (
  state: CodexAccountRoutingState,
  account: RoutingAccount,
  parsed: Codex429Classification,
  now: number,
  recoveryProbe: boolean
): CodexAccountRoutingState | null => {
  const retryAtMs = parsed.retryAtMs;
  const quotaBlockSource = parsed.quotaBlockSource;
  if (retryAtMs === null || quotaBlockSource === null) return null;
  const current = slotFor(state, account);
  if (!slotMatchesRoutingAccount(current, account)) return null;
  const foreignQuotaProbe = isForeignQuotaProbeLease(current, account, quotaClass(account.requestedModel));
  if (account.probeGeneration === null && current.probe_lease !== null && !foreignQuotaProbe) return null;
  if (account.probeGeneration !== null && !probeLeaseMatchesRoutingAccount(current, account)) return null;
  return withSlot(state, account.slot, buildQuotaBlockedSlot(current, account, parsed, quotaBlockSource, retryAtMs, now, recoveryProbe, foreignQuotaProbe));
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
    await updateRoutingState((state) => quotaBlockTransition(state, account, parsed, now, recoveryProbe));
  }
  return parsed;
};

export const markCodexQuotaBlocked = async (account: RoutingAccount, response: Response, now = Date.now()): Promise<Codex429Classification> =>
  await markCodexQuotaBlockedWithMode(account, response, now, false);

/**
 * Record a failed probe immediately after a verified banked reset. Keep the
 * account fenced, but schedule a short half-open retry because reset
 * propagation can lag the provider's terminal consume response.
 */

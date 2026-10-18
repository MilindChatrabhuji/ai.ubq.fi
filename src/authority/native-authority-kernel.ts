import { API_KEY_NO_USAGE_LIMIT, USAGE_RESET_PERIOD_MS } from "../api-keys.ts";
import * as kernel from "./native-kernel.ts";
import type {
  KernelQuotaIdentity,
  KernelQuotaReservationIdentity,
  KernelQuotaReservationRowV2,
  KernelQuotaEffectivePolicy,
  KernelQuotaWindowV2,
} from "./native-kernel-contracts.ts";
import {
  NativeAuthorityError,
  nativeIdentity,
  type NativeArguments,
  type NativeAuthorityInitial,
  type NativeCapability,
  type NativeReply,
} from "./native-authority-contracts.ts";
import { nativeKey, NativeAuthoritySql } from "./native-authority-sql.ts";
import { NativeAuthorityApi } from "./native-authority-api.ts";

export class NativeAuthorityKernel {
  constructor(
    private readonly _sql: NativeAuthoritySql,
    private readonly _api: NativeAuthorityApi,
    private readonly _initial: NativeAuthorityInitial
  ) {}
  private _defaults(now: number) {
    return {
      limit: kernel.normalizeUsageLimit(
        this._sql.read("kernel_default", ["default", "kernel_policy_limit_requests"], now).value,
        API_KEY_NO_USAGE_LIMIT,
        this._initial.kernelConstants.noUsageLimit
      ),
      windowMs: kernel.normalizeWindow(this._sql.read("kernel_default", ["default", "kernel_policy_window_ms"], now).value, USAGE_RESET_PERIOD_MS),
    };
  }
  private _readWindow(identity: KernelQuotaIdentity, now: number) {
    const row = this._sql.read("kernel_window", kernel.kernelScopedWindowKey(identity.scope, identity.owner, identity.repo), now);
    const value = kernel.normalizeKernelQuotaWindowV2(row.value, identity.scope, identity.owner, identity.repo);
    if (row.value !== null && !value) throw new NativeAuthorityError("kernel_window_malformed", 503);
    return { row, value };
  }
  private _reservation(identity: KernelQuotaReservationIdentity, now: number) {
    return this._sql.read(
      "kernel_reservation",
      kernel.kernelReservationKey(identity.scope, identity.owner, identity.repo, identity.windowCreatedAtMs, identity.requestId),
      now
    );
  }
  private _writeReservation(identity: KernelQuotaIdentity, row: KernelQuotaReservationRowV2, expiry: number): void {
    this._sql.write(
      "kernel_reservation",
      kernel.kernelReservationKey(identity.scope, identity.owner, identity.repo, row.window_created_at_ms, row.request_id),
      row,
      expiry,
      {
        scope: nativeKey([identity.owner, identity.repo ?? ""]),
        parent: nativeKey(kernel.kernelScopedWindowKey(identity.scope, identity.owner, identity.repo)),
      }
    );
  }
  private _reclaimWindow(identity: KernelQuotaIdentity, now: number): number {
    let count = 0,
      after = "";
    for (;;) {
      const page = this._sql.page("kernel_reservation", now, after, 100, {
        parent: nativeKey(kernel.kernelScopedWindowKey(identity.scope, identity.owner, identity.repo)),
      });
      for (const item of page) {
        const row = kernel.normalizeKernelQuotaReservationRowV2(item.row.value, identity.scope, identity.owner, identity.repo);
        if (!row) throw new NativeAuthorityError("kernel_reservation_malformed", 503);
        const target = kernel.decideKernelQuotaReclaim(row, now);
        if (target) {
          this._settle(
            { ...identity, windowCreatedAtMs: row.window_created_at_ms, requestId: row.request_id, route: row.route },
            target,
            "reservation_lease_expired",
            now
          );
          count++;
        }
      }
      if (page.length < 100) break;
      after = page[page.length - 1].encoded;
    }
    return count;
  }
  reserve(cap: NativeCapability, handle: string, now: number): NativeReply {
    const request = this._api.request(cap, handle, now);
    const repo = this._sql.read("kernel_policy", kernel.kernelRepoPolicyKey(cap.kernel.owner, cap.kernel.repo), now);
    const org = this._sql.read("kernel_policy", kernel.kernelOrgPolicyKey(cap.kernel.owner), now);
    const scope = kernel.decideKernelQuotaScope(
      { repoPolicy: repo, orgPolicy: org },
      cap.kernel.owner,
      cap.kernel.repo,
      this._initial.kernelConstants
    ).limit_scope;
    const identity = nativeIdentity(scope, cap);
    const eligibility = kernel.decideKernelQuotaEligibility(
      identity,
      {
        policy: scope === "repo" ? repo : org,
        repoGuard: scope === "org" ? repo : null,
        defaultCutover: this._sql.read("kernel_cutover", kernel.KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, now),
        expectedRepoPolicy: scope === "repo" ? "present" : "absent",
      },
      this._defaults(now),
      this._initial.kernelConstants,
      now
    );
    if (eligibility.kind !== "eligible") return { kind: eligibility.kind, detail: eligibility };
    const decide = () => {
      const current = this._readWindow(identity, now);
      const window = kernel.windowForEffectivePolicy(current.value, identity.scope, identity.owner, identity.repo, eligibility.effective.windowMs, now).window;
      return kernel.decideKernelQuotaReserve(
        identity,
        eligibility.effective,
        window,
        this._sql.read("kernel_reservation", kernel.kernelReservationKey(scope, identity.owner, identity.repo, window.created_at_ms, request.requestId), now),
        request.requestId,
        request.route,
        this._initial.kernelConstants.noUsageLimit,
        now
      );
    };
    let plan = decide();
    if (plan.kind === "full" && this._reclaimWindow(identity, now) > 0) plan = decide();
    if (plan.kind !== "reserve") return { kind: plan.kind, detail: plan };
    this._sql.write("kernel_window", kernel.kernelScopedWindowKey(scope, identity.owner, identity.repo), plan.window, now + plan.expireIn, {
      scope: nativeKey([identity.owner, identity.repo ?? ""]),
    });
    this._writeReservation(identity, plan.reservation, now + plan.expireIn);
    this._api.save({ ...request, kernel: { ...identity, requestId: request.requestId, route: request.route, windowCreatedAtMs: plan.window.created_at_ms } });
    return { kind: "reserved", detail: plan.reservation };
  }
  private _identity(cap: NativeCapability, handle: string, now: number): KernelQuotaReservationIdentity {
    const identity = this._api.request(cap, handle, now).kernel;
    if (!identity) throw new NativeAuthorityError("kernel_reservation_missing");
    return identity;
  }
  intent(cap: NativeCapability, args: NativeArguments["recordKernelTerminalIntent"], now: number): NativeReply {
    const identity = this._identity(cap, args.handle, now);
    const plan = kernel.decideKernelQuotaTerminalIntent(identity, this._reservation(identity, now), args.terminalState, now);
    if (plan.kind === "intent") this._writeReservation(identity, plan.reservation, now + plan.expireIn);
    return { kind: plan.kind, detail: plan.kind === "unchanged" ? plan.outcome : plan.reservation };
  }
  private _settle(identity: KernelQuotaReservationIdentity, target: "committed" | "released", reason: string, now: number): NativeReply {
    const read = this._reservation(identity, now);
    const row = kernel.normalizeKernelQuotaReservationRowV2(read.value, identity.scope, identity.owner, identity.repo);
    if (!row) return { kind: "unchanged", detail: read.value === null ? "missing" : "invalid" };
    const precondition = kernel.kernelReservationPrecondition(row, identity.requestId, identity.route, identity.windowCreatedAtMs, target);
    if (precondition) return { kind: "unchanged", detail: precondition };
    const current = this._readWindow(identity, now);
    const plan = kernel.decideKernelQuotaSettlement(row, { window: current.value, windowPresent: current.row.value !== null }, target, reason, now);
    if (plan.kind === "settle") {
      this._writeReservation(identity, plan.reservation, now + plan.expireIn);
      if (plan.window)
        this._sql.write("kernel_window", kernel.kernelScopedWindowKey(identity.scope, identity.owner, identity.repo), plan.window, now + plan.expireIn, {
          scope: nativeKey([identity.owner, identity.repo ?? ""]),
        });
    }
    return { kind: plan.kind, detail: plan.kind === "unchanged" ? plan.outcome : plan.reservation };
  }
  settle(cap: NativeCapability, args: NativeArguments["settleKernelUsage"], now: number): NativeReply {
    return this._settle(this._identity(cap, args.handle, now), args.terminalState, args.reason, now);
  }
  renew(cap: NativeCapability, handle: string, now: number): NativeReply {
    const identity = this._identity(cap, handle, now);
    const plan = kernel.decideKernelQuotaRenewal(identity, this._reservation(identity, now), now);
    this._writeReservation(identity, plan.reservation, now + plan.expireIn);
    return { kind: "renewed", detail: plan.reservation };
  }
  reclaim(cap: NativeCapability, args: NativeArguments["reclaimExpiredKernelReservations"], now: number): NativeReply {
    let scope: "org" | "repo" = "org",
      after = "";
    if (args.cursor) {
      const cursor = this._sql.read("cursor", [args.cursor], now).value;
      if (cursor?.capabilityId !== cap.id || cursor.parent !== cap.keyId || !cursor.family.startsWith("kernel_reclaim:"))
        throw new NativeAuthorityError("cursor_ownership_mismatch", 403);
      scope = cursor.family === "kernel_reclaim:repo" ? "repo" : "org";
      after = cursor.after;
    }
    const identity = nativeIdentity(scope, cap),
      page = this._sql.page("kernel_reservation", now, after, args.limit, { scope: nativeKey([identity.owner, identity.repo ?? ""]) });
    let reclaimed = 0;
    for (const item of page) {
      const row = kernel.normalizeKernelQuotaReservationRowV2(item.row.value, scope, identity.owner, identity.repo);
      if (!row) throw new NativeAuthorityError("kernel_reservation_malformed", 503);
      const target = kernel.decideKernelQuotaReclaim(row, now);
      if (target) {
        this._settle(
          { ...identity, requestId: row.request_id, route: row.route, windowCreatedAtMs: row.window_created_at_ms },
          target,
          "reservation_lease_expired",
          now
        );
        reclaimed++;
      }
    }
    let cursor: string | null = null;
    if (page.length === args.limit || scope === "org") {
      cursor = crypto.randomUUID();
      const continuing = page.length === args.limit;
      this._sql.write("cursor", [cursor], {
        id: cursor,
        capabilityId: cap.id,
        parent: cap.keyId,
        family: "kernel_reclaim:" + (continuing ? scope : "repo"),
        after: continuing ? page[page.length - 1].encoded : "",
        lease: null,
      });
    }
    return { kind: "reclaimed", cursor, detail: { reclaimed, scanned: page.length } };
  }
  cutover(now: number): NativeReply {
    const plan = kernel.decideKernelDefaultWindowCutover(
      this._sql.read("kernel_cutover", kernel.KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, now),
      crypto.randomUUID(),
      now
    );
    if (plan.kind === "acquire") this._sql.write("kernel_cutover", kernel.KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, plan.marker, now + plan.expireIn);
    return { kind: plan.kind, detail: plan };
  }
  private _setPolicy(
    identity: KernelQuotaIdentity,
    args: NativeArguments["setKernelQuota"],
    current: KernelQuotaEffectivePolicy,
    window: KernelQuotaWindowV2 | null,
    now: number
  ): NativeReply {
    const timing = kernel.resolveKernelPolicyTiming(args.options, current, this._initial.kernelConstants.noExpirationMs);
    const reset = kernel.kernelQuotaPolicyResetRequested(args.options, current.windowMs, timing.windowMs);
    if (kernel.decideKernelPolicyWindowGuard(window, window !== null, reset, now).kind === "reclaim") {
      this._reclaimWindow(identity, now);
      window = this._readWindow(identity, now).value;
      if (kernel.hasLiveKernelReservations(window, now)) return { kind: "conflict" };
    }
    const policy = kernel.makeKernelQuotaPolicy(identity, current, args.usageLimitRequests, timing, this._initial.kernelConstants.noUsageLimit, now);
    const plan = kernel.decideKernelQuotaPolicyWrite(identity, policy, window, reset, now);
    this._sql.write("kernel_policy", kernel.kernelScopedPolicyKey(identity.scope, identity.owner, identity.repo), plan.policy, null);
    this._sql.write("kernel_window", kernel.kernelScopedWindowKey(identity.scope, identity.owner, identity.repo), plan.window, null);
    return { kind: "written", detail: plan.policy };
  }
  policy(cap: NativeCapability, args: NativeArguments["setKernelQuota"] | NativeArguments["deleteKernelQuota"], now: number): NativeReply {
    const identity = nativeIdentity(args.scope, cap),
      keys = kernel.kernelPolicyKeys(identity.scope, identity.owner, identity.repo);
    const entry = this._sql.read("kernel_policy", keys.policyKey, now),
      marker = this._sql.read("kernel_cutover", kernel.KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, now);
    const current = kernel.policyFor(entry, identity.scope, identity.owner, identity.repo, this._defaults(now), this._initial.kernelConstants);
    if (kernel.kernelQuotaDefaultCutoverBlocks(current, marker)) return { kind: "conflict" };
    if (identity.scope === "repo" && entry.value === null) {
      const org = nativeIdentity("org", cap);
      const window = this._readWindow(org, now).value;
      if (kernel.hasLiveKernelReservations(window, now)) {
        this._reclaimWindow(org, now);
        if (kernel.hasLiveKernelReservations(this._readWindow(org, now).value, now)) return { kind: "conflict" };
      }
    }
    let window = this._readWindow(identity, now).value;
    if ("usageLimitRequests" in args) {
      return this._setPolicy(identity, args, current, window, now);
    }
    const pre = kernel.decideKernelQuotaPolicyDeletePrecondition({ policy: entry, defaultCutover: marker });
    if (pre !== "proceed") return { kind: pre };
    // Deletion changes default-window identity only after outstanding live reservations are gone.
    if (kernel.hasLiveKernelReservations(window, now)) {
      this._reclaimWindow(identity, now);
      window = this._readWindow(identity, now).value;
      if (kernel.hasLiveKernelReservations(window, now)) return { kind: "conflict" };
    }
    const next = kernel.decideKernelQuotaPolicyDeleteWindow(identity, current, this._defaults(now), window, now);
    this._sql.delete("kernel_policy", keys.policyKey);
    this._sql.write("kernel_window", keys.windowKey, next, null);
    return { kind: "deleted" };
  }
}

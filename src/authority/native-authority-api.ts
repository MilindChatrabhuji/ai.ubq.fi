import { apiKeyHashKey } from "../api-keys.ts";
import {
  currentApiKeyUsageWindow,
  isApiKeyUsageReservationExpired,
  normalizeApiKeyUsageRequestV3,
  planApiKeyUsageDispatch,
  planApiKeyUsageDispatchCancellation,
  planApiKeyUsageReservation,
  planApiKeyUsageReservedRelease,
} from "./native-api-key.ts";
import type { ApiKeyPolicy, ApiKeyUsageWritePlan } from "./native-contracts.ts";
import { NativeAuthorityError, type NativeArguments, type NativeCapability, type NativeReply, type NativeRequest } from "./native-authority-contracts.ts";
import { nativeKey, NativeAuthoritySql } from "./native-authority-sql.ts";

const windowKey = (policy: ApiKeyPolicy) => ["uos_ai", "api_key_usage", "v3", "window", policy.key_id, policy.policy_version, policy.window_start_ms] as const;
const requestKey = (policy: ApiKeyPolicy, requestId: string) =>
  ["uos_ai", "api_key_usage", "v3", "request", policy.key_id, policy.policy_version, policy.window_start_ms, requestId] as const;
/** Source key helpers currently live in the native wrapper; these exact tuples are its fixed adapter boundary. */
export class NativeAuthorityApi {
  constructor(private readonly _sql: NativeAuthoritySql) {}
  request(cap: NativeCapability, handle: string, now: number): NativeRequest {
    const row = this._sql.read("request_lifetime", [handle], now).value;
    if (row?.principalId !== cap.principalId || row.keyId !== cap.keyId) throw new NativeAuthorityError("request_ownership_mismatch", 403);
    return row;
  }
  save(row: NativeRequest): void {
    this._sql.write("request_lifetime", [row.handle], row, null, { scope: row.keyId, parent: nativeKey(requestKey(row.api, row.requestId)) });
  }
  private _snapshot(row: NativeRequest, now: number) {
    return {
      request: this._sql.read("api_request", requestKey(row.api, row.requestId), now).value,
      window: this._sql.read("api_window", windowKey(row.api), now).value,
    };
  }
  private _write(policy: ApiKeyPolicy, plan: ApiKeyUsageWritePlan, now: number): void {
    this._sql.write("api_request", requestKey(policy, plan.request.request_id), plan.request, now + plan.expireIn, {
      scope: policy.key_id,
      parent: nativeKey(windowKey(policy)),
    });
    this._sql.write("api_window", windowKey(policy), plan.window, now + plan.expireIn, { scope: policy.key_id });
  }
  private _reclaim(policy: ApiKeyPolicy, now: number): void {
    // The native wrapper only reclaims after a full-window decision. Retain each release row.
    let after = "";
    for (;;) {
      const page = this._sql.page("api_request", now, after, 100, { parent: nativeKey(windowKey(policy)) });
      for (const entry of page) {
        const row = normalizeApiKeyUsageRequestV3(entry.row.value);
        if (!row) throw new NativeAuthorityError("request_malformed", 503);
        if (isApiKeyUsageReservationExpired(row, now)) {
          const release = planApiKeyUsageReservedRelease(
            policy,
            row.request_id,
            "reservation_lease_expired",
            { request: row, window: this._sql.read("api_window", windowKey(policy), now).value },
            now
          );
          if (release.kind === "write") this._write(policy, release, now);
        }
      }
      if (page.length < 100) break;
      after = page[page.length - 1].encoded;
    }
  }
  reserve(cap: NativeCapability, args: NativeArguments["reserveApiUsage"], now: number): NativeReply {
    const source = this._sql.read("api_policy", apiKeyHashKey(cap.tokenHash), now).value;
    if (
      source?.api.key_id !== cap.keyId ||
      source.api.token_hash !== cap.tokenHash ||
      source.revoked ||
      (source.api.expires_at_ms !== -1 && source.api.expires_at_ms <= now)
    )
      return { kind: "unauthorized" };
    const window = currentApiKeyUsageWindow(source.api.usage_reset_at_ms, source.api.window_ms, now);
    const policy = { ...source.api, window_start_ms: window.start, usage_reset_at_ms: window.reset };
    const snapshot = {
      request: this._sql.read("api_request", requestKey(policy, args.requestId), now).value,
      window: this._sql.read("api_window", windowKey(policy), now).value,
    };
    let plan = planApiKeyUsageReservation(policy, args.requestId, args.route, snapshot, now);
    if (plan.kind === "full") {
      this._reclaim(policy, now);
      plan = planApiKeyUsageReservation(
        policy,
        args.requestId,
        args.route,
        {
          request: this._sql.read("api_request", requestKey(policy, args.requestId), now).value,
          window: this._sql.read("api_window", windowKey(policy), now).value,
        },
        now
      );
    }
    if (plan.kind !== "write" && plan.kind !== "reuse") return { kind: plan.kind, detail: plan };
    const previous = this._sql.page("request_lifetime", now, "", 1, { parent: nativeKey(requestKey(policy, args.requestId)) })[0]?.row.value;
    if (plan.kind === "reuse") {
      if (
        previous?.principalId !== cap.principalId ||
        previous.model !== args.model ||
        previous.stream !== args.stream ||
        previous.reasoning !== (args.reasoning ?? null)
      )
        return { kind: "unavailable", detail: "identity_conflict" };
      return { kind: "reuse", handle: previous.handle };
    }
    this._write(policy, plan, now);
    const handle = crypto.randomUUID();
    this.save({
      handle,
      principalId: cap.principalId,
      keyId: cap.keyId,
      requestId: args.requestId,
      route: args.route,
      model: args.model,
      stream: args.stream,
      reasoning: args.reasoning ?? null,
      createdAtMs: now,
      api: policy,
      kernel: null,
      codex: null,
      selection: null,
      codexProof: null,
      ownerFence: null,
      semantic: null,
      delivery: null,
      dispatch: null,
    });
    return { kind: "reserved", handle };
  }
  dispatch(cap: NativeCapability, args: NativeArguments["markApiDispatch"], now: number): NativeReply {
    const row = this.request(cap, args.handle, now);
    const plan = planApiKeyUsageDispatch(row.api, row.requestId, row.route, args.provider, this._snapshot(row, now), now);
    if (plan.kind !== "write") return { kind: plan.kind };
    this._write(row.api, plan, now);
    this.save({ ...row, dispatch: { provider: args.provider, cancellationOwned: true, fetchStarted: false } });
    return { kind: "dispatched" };
  }
  release(cap: NativeCapability, args: NativeArguments["releaseApiUndispatched"], now: number): NativeReply {
    const row = this.request(cap, args.handle, now);
    const plan = planApiKeyUsageReservedRelease(row.api, row.requestId, args.reason, this._snapshot(row, now), now, row.route);
    if (plan.kind !== "write") return { kind: plan.kind };
    this._write(row.api, plan, now);
    return { kind: "released" };
  }
  cancel(cap: NativeCapability, handle: string, now: number): NativeReply {
    const row = this.request(cap, handle, now);
    if (!row.dispatch?.cancellationOwned || row.dispatch.fetchStarted) throw new NativeAuthorityError("prefetch_cancellation_not_owned");
    const plan = planApiKeyUsageDispatchCancellation(row.api, row.requestId, row.route, row.dispatch.provider, this._snapshot(row, now), now);
    if (plan.kind !== "write") return { kind: plan.kind };
    this._write(row.api, plan, now);
    this.save({ ...row, dispatch: { ...row.dispatch, cancellationOwned: false } });
    return { kind: "released" };
  }
  status(cap: NativeCapability, handle: string, now: number): NativeReply {
    const row = this.request(cap, handle, now);
    return { kind: "status", handle, detail: { api: this._snapshot(row, now).request } };
  }
}

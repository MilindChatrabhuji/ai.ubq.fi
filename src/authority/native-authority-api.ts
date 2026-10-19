import {
  apiKeyUsageV3RetentionMs,
  currentApiKeyUsageWindow,
  isApiKeyUsageReservationExpired,
  makeApiKeyUsageWindowV3,
  matchingApiKeyUsageWindowV3,
  normalizeApiKeyUsageRequestV3,
  planApiKeyUsageDispatch,
  planApiKeyUsageDispatchCancellation,
  planApiKeyUsageReservation,
  planApiKeyUsageReservedRelease,
} from "./native-api-key.ts";
import type { ApiKeyPolicy, ApiKeyUsageWritePlan, ApiKeyUsageRequestV3 } from "./native-contracts.ts";
import { NativeAuthorityError, type NativeArguments, type NativeCapability, type NativeReply, type NativeRequest } from "./native-authority-contracts.ts";
import type { NativeValidatedRequest } from "./native-runtime-contracts.ts";
import { nativeKey, NativeAuthoritySql } from "./native-authority-sql.ts";

const windowKey = (policy: ApiKeyPolicy) => ["uos_ai", "api_key_usage", "v3", "window", policy.key_id, policy.policy_version, policy.window_start_ms] as const;
const requestKey = (policy: ApiKeyPolicy, requestId: string) =>
  ["uos_ai", "api_key_usage", "v3", "request", policy.key_id, policy.policy_version, policy.window_start_ms, requestId] as const;
/** Source key helpers currently live in the native wrapper; these exact tuples are its fixed adapter boundary. */
export class NativeAuthorityApi {
  constructor(private readonly _sql: NativeAuthoritySql) {}
  request(cap: NativeCapability, handle: string, now: number): NativeRequest {
    const row = this._sql.read("request_lifetime", [handle], now).value;
    if (row?.principalId !== cap.principalId || row.keyId !== cap.keyId || row.runtimeBindingId !== cap.id)
      throw new NativeAuthorityError("request_ownership_mismatch", 403);
    return row;
  }
  save(row: NativeRequest): void {
    this._sql.write("request_lifetime", [row.handle], row, null, {
      scope: row.keyId ?? row.principalId,
      ...(row.api ? { parent: nativeKey(requestKey(row.api, row.requestId)) } : {}),
    });
  }
  validated(cap: NativeCapability, handle: string, now: number): NativeValidatedRequest {
    const row = this.request(cap, handle, now);
    if (!row.metadataBound || row.model === null || row.stream === null) throw new NativeAuthorityError("validated_metadata_missing");
    return { ...row, model: row.model, stream: row.stream };
  }
  private _snapshot(row: NativeRequest, now: number) {
    if (!row.api) return { request: null, window: null };
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
    const row = this.request(cap, args.handle, now);
    if (!row.apiApplicable) return { kind: "not_applicable", handle: row.handle };
    const keyId = cap.keyId;
    const tokenHash = cap.tokenHash;
    if (keyId === null || tokenHash === null) return { kind: "unauthorized" };
    const source = this._sql.currentKeyPolicy(tokenHash, keyId, now)?.value;
    if (!source) return { kind: "unauthorized" };
    if (
      source.api.key_id !== keyId ||
      source.api.token_hash !== tokenHash ||
      source.revoked ||
      (source.api.expires_at_ms !== -1 && source.api.expires_at_ms <= now)
    )
      return { kind: "unauthorized" };
    if (row.metadataBound && !row.api) throw new NativeAuthorityError("api_admission_phase_closed");
    const window = currentApiKeyUsageWindow(source.api.usage_reset_at_ms, source.api.window_ms, now);
    const policy = row.api ?? { ...source.api, window_start_ms: window.start, usage_reset_at_ms: window.reset };
    const snapshot = () => ({
      request: this._sql.read("api_request", requestKey(policy, row.requestId), now).value,
      window: this._sql.read("api_window", windowKey(policy), now).value,
    });
    let plan = planApiKeyUsageReservation(policy, row.requestId, row.route, snapshot(), now);
    if (plan.kind === "full") {
      this._reclaim(policy, now);
      plan = planApiKeyUsageReservation(policy, row.requestId, row.route, snapshot(), now);
    }
    if (plan.kind !== "write" && plan.kind !== "reuse") return { kind: plan.kind, detail: plan };
    if (plan.kind === "write") this._write(policy, plan, now);
    this.save({ ...row, api: policy });
    return { kind: plan.kind === "write" ? "reserved" : "reuse", handle: row.handle, detail: { policy } };
  }
  dispatch(cap: NativeCapability, args: NativeArguments["markApiDispatch"], now: number): NativeReply {
    const row = this.request(cap, args.handle, now);
    if (!row.api) {
      if (row.dispatch) return { kind: "unchanged" };
      this.save({ ...row, dispatch: { provider: args.provider, cancellationOwned: true, fetchStarted: false } });
      return { kind: "dispatched" };
    }
    const plan = planApiKeyUsageDispatch(row.api, row.requestId, row.route, args.provider, this._snapshot(row, now), now);
    if (plan.kind !== "write") return { kind: plan.kind };
    this._write(row.api, plan, now);
    this.save({ ...row, dispatch: { provider: args.provider, cancellationOwned: true, fetchStarted: false } });
    return { kind: "dispatched" };
  }
  private _compensationSafe(row: NativeRequest): boolean {
    return !row.transport && !row.responding && !row.providerObserved && row.semantic === null && (row.delivery === null || row.delivery === "unobserved");
  }
  assertDispatchReceipt(cap: NativeCapability, handle: string, now: number): void {
    const row = this.request(cap, handle, now);
    const api = normalizeApiKeyUsageRequestV3(this._snapshot(row, now).request);
    if ((row.api && api?.state !== "dispatched") || !row.dispatch?.cancellationOwned) throw new NativeAuthorityError("api_dispatch_receipt_stale");
  }
  assertTransportReceipt(cap: NativeCapability, handle: string, operationId: string, now: number): void {
    this.assertDispatchReceipt(cap, handle, now);
    const row = this.request(cap, handle, now);
    if (row.transport?.operationId !== operationId || row.semantic !== null) throw new NativeAuthorityError("transport_start_receipt_stale");
  }
  start(cap: NativeCapability, args: NativeArguments["recordTransportStarted"], operationId: string, now: number): NativeReply {
    const row = this.request(cap, args.handle, now);
    this.assertDispatchReceipt(cap, args.handle, now);
    if (row.semantic !== null) throw new NativeAuthorityError("request_already_terminal");
    const attemptHandle = args.attemptHandle ?? null;
    if (row.transport?.provider === args.provider && row.transport.attemptHandle === attemptHandle)
      return { kind: "unchanged", detail: { provider: args.provider, attemptHandle } };
    if (!row.dispatch) throw new NativeAuthorityError("api_dispatch_missing");
    const responding = { provider: args.provider, attemptHandle };
    this.save({ ...row, dispatch: { ...row.dispatch, fetchStarted: true }, transport: { ...responding, operationId, startedAtMs: now }, responding });
    return { kind: "started", detail: responding };
  }
  release(cap: NativeCapability, args: NativeArguments["releaseApiUndispatched"], now: number): NativeReply {
    const row = this.request(cap, args.handle, now);
    if (!this._compensationSafe(row)) throw new NativeAuthorityError("prefetch_compensation_closed");
    if (!row.api) return { kind: "not_applicable" };
    const plan = planApiKeyUsageReservedRelease(row.api, row.requestId, args.reason, this._snapshot(row, now), now, row.route);
    if (plan.kind !== "write") return { kind: plan.kind };
    this._write(row.api, plan, now);
    return { kind: "released" };
  }
  cancel(cap: NativeCapability, handle: string, now: number): NativeReply {
    const row = this.request(cap, handle, now);
    if (!row.dispatch?.cancellationOwned || row.dispatch.fetchStarted || !this._compensationSafe(row))
      throw new NativeAuthorityError("prefetch_cancellation_not_owned");
    if (!row.api) {
      this.save({ ...row, dispatch: { ...row.dispatch, cancellationOwned: false } });
      return { kind: "released" };
    }
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
  usage(policy: ApiKeyPolicy, now: number): number {
    return matchingApiKeyUsageWindowV3(this._sql.read("api_window", windowKey(policy), now).value, policy)?.committed_requests ?? 0;
  }
  createWindow(policy: ApiKeyPolicy, now: number): void {
    if (this._sql.read("api_window", windowKey(policy), now).value) throw new NativeAuthorityError("api_window_identity_conflict");
    const window = makeApiKeyUsageWindowV3(policy, now);
    this._sql.write("api_window", windowKey(policy), window, now + apiKeyUsageV3RetentionMs(window.window_reset_at_ms, now), { scope: policy.key_id });
  }
  /** Key-wide administrative inspection uses each request's original stored identity. */
  private _resetReservation(keyId: string, encoded: string, value: ApiKeyUsageRequestV3 | null, now: number): boolean {
    const row = normalizeApiKeyUsageRequestV3(value);
    if (row?.key_id !== keyId) throw new NativeAuthorityError("API key quota ledger is unavailable", 503);
    if (row.state !== "reserved") return false;
    const lifetimes = this._sql.page("request_lifetime", now, "", 2, { parent: encoded });
    const lifetime = lifetimes[0]?.row.value;
    if (lifetimes.length !== 1 || !lifetime?.api || nativeKey(requestKey(lifetime.api, lifetime.requestId)) !== encoded || lifetime.keyId !== keyId)
      throw new NativeAuthorityError("api_reset_original_identity_missing", 503);
    if (!isApiKeyUsageReservationExpired(row, now)) return true;
    const release = planApiKeyUsageReservedRelease(
      lifetime.api,
      row.request_id,
      "reservation_lease_expired",
      { request: row, window: this._sql.read("api_window", windowKey(lifetime.api), now).value },
      now,
      lifetime.route
    );
    if (release.kind !== "write") throw new NativeAuthorityError("API key quota ledger is unavailable", 503);
    this._write(lifetime.api, release, now);
    return false;
  }
  inspectKeyReset(keyId: string, now: number): boolean {
    let after = "",
      live = false;
    for (;;) {
      const page = this._sql.page("api_request", now, after, 100, { scope: keyId });
      for (const entry of page) {
        // Always inspect every entry, including after a live reservation was found.
        const reserved = this._resetReservation(keyId, entry.encoded, entry.row.value, now);
        live = live || reserved;
      }
      if (page.length < 100) break;
      after = page[page.length - 1].encoded;
    }
    return live;
  }
  deleteForKey(keyId: string, now: number): void {
    for (const table of ["api_request", "api_window", "principal_resolution"] as const) {
      for (;;) {
        const page = this._sql.page(table, now, "", 100, { scope: keyId });
        for (const entry of page) this._sql.delete(table, entry.key);
        if (page.length < 100) break;
      }
    }
  }
}

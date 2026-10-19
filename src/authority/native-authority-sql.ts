import {
  NativeAuthorityError,
  nativeObject,
  type NativeKey,
  type NativeRows,
  type NativeSqlStorage,
  type NativeTable,
  type NativeRead,
  type NativeCapability,
  type NativeAttempt,
} from "./native-authority-contracts.ts";
import { apiKeyHashKey } from "../api-keys.ts";
import { hasStrictPaidFallbackPolicy } from "./native-paid-policy.ts";
import { apiKeyPolicyFromHashRecord } from "./native-api-key-policy.ts";

const TABLES: readonly NativeTable[] = [
  "retained_history_grant",
  "runtime_grant",
  "runtime_request",
  "key_control_grant",
  "principal_resolution",
  "api_key_id",
  "api_key_hash",
  "api_key_audit",
  "key_control_receipt",
  "kernel_default",
  "authority_config",
  "capability",
  "api_policy",
  "api_window",
  "api_request",
  "kernel_policy",
  "kernel_window",
  "kernel_reservation",
  "kernel_cutover",
  "codex_pool",
  "codex_routing",
  "codex_active",
  "codex_capacity",
  "codex_owner",
  "codex_reset",
  "paid_request",
  "paid_window",
  "paid_pending",
  "paid_gate",
  "paid_lease",
  "paid_backfill_lease",
  "paid_rollup",
  "paid_deletion_guard",
  "request_lifetime",
  "attempt_lifetime",
  "cursor",
  "operation_receipt",
];
const tableName = (table: NativeTable): string => {
  if (!TABLES.includes(table)) throw new NativeAuthorityError("invalid_table", 400);
  return `uos_native_${table}`;
};
/** FoundationDB tuple tags match the pinned native @deno/kv key codec. Hex preserves byte order in SQLite TEXT. */
const bytesPart = (part: string | Uint8Array): number[] => {
  const result = [typeof part === "string" ? 2 : 1];
  const input = typeof part === "string" ? new TextEncoder().encode(part) : part;
  for (const byte of input) {
    result.push(byte);
    if (byte === 0) result.push(255);
  }
  return [...result, 0];
};
const numberPart = (part: number): number[] => {
  if (Number.isNaN(part)) throw new NativeAuthorityError("nonportable_native_key", 500);
  const buffer = new Uint8Array(8);
  new DataView(buffer.buffer).setFloat64(0, part, false);
  if (buffer[0] & 128) {
    for (let i = 0; i < 8; i++) buffer[i] ^= 255;
  } else buffer[0] ^= 128;
  return [33, ...buffer];
};
const bigintPart = (part: bigint): number[] => {
  const negative = part < 0n;
  let value = negative ? -part : part;
  const body: number[] = [];
  while (value > 0n) {
    body.unshift(Number(value & 255n));
    value >>= 8n;
  }
  if (body.length === 0) return [20];
  if (body.length > 255) throw new NativeAuthorityError("native_bigint_key_too_large", 500);
  let tag = negative ? 11 : 29;
  if (body.length <= 8) tag = negative ? 20 - body.length : 20 + body.length;
  const prefix = body.length > 8 ? [tag, negative ? 255 - body.length : body.length] : [tag];
  return [...prefix, ...body.map((byte) => (negative ? 255 - byte : byte))];
};
const packedPart = (part: NativeKey[number]): number[] => {
  if (typeof part === "string" || part instanceof Uint8Array) return bytesPart(part);
  if (typeof part === "number") return numberPart(part);
  if (typeof part === "bigint") return bigintPart(part);
  return [part ? 39 : 38];
};
export const nativeKey = (key: NativeKey): string =>
  key
    .flatMap(packedPart)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const jsonPart = (part: NativeKey[number]): Readonly<{ part: unknown }> => {
  if (part instanceof Uint8Array) return { part: { bytes: Array.from(part) } };
  if (typeof part === "bigint") return { part: { bigint: String(part) } };
  if (typeof part === "number" && Object.is(part, -0)) return { part: { negativeZero: true } };
  return { part };
};
const keyJson = (key: NativeKey): string => JSON.stringify(key.map((part) => jsonPart(part).part));
const parsedPart = (part: unknown): Readonly<{ value: NativeKey[number] }> => {
  if (typeof part === "string" || typeof part === "number" || typeof part === "boolean") return { value: part };
  if (
    nativeObject(part) &&
    Array.isArray(part.bytes) &&
    part.bytes.every((byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
    return { value: new Uint8Array(part.bytes) };
  if (nativeObject(part) && typeof part.bigint === "string") return { value: BigInt(part.bigint) };
  if (nativeObject(part) && part.negativeZero === true) return { value: -0 };
  throw new NativeAuthorityError("malformed_native_key", 503);
};
const parseKey = (encoded: string): NativeKey => {
  const values: unknown = JSON.parse(encoded);
  if (!Array.isArray(values)) throw new NativeAuthorityError("malformed_native_key", 503);
  return values.map((part: unknown) => parsedPart(part).value);
};
/** Private row adapter. Only closed family operations are exposed by the RPC layer. */
export class NativeAuthoritySql {
  constructor(
    private readonly _storage: NativeSqlStorage,
    readonly namespace: string,
    readonly epoch: string
  ) {
    _storage.transactionSync(() => {
      _storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS uos_native_authority_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, namespace TEXT NOT NULL, epoch TEXT NOT NULL, sequence INTEGER NOT NULL, initialized INTEGER NOT NULL DEFAULT 0)"
      );
      for (const table of TABLES) {
        const name = tableName(table);
        _storage.sql.exec(
          `CREATE TABLE IF NOT EXISTS ${name} (row_key TEXT PRIMARY KEY, key_json TEXT NOT NULL, row_json TEXT NOT NULL, revision TEXT NOT NULL, expires_at_ms INTEGER NULL, scope_key TEXT NULL, parent_key TEXT NULL, due_at_ms INTEGER NULL)`
        );
        _storage.sql.exec(`CREATE INDEX IF NOT EXISTS ${name}_scope ON ${name}(scope_key, row_key)`);
        _storage.sql.exec(`CREATE INDEX IF NOT EXISTS ${name}_parent ON ${name}(parent_key, row_key)`);
        _storage.sql.exec(`CREATE INDEX IF NOT EXISTS ${name}_expiry ON ${name}(expires_at_ms)`);
      }
      _storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS uos_native_attempt_billing ON uos_native_attempt_lifetime(scope_key,json_extract(row_json,'$.billingRequestId'))"
      );
      const found = _storage.sql.exec("SELECT * FROM uos_native_authority_meta WHERE id=1").toArray();
      if (found.length === 0) _storage.sql.exec("INSERT INTO uos_native_authority_meta VALUES(1,3,?,?,0,0)", namespace, epoch);
      this.assertEpoch();
    });
  }
  assertEpoch(): void {
    const row = this._storage.sql.exec("SELECT * FROM uos_native_authority_meta WHERE id=1").toArray().at(0);
    if (row?.schema_version !== 3 || row.namespace !== this.namespace || row.epoch !== this.epoch || !Number.isSafeInteger(row.sequence))
      throw new NativeAuthorityError("authority_schema_or_epoch_mismatch", 503);
  }
  transaction<T>(callback: () => T): T {
    return this._storage.transactionSync(() => {
      this.assertEpoch();
      const result = callback();
      if (result instanceof Promise) throw new NativeAuthorityError("async_transaction_forbidden", 500);
      return result;
    });
  }
  read<T extends NativeTable>(table: T, key: NativeKey, now: number): NativeRead<NativeRows[T]> {
    const row = this._storage.sql
      .exec(
        `SELECT row_json,revision,expires_at_ms FROM ${tableName(table)} WHERE row_key=? AND (expires_at_ms IS NULL OR expires_at_ms>?)`,
        nativeKey(key),
        now
      )
      .toArray()
      .at(0);
    if (!row) return { value: null, revision: null, versionstamp: null, expiresAtMs: null };
    if (
      typeof row.row_json !== "string" ||
      typeof row.revision !== "string" ||
      (row.expires_at_ms !== null && (typeof row.expires_at_ms !== "number" || !Number.isSafeInteger(row.expires_at_ms)))
    )
      throw new NativeAuthorityError("malformed_native_row", 503);
    const value: unknown = JSON.parse(row.row_json);
    if (table !== "kernel_default" && !nativeObject(value)) throw new NativeAuthorityError("malformed_native_row", 503);
    return { value: value as NativeRows[T], revision: row.revision, versionstamp: row.revision, expiresAtMs: row.expires_at_ms };
  }
  write<T extends NativeTable>(
    table: T,
    key: NativeKey,
    value: NativeRows[T],
    expiresAtMs: number | null = null,
    index: Readonly<{ scope?: string; parent?: string; due?: number }> = {}
  ): void {
    if ((table !== "kernel_default" && !nativeObject(value)) || (expiresAtMs !== null && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0)))
      throw new NativeAuthorityError("invalid_native_write", 500);
    const next = this._storage.sql
      .exec("UPDATE uos_native_authority_meta SET sequence=sequence+1 WHERE id=1 AND sequence<9007199254740991 RETURNING sequence")
      .toArray()
      .at(0)?.sequence;
    if (typeof next !== "number") throw new NativeAuthorityError("authority_revision_exhausted", 503);
    this._storage.sql.exec(
      `INSERT INTO ${tableName(table)} (row_key,key_json,row_json,revision,expires_at_ms,scope_key,parent_key,due_at_ms) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(row_key) DO UPDATE SET row_json=excluded.row_json,revision=excluded.revision,expires_at_ms=excluded.expires_at_ms,scope_key=excluded.scope_key,parent_key=excluded.parent_key,due_at_ms=excluded.due_at_ms`,
      nativeKey(key),
      keyJson(key),
      JSON.stringify(value),
      `r${String(next).padStart(20, "0")}`,
      expiresAtMs,
      index.scope ?? null,
      index.parent ?? null,
      index.due ?? null
    );
  }
  delete(table: NativeTable, key: NativeKey): void {
    this._storage.sql.exec(`DELETE FROM ${tableName(table)} WHERE row_key=?`, nativeKey(key));
  }
  page<T extends NativeTable>(
    table: T,
    now: number,
    after: string,
    limit: number,
    filter: Readonly<{ scope?: string; parent?: string }> = {}
  ): Readonly<{ key: NativeKey; encoded: string; row: NativeRead<NativeRows[T]> }>[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new NativeAuthorityError("invalid_page_limit", 400);
    const column = filter.parent !== undefined ? "parent_key" : "scope_key";
    const match = filter.parent ?? filter.scope;
    const rows = this._storage.sql
      .exec(
        `SELECT row_key,key_json FROM ${tableName(table)} WHERE row_key>? AND (expires_at_ms IS NULL OR expires_at_ms>?)${match === undefined ? "" : " AND " + column + "=?"} ORDER BY row_key LIMIT ?`,
        after,
        now,
        ...(match === undefined ? [] : [match]),
        limit
      )
      .toArray();
    return rows.map((row) => {
      if (typeof row.row_key !== "string") throw new NativeAuthorityError("malformed_native_key", 503);
      if (typeof row.key_json !== "string") throw new NativeAuthorityError("malformed_native_key", 503);
      const key = parseKey(row.key_json);
      return { key, encoded: row.row_key, row: this.read(table, key, now) };
    });
  }
  initialize(callback: () => void): void {
    this.transaction(() => {
      const row = this._storage.sql.exec("SELECT initialized FROM uos_native_authority_meta WHERE id=1").toArray().at(0);
      if (row?.initialized === 1) return;
      if (row?.initialized !== 0) throw new NativeAuthorityError("authority_initialization_malformed", 503);
      callback();
      this._storage.sql.exec("UPDATE uos_native_authority_meta SET initialized=1 WHERE id=1");
    });
  }
  earliestPaidDue(now: number): number | null {
    const result = this._storage.sql
      .exec("SELECT MIN(due_at_ms) AS due FROM uos_native_paid_pending WHERE expires_at_ms IS NULL OR expires_at_ms>?", now)
      .toArray()
      .at(0)?.due;
    if (result === null) return null;
    if (typeof result !== "number" || !Number.isSafeInteger(result)) throw new NativeAuthorityError("pending_due_malformed", 503);
    return result;
  }
  paidAttempt(keyId: string, billingRequestId: string, now: number): NativeAttempt | null {
    const rows = this._storage.sql
      .exec(
        "SELECT row_json FROM uos_native_attempt_lifetime WHERE scope_key=? AND json_extract(row_json,'$.billingRequestId')=? AND (expires_at_ms IS NULL OR expires_at_ms>?) LIMIT 2",
        keyId,
        billingRequestId,
        now
      )
      .toArray();
    if (rows.length > 1) throw new NativeAuthorityError("paid_attempt_identity_conflict", 503);
    const encoded = rows.at(0)?.row_json;
    if (encoded === undefined) return null;
    if (typeof encoded !== "string") throw new NativeAuthorityError("paid_attempt_malformed", 503);
    const row: unknown = JSON.parse(encoded);
    if (!nativeObject(row) || typeof row.handle !== "string") throw new NativeAuthorityError("paid_attempt_malformed", 503);
    return this.read("attempt_lifetime", [row.handle], now).value;
  }
  capability(id: string, now: number): NativeCapability {
    const cap = this.read("capability", [id], now).value;
    if (!cap || cap.revoked || cap.epoch !== this.epoch) throw new NativeAuthorityError("capability_revoked_or_wrong_epoch", 403);
    return cap;
  }
  principalReference(id: string, keyId: string, now: number): NativeRows["principal_resolution"] | null {
    const rows = this._storage.sql
      .exec(
        "SELECT key_json FROM uos_native_principal_resolution WHERE scope_key=? AND json_extract(row_json,'$.id')=? AND (expires_at_ms IS NULL OR expires_at_ms>?) LIMIT 2",
        keyId,
        id,
        now
      )
      .toArray();
    if (rows.length > 1) throw new NativeAuthorityError("principal_reference_identity_conflict", 503);
    const encoded = rows.at(0)?.key_json;
    if (encoded === undefined) return null;
    if (typeof encoded !== "string") throw new NativeAuthorityError("principal_reference_malformed", 503);
    return this.read("principal_resolution", parseKey(encoded), now).value;
  }
  currentKeyPolicy(tokenHash: string | null, keyId: string | null, now: number) {
    if (tokenHash === null || keyId === null) return null;
    const source = this.read("api_policy", apiKeyHashKey(tokenHash), now);
    if (source.value?.api.key_id !== keyId) return null;
    const raw = this.read("api_key_hash", apiKeyHashKey(tokenHash), now).value;
    if (raw?.id !== keyId || raw.revoked_at_ms !== null || !hasStrictPaidFallbackPolicy(raw)) return null;
    const api = apiKeyPolicyFromHashRecord(tokenHash, raw, now);
    if (!api) return null;
    // API admission rolls this source anchor at its own request time. Paid admission
    // must retain it so an older request still selects its original billing window.
    const anchored = { ...api, window_start_ms: raw.usage_reset_at_ms - api.window_ms, usage_reset_at_ms: raw.usage_reset_at_ms };
    return { ...source, value: { ...source.value, api: anchored } };
  }
}

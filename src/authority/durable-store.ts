import { AuthorityError, sameScope, type AuthorityScope, type AuthoritySnapshot, type AuthorityState, type AuthorityStore } from "./contracts.ts";

/** The actual platform storage is injected; no platform shim or local fallback. */
export type AuthoritySqlStorage = Readonly<{
  sql: { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<TResult>(callback: () => TResult): TResult;
}>;
type Guard = (value: unknown) => boolean;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text: Guard = (value) => typeof value === "string";
const number: Guard = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const boolean: Guard = (value) => typeof value === "boolean";
const oneOf =
  (...values: unknown[]): Guard =>
  (value) =>
    values.includes(value);
const nullable =
  (guard: Guard): Guard =>
  (value) =>
    value === null || guard(value);
const array =
  (guard: Guard): Guard =>
  (value) =>
    Array.isArray(value) && value.every(guard);
const dictionary =
  (guard: Guard): Guard =>
  (value) =>
    record(value) && Object.values(value).every(guard);
const fields =
  (shape: Readonly<Record<string, Guard>>): Guard =>
  (value) =>
    record(value) &&
    Object.keys(value).length === Object.keys(shape).length &&
    Object.entries(shape).every(([key, guard]) => Object.hasOwn(value, key) && guard(value[key]));
const scopeGuard = fields({ namespace: text, epoch: number });
const proof = fields({
  kind: oneOf("quota_exhausted", "credential_invalid", "transient"),
  model: text,
  fingerprint: text,
  observedAtMs: number,
  validUntilMs: number,
});
const account = fields({
  accountId: text,
  fingerprint: text,
  credentialGeneration: number,
  routingGeneration: number,
  resetGeneration: number,
  overageVersion: number,
  overageEnabled: boolean,
  enabled: boolean,
  models: array(text),
  proof: nullable(proof),
});
const handle = fields({ scope: scopeGuard, requestId: text, fence: number });
const terminal = fields({
  outcome: oneOf("completed", "incomplete", "failed", "cancelled"),
  providerRequestId: nullable(text),
  spendMicrocredits: nullable(number),
  fallback: oneOf(null, "quota_exhausted", "capacity_exhausted"),
});
const attempt = fields({
  input: fields({ attemptId: text, provider: oneOf("codex", "surplus", "openlux"), maximumExposureMicrocredits: number, account: nullable(account) }),
  state: oneOf("reserved", "dispatch_intent", "dispatched", "not_dispatched"),
  terminal: nullable(terminal),
  billingSettled: boolean,
  settledSpendMicrocredits: nullable(number),
});
const admission = fields({
  handle,
  principalId: text,
  policyVersion: number,
  windowKey: text,
  digest: text,
  route: oneOf("/v1/responses", "/v1/chat/completions"),
  model: text,
  account: nullable(account),
  activeGeneration: nullable(number),
  attempts: dictionary(attempt),
  dispatched: boolean,
  semantic: oneOf(null, "completed", "incomplete", "failed", "cancelled"),
  kernelSettled: boolean,
  delivery: oneOf(null, "delivered", "interrupted", "unobserved"),
  settled: boolean,
});
const stateGuard = fields({
  scope: scopeGuard,
  sequence: number,
  accounts: array(account),
  active: nullable(fields({ accountId: text, fingerprint: text, generation: number })),
  policies: dictionary(
    fields({
      principalId: text,
      version: number,
      deleted: boolean,
      windowResetAtMs: number,
      requestLimit: number,
      kernelLimit: number,
      concurrencyLimit: number,
      paidLimitMicrocredits: number,
    })
  ),
  windows: dictionary(
    fields({
      reserved: number,
      dispatched: number,
      kernelReserved: number,
      kernelCompleted: number,
      active: number,
      paidReservedMicrocredits: number,
      paidSettledMicrocredits: number,
    })
  ),
  admissions: dictionary(admission),
  publications: dictionary(
    fields({
      ownerId: text,
      ownerEpoch: number,
      accountId: text,
      workspaceId: text,
      generation: number,
      nativeRefreshedAtNs: text,
      fingerprint: text,
      accessToken: text,
      idToken: text,
      issuedAtMs: number,
      expiresAtMs: number,
    })
  ),
});
const SCHEMA_VERSION = 1;
const TABLE = "uos_authority_atom";

/** One bounded coordination atom; migrations, retention and production scale are separate. */
export class DurableAuthorityStore implements AuthorityStore {
  private readonly _scope: AuthorityScope;

  constructor(
    private readonly _storage: AuthoritySqlStorage,
    initial: AuthorityState,
    private readonly _maximumStateBytes: number
  ) {
    if (!Number.isSafeInteger(_maximumStateBytes) || _maximumStateBytes < 1) throw new AuthorityError("invalid_authority_storage_bound", 400);
    this._scope = structuredClone(initial.scope);
    const encoded = this._encode(initial);
    _storage.transactionSync(() => {
      _storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL)`
      );
      const rows = _storage.sql.exec(`SELECT schema_version, revision, state_json FROM ${TABLE} WHERE id = 1`).toArray();
      if (rows.length === 0) _storage.sql.exec(`INSERT INTO ${TABLE} (id, schema_version, revision, state_json) VALUES (1, ?, 0, ?)`, SCHEMA_VERSION, encoded);
      this._read();
    });
  }

  private _bounded(encoded: string): void {
    if (new TextEncoder().encode(encoded).byteLength > this._maximumStateBytes) throw new AuthorityError("authority_state_too_large", 503);
  }

  private _encode(state: AuthorityState): string {
    if (!stateGuard(state)) throw new AuthorityError("invalid_authority_state", 503);
    if (!sameScope(state.scope, this._scope)) throw new AuthorityError("namespace_or_epoch_mismatch", 403);
    const encoded = JSON.stringify(state);
    this._bounded(encoded);
    return encoded;
  }

  private _read(): AuthoritySnapshot {
    const rows = this._storage.sql.exec(`SELECT schema_version, revision, state_json FROM ${TABLE} WHERE id = 1`).toArray();
    const row = rows[0];
    if (rows.length !== 1 || row.schema_version !== SCHEMA_VERSION) throw new AuthorityError("authority_schema_mismatch", 503);
    if (typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0 || typeof row.state_json !== "string")
      throw new AuthorityError("invalid_authority_record", 503);
    this._bounded(row.state_json);
    let state: unknown;
    try {
      state = JSON.parse(row.state_json);
    } catch {
      throw new AuthorityError("invalid_authority_state", 503);
    }
    if (!stateGuard(state)) throw new AuthorityError("invalid_authority_state", 503);
    const accepted = state as AuthorityState;
    if (!sameScope(accepted.scope, this._scope)) throw new AuthorityError("namespace_or_epoch_mismatch", 403);
    return { revision: row.revision, state: accepted };
  }

  read(): Promise<AuthoritySnapshot> {
    return Promise.resolve(this._read());
  }

  compareAndSwap(revision: number, state: AuthorityState): Promise<boolean> {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new AuthorityError("invalid_authority_revision", 400);
    const encoded = this._encode(state);
    const committed = this._storage.transactionSync(() => {
      if (this._read().revision !== revision) return false;
      const rows = this._storage.sql
        .exec(`UPDATE ${TABLE} SET revision = ?, state_json = ? WHERE id = 1 AND revision = ? RETURNING revision`, revision + 1, encoded, revision)
        .toArray();
      return rows.length === 1;
    });
    return Promise.resolve(committed);
  }
}

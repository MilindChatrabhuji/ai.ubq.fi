import {
  lookup,
  AuthorityError,
  sameEvidence,
  sameScope,
  type AccessAuthorization,
  type AuthorityScope,
  type AuthorityStore,
  type AuthorityState,
} from "./contracts.ts";

export type CredentialOwnerBinding = Readonly<{
  scope: AuthorityScope;
  ownerId: string;
  ownerEpoch: number;
  accountId: string;
  workspaceId: string;
  minimumNativeRefreshedAtNs: string;
}>;
export type AccessPublication = AccessAuthorization & Readonly<{ previousGeneration: number }>;
export type VerifiedAccessIdentity = Readonly<{ accountId: string; workspaceId: string; fingerprint: string; issuedAtMs: number; expiresAtMs: number }>;
export type AccessVerifier = (publication: AccessPublication) => Promise<VerifiedAccessIdentity>;
const FIELDS = new Set([
  "ownerId",
  "ownerEpoch",
  "accountId",
  "workspaceId",
  "generation",
  "previousGeneration",
  "nativeRefreshedAtNs",
  "fingerprint",
  "accessToken",
  "idToken",
  "issuedAtMs",
  "expiresAtMs",
]);

/** Fixed owner capability; access-only publication has no renewal or native transport API. */
export class CredentialPublisher {
  constructor(
    private readonly _store: AuthorityStore,
    private readonly _binding: CredentialOwnerBinding,
    private readonly _verifyAccess: AccessVerifier
  ) {}

  private _validateBinding(input: AccessPublication): void {
    if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !FIELDS.has(key))) throw new AuthorityError("unexpected_credential_field", 400);
    if (
      input.ownerId !== this._binding.ownerId ||
      input.ownerEpoch !== this._binding.ownerEpoch ||
      input.accountId !== this._binding.accountId ||
      input.workspaceId !== this._binding.workspaceId
    )
      throw new AuthorityError("credential_owner_binding_mismatch", 403);
  }

  private _validateGeneration(input: AccessPublication, nowMs: number): void {
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.previousGeneration !== input.generation - 1 ||
      !/^\d+$/.test(input.nativeRefreshedAtNs) ||
      !input.accessToken ||
      !input.idToken ||
      !input.fingerprint ||
      !Number.isSafeInteger(input.expiresAtMs) ||
      !Number.isSafeInteger(input.issuedAtMs) ||
      input.issuedAtMs > nowMs ||
      input.expiresAtMs <= nowMs + 120_000
    )
      throw new AuthorityError("credential_generation_invalid", 403);
  }

  private _applyPublication(state: AuthorityState, input: AccessPublication, authorization: AccessAuthorization): "published" | "duplicate" {
    const current = lookup(state.publications, input.accountId);
    const accountIndex = state.accounts.findIndex((account) => account.accountId === input.accountId);
    const account = state.accounts.find((value) => value.accountId === input.accountId);
    if (!account) throw new AuthorityError("credential_account_missing", 403);
    if (current?.generation === input.generation) {
      if (!sameEvidence(current, authorization)) throw new AuthorityError("credential_generation_conflict");
      return "duplicate";
    }
    if (
      current &&
      (current.ownerId !== this._binding.ownerId || current.ownerEpoch !== this._binding.ownerEpoch || current.workspaceId !== this._binding.workspaceId)
    )
      throw new AuthorityError("credential_owner_binding_mismatch", 403);
    if (
      (current?.generation ?? account.credentialGeneration) !== input.previousGeneration ||
      (current && (BigInt(input.nativeRefreshedAtNs) <= BigInt(current.nativeRefreshedAtNs) || input.expiresAtMs < current.expiresAtMs))
    )
      throw new AuthorityError("credential_generation_conflict");
    state.publications[input.accountId] = authorization;
    state.accounts[accountIndex] = { ...account, fingerprint: input.fingerprint, credentialGeneration: input.generation, proof: null };
    // A same-account publication keeps the durable global account generation.
    if (state.active?.accountId === input.accountId) state.active = { ...state.active, fingerprint: input.fingerprint };
    return "published";
  }

  async publish(input: AccessPublication, nowMs: number): Promise<"published" | "duplicate"> {
    this._validateBinding(input);
    this._validateGeneration(input, nowMs);
    const identity = await this._verifyAccess(input);
    if (
      identity.accountId !== input.accountId ||
      identity.workspaceId !== input.workspaceId ||
      identity.fingerprint !== input.fingerprint ||
      identity.issuedAtMs !== input.issuedAtMs ||
      identity.expiresAtMs !== input.expiresAtMs ||
      BigInt(input.nativeRefreshedAtNs) <= BigInt(this._binding.minimumNativeRefreshedAtNs)
    )
      throw new AuthorityError("credential_identity_mismatch", 403);
    const authorization: AccessAuthorization = {
      ownerId: input.ownerId,
      ownerEpoch: input.ownerEpoch,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      generation: input.generation,
      nativeRefreshedAtNs: input.nativeRefreshedAtNs,
      fingerprint: input.fingerprint,
      accessToken: input.accessToken,
      idToken: input.idToken,
      issuedAtMs: input.issuedAtMs,
      expiresAtMs: input.expiresAtMs,
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await this._store.read();
      if (!sameScope(snapshot.state.scope, this._binding.scope)) throw new AuthorityError("namespace_or_epoch_mismatch", 403);
      const state = structuredClone(snapshot.state);
      const outcome = this._applyPublication(state, input, authorization);
      if (await this._store.compareAndSwap(snapshot.revision, state)) return outcome;
    }
    throw new AuthorityError("concurrent_update", 503);
  }
}

import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createAuthorityState, PortableAuthority } from "../src/authority/admission-state.ts";
import { CredentialPublisher, type AccessPublication } from "../src/authority/credential-publication.ts";
import type { AccountBinding, AuthorityStore } from "../src/authority/contracts.ts";

const scope = { namespace: "synthetic-publication", epoch: 1 };
const fixture = () => {
  const account: AccountBinding = {
    accountId: "a",
    fingerprint: "old",
    credentialGeneration: 0,
    routingGeneration: 1,
    resetGeneration: 1,
    overageVersion: 1,
    overageEnabled: false,
    enabled: true,
    models: ["fixture"],
    proof: null,
  };
  let state = createAuthorityState(scope, [account], []);
  state.active = { accountId: "a", fingerprint: "old", generation: 7 };
  let revision = 0;
  const store: AuthorityStore = {
    read() {
      return Promise.resolve({ revision, state: structuredClone(state) });
    },
    compareAndSwap(expected, value) {
      if (expected !== revision) return Promise.resolve(false);
      state = structuredClone(value);
      revision += 1;
      return Promise.resolve(true);
    },
  };
  const binding = { scope, ownerId: "owner", ownerEpoch: 3, accountId: "a", workspaceId: "workspace", minimumNativeRefreshedAtNs: "1000000000000000001" };
  const publisher = new CredentialPublisher(store, binding, (value) =>
    Promise.resolve({
      accountId: value.accountId,
      workspaceId: value.workspaceId,
      fingerprint: value.fingerprint,
      issuedAtMs: value.issuedAtMs,
      expiresAtMs: value.expiresAtMs,
    })
  );
  return { publisher, state: () => state, store, binding };
};
const publication: AccessPublication = {
  ownerId: "owner",
  ownerEpoch: 3,
  accountId: "a",
  workspaceId: "workspace",
  generation: 1,
  previousGeneration: 0,
  nativeRefreshedAtNs: "1000000000000000002",
  fingerprint: "new",
  accessToken: "synthetic-access",
  idToken: "synthetic-id",
  issuedAtMs: 900,
  expiresAtMs: 200_000,
};

test("access-only publication advances precise generation once and preserves global active identity", async () => {
  const f = fixture();
  expect(await f.publisher.publish(publication, 1_000)).toBe("published");
  expect(await f.publisher.publish(publication, 1_000)).toBe("duplicate");
  expect(f.state().active).toEqual({ accountId: "a", fingerprint: "new", generation: 7 });
  expect(f.state().accounts[0].credentialGeneration).toBe(1);
  expect(f.state().publications.a).not.toHaveProperty("previousGeneration");
  expect(
    await new PortableAuthority(f.store, scope)
      .resetEligible({ scope, requestId: "missing", fence: 1 }, 1_000)
      .catch((error: unknown) => (error instanceof Error ? error.message : "unexpected"))
  ).toBe("admission_fence_mismatch");
});

test("refresh material, arbitrary destinations and unknown credential fields are rejected", async () => {
  const f = fixture();
  for (const field of ["refreshToken", "refresh_token", "url", "socketPath", "namespace"]) {
    await assert.rejects(f.publisher.publish({ ...publication, [field]: "forbidden" }, 1_000), /unexpected_credential_field/);
  }
  expect(Object.keys(f.state().publications)).toHaveLength(0);
});

test("owner epoch, workspace, identity verifier and native generation cannot be substituted", async () => {
  const f = fixture();
  await assert.rejects(f.publisher.publish({ ...publication, ownerEpoch: 4 }, 1_000), /credential_owner_binding_mismatch/);
  await assert.rejects(f.publisher.publish({ ...publication, workspaceId: "another" }, 1_000), /credential_owner_binding_mismatch/);
  await assert.rejects(f.publisher.publish({ ...publication, nativeRefreshedAtNs: "1000000000000000001" }, 1_000), /credential_identity_mismatch/);
  const badVerifier = new CredentialPublisher(f.store, f.binding, (value) =>
    Promise.resolve({
      accountId: "different",
      workspaceId: value.workspaceId,
      fingerprint: value.fingerprint,
      issuedAtMs: value.issuedAtMs,
      expiresAtMs: value.expiresAtMs,
    })
  );
  await assert.rejects(badVerifier.publish(publication, 1_000), /credential_identity_mismatch/);
});

test("conflicting replay, expired access and wrong authority namespace fail closed", async () => {
  const f = fixture();
  await f.publisher.publish(publication, 1_000);
  await assert.rejects(f.publisher.publish({ ...publication, accessToken: "conflict" }, 1_000), /credential_generation_conflict/);
  await assert.rejects(f.publisher.publish({ ...publication, expiresAtMs: 2_000 }, 1_000), /credential_generation_invalid/);
  const renewed = { ...publication, generation: 2, previousGeneration: 1, nativeRefreshedAtNs: "1000000000000000003", expiresAtMs: 150_000 };
  await assert.rejects(f.publisher.publish(renewed, 1_000), /credential_generation_conflict/);
  const missing = fixture();
  missing.state().accounts = [];
  await assert.rejects(missing.publisher.publish(publication, 1_000), /credential_account_missing/);
  f.state().scope = { ...scope, epoch: 2 };
  await assert.rejects(f.publisher.publish(publication, 1_000), /namespace_or_epoch_mismatch/);
});

import type { Kv, KvEntryMaybe } from "#kv";
import { isRecord, sha256Hex } from "../utils.ts";
import type { ClaudeCodeEnvLookup } from "./claude-code.ts";
import {
  CLAUDE_CODE_AUTH_KV_KEY,
  CLAUDE_CODE_WORKSPACE_KV_KEY,
  parseClaudeCodeStoredCredential,
  parseClaudeCodeWorkspaceState,
  readClaudeCodeEnvCredential,
  readClaudeCodeWorkspaceIdEnv,
  type ClaudeCodeCredentialKind,
  type ClaudeCodeResolvedCredential,
  type ClaudeCodeWorkspaceState,
} from "./claude-code-credentials.ts";

export const CLAUDE_CODE_ACCOUNTS_KEY = ["uos_ai", "claude_code_accounts", "v1"] as const;
const MAX_ACCOUNTS = 32;
const MAX_CAS_ATTEMPTS = 12;

/** Locally assigned identity; neither a label nor an opaque ID verifies provider identity. */
export type ClaudeCodeAccountBinding = Readonly<{
  account_id: string;
  account_cohort_id: string;
  credential_fingerprint: string;
  evidence_generation: string;
  credential: ClaudeCodeResolvedCredential;
  workspace: ClaudeCodeWorkspaceState | null;
}>;
export type ClaudeCodeAccountStore = Readonly<{
  v: 1;
  accounts: readonly ClaudeCodeAccountBinding[];
  active_account_id: string | null;
  active_reason: string;
  updated_at_ms: number;
}>;
/** Dispatch-only secret-bearing value. Never serialize this binding into admin JSON. */
export type ClaudeCodeAccountIdentity = Readonly<{
  account_id: string;
  account_cohort_id: string;
  credential_kind: ClaudeCodeCredentialKind;
  workspace_id: string | null;
}>;
export const claudeCodeAccountIdentity = (binding: ClaudeCodeAccountBinding): ClaudeCodeAccountIdentity => ({
  account_id: binding.account_id,
  account_cohort_id: binding.account_cohort_id,
  credential_kind: binding.credential.kind,
  workspace_id: binding.workspace?.id ?? null,
});

const opaqueId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const fingerprint = (credential: ClaudeCodeResolvedCredential, workspace: ClaudeCodeWorkspaceState | null): Promise<string> =>
  sha256Hex(JSON.stringify([credential.kind, credential.secret, workspace?.id ?? null]));

const parseAccount = (value: unknown): ClaudeCodeAccountBinding | null => {
  if (!isRecord(value) || !opaqueId(value.account_id) || !opaqueId(value.account_cohort_id) || !opaqueId(value.evidence_generation)) return null;
  if (typeof value.credential_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.credential_fingerprint) || !isRecord(value.credential)) return null;
  const raw = value.credential;
  const parsed = parseClaudeCodeStoredCredential({ ...raw, updated_at_ms: raw.updated_at_ms ?? 1 });
  if (!parsed || !["kv", "CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].includes(String(raw.source))) return null;
  const workspace = value.workspace === null ? null : parseClaudeCodeWorkspaceState(value.workspace);
  if (value.workspace !== null && !workspace) return null;
  return {
    account_id: value.account_id,
    account_cohort_id: value.account_cohort_id,
    credential_fingerprint: value.credential_fingerprint,
    evidence_generation: value.evidence_generation,
    credential: {
      ...parsed,
      source: raw.source as ClaudeCodeResolvedCredential["source"],
      updated_at_ms: raw.updated_at_ms === null ? null : parsed.updated_at_ms,
    },
    workspace,
  };
};

export const parseClaudeCodeAccountStore = (value: unknown): ClaudeCodeAccountStore | null => {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS) return null;
  const accounts = value.accounts.map(parseAccount);
  if (accounts.some((account) => account === null)) return null;
  const valid = accounts.filter((account): account is ClaudeCodeAccountBinding => account !== null);
  if (new Set(valid.map((account) => account.account_id)).size !== valid.length) return null;
  if (value.active_account_id !== null && !valid.some((account) => account.account_id === value.active_account_id)) return null;
  if (
    typeof value.active_reason !== "string" ||
    typeof value.updated_at_ms !== "number" ||
    !Number.isSafeInteger(value.updated_at_ms) ||
    value.updated_at_ms <= 0
  )
    return null;
  return {
    v: 1,
    accounts: valid,
    active_account_id: value.active_account_id as string | null,
    active_reason: value.active_reason,
    updated_at_ms: value.updated_at_ms,
  };
};

/** A present empty roster is a tombstone: old singleton/env credentials cannot resurrect. */
export const readClaudeCodeAccountStore = async (kv: Kv): Promise<ClaudeCodeAccountStore | null> => {
  const entry = await kv.get(CLAUDE_CODE_ACCOUNTS_KEY, { consistency: "strong" });
  if (entry.value === null) return null;
  const store = parseClaudeCodeAccountStore(entry.value);
  if (!store) throw new Error("Claude account roster is invalid; refusing legacy fallback");
  return store;
};

const makeAccount = async (
  credential: ClaudeCodeResolvedCredential,
  workspace: ClaudeCodeWorkspaceState | null,
  previous?: ClaudeCodeAccountBinding
): Promise<ClaudeCodeAccountBinding> => {
  const digest = await fingerprint(credential, workspace);
  const same = previous?.credential_fingerprint === digest;
  return {
    account_id: previous?.account_id ?? crypto.randomUUID(),
    account_cohort_id: same ? previous.account_cohort_id : crypto.randomUUID(),
    credential_fingerprint: digest,
    evidence_generation: same ? previous.evidence_generation : crypto.randomUUID(),
    credential,
    workspace,
  };
};

const emptyAccountStore = (): ClaudeCodeAccountStore => ({
  v: 1,
  accounts: [],
  active_account_id: null,
  active_reason: "unconfigured",
  updated_at_ms: Date.now(),
});

const bootstrapWorkspace = (value: unknown, env?: ClaudeCodeEnvLookup): ClaudeCodeWorkspaceState | null => {
  const stored = parseClaudeCodeWorkspaceState(value);
  if (stored) return stored;
  const id = readClaudeCodeWorkspaceIdEnv(env);
  return id ? { id, name: null, source: "env", discovered_at_ms: null, verified_at_ms: null, last_error: null } : null;
};

/** Exactly-once compatible bootstrap; legacy keys remain untouched and unbound evidence is not imported. */
export const loadClaudeCodeAccountStore = async (kv: Kv, env?: ClaudeCodeEnvLookup): Promise<ClaudeCodeAccountStore> => {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const [entry, legacyCredential, legacyWorkspace] = await Promise.all([
      kv.get(CLAUDE_CODE_ACCOUNTS_KEY, { consistency: "strong" }),
      kv.get(CLAUDE_CODE_AUTH_KV_KEY, { consistency: "strong" }),
      kv.get(CLAUDE_CODE_WORKSPACE_KV_KEY, { consistency: "strong" }),
    ]);
    if (entry.value !== null) {
      const store = parseClaudeCodeAccountStore(entry.value);
      if (!store) throw new Error("Claude account roster is invalid; refusing legacy fallback");
      return store;
    }
    const stored = parseClaudeCodeStoredCredential(legacyCredential.value);
    const credential: ClaudeCodeResolvedCredential | null = stored ? { ...stored, source: "kv" } : readClaudeCodeEnvCredential(env);
    // Absence is not an intentional removal: a passive read must not retire a future first credential.
    if (!credential) return emptyAccountStore();
    const workspace = bootstrapWorkspace(legacyWorkspace.value, env);
    const account = await makeAccount(credential, workspace);
    const store: ClaudeCodeAccountStore = {
      v: 1,
      accounts: [account],
      active_account_id: account.account_id,
      active_reason: "singleton_bootstrap",
      updated_at_ms: Date.now(),
    };
    const committed = await kv.atomic().check(entry, legacyCredential, legacyWorkspace).set(CLAUDE_CODE_ACCOUNTS_KEY, store).commit();
    if (committed.ok) return store;
  }
  throw new Error("Claude account bootstrap changed repeatedly");
};

export const resolveClaudeCodeAccount = async (
  kv: Kv | null,
  env?: ClaudeCodeEnvLookup,
  options: Readonly<{ accountId?: string }> = {}
): Promise<ClaudeCodeAccountBinding | null> => {
  if (!kv) return null;
  const store = await loadClaudeCodeAccountStore(kv, env);
  return store.accounts.find((account) => account.account_id === (options.accountId ?? store.active_account_id)) ?? null;
};

export const currentClaudeCodeAccountEntry = async (kv: Kv, binding: ClaudeCodeAccountBinding): Promise<KvEntryMaybe<ClaudeCodeAccountStore> | null> => {
  const entry = await kv.get<ClaudeCodeAccountStore>(CLAUDE_CODE_ACCOUNTS_KEY, { consistency: "strong" });
  const account = parseClaudeCodeAccountStore(entry.value)?.accounts.find((candidate) => candidate.account_id === binding.account_id);
  return account?.account_cohort_id === binding.account_cohort_id &&
    account.evidence_generation === binding.evidence_generation &&
    account.credential_fingerprint === binding.credential_fingerprint
    ? entry
    : null;
};
export const isClaudeCodeAccountCurrent = async (kv: Kv | null, binding: ClaudeCodeAccountBinding): Promise<boolean> =>
  kv !== null && (await currentClaudeCodeAccountEntry(kv, binding)) !== null;

type AccountUpdate = Readonly<{
  accountId?: string;
  createNew?: boolean;
  credential?: ClaudeCodeResolvedCredential;
  workspace?: ClaudeCodeWorkspaceState | null;
  activate?: boolean;
  expected?: ClaudeCodeAccountBinding;
}>;
const sameAccountBinding = (current: ClaudeCodeAccountBinding | undefined, expected: ClaudeCodeAccountBinding): boolean =>
  current?.account_id === expected.account_id &&
  current.account_cohort_id === expected.account_cohort_id &&
  current.evidence_generation === expected.evidence_generation &&
  current.credential_fingerprint === expected.credential_fingerprint;
const changedAccountStore = async (store: ClaudeCodeAccountStore, input: AccountUpdate) => {
  const previous = input.createNew ? undefined : store.accounts.find((account) => account.account_id === (input.accountId ?? store.active_account_id));
  if (input.accountId && !previous) throw new Error("Claude account was not found");
  if (input.expected && !sameAccountBinding(previous, input.expected)) throw new Error("Claude account changed before update");
  const credential = input.credential ?? previous?.credential;
  if (!credential) throw new Error("Claude credential is required");
  if (!previous && store.accounts.length >= MAX_ACCOUNTS) throw new Error("Claude account storage limit reached");
  const workspace = input.workspace === undefined ? (previous?.workspace ?? null) : input.workspace;
  const account = await makeAccount(credential, workspace, previous);
  if (!previous && store.accounts.some((configured) => configured.credential_fingerprint === account.credential_fingerprint))
    throw new Error("This credential/workspace binding is already configured");
  const accounts = previous ? store.accounts.map((item) => (item.account_id === account.account_id ? account : item)) : [...store.accounts, account];
  const activate = input.activate === true || store.active_account_id === null;
  const newActiveReason = input.activate ? "admin_selection" : "first_configured";
  const next: ClaudeCodeAccountStore = {
    ...store,
    accounts,
    active_account_id: activate ? account.account_id : store.active_account_id,
    active_reason: activate ? newActiveReason : store.active_reason,
    updated_at_ms: Date.now(),
  };
  return { account, next };
};
export const updateClaudeCodeAccount = async (kv: Kv, input: AccountUpdate, env?: ClaudeCodeEnvLookup): Promise<ClaudeCodeAccountBinding> => {
  await loadClaudeCodeAccountStore(kv, env);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const entry = await kv.get(CLAUDE_CODE_ACCOUNTS_KEY, { consistency: "strong" });
    const store = entry.value === null ? emptyAccountStore() : parseClaudeCodeAccountStore(entry.value);
    if (!store) throw new Error("Claude account roster is invalid");
    const { account, next } = await changedAccountStore(store, input);
    if ((await kv.atomic().check(entry).set(CLAUDE_CODE_ACCOUNTS_KEY, next).commit()).ok) return account;
  }
  throw new Error("Claude account update changed repeatedly");
};

export const selectClaudeCodeAccount = async (kv: Kv, accountId: string, reason = "admin_selection", expected?: ClaudeCodeAccountBinding): Promise<boolean> => {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const entry = await kv.get(CLAUDE_CODE_ACCOUNTS_KEY, { consistency: "strong" });
    const store = parseClaudeCodeAccountStore(entry.value);
    if (!store?.accounts.some((account) => account.account_id === accountId)) return false;
    if (expected && (store.active_account_id !== expected.account_id || !(await isClaudeCodeAccountCurrent(kv, expected)))) return false;
    if (store.active_account_id === accountId) return true;
    if (
      (
        await kv
          .atomic()
          .check(entry)
          .set(CLAUDE_CODE_ACCOUNTS_KEY, { ...store, active_account_id: accountId, active_reason: reason, updated_at_ms: Date.now() })
          .commit()
      ).ok
    )
      return true;
  }
  return false;
};

export const removeClaudeCodeAccount = async (kv: Kv, accountId?: string): Promise<boolean> => {
  if (!accountId) await loadClaudeCodeAccountStore(kv);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const entry = await kv.get(CLAUDE_CODE_ACCOUNTS_KEY, { consistency: "strong" });
    const store = entry.value === null ? emptyAccountStore() : parseClaudeCodeAccountStore(entry.value);
    if (!store) throw new Error("Claude account roster is invalid");
    if (accountId && !store.accounts.some((account) => account.account_id === accountId)) return false;
    const target = accountId ?? store.active_account_id;
    const accounts = store.accounts.filter((account) => account.account_id !== target);
    const removedActive = target === store.active_account_id;
    const next = {
      ...store,
      accounts,
      active_account_id: removedActive ? (accounts[0]?.account_id ?? null) : store.active_account_id,
      active_reason: removedActive ? "account_removed" : store.active_reason,
      updated_at_ms: Date.now(),
    };
    if ((await kv.atomic().check(entry).set(CLAUDE_CODE_ACCOUNTS_KEY, next).commit()).ok) return accounts.length !== store.accounts.length;
  }
  return false;
};

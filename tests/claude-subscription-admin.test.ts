import type { Kv, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  handleAdminClaudeCodeAuthDelete,
  handleAdminClaudeCodeAuthGet,
  handleAdminClaudeCodeAuthSet,
  handleAdminClaudeCodeQuotaClear,
  handleAdminClaudeCodeAccess,
  handleAdminClaudeCodeAccountActive,
} from "../src/admin/claude-code.ts";
import { setKvForTest } from "../src/kv.ts";
import {
  CLAUDE_CODE_AUTH_KV_KEY,
  CLAUDE_CODE_WORKSPACE_KV_KEY,
  loadClaudeCodeStoredCredential,
  resetClaudeCodeCredentialCacheForTest,
  resolveClaudeCodeWorkspace,
} from "../src/provider/claude-code-credentials.ts";
import { CLAUDE_CODE_CONFIG_COOLDOWN_MS, loadClaudeCodeQuotaState, recordClaudeCodeQuotaOutcome } from "../src/provider/claude-code-quota.ts";
import { resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import { resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";
import { CLAUDE_CODE_ACCOUNTS_KEY, loadClaudeCodeAccountStore, resolveClaudeCodeAccount } from "../src/provider/claude-code-accounts.ts";
import { loadClaudeCodeAccessPolicy } from "../src/provider/claude-code-access.ts";

const keyOf = (key: KvKey): string => JSON.stringify(key);

class AdminKv {
  readonly values = new Map<string, unknown>();

  atomic() {
    const writes: (() => void)[] = [];
    const operation = {
      check: (..._entries: unknown[]) => operation,
      set: (key: KvKey, value: unknown) => {
        writes.push(() => this.values.set(keyOf(key), value));
        return operation;
      },
      commit: () => {
        for (const write of writes) {
          write();
        }
        return Promise.resolve({ ok: true, versionstamp: "00000000000000000002" });
      },
    };
    return operation;
  }

  get<T>(key: KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({
      key,
      value: (stored ?? null) as T | null,
      versionstamp: stored === undefined ? null : "00000000000000000001",
    } as KvEntryMaybe<T>);
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    this.values.set(keyOf(key), value);
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" } as KvCommitResult);
  }

  delete(key: KvKey): Promise<void> {
    this.values.delete(keyOf(key));
    return Promise.resolve();
  }
}

const withAdminKv = async (run: (kv: AdminKv) => Promise<void>): Promise<void> => {
  const kv = new AdminKv();
  resetClaudeCodeCredentialCacheForTest();
  resetProviderSelectionCacheForTest();
  resetProviderHealthThrottleForTest();
  setKvForTest(kv as unknown as Kv);
  try {
    await run(kv);
  } finally {
    setKvForTest(null);
  }
};

type StubCall = Readonly<{ url: string; method: string; headers: Headers }>;

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

const withStubbedAnthropic = async (responder: (call: StubCall) => Response, run: (calls: StubCall[]) => Promise<void>): Promise<void> => {
  const originalFetch = globalThis.fetch;
  const calls: StubCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers) };
    calls.push(call);
    return Promise.resolve(responder(call));
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const modelsOk = (): Response => new Response(JSON.stringify({ data: [], has_more: false }), { status: 200, headers: { "content-type": "application/json" } });

const jsonRequest = (body: unknown, method = "POST"): Request =>
  new Request("https://ai.ubq.fi/admin/providers/claude-code/auth", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("the admin status route reports the tier without any secret material", async () => {
  await withAdminKv(async (kv) => {
    await withStubbedAnthropic(modelsOk, async () => {
      const stored = await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-usr-1A6ABCDEFGHIJKLMNOPBwAA", label: "primary" }));
      assert.equal(stored.status, 200);
      const body = await stored.json();
      assert.equal(body.data.configured, true);
      assert.equal(body.data.credential.kind, "api_key");
      assert.equal(body.data.credential.source, "kv");
      assert.equal(body.data.credential.hint, "sk-ant-usr-1A6...BwAA");
      assert.equal(body.data.credential.label, "primary");
      assert.equal(JSON.stringify(body).includes("ABCDEFGHIJ"), false, "the full secret never appears in an admin response");
      assert.equal(body.hint, "sk-ant-usr-1A6...BwAA");
      assert.equal(kv.values.has(keyOf(CLAUDE_CODE_ACCOUNTS_KEY)), true);
    });

    const status = await handleAdminClaudeCodeAuthGet();
    const payload = await status.json();
    assert.equal(payload.data.credential.hint, "sk-ant-usr-1A6...BwAA");
    assert.equal(JSON.stringify(payload).includes("ABCDEFGHIJ"), false);
  });
});

test("a rejected credential is refused upstream and never stored", async () => {
  await withAdminKv(async (kv) => {
    await withStubbedAnthropic(
      () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 }),
      async (calls) => {
        const response = await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-usr-rejected-key-abcdefghijklmnop" }));
        assert.equal(response.status, 400);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "https://api.anthropic.com/v1/models?limit=100");
        assert.equal(calls[0].headers.get("x-api-key"), "sk-ant-usr-rejected-key-abcdefghijklmnop");
      }
    );
    assert.equal(kv.values.has(keyOf([...CLAUDE_CODE_AUTH_KV_KEY])), false, "a rejected credential is not persisted");
  });
});

test("credential submissions are shape-checked before any upstream call", async () => {
  await withAdminKv(async () => {
    await withStubbedAnthropic(modelsOk, async (calls) => {
      const blank = await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "  " }));
      assert.equal(blank.status, 400);
      const wrongPrefix = await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "openai-sk-not-anthropic" }));
      assert.equal(wrongPrefix.status, 400);
      const longLabel = await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-usr-abcdefghijklmnop", label: "x".repeat(65) }));
      assert.equal(longLabel.status, 400);
      const badWorkspace = await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-usr-abcdefghijklmnop", workspace_id: "not-a-workspace" }));
      assert.equal(badWorkspace.status, 400);
      assert.equal(calls.length, 0, "no upstream validation runs for a malformed submission");
    });
  });
});

test("a workspace pin is stored, validated, and reported with its source", async () => {
  await withAdminKv(async (kv) => {
    await withStubbedAnthropic(modelsOk, async (calls) => {
      const response = await handleAdminClaudeCodeAuthSet(
        jsonRequest({ credential: "sk-ant-usr-1A6ABCDEFGHIJKLMNOPBwAA", workspace_id: "wrkspc_01ErorW3iFLRvQy55cpNWtEt" })
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.workspace.id, "wrkspc_01ErorW3iFLRvQy55cpNWtEt");
      assert.equal(body.data.workspace.source, "kv");
      assert.equal(typeof body.data.workspace.verified_at_ms, "number");
      assert.equal(calls[0].headers.get("anthropic-workspace-id"), "wrkspc_01ErorW3iFLRvQy55cpNWtEt");
      const resolved = await resolveClaudeCodeWorkspace(kv as unknown as Kv);
      assert.equal(resolved?.source, "kv");

      // A workspace-only submission changes the pin without touching the credential.
      const storedBefore = await loadClaudeCodeStoredCredential(kv as unknown as Kv);
      const repinned = await handleAdminClaudeCodeAuthSet(jsonRequest({ workspace_id: "wrkspc_01FBEp5VyCHs7ghEnJqk6giF" }));
      assert.equal(repinned.status, 200);
      const repinnedBody = await repinned.json();
      assert.equal(repinnedBody.data.workspace.id, "wrkspc_01FBEp5VyCHs7ghEnJqk6giF");
      const storedAfter = await loadClaudeCodeStoredCredential(kv as unknown as Kv);
      assert.equal(storedAfter?.secret, storedBefore?.secret);
    });
  });
});

test("clearing account guards preserves observations and account removal remains a tombstone", async () => {
  await withAdminKv(async (kv) => {
    await withStubbedAnthropic(modelsOk, async () => {
      await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-usr-1A6ABCDEFGHIJKLMNOPBwAA" }));
    });
    const account = await resolveClaudeCodeAccount(kv as unknown as Kv);
    assert(account);
    await recordClaudeCodeQuotaOutcome(kv as unknown as Kv, {
      binding: account,
      observation: null,
      config_error: { kind: "billing_blocked", status: 400, message: "credit balance too low", retry_after_ms: null },
    });
    const cooling = await loadClaudeCodeQuotaState(kv as unknown as Kv, account);
    assert.equal(cooling?.last_error?.kind, "billing_blocked");
    const clearedGuards = await handleAdminClaudeCodeQuotaClear();
    const payload = await clearedGuards.json();
    assert.equal(payload.guards_cleared, true);
    assert.equal(payload.data.quota.cooldown_until_ms, null);
    assert.equal(payload.data.quota.last_error, null);
    const cleared = await handleAdminClaudeCodeAuthDelete();
    assert.equal(cleared.status, 200);
    assert.equal(await loadClaudeCodeStoredCredential(kv as unknown as Kv), null);
  });
});

test("the admin routes stay behind admin auth and expose the documented paths", async () => {
  const { default: handler } = await import("../src/handler/index.ts");
  const paths: [string, string][] = [
    ["GET", "/admin/providers/claude-code/auth"],
    ["POST", "/admin/providers/claude-code/auth"],
    ["DELETE", "/admin/providers/claude-code/auth"],
    ["POST", "/admin/providers/claude-code/quota/clear"],
    ["GET", "/admin/providers/claude-code/access"],
    ["POST", "/admin/providers/claude-code/access"],
    ["POST", "/admin/providers/claude-code/accounts/active"],
  ];
  for (const [method, path] of paths) {
    const response = await handler(new Request(`http://localhost${path}`, { method }));
    assert.equal(response.status, 401, `${method} ${path} must require admin auth`);
    await response.body?.cancel();
  }
});

test("a workspace-only submission without any credential reports the missing credential", async () => {
  await withAdminKv(async () => {
    await withStubbedAnthropic(modelsOk, async (calls) => {
      // The seam keeps this deterministic: the acceptance process may carry an
      // ambient CLAUDE_API_KEY of its own.
      const response = await handleAdminClaudeCodeAuthSet(jsonRequest({ workspace_id: "wrkspc_01ErorW3iFLRvQy55cpNWtEt" }), { env: () => null });
      assert.equal(response.status, 409);
      assert.equal(calls.length, 0);
    });
  });
});

test("configuration cooldown recorded by the tier is visible to the admin readback", async () => {
  await withAdminKv(async (kv) => {
    await withStubbedAnthropic(modelsOk, async () => {
      await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-oat-fixture-config" }));
    });
    const account = await resolveClaudeCodeAccount(kv as unknown as Kv);
    assert(account);
    await recordClaudeCodeQuotaOutcome(kv as unknown as Kv, {
      binding: account,
      observation: null,
      config_error: { kind: "workspace_not_found", status: 404, message: "Workspace `72cde404` not found.", retry_after_ms: null },
      nowMs: Date.now(),
    });
    const response = await handleAdminClaudeCodeAuthGet();
    const payload = await response.json();
    assert.equal(payload.data.quota.last_error.kind, "workspace_not_found");
    assert.equal(CLAUDE_CODE_CONFIG_COOLDOWN_MS > 0, true);
    assert.equal(kv.values.has(keyOf([...CLAUDE_CODE_WORKSPACE_KV_KEY])), false, "no workspace is pinned by these fixtures");
  });
});

test("account roster preserves singleton requests and explicit active selection without granting principals", async () => {
  await withAdminKv(async (kv) => {
    await withStubbedAnthropic(modelsOk, async () => {
      const firstResponse = await handleAdminClaudeCodeAuthSet(
        jsonRequest({ credential: "sk-ant-oat-fixture-first-admin", label: "local label, not provider identity" })
      );
      const first = await firstResponse.json();
      const secondResponse = await handleAdminClaudeCodeAuthSet(
        jsonRequest({ credential: "sk-ant-oat-fixture-second-admin", create_new: true, label: "secondary" })
      );
      const second = await secondResponse.json();
      assert.equal(secondResponse.status, 200);
      assert.equal(second.data.accounts.length, 2);
      assert.equal(second.data.active_account_id, first.account_id);
      assert.deepEqual((await loadClaudeCodeAccessPolicy(kv as unknown as Kv)).allowed_key_ids, []);
      const selection = await handleAdminClaudeCodeAccountActive(jsonRequest({ account_id: second.account_id }));
      const selected = await selection.json();
      assert.equal(selected.data.active_account_id, second.account_id);
      assert.equal(selected.data.active_reason, "admin_selection");
      assert.equal(selected.data.credential.label, "secondary");
      assert.equal(selected.data.credential.expires_at_ms, null);
      assert.equal(selected.data.accounts[0].capabilities.identity_verified, false);
      assert.equal(selected.data.accounts[0].capabilities.can_refresh, false, "this imported credential has no owned refresh material");
      assert.equal(JSON.stringify(selected).includes("credential_fingerprint"), false);
      assert.equal(JSON.stringify(selected).includes("sk-ant-oat-fixture-second-admin"), false);
      const targeted = await handleAdminClaudeCodeAuthSet(jsonRequest({ account_id: first.account_id, credential: "sk-ant-oat-fixture-first-replacement" }));
      assert.equal(targeted.status, 200);
      assert.equal((await loadClaudeCodeAccountStore(kv as unknown as Kv)).active_account_id, second.account_id);
    });
  });
});

test("targeted guard clear refuses a replaced cohort and never clears another account", async () => {
  await withAdminKv(async (kv) => {
    await withStubbedAnthropic(modelsOk, async () => {
      const first = await (await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-oat-fixture-first-guards" }))).json();
      const second = await (await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-oat-fixture-second-guards", create_new: true }))).json();
      const firstBinding = await resolveClaudeCodeAccount(kv as unknown as Kv, undefined, { accountId: first.account_id });
      const secondBinding = await resolveClaudeCodeAccount(kv as unknown as Kv, undefined, { accountId: second.account_id });
      assert(firstBinding && secondBinding);
      for (const account of [firstBinding, secondBinding])
        await recordClaudeCodeQuotaOutcome(kv as unknown as Kv, {
          binding: account,
          observation: null,
          config_error: { kind: "workspace_required", status: 400, message: "fixture workspace required" },
        });
      const missing = await handleAdminClaudeCodeQuotaClear(jsonRequest({ account_id: first.account_id }));
      assert.equal(missing.status, 400);
      const wrong = await handleAdminClaudeCodeQuotaClear(jsonRequest({ account_id: first.account_id, account_cohort_id: "retired" }));
      assert.equal(wrong.status, 409);
      assert.equal(
        (await handleAdminClaudeCodeQuotaClear(jsonRequest({ account_id: first.account_id, account_cohort_id: firstBinding.account_cohort_id }))).status,
        200
      );
      assert.equal((await loadClaudeCodeQuotaState(kv as unknown as Kv, secondBinding))?.last_error?.kind, "workspace_required");
      const deleted = await handleAdminClaudeCodeAuthDelete(
        new Request(`https://ai.ubq.fi/admin/providers/claude-code/auth?account_id=${second.account_id}`, { method: "DELETE" })
      );
      assert.equal(deleted.status, 200);
      assert.equal((await loadClaudeCodeAccountStore(kv as unknown as Kv)).active_account_id, first.account_id);
    });
  });
});

test("explicit persisted principal controls are independent of credential import and deny by default", async () => {
  await withAdminKv(async (kv) => {
    assert.equal((await handleAdminClaudeCodeAccess(jsonRequest({ allowed_key_ids: ["fixture-principal"] }))).status, 200);
    await withStubbedAnthropic(modelsOk, async () => {
      await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-oat-fixture-policy" }));
    });
    assert.deepEqual((await loadClaudeCodeAccessPolicy(kv as unknown as Kv)).allowed_key_ids, ["fixture-principal"]);
    const deny = await handleAdminClaudeCodeAccess(jsonRequest({ allowed_key_ids: [] }));
    assert.equal(deny.status, 200);
    const readback = await (await handleAdminClaudeCodeAccess(new Request("https://ai.ubq.fi/admin/providers/claude-code/access"))).json();
    assert.deepEqual(readback.data.allowed_key_ids, []);
    assert.equal(readback.data.source, "kv");
    const malformed = await handleAdminClaudeCodeAccess(jsonRequest({ allowed_key_ids: ["a,b"] }));
    assert.equal(malformed.status, 400);
    assert.deepEqual((await loadClaudeCodeAccessPolicy(kv as unknown as Kv)).allowed_key_ids, []);
  });
});

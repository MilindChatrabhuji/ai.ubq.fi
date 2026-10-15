import assert from "node:assert/strict";
import {
  handleAdminClaudeCodeAuthDelete,
  handleAdminClaudeCodeAuthGet,
  handleAdminClaudeCodeAuthSet,
  handleAdminClaudeCodeQuotaClear,
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

const keyOf = (key: Deno.KvKey): string => JSON.stringify(key);

class AdminKv {
  readonly values = new Map<string, unknown>();

  get<T>(key: Deno.KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<Deno.KvEntryMaybe<T>> {
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({
      key,
      value: (stored ?? null) as T | null,
      versionstamp: stored === undefined ? null : "00000000000000000001",
    } as Deno.KvEntryMaybe<T>);
  }

  set(key: Deno.KvKey, value: unknown): Promise<Deno.KvCommitResult> {
    this.values.set(keyOf(key), value);
    return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" } as Deno.KvCommitResult);
  }

  delete(key: Deno.KvKey): Promise<void> {
    this.values.delete(keyOf(key));
    return Promise.resolve();
  }
}

const withAdminKv = async (run: (kv: AdminKv) => Promise<void>): Promise<void> => {
  const kv = new AdminKv();
  resetClaudeCodeCredentialCacheForTest();
  resetProviderSelectionCacheForTest();
  resetProviderHealthThrottleForTest();
  setKvForTest(kv as unknown as Deno.Kv);
  try {
    await run(kv);
  } finally {
    setKvForTest(null);
  }
};

type StubCall = Readonly<{ url: string; method: string; headers: Headers }>;

const withStubbedAnthropic = async (responder: (call: StubCall) => Response, run: (calls: StubCall[]) => Promise<void>): Promise<void> => {
  const originalFetch = globalThis.fetch;
  const calls: StubCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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

const modelsOk = (): Response => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });

const jsonRequest = (body: unknown, method = "POST"): Request =>
  new Request("https://ai.ubq.fi/admin/providers/claude-code/auth", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("the admin status route reports the tier without any secret material", async () => {
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
      assert.equal(kv.values.has(keyOf([...CLAUDE_CODE_AUTH_KV_KEY])), true);
    });

    const status = await handleAdminClaudeCodeAuthGet();
    const payload = await status.json();
    assert.equal(payload.data.credential.hint, "sk-ant-usr-1A6...BwAA");
    assert.equal(JSON.stringify(payload).includes("ABCDEFGHIJ"), false);
  });
});

Deno.test("a rejected credential is refused upstream and never stored", async () => {
  await withAdminKv(async (kv) => {
    await withStubbedAnthropic(
      () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 }),
      async (calls) => {
        const response = await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-usr-rejected-key-abcdefghijklmnop" }));
        assert.equal(response.status, 400);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "https://api.anthropic.com/v1/models");
        assert.equal(calls[0].headers.get("x-api-key"), "sk-ant-usr-rejected-key-abcdefghijklmnop");
      }
    );
    assert.equal(kv.values.has(keyOf([...CLAUDE_CODE_AUTH_KV_KEY])), false, "a rejected credential is not persisted");
  });
});

Deno.test("credential submissions are shape-checked before any upstream call", async () => {
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

Deno.test("a workspace pin is stored, validated, and reported with its source", async () => {
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
      const resolved = await resolveClaudeCodeWorkspace(kv as unknown as Deno.Kv);
      assert.equal(resolved?.source, "kv");

      // A workspace-only submission changes the pin without touching the credential.
      const storedBefore = await loadClaudeCodeStoredCredential(kv as unknown as Deno.Kv);
      const repinned = await handleAdminClaudeCodeAuthSet(jsonRequest({ workspace_id: "wrkspc_01FBEp5VyCHs7ghEnJqk6giF" }));
      assert.equal(repinned.status, 200);
      const repinnedBody = await repinned.json();
      assert.equal(repinnedBody.data.workspace.id, "wrkspc_01FBEp5VyCHs7ghEnJqk6giF");
      const storedAfter = await loadClaudeCodeStoredCredential(kv as unknown as Deno.Kv);
      assert.equal(storedAfter?.secret, storedBefore?.secret);
    });
  });
});

Deno.test("clearing the stored credential falls back to the environment and clearing guards removes them", async () => {
  await withAdminKv(async (kv) => {
    await withStubbedAnthropic(modelsOk, async () => {
      await handleAdminClaudeCodeAuthSet(jsonRequest({ credential: "sk-ant-usr-1A6ABCDEFGHIJKLMNOPBwAA" }));
    });
    const cleared = await handleAdminClaudeCodeAuthDelete();
    assert.equal(cleared.status, 200);
    assert.equal(kv.values.has(keyOf([...CLAUDE_CODE_AUTH_KV_KEY])), false);
    assert.equal(await loadClaudeCodeStoredCredential(kv as unknown as Deno.Kv), null);

    await recordClaudeCodeQuotaOutcome(kv as unknown as Deno.Kv, {
      observation: null,
      config_error: { kind: "billing_blocked", status: 400, message: "credit balance too low", retry_after_ms: null },
    });
    const cooling = await loadClaudeCodeQuotaState(kv as unknown as Deno.Kv);
    assert.equal(cooling?.last_error?.kind, "billing_blocked");
    const clearedGuards = await handleAdminClaudeCodeQuotaClear();
    const payload = await clearedGuards.json();
    assert.equal(payload.guards_cleared, true);
    assert.equal(payload.data.quota.cooldown_until_ms, null);
    assert.equal(payload.data.quota.last_error, null);
  });
});

Deno.test("the admin routes stay behind admin auth and expose the documented paths", async () => {
  const { default: handler } = await import("../src/handler/index.ts");
  const paths: Array<[string, string]> = [
    ["GET", "/admin/providers/claude-code/auth"],
    ["POST", "/admin/providers/claude-code/auth"],
    ["DELETE", "/admin/providers/claude-code/auth"],
    ["POST", "/admin/providers/claude-code/quota/clear"],
  ];
  for (const [method, path] of paths) {
    const response = await handler(new Request(`http://localhost${path}`, { method }));
    assert.equal(response.status, 401, `${method} ${path} must require admin auth`);
    await response.body?.cancel();
  }
});

Deno.test("a workspace-only submission without any credential reports the missing credential", async () => {
  const previousApiKey = Deno.env.get("CLAUDE_API_KEY");
  const previousOauth = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
  Deno.env.delete("CLAUDE_API_KEY");
  Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
  try {
    await withAdminKv(async () => {
      await withStubbedAnthropic(modelsOk, async (calls) => {
        const response = await handleAdminClaudeCodeAuthSet(jsonRequest({ workspace_id: "wrkspc_01ErorW3iFLRvQy55cpNWtEt" }));
        assert.equal(response.status, 409);
        assert.equal(calls.length, 0);
      });
    });
  } finally {
    if (previousApiKey !== undefined) Deno.env.set("CLAUDE_API_KEY", previousApiKey);
    if (previousOauth !== undefined) Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", previousOauth);
  }
});

Deno.test("configuration cooldown recorded by the tier is visible to the admin readback", async () => {
  await withAdminKv(async (kv) => {
    await recordClaudeCodeQuotaOutcome(kv as unknown as Deno.Kv, {
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

import { test } from "bun:test";
import assert from "node:assert/strict";
import { verifyNativeCodexAccount } from "../src/codex/native-auth-transport.ts";

const expected = { email: "native@example.test", accountId: "acct-native" };
const reported = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  account: { type: "chatgpt", email: expected.email, planType: "pro", ...overrides },
  requiresOpenaiAuth: true,
  workspaceRouting: {
    accountRoutingOverride: "NO_CONSTRAINT",
    backendOrigin: "https://chatgpt.com",
    chatgptAccountId: expected.accountId,
  },
});

test("a reported ChatGPT identity must match email and account exactly", () => {
  assert.equal(verifyNativeCodexAccount(reported(), expected, null).ok, true);
  const mismatches: unknown[] = [
    reported({ email: "other@example.test" }),
    {
      ...reported(),
      workspaceRouting: {
        accountRoutingOverride: "NO_CONSTRAINT",
        backendOrigin: "https://chatgpt.com",
        chatgptAccountId: "acct-other",
      },
    },
    { ...reported(), account: { type: "apiKey" } },
    { account: null, requiresOpenaiAuth: true, workspaceRouting: null },
    {},
    null,
  ];
  for (const value of mismatches) {
    assert.equal(verifyNativeCodexAccount(value, expected, expected.accountId).ok, false);
  }
});

test("a blank account is accepted only for a non-OpenAI-auth provider with the bound file account", () => {
  const blank = { account: null, requiresOpenaiAuth: false, workspaceRouting: null };
  assert.equal(verifyNativeCodexAccount(blank, expected, expected.accountId).ok, true);
  for (const fileAccountId of [null, "acct-other"]) {
    assert.equal(verifyNativeCodexAccount(blank, expected, fileAccountId).ok, false);
  }
  assert.equal(verifyNativeCodexAccount({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }, expected, expected.accountId).ok, false);
  assert.equal(verifyNativeCodexAccount({ account: null }, expected, expected.accountId).ok, false);
});

import { test } from "bun:test";
import assert from "node:assert/strict";

import { decideRetry, DEFAULT_RETRY_POLICY, renderRepeatedFailureFeedback, RetryLedger } from "../src/harmony/reliability/retry.ts";
import { callIdentity } from "../src/harmony/reliability/loops.ts";

test("retry: transient codes are retried up to maxRetriesPerCall with backoff", () => {
  const policy = { ...DEFAULT_RETRY_POLICY, maxRetriesPerCall: 2, backoffMs: 50 };
  const first = decideRetry(policy, "timeout", 0);
  assert.deepEqual(first, { retry: true, delayMs: 50, attempt: 1, code: "timeout", reason: "transient_code" });
  const second = decideRetry(policy, "timeout", 1);
  assert.equal(second.retry, true);
  const third = decideRetry(policy, "timeout", 3);
  assert.equal(third.retry, false);
  assert.equal(third.reason, "attempts_exhausted");
});

test("retry: deterministic codes are never retried with identical arguments", () => {
  for (const code of ["invalid_args", "path_escape", "write_scope", "not_found", "patch_failed", "exec_failed"]) {
    const decision = decideRetry(DEFAULT_RETRY_POLICY, code, 0);
    assert.equal(decision.retry, false, `${code} must not be retried`);
    assert.equal(decision.reason, "not_retryable");
  }
});

test("retry: null code (previous call succeeded) is not retried", () => {
  const decision = decideRetry(DEFAULT_RETRY_POLICY, null, 1);
  assert.equal(decision.retry, false);
  assert.equal(decision.reason, "not_retryable");
});

test("retry: the ledger counts retryable recoveries and rejected repeats", () => {
  const ledger = new RetryLedger(DEFAULT_RETRY_POLICY);
  const identity = callIdentity("shell.exec", { command: "sleep 1" });
  ledger.observe(identity, { ok: false, error_code: "timeout" }, 0);
  // Second attempt with identical arguments: allowed (transient code).
  const allowed = ledger.observe(identity, { ok: true }, 1);
  assert.equal(allowed?.retry, true);
  const entry = ledger.entry(identity);
  assert.ok(entry);
  assert.equal(entry.recovered, true);
  const summary = ledger.summary();
  assert.ok(summary.attempts >= 1 && summary.retried >= 1);
});

test("retry: the ledger rejects a repeat after a deterministic failure", () => {
  const ledger = new RetryLedger(DEFAULT_RETRY_POLICY);
  const identity = callIdentity("editor.apply_patch", { path: "a.txt", old: "x", new: "y" });
  ledger.observe(identity, { ok: false, error_code: "patch_failed" }, 0);
  const rejected = ledger.observe(identity, { ok: false, error_code: "patch_failed" }, 1);
  assert.equal(rejected?.retry, false);
  assert.equal(rejected.reason, "not_retryable");
  const summary = ledger.summary();
  assert.ok(summary.rejected >= 1 && summary.byReason.not_retryable === 1);
});

test("retry: repeated-failure feedback names the deterministic code", () => {
  const text = renderRepeatedFailureFeedback("patch_failed", callIdentity("editor.apply_patch", { path: "a" }));
  assert.match(text, /patch_failed/);
  assert.match(text, /change the arguments or approach/);
});

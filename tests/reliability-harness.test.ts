import { test } from "bun:test";
import assert from "node:assert/strict";

import type { HarmonyTransport } from "../src/harmony/adapter.ts";
import { type HarnessEvent, type HarnessOptions, renderCanonicalPolicy, runReliabilityHarness } from "../src/harmony/reliability/harness.ts";
import { createFakeToolBackends, FakeShell } from "../src/harmony/tools/fakes.ts";
import type { ToolBackends } from "../src/harmony/tools/backend.ts";
import { broadToolSurface } from "../src/harmony/reliability/surfaces.ts";

const files = {
  "a.txt": "a=0\n",
  "b.txt": "b=0\n",
  "notes.txt": "note body\n",
} as const;

const backends = (): ToolBackends => createFakeToolBackends({ files: { ...files }, shell: new FakeShell([]) });

type ScriptStep = { content?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] };

const completion = (message: Record<string, unknown>): Response =>
  new Response(
    JSON.stringify({
      id: "cmpl-c",
      object: "chat.completion",
      created: 1,
      model: "gpt-oss-120b",
      choices: [
        {
          index: 0,
          message: { role: "assistant", ...message },
          finish_reason: message.tool_calls ? "tool_calls" : "stop",
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

/** Deterministic scripted transport: one response per request. */
function scriptedTransport(script: ScriptStep[]): HarmonyTransport {
  let index = 0;
  return () => {
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    const toolCalls = step.toolCalls?.map((call, j) => ({
      id: `call-${index}-${j}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
    return Promise.resolve(completion({ content: step.content ?? "", tool_calls: toolCalls }));
  };
}

const baseOptions = (script: ScriptStep[], overrides: Partial<HarnessOptions> = {}): HarnessOptions => ({
  systemPrompt: renderCanonicalPolicy({
    tools: ["filesystem.read", "editor.apply_patch", "shell.exec"],
    budget: "medium",
  }),
  userPrompt: "Fix a.txt and verify.",
  transport: scriptedTransport(script),
  backends: backends(),
  verificationCommand: "sh tests/run.sh",
  ...overrides,
});

const evidence = (outcome: { events: readonly HarnessEvent[] }) => ({
  toolCalls: outcome.events.filter((e): e is Extract<HarnessEvent, { type: "tool_call" }> => e.type === "tool_call"),
  toolResults: outcome.events.filter((e): e is Extract<HarnessEvent, { type: "tool_result" }> => e.type === "tool_result"),
  guards: outcome.events.filter((e): e is Extract<HarnessEvent, { type: "guard" }> => e.type === "guard"),
  finals: outcome.events.filter((e): e is Extract<HarnessEvent, { type: "final" }> => e.type === "final"),
});

test("harness: a clean scripted run completes with verified writes", async () => {
  const outcome = await runReliabilityHarness(
    baseOptions([
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] },
      { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "a.txt", old: "a=0", new: "a=1" } }] },
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] },
      { content: "Fixed a.txt." },
    ])
  );
  assert.equal(outcome.phase, "completed");
  assert.equal(outcome.finalContent, "Fixed a.txt.");
  assert.equal(outcome.state.pendingVerification.length, 0);
  assert.equal(outcome.state.writes[0].verified, true);
  assert.equal(outcome.modelCalls, 4);
  assert.equal(evidence(outcome).guards.length, 0);
  assert.equal(outcome.classification.failure_class, null);
});

test("harness: invalid calls are never executed and feedback is deterministic", async () => {
  const outcome = await runReliabilityHarness(
    baseOptions([
      { toolCalls: [{ name: "filesystem.read", arguments: { path: 42 } }] },
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "notes.txt" } }] },
      { content: "done" },
    ])
  );
  const ev = evidence(outcome);
  assert.equal(outcome.phase, "completed");
  const invalid = ev.toolCalls.find((c) => !c.valid);
  assert.ok(invalid);
  assert.equal(invalid.invalidReason, "wrong_type:arguments.path");
  const invalidResult = ev.toolResults.find((r) => r.id === invalid.id);
  assert.ok(invalidResult);
  assert.equal(String(invalidResult.result.error_code), "invalid_args");
  assert.match(invalidResult.result.error ?? "", /invalid arguments \(1 issue\(s\)\)/);
  assert.equal(outcome.state.invalidCalls, 1);
});

test("harness: exact duplicates after success are blocked, not re-executed", async () => {
  const outcome = await runReliabilityHarness(
    baseOptions([
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] },
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] }, // duplicate
      { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "a.txt", old: "a=0", new: "a=1" } }] },
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] },
      { content: "done" },
    ])
  );
  const ev = evidence(outcome);
  assert.equal(outcome.phase, "completed");
  const repeated = ev.toolCalls.find((c) => c.repeated !== null && c.repeated !== undefined);
  assert.ok(repeated);
  assert.equal(repeated.repeated, "repeat_after_success");
  const result = ev.toolResults.find((r) => r.id === repeated.id);
  assert.ok(result);
  assert.equal(String(result.result.error_code), "duplicate_call");
  assert.match(result.result.error ?? "", /duplicate of the previous call/);
  assert.equal(outcome.state.duplicateCalls, 1);
});

test("harness: repeated calls after deterministic failures are blocked as repeated_failure", async () => {
  const outcome = await runReliabilityHarness(
    baseOptions([
      { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "missing.txt", old: "x", new: "y" } }] },
      { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "missing.txt", old: "x", new: "y" } }] }, // repeat after patch_failed
      { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "missing.txt", add: true, new: "y" } }] }, // different args: recover
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "missing.txt" } }] },
      { content: "done" },
    ])
  );
  const ev = evidence(outcome);
  assert.equal(outcome.phase, "completed");
  const first = ev.toolResults[0];
  assert.equal(String(first.result.error_code), "patch_failed");
  const second = ev.toolResults[1];
  assert.equal(String(second.result.error_code), "repeated_failure");
  assert.match(second.result.error ?? "", /change the arguments or approach/);
});

test("harness: a final without verification is rejected, then accepted after verification", async () => {
  const outcome = await runReliabilityHarness(
    baseOptions([
      { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "a.txt", old: "a=0", new: "a=1" } }] },
      { content: "done" }, // rejected: unverified write
      { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] },
      { content: "done" }, // accepted
    ])
  );
  const ev = evidence(outcome);
  assert.equal(outcome.phase, "completed");
  assert.ok(ev.guards.length === 1, `expected 1 guard, got ${ev.guards.length}`);
  assert.equal(ev.guards[0].kind, "unverified_write");
  assert.equal(ev.finals.length, 2);
  assert.equal(ev.finals[0].accepted, false);
  assert.equal(ev.finals[1].accepted, true);
  assert.equal(outcome.state.writes[0].verified, true);
});

test("harness: two identical finals with no intervening action abort as false_completion", async () => {
  const outcome = await runReliabilityHarness(
    baseOptions(
      [
        { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "a.txt", old: "a=0", new: "a=1" } }] },
        { content: "done" },
        { content: "done" }, // repeated, no action
      ],
      { maxGuardRejections: 8 }
    )
  );
  assert.equal(outcome.phase, "failed");
  assert.equal(outcome.abortedReason, "false_completion");
  assert.equal(outcome.classification.failure_class, "false_completion");
  const ev = evidence(outcome);
  assert.ok(ev.guards.some((g) => g.kind === "false_completion"));
});

test("harness: transient timeouts are auto-retried once, then blocked", async () => {
  const shell = new FakeShell([
    { command: "slow-cmd", timed_out: true },
    { command: "true", exit_code: 0, stdout: "ok" },
  ]);
  const outcome = await runReliabilityHarness(
    baseOptions(
      [
        { toolCalls: [{ name: "shell.exec", arguments: { command: "slow-cmd" } }] },
        { toolCalls: [{ name: "shell.exec", arguments: { command: "slow-cmd" } }] }, // retry allowed
        { toolCalls: [{ name: "shell.exec", arguments: { command: "slow-cmd" } }] }, // attempts exhausted
        { toolCalls: [{ name: "shell.exec", arguments: { command: "true" } }] },
        { content: "ok" },
      ],
      {
        backends: createFakeToolBackends({ files: { ...files }, shell }),
        retryPolicy: {
          maxRetriesPerCall: 1,
          backoffMs: 0,
          retryableCodes: ["timeout", "internal", "unavailable", "transport"],
        },
      }
    )
  );
  const ev = evidence(outcome);
  assert.equal(outcome.phase, "completed");
  const timeouts = ev.toolResults.filter((r) => String(r.result.error_code) === "timeout").length;
  assert.equal(timeouts, 2, "first attempt + one allowed retry");
  const blocked = ev.toolResults.filter((r) => String(r.result.error_code) === "repeated_failure").length;
  assert.equal(blocked, 1, "third identical call is blocked");
  assert.notEqual(
    ev.toolResults.find((r) => String(r.result.error_code) === "timeout"),
    undefined
  );
});

test("harness: semantic loops are detected, guarded, and recoverable", async () => {
  const outcome = await runReliabilityHarness(
    baseOptions(
      [
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] },
        { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "missing.txt", old: "x", new: "y" } }] },
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] },
        { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "missing.txt", old: "x", new: "y" } }] },
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] },
        { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "missing.txt", old: "x", new: "y" } }] },
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] },
        { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "missing.txt", old: "x", new: "y" } }] },
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] },
        { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "missing.txt", old: "x", new: "y" } }] },
        // Break the loop: revise the plan (abandoning the failing edit), then finish.
        { toolCalls: [{ name: "task.update_plan", arguments: { plan: ["created result.txt instead"] } }] },
        { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "result.txt", add: true, new: "done" } }] },
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "result.txt" } }] },
        { content: "done" },
      ],
      { loopThreshold: 3, maxTurns: 30 }
    )
  );
  const ev = evidence(outcome);
  assert.ok(outcome.state.semanticLoops > 0, "loop must be recorded");
  assert.ok(
    ev.guards.some((g) => g.kind === "loop"),
    "a loop guard must be emitted"
  );
  assert.equal(outcome.phase, "completed");
});

test("harness: unknown experimental tools on the broad surface get deterministic feedback", async () => {
  const outcome = await runReliabilityHarness(
    baseOptions(
      [
        { toolCalls: [{ name: "filesystem.write", arguments: { path: "a.txt", content: "x" } }] },
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "notes.txt" } }] },
        { content: "done" },
      ],
      { tools: broadToolSurface().definitions }
    )
  );
  const ev = evidence(outcome);
  const invalid = ev.toolCalls.find((c) => c.tool === "filesystem.write");
  assert.ok(invalid);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.invalidReason, "unknown_tool:tool");
  const result = ev.toolResults.find((r) => r.id === invalid.id);
  assert.ok(result);
  assert.match(result.result.error ?? "", /unknown_tool/);
});

test("harness: guard rejection budget exhausts deterministically", async () => {
  const outcome = await runReliabilityHarness(
    baseOptions(
      [
        { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "a.txt", old: "a=0", new: "a=1" } }] },
        { content: "first" },
        { content: "second" },
        { content: "third" },
      ],
      { maxGuardRejections: 2, maxTurns: 12 }
    )
  );
  assert.equal(outcome.phase, "failed");
  assert.equal(outcome.abortedReason, "guard_exhausted");
  assert.equal(outcome.classification.failure_class, "guard_exhausted");
  assert.ok(evidence(outcome).guards.length >= 2);
});

test("harness: configured final-attempt limit is enforced", async () => {
  const outcome = await runReliabilityHarness(
    baseOptions(
      [
        { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "a.txt", old: "a=0", new: "a=1" } }] },
        { content: "unverified" },
        { content: "must not be requested" },
      ],
      {
        maxGuardRejections: 8,
        verificationPolicy: {
          requireVerificationBeforeFinal: true,
          requireRecoveryBeforeFinal: true,
          rejectFinalDuringLoop: true,
          requirePlanBeforeWrites: false,
          maxRepeatedFinals: 8,
          maxFinalAttempts: 1,
          verificationCommand: "sh tests/run.sh",
        },
      }
    )
  );
  assert.equal(outcome.phase, "failed");
  assert.equal(outcome.abortedReason, "guard_exhausted");
  assert.equal(evidence(outcome).finals.length, 1);
});

test("harness: deterministic HTTP failures are not retried", async () => {
  let calls = 0;
  const outcome = await runReliabilityHarness(
    baseOptions([], {
      transport: () => {
        calls += 1;
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      },
      retryPolicy: { maxRetriesPerCall: 3, backoffMs: 0, retryableCodes: ["transport"] },
    })
  );
  assert.equal(calls, 1);
  assert.equal(outcome.abortedReason, "transport_failed");
  assert.equal(outcome.events.filter((event) => event.type === "model_request").length, 1);
});

test("harness: whole-run cancellation aborts a stalled injected transport", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const transport: HarmonyTransport = (_body, options) => {
    observedSignal = options?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const signal = options?.signal;
      if (signal === undefined) return;
      if (signal.aborted) {
        reject(new Error("stalled transport aborted before dispatch", { cause: signal.reason }));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error("stalled transport aborted while awaiting the response", { cause: signal.reason }));
        },
        { once: true }
      );
    });
  };
  // The timer is created by the promise executor, which runs synchronously, and
  // recorded in a list so cleanup needs no nullish sentinel.
  const timeoutTimers: ReturnType<typeof setTimeout>[] = [];
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutTimers.push(
      setTimeout(() => {
        reject(new Error("stalled transport ignored cancellation"));
      }, 500)
    );
  });
  const started = Date.now();
  setTimeout(() => {
    controller.abort(new DOMException("task deadline", "TimeoutError"));
  }, 20);
  try {
    const outcome = await Promise.race([runReliabilityHarness(baseOptions([], { transport, signal: controller.signal })), timeout]);
    assert.equal(observedSignal, controller.signal);
    assert.equal(outcome.phase, "aborted");
    assert.equal(outcome.abortedReason, "signal");
    assert.ok(Date.now() - started < 500, "transport should stop at the run deadline");
  } finally {
    for (const timer of timeoutTimers) clearTimeout(timer);
  }
});

test("harness: a stalled transport that ignores cancellation stops at the run deadline", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  // A hung provider socket that never honours the run signal: the harness owns
  // the deadline, so the run must end without the transport's cooperation.
  const transport: HarmonyTransport = (_body, options) => {
    observedSignal = options?.signal;
    return new Promise<Response>(() => {});
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const watchdog = new Promise<never>((_resolve, reject) => {
    timers.push(
      setTimeout(() => {
        reject(new Error("stalled transport ignored cancellation"));
      }, 1000)
    );
  });
  timers.push(
    setTimeout(() => {
      controller.abort(new DOMException("task deadline", "TimeoutError"));
    }, 20)
  );
  try {
    const started = Date.now();
    const outcome = await Promise.race([runReliabilityHarness(baseOptions([], { transport, signal: controller.signal })), watchdog]);
    assert.equal(observedSignal, controller.signal);
    assert.equal(outcome.phase, "aborted");
    assert.equal(outcome.abortedReason, "signal");
    assert.ok(Date.now() - started < 1000, "the run must stop at the task deadline");
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});

test("harness: structured mode requests carry deterministically fewer tokens than full mode", async () => {
  const script: ScriptStep[] = [];
  const bigFiles: Record<string, string> = {};
  for (let i = 0; i < 12; i++) {
    const path = `file-${String(i).padStart(2, "0")}.txt`;
    bigFiles[path] = `line ${i}\n`.repeat(150); // distinct, large content
    script.push({ toolCalls: [{ name: "filesystem.read", arguments: { path } }] });
  }
  script.push({ content: "done" });
  const bigBackends = createFakeToolBackends({ files: bigFiles, shell: new FakeShell([]) });
  const full = await runReliabilityHarness(baseOptions(script, { contextMode: "full", backends: bigBackends }));
  const structured = await runReliabilityHarness(baseOptions(script, { contextMode: "structured", backends: bigBackends }));
  assert.equal(full.phase, "completed");
  assert.equal(structured.phase, "completed");
  const fullRequests = full.events.filter((e): e is Extract<HarnessEvent, { type: "model_request" }> => e.type === "model_request");
  const structuredRequests = structured.events.filter((e): e is Extract<HarnessEvent, { type: "model_request" }> => e.type === "model_request");
  const lastFull = fullRequests[fullRequests.length - 1];
  const lastStructured = structuredRequests[structuredRequests.length - 1];
  assert.ok(lastStructured.estimatedTokens < lastFull.estimatedTokens, `structured ${lastStructured.estimatedTokens} < full ${lastFull.estimatedTokens}`);
});

test("harness: verificationCommand declared in the harness option satisfies writes", async () => {
  const scriptedShell = new FakeShell([{ command: "sh tests/run.sh", exit_code: 0, stdout: "ok" }]);
  const outcome = await runReliabilityHarness(
    baseOptions(
      [
        { toolCalls: [{ name: "editor.apply_patch", arguments: { path: "a.txt", old: "a=0", new: "a=1" } }] },
        { toolCalls: [{ name: "shell.exec", arguments: { command: "sh tests/run.sh" } }] },
        { content: "done" },
      ],
      { backends: createFakeToolBackends({ files: { ...files }, shell: scriptedShell }) }
    )
  );
  assert.equal(outcome.phase, "completed");
  assert.equal(outcome.state.writes[0].verified, true);
  assert.equal(outcome.state.writes[0].verifiedBy, "shell");
});

test("harness: maxTurns aborts as stalled turn_limit", async () => {
  const outcome = await runReliabilityHarness(baseOptions([{ toolCalls: [{ name: "filesystem.read", arguments: { path: "a.txt" } }] }], { maxTurns: 2 }));
  assert.equal(outcome.phase, "failed");
  assert.equal(outcome.abortedReason, "turn_limit");
  assert.equal(outcome.classification.failure_class, "stalled");
});

test("harness: policy preambles are deterministic and reference the surface", () => {
  const a = renderCanonicalPolicy({ tools: ["filesystem.read"], budget: "large" });
  const b = renderCanonicalPolicy({ tools: ["filesystem.read"], budget: "large" });
  assert.equal(a, b);
  assert.match(a, /filesystem\.read/);
  assert.match(a, /Context budget tier: large/);
});

// kv-budget suite part: tests moved out of tests/kv-budget.test.ts.

import assert from "node:assert/strict";
import {
  ApiKeyQuotaDispatchError,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  DEFAULT_KERNEL_POLICY_WINDOW_KEY,
  KERNEL_QUOTA_RESERVATION_LEASE_MS,
  MODEL,
  RUNTIME_CONFIG_CACHE_TTL_MS,
  RUNTIME_CONFIG_V2_KEY,
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3WindowKey,
  assertOrderedTerminalTimings,
  authenticateApiKeyToken,
  authoritativeCodexQuotaResponse,
  codexAuthPool,
  completedSseEvent,
  createRequestDeliveryLifecycle,
  deferred,
  deleteKernelOrgUsageLimit,
  encodeKey,
  fetchInputUrl,
  fetchMeteredModels,
  getCodexProviderHealth,
  handleAdminDefaults,
  handleResponses,
  handler,
  invalidateApiKeyPolicy,
  kernelOrgReservationKey,
  kernelOrgWindowKey,
  kernelRepoPolicyKey,
  kv,
  loadRuntimeConfig,
  makeApiKeyUsageWindowV3,
  now,
  paidFallbackRequestV3Key,
  prepareApiKeyInference,
  request,
  requiredTerminalTiming,
  reserveEffectiveKernelUsageLimit,
  reserveKernelOrgUsageLimit,
  resetApiKeyPolicyCacheForTest,
  resetCodexAuthCacheForTest,
  resetMeteredModelsCacheForTest,
  resetProviderHealthThrottleForTest,
  resetRuntimeConfigCacheForTest,
  resetSurplusModelsCacheForTest,
  runtime,
  seedKernelDefaultLimit,
  seedKey,
  seedPaidFallbackKey,
  semanticSseEvent,
  setKernelOrgUsageLimit,
  setKernelUsageLimit,
  setStreamFirstEventDeadlineMsForTest,
  sha256Hex,
  sse,
  streamingRequest,
  usageWindow,
  waitFor,
} from "./helpers/kv-budget-harness.ts";

Deno.test("Kernel quota retries failed settlement and rejects terminal-state changes", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(1, KERNEL_QUOTA_RESERVATION_LEASE_MS * 2);
  const owner = "kernel-settlement-retry-org";
  const requestId = "settlement-retry-request";
  const decision = await reserveKernelOrgUsageLimit(owner, requestId, "responses", {
    kv: kv as unknown as Deno.Kv,
    nowMs: Date.now() - KERNEL_QUOTA_RESERVATION_LEASE_MS + 80,
  });
  assert.equal(decision.ok, true);

  const window = kv.values.get(encodeKey(kernelOrgWindowKey(owner))) as {
    created_at_ms: number;
    usage_requests?: number;
    reserved_requests?: number;
  };
  const reservationKey = kernelOrgReservationKey(owner, window.created_at_ms, requestId);
  kv.failNextKernelSettlementCommits = 3;
  await assert.rejects(() => decision.reservation.commit(), /could not be settled/);
  const pending = kv.values.get(encodeKey(reservationKey)) as {
    state?: string;
    terminal_intent?: string | null;
    lease_expires_at_ms?: number;
  };
  assert.equal(pending.state, "reserved");
  assert.equal(pending.terminal_intent, "committed");
  assert.ok((pending.lease_expires_at_ms ?? 0) > Date.now() + KERNEL_QUOTA_RESERVATION_LEASE_MS / 2);
  await new Promise<void>((resolve) => setTimeout(resolve, 120));
  assert.equal(decision.reservation.signal.aborted, false, "terminal intent must renew the near-expiry lease");
  await waitFor(() => {
    const current = kv.values.get(encodeKey(kernelOrgWindowKey(owner))) as
      | {
          usage_requests?: number;
          reserved_requests?: number;
        }
      | undefined;
    return current?.usage_requests === 1 && current.reserved_requests === 0;
  }, "Kernel background settlement retry");
  await decision.reservation.commit();
  await assert.rejects(() => decision.reservation.release("late_cancel"), /terminal state is already committed/);
  const settledWindow = kv.values.get(encodeKey(kernelOrgWindowKey(owner))) as {
    usage_requests?: number;
    reserved_requests?: number;
  };
  assert.equal(settledWindow.usage_requests, 1);
  assert.equal(settledWindow.reserved_requests, 0);
});

Deno.test("Kernel quota blocks reset and deletion while a reservation is active", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(10);
  const owner = "kernel-policy-cutover-org";
  const configured = await setKernelOrgUsageLimit(owner, 5);
  assert.ok(configured);
  const decision = await reserveKernelOrgUsageLimit(owner, "policy-cutover-request", "responses", {
    kv: kv as unknown as Deno.Kv,
  });
  assert.equal(decision.ok, true);

  assert.equal(await setKernelOrgUsageLimit(owner, 5, { resetUsage: true }), null);
  assert.equal(await deleteKernelOrgUsageLimit(owner), "conflict");
  await decision.reservation.release("test_cleanup");
  assert.ok(await setKernelOrgUsageLimit(owner, 5, { resetUsage: true }));
  assert.equal(await deleteKernelOrgUsageLimit(owner), true);
});

Deno.test("Kernel quota blocks repo override creation while its effective org reservation is active", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(1);
  const owner = "kernel-org-repo-cutover-org";
  const repo = "kernel-org-repo-cutover-repo";
  const decision = await reserveEffectiveKernelUsageLimit(owner, repo, "org-repo-cutover-request", "responses", {
    kv: kv as unknown as Deno.Kv,
  });
  assert.equal(decision.ok, true);

  assert.equal(await setKernelUsageLimit(owner, repo, 1), null);
  assert.equal(kv.values.has(encodeKey(kernelRepoPolicyKey(owner, repo))), false);
  await decision.reservation.release("test_cleanup");
  assert.ok(await setKernelUsageLimit(owner, repo, 1));
});

Deno.test("Kernel default-window cutover blocks active default-backed reservations", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(2, 60_000);
  const decision = await reserveKernelOrgUsageLimit("kernel-default-window-cutover-org", "default-window-cutover-request", "responses", {
    kv: kv as unknown as Deno.Kv,
  });
  assert.equal(decision.ok, true);

  const updateDefaults = () =>
    handleAdminDefaults(
      new Request("https://ai.ubq.fi/admin/defaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kernel_policy_window_ms: 120_000 }),
      })
    );
  const blocked = await updateDefaults();
  assert.equal(blocked.status, 409);
  assert.equal(kv.values.get(encodeKey(DEFAULT_KERNEL_POLICY_WINDOW_KEY)), 60_000);
  await decision.reservation.release("test_cleanup");
  const updated = await updateDefaults();
  assert.equal(updated.status, 200);
  assert.equal(kv.values.get(encodeKey(DEFAULT_KERNEL_POLICY_WINDOW_KEY)), 120_000);
});

Deno.test("Kernel quota preserves the requested terminal state after natural window replacement", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(1);
  const owner = "kernel-window-replaced-org";
  const requestId = "window-replaced-request";
  const decision = await reserveKernelOrgUsageLimit(owner, requestId, "responses", {
    kv: kv as unknown as Deno.Kv,
  });
  assert.equal(decision.ok, true);

  const originalWindow = kv.values.get(encodeKey(kernelOrgWindowKey(owner))) as Record<string, unknown> & {
    created_at_ms: number;
  };
  const reservationKey = kernelOrgReservationKey(owner, originalWindow.created_at_ms, requestId);
  const replacementNowMs = Date.now() + 1;
  kv.values.set(encodeKey(kernelOrgWindowKey(owner)), {
    ...originalWindow,
    usage_requests: 0,
    reserved_requests: 0,
    created_at_ms: replacementNowMs,
    updated_at_ms: replacementNowMs,
  });
  await decision.reservation.commit();
  const reservation = kv.values.get(encodeKey(reservationKey)) as {
    state?: string;
    committed_at_ms?: number | null;
    release_reason?: string | null;
  };
  assert.equal(reservation.state, "committed");
  assert.equal(typeof reservation.committed_at_ms, "number");
  assert.equal(reservation.release_reason, null);
});

Deno.test("KV budget: warm kernel inference writes no ordinary usage aggregates", async () => {
  kv.values.clear();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(sse());
  const kernelContext = {
    keyId: null,
    kernelRepo: { owner: "ubiquity", repo: "kernel" },
    kernelOrg: { owner: "ubiquity" },
    paidFallbackEnabled: false,
    requestId: "kernel-telemetry-budget",
    startedAtMs: Date.now(),
  };
  const kernelRequest = () =>
    new Request("https://ai.ubq.fi/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "ping" }),
    });
  try {
    assert.equal((await handleResponses(kernelRequest(), kernelContext)).status, 200);
    kv.resetCounts();
    assert.equal((await handleResponses(kernelRequest(), kernelContext)).status, 200);
    assert.equal(kv.writes, 0);
    // The durable active selection, auth pool, routing state, and capacity
    // observations must be read strongly for admission and final dispatch
    // fencing; nothing else may be read on this warm path.
    const allowedReadKeys = [
      ["uos_ai", "debug_routing", "v1"],
      ["uos_ai", "removed_provider_failover", "circuit", "v1"],
      CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
      CODEX_AUTH_POOL_KV_KEY,
      CODEX_ACCOUNT_ROUTING_KV_KEY,
      CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
    ];
    assert.ok(
      kv.readKeys.every((key) => allowedReadKeys.some((allowed) => JSON.stringify(key) === JSON.stringify(allowed))),
      `unexpected warm-kernel reads: ${kv.readKeys.map((key) => JSON.stringify(key)).join(", ")}`
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("terminal inference telemetry includes resolved defaults and response usage", async () => {
  kv.values.clear();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const token = `u_${"5".repeat(64)}`;
  await seedKey(token, "telemetry", -1);
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalGitRevision = Deno.env.get("GIT_REVISION");
  const originalGithubSha = Deno.env.get("GITHUB_SHA");
  const originalBuildId = Deno.env.get("DENO_DEPLOY_BUILD_ID");
  const originalDeploymentId = Deno.env.get("DENO_DEPLOYMENT_ID");
  const logs: unknown[][] = [];
  globalThis.fetch = () =>
    Promise.resolve(
      sse({
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1 },
        output_tokens: 1,
        total_tokens: 2,
      })
    );
  console.info = (...args: unknown[]) => logs.push(args);
  Deno.env.delete("GIT_REVISION");
  Deno.env.delete("GITHUB_SHA");
  Deno.env.delete("DENO_DEPLOY_BUILD_ID");
  Deno.env.delete("DENO_DEPLOYMENT_ID");
  const promptCacheKey = "must-not-appear-in-terminal-telemetry";
  try {
    const response = await handler(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: "ping", prompt_cache_key: promptCacheKey }),
      })
    );
    assert.equal(response.status, 200);
    const terminal = logs.find((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.ok(terminal);
    const requestId = response.headers.get("x-uos-request-id");
    assert.ok(requestId);
    const terminalPayload = JSON.parse(String(terminal[1])) as Record<string, unknown>;
    assert.deepEqual(terminalPayload, {
      request_id: requestId,
      route: "responses",
      status: 200,
      provider: "chatgpt_codex",
      latency_ms: terminalPayload.latency_ms,
      first_provider_dispatch_ms: terminalPayload.first_provider_dispatch_ms,
      first_provider_headers_ms: terminalPayload.first_provider_headers_ms,
      first_codex_dispatch_ms: terminalPayload.first_codex_dispatch_ms,
      first_codex_headers_ms: terminalPayload.first_codex_headers_ms,
      first_upstream_sse_event_ms: terminalPayload.first_upstream_sse_event_ms,
      first_semantic_commitment_ms: terminalPayload.first_semantic_commitment_ms,
      stream_terminal_ms: terminalPayload.stream_terminal_ms,
      downstream_drain_ms: null,
      admission_wait_ms: 0,
      admission_stage: "accepted",
      delivery_outcome: "unobserved",
      model: MODEL,
      reasoning: "medium",
      output_token_allowance: null,
      rate_limit_wait_ms: null,
      rate_limit_failover_model: null,
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      usage_observed: true,
      usage_telemetry_status: "reported",
      prompt_cache_key_present: true,
      prompt_cache_mode: "unspecified",
      explicit_breakpoint_count: 0,
      account_slot: 1,
      account_cohort_id: await sha256Hex("uos-prompt-cache-account-cohort-v1\0acct-1"),
      active_generation: 1,
      active_transition_reason: null,
      provider_request_id: null,
      fallback_reason: null,
      semantic_output_observed: null,
      upstream_event_kinds: ["response.completed"],
      attempted_providers: ["chatgpt_codex"],
      removed_provider_trigger_class: null,
      removed_provider_circuit_transition: null,
      removed_provider_selected_model: null,
      removed_provider_task_type: null,
      removed_provider_latency_ms: null,
      removed_provider_terminal_status: null,
      removed_provider_semantic_commitment: null,
      stream: false,
      stream_terminal_type: "response.completed",
      failure_kind: null,
      response_created_observed: false,
      synthetic_terminal_type: null,
      git_sha: "unknown",
      deno_revision: "unknown",
      router_revision: null,
    });
    assert.doesNotMatch(String(terminal[1]), new RegExp(promptCacheKey));
    assert.doesNotMatch(String(terminal[1]), /"key_id"/);
    assert.doesNotMatch(String(terminal[1]), /"telemetry"/);
    assertOrderedTerminalTimings(terminalPayload, false);
    assert.equal(logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal").length, 1);
    const accepted = logs.find((entry) => entry[0] === "[ai.ubq.fi] request_accepted");
    assert.ok(accepted);
    const acceptedPayload = JSON.parse(String(accepted[1])) as Record<string, unknown>;
    assert.equal(acceptedPayload.request_id, requestId);
    assert.equal(Object.prototype.hasOwnProperty.call(acceptedPayload, "key_id"), false);

    globalThis.fetch = () =>
      Promise.resolve(
        sse({
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
          output_tokens: 0,
          total_tokens: 1,
        })
      );
    const invalidCacheRead = await handler(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: "invalid cache telemetry" }),
      })
    );
    assert.equal(invalidCacheRead.status, 200);
    const terminalEvents = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalEvents.length, 2);
    const invalidCacheReadTerminal = JSON.parse(String(terminalEvents[1]?.[1])) as Record<string, unknown>;
    assert.equal(invalidCacheReadTerminal.cached_input_tokens, 2);
    assert.equal(invalidCacheReadTerminal.cache_write_input_tokens, 0);
    assert.equal(invalidCacheReadTerminal.usage_telemetry_status, "invalid");

    // An omitted cache-details object is distinct from the provider explicitly
    // reporting a zero cache read/write. Keep that distinction in the terminal
    // event so downstream counter aggregation does not turn missing telemetry
    // into a false zero-token observation.
    globalThis.fetch = () =>
      Promise.resolve(
        sse({
          input_tokens: 1,
          output_tokens: 0,
          total_tokens: 1,
        })
      );
    const partial = await handler(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: "cache details omitted" }),
      })
    );
    assert.equal(partial.status, 200);
    const partialTerminalEvents = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(partialTerminalEvents.length, 3);
    const partialTerminal = JSON.parse(String(partialTerminalEvents[2]?.[1])) as Record<string, unknown>;
    assert.equal(partialTerminal.cached_input_tokens, null);
    assert.equal(partialTerminal.cache_write_input_tokens, null);
    assert.equal(partialTerminal.usage_telemetry_status, "partial");
  } finally {
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
    if (originalGitRevision === undefined) Deno.env.delete("GIT_REVISION");
    else Deno.env.set("GIT_REVISION", originalGitRevision);
    if (originalGithubSha === undefined) Deno.env.delete("GITHUB_SHA");
    else Deno.env.set("GITHUB_SHA", originalGithubSha);
    if (originalBuildId === undefined) Deno.env.delete("DENO_DEPLOY_BUILD_ID");
    else Deno.env.set("DENO_DEPLOY_BUILD_ID", originalBuildId);
    if (originalDeploymentId === undefined) Deno.env.delete("DENO_DEPLOYMENT_ID");
    else Deno.env.set("DENO_DEPLOYMENT_ID", originalDeploymentId);
  }
});

Deno.test("streaming inference emits one terminal log only after the response body completes", async () => {
  kv.values.clear();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const token = `u_${"7".repeat(64)}`;
  const { hash, record } = await seedKey(token, "stream-telemetry", -1);
  const policy = apiKeyPolicyFromHashRecord(hash, record, Date.now());
  assert.ok(policy);

  const encoder = new TextEncoder();
  let resolveUpstreamController: (controller: ReadableStreamDefaultController<Uint8Array>) => void = () => {};
  const upstreamControllerPromise = new Promise<ReadableStreamDefaultController<Uint8Array>>((resolve) => {
    resolveUpstreamController = resolve;
  });
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const logs: unknown[][] = [];
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            resolveUpstreamController(controller);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "stream" } })}\n\n`));
            controller.enqueue(encoder.encode(semanticSseEvent()));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    const requestController = new AbortController();
    const completed = deferred();
    const delivery = createRequestDeliveryLifecycle(requestController.signal, completed.promise);
    const response = await handler(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: "ping", stream: true }),
        signal: requestController.signal,
      }),
      { completed: completed.promise, downstreamSignal: delivery.signal }
    );
    delivery.handoff();
    requestController.abort(new DOMException("legacy success abort", "AbortError"));
    assert.equal(delivery.signal.aborted, false);
    assert.equal(response.status, 200);
    assert.equal(logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal").length, 0);

    const bodyPromise = response.text();
    const upstreamController = await upstreamControllerPromise;
    upstreamController.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { model: MODEL, output: [], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
        })}\n\n`
      )
    );
    upstreamController.close();
    await bodyPromise;
    assert.equal(logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal").length, 0);
    completed.resolve();
    await waitFor(() => logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal").length === 1, "delivered terminal telemetry");

    const terminalLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalLogs.length, 1);
    const terminal = JSON.parse(String(terminalLogs[0]?.[1])) as Record<string, unknown>;
    assert.equal(terminal.provider, "chatgpt_codex");
    assert.equal(terminal.model, MODEL);
    assert.equal(terminal.reasoning, "medium");
    assert.equal(terminal.provider_request_id, null);
    assert.equal(terminal.stream_terminal_type, "response.completed");
    assert.equal(terminal.delivery_outcome, "delivered");
    assertOrderedTerminalTimings(terminal, true);
    assert.equal(terminal.input_tokens, 3);
    assert.equal(terminal.output_tokens, 4);
    assert.equal(terminal.total_tokens, 7);
    assert.equal(terminal.usage_telemetry_status, "partial");
    assert.equal(terminal.request_id, response.headers.get("x-uos-request-id"));
    assert.deepEqual(usageWindow(policy), {
      committed_requests: 1,
      reserved_requests: 0,
      window_reset_at_ms: policy.usage_reset_at_ms,
    });
  } finally {
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
  }
});

Deno.test("streaming timeout after dispatch emits one delivered terminal and keeps quota committed", async () => {
  const { token, policy } = await prepareApiKeyInference("6", "stream-deadline-telemetry", 5);
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const logs: unknown[][] = [];
  const encoder = new TextEncoder();
  setStreamFirstEventDeadlineMsForTest(250);
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("data: " + JSON.stringify({ type: "response.created", response: { id: "presemantic-timeout" } }) + "\n\n"));
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      )
    );
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    const completed = deferred();
    const delivery = createRequestDeliveryLifecycle(new AbortController().signal, completed.promise);
    const response = await handler(streamingRequest(token, "responses"), { completed: completed.promise, downstreamSignal: delivery.signal });
    delivery.handoff();
    assert.equal(response.status, 504);
    await response.text();
    assert.equal(logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal").length, 0);
    completed.resolve();
    await waitFor(() => logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal").length === 1, "deadline terminal telemetry");
    const terminalLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalLogs.length, 1);
    const terminal = JSON.parse(String(terminalLogs[0]?.[1])) as Record<string, unknown>;
    assert.equal(terminal.status, 504);
    assert.equal(terminal.stream_terminal_type, "deadline");
    assert.equal(terminal.delivery_outcome, "delivered");
    const firstUpstreamSseEventMs = requiredTerminalTiming(terminal, "first_upstream_sse_event_ms");
    const streamTerminalMs = requiredTerminalTiming(terminal, "stream_terminal_ms");
    const latencyMs = requiredTerminalTiming(terminal, "latency_ms");
    assert.ok(firstUpstreamSseEventMs <= streamTerminalMs);
    assert.ok(streamTerminalMs <= latencyMs);
    assert.equal(terminal.first_semantic_commitment_ms, null);
    assert.equal(terminal.downstream_drain_ms, null);
    assert.equal(delivery.signal.aborted, false);
    assert.deepEqual(usageWindow(policy), {
      committed_requests: 1,
      reserved_requests: 0,
      window_reset_at_ms: policy.usage_reset_at_ms,
    });
  } finally {
    setStreamFirstEventDeadlineMsForTest(null);
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
  }
});

Deno.test("streaming drain timing remains separate from V3 dispatch accounting", async () => {
  kv.values.clear();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const token = `u_${"c".repeat(64)}`;
  await seedKey(token, "stream-drain-timing", 5);

  const encoder = new TextEncoder();
  let resolveUpstreamController: (controller: ReadableStreamDefaultController<Uint8Array>) => void = () => {};
  const upstreamControllerPromise = new Promise<ReadableStreamDefaultController<Uint8Array>>((resolve) => {
    resolveUpstreamController = resolve;
  });
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const logs: unknown[][] = [];
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            resolveUpstreamController(controller);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "stream" } })}\n\n`));
            controller.enqueue(encoder.encode(semanticSseEvent()));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    const response = await handler(streamingRequest(token, "responses"));
    assert.ok(response.body);
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    // Precommit buffers response.created together with the first semantic
    // event. Consume that buffered delta before waiting for the provider's
    // terminal event so the drain assertion remains about terminal delivery.
    assert.equal((await reader.read()).done, false);

    const upstreamController = await upstreamControllerPromise;
    upstreamController.enqueue(encoder.encode(completedSseEvent(3, 4)));
    upstreamController.close();
    assert.equal((await reader.read()).done, false);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal((await reader.read()).done, true);

    const terminalLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalLogs.length, 1);
    const terminal = JSON.parse(String(terminalLogs[0]?.[1])) as Record<string, unknown>;
    assertOrderedTerminalTimings(terminal, true);
    const postTerminalMs = requiredTerminalTiming(terminal, "latency_ms") - requiredTerminalTiming(terminal, "stream_terminal_ms");
    const downstreamDrainMs = requiredTerminalTiming(terminal, "downstream_drain_ms");
    assert.ok(postTerminalMs >= downstreamDrainMs, "downstream drain must be part of terminal latency");
  } finally {
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
  }
});

Deno.test("semantic Responses stream drops without response.created emit one failed terminal and redacted diagnostics", async () => {
  kv.values.clear();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const token = `u_${"d".repeat(64)}`;
  const { hash, record } = await seedKey(token, "responses-stream-drop-no-created", -1);
  const policy = apiKeyPolicyFromHashRecord(hash, record, Date.now());
  assert.ok(policy);

  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const logs: unknown[][] = [];
  const encoder = new TextEncoder();
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(semanticSseEvent("partial")));
            setTimeout(() => {
              controller.error(new Error("provider socket reset"));
            }, 5);
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    const completed = deferred();
    const delivery = createRequestDeliveryLifecycle(new AbortController().signal, completed.promise);
    const response = await handler(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: "ping", stream: true }),
      }),
      { completed: completed.promise, downstreamSignal: delivery.signal }
    );
    delivery.handoff();
    assert.equal(response.status, 200);
    const text = await response.text();
    const values = [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]) as Record<string, unknown>);
    assert.deepEqual(
      values.map((value) => value.type),
      ["response.output_text.delta", "response.failed"]
    );
    assert.equal(logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal").length, 0);
    completed.resolve();
    await waitFor(() => logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal").length === 1, "post-commit failure terminal telemetry");
    const terminalLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalLogs.length, 1);
    const terminal = JSON.parse(String(terminalLogs[0]?.[1])) as Record<string, unknown>;
    assert.equal(terminal.failure_kind, "read_error");
    assert.equal(terminal.response_created_observed, false);
    assert.equal(terminal.synthetic_terminal_type, "response.failed");
    assert.equal(terminal.stream_terminal_type, "error");
    assert.equal(terminal.delivery_outcome, "delivered");
    assert.equal(terminal.request_id, response.headers.get("x-uos-request-id"));
    assert.deepEqual(usageWindow(policy), {
      committed_requests: 1,
      reserved_requests: 0,
      window_reset_at_ms: policy.usage_reset_at_ms,
    });
  } finally {
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Chat streaming terminal telemetry reports ordered timings once", async () => {
  kv.values.clear();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const token = `u_${"b".repeat(64)}`;
  await seedKey(token, "chat-stream-telemetry", -1);
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const logs: unknown[][] = [];
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(`${semanticSseEvent()}${completedSseEvent()}`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    const response = await handler(streamingRequest(token, "chat"));
    assert.equal(response.status, 200);
    await response.text();

    const terminalLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalLogs.length, 1);
    const terminal = JSON.parse(String(terminalLogs[0]?.[1])) as Record<string, unknown>;
    assert.equal(terminal.route, "chat.completions");
    assert.equal(terminal.stream_terminal_type, "response.completed");
    assertOrderedTerminalTimings(terminal, true);
  } finally {
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Images preserve Codex quota responses without hidden-model paid fallback", async () => {
  kv.values.clear();
  resetProviderHealthThrottleForTest();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const token = `u_${"d".repeat(64)}`;
  const keyId = "images-no-paid-fallback";
  await seedPaidFallbackKey(token, keyId);

  const originalFetch = globalThis.fetch;
  const originalMeteredApiKey = Deno.env.get("METERED_API_KEY");
  const originalSurplusApiKey = Deno.env.get("SURPLUS_API_KEY");
  let codexCalls = 0;
  let meteredCalls = 0;
  (await import("../src/images.ts")).setImageBaseModelForTest(MODEL);
  Deno.env.set("METERED_API_KEY", "metered-image-gate-test-key");
  Deno.env.delete("SURPLUS_API_KEY");
  await fetchMeteredModels({
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [{ id: MODEL, supported_endpoint_types: ["openai-response"] }],
        })
      ),
  });
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://api.openlux.ai/v1/responses") {
      meteredCalls += 1;
      return Promise.reject(new Error("Images must not use the hidden text model for paid fallback"));
    }
    codexCalls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: { message: "Primary image capacity exhausted", type: "rate_limit_error" },
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "29" },
        }
      )
    );
  };
  try {
    const response = await handler(
      new Request("https://ai.ubq.fi/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "a blue square" }),
      })
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
    assert.equal(response.headers.get("Retry-After"), "29");
    assert.equal((await response.json()).error?.message, "Primary image capacity exhausted");
    assert.ok(codexCalls > 0);
    assert.equal(meteredCalls, 0);
    const requestId = response.headers.get("x-uos-request-id");
    assert.ok(requestId);
    assert.equal(kv.values.get(encodeKey(paidFallbackRequestV3Key(keyId, requestId))), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    (await import("../src/images.ts")).setImageBaseModelForTest(null);
    if (originalMeteredApiKey === undefined) Deno.env.delete("METERED_API_KEY");
    else Deno.env.set("METERED_API_KEY", originalMeteredApiKey);
    if (originalSurplusApiKey === undefined) Deno.env.delete("SURPLUS_API_KEY");
    else Deno.env.set("SURPLUS_API_KEY", originalSurplusApiKey);
  }
});

Deno.test("paid fallback releases its dispatch intent when metered quota admission fails before fetch", async () => {
  kv.values.clear();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const token = `u_${"7".repeat(64)}`;
  const keyId = "fallback-pre-dispatch-quota-failure";
  await seedPaidFallbackKey(token, keyId);

  const originalFetch = globalThis.fetch;
  const originalMeteredApiKey = Deno.env.get("METERED_API_KEY");
  let meteredCalls = 0;
  Deno.env.set("METERED_API_KEY", "metered-test-key");
  globalThis.fetch = (input) => {
    const url = fetchInputUrl(input);
    if (url === "https://api.openlux.ai/v1/responses") {
      meteredCalls += 1;
      return Promise.reject(new Error("Metered transport must not start"));
    }
    return Promise.resolve(authoritativeCodexQuotaResponse());
  };
  try {
    const response = await handleResponses(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping" }),
      }),
      {
        keyId,
        kernelRepo: null,
        kernelOrg: null,
        requestId: "fallback-pre-dispatch-quota-failure-request",
        startedAtMs: Date.now(),
        beforeProviderDispatch: (provider) =>
          provider === "metered" ? Promise.reject(new ApiKeyQuotaDispatchError("API key quota reservation is unavailable")) : Promise.resolve(undefined),
      }
    );
    assert.equal(response.status, 503);
    assert.equal(meteredCalls, 0);
    const stored = [...kv.values.entries()].find(([key]) => key.includes(`"paid_fallback","v3","request","${keyId}"`))?.[1] as
      | {
          dispatch_state?: string;
          terminal_state?: string;
          billing_state?: string;
        }
      | undefined;
    assert.equal(stored?.dispatch_state, "not_dispatched");
    assert.equal(stored.terminal_state, "cancelled");
    assert.equal(stored.billing_state, "not_billed");
    const window = [...kv.values.entries()].find(([key]) => key.includes(`"paid_fallback","v3","window","${keyId}"`))?.[1] as
      { reserved_microcredits?: number; pending_count?: number } | undefined;
    assert.equal(window?.reserved_microcredits, 0);
    assert.equal(window.pending_count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMeteredApiKey === undefined) Deno.env.delete("METERED_API_KEY");
    else Deno.env.set("METERED_API_KEY", originalMeteredApiKey);
  }
});

Deno.test("expired Codex credentials prove both accounts unavailable and use same-model paid fallback", async () => {
  kv.values.clear();
  resetProviderHealthThrottleForTest();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool(2));
  const token = `u_${"b".repeat(64)}`;
  const keyId = "expired-codex-fallback";
  await seedPaidFallbackKey(token, keyId);

  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalMeteredApiKey = Deno.env.get("METERED_API_KEY");
  const originalSurplusApiKey = Deno.env.get("SURPLUS_API_KEY");
  const accountIds: string[] = [];
  const paidModels: unknown[] = [];
  const logs: unknown[][] = [];
  let refreshCalls = 0;
  let meteredCalls = 0;
  Deno.env.set("METERED_API_KEY", "metered-test-key");
  Deno.env.delete("SURPLUS_API_KEY");
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://auth.openai.com/oauth/token") {
      refreshCalls += 1;
      return Promise.resolve(
        new Response('{"error":"invalid_grant","error_description":"refresh token reused"}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (request.url === "https://api.openlux.ai/v1/models") {
      return Promise.resolve(Response.json({ data: [{ id: MODEL, supported_endpoint_types: ["openai-response"] }] }));
    }
    if (request.url === "https://api.openlux.ai/v1/responses") {
      meteredCalls += 1;
      const body = init?.body;
      if (typeof body !== "string") throw new Error("paid fixture requires a serialized JSON request");
      paidModels.push(JSON.parse(body).model);
      return Promise.resolve(sse());
    }
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: "Access token expired" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );
  };
  console.info = (...args: unknown[]) => logs.push(args);

  try {
    const response = await handler(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping", stream: true }),
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-upstream"), "metered");
    assert.equal(response.headers.get("retry-after"), null);
    await response.text();
    assert.equal(accountIds.length, 2);
    assert.equal(new Set(accountIds).size, 2);
    assert.equal(refreshCalls, 2);
    assert.equal(meteredCalls, 1);
    assert.deepEqual(paidModels, [MODEL]);
    assert.deepEqual(await Promise.all(["acct-1", "acct-2"].map(async (accountId) => (await getCodexProviderHealth(accountId)).state)), ["invalid", "invalid"]);

    const terminalLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalLogs.length, 1);
    const terminal = JSON.parse(String(terminalLogs[0]?.[1])) as Record<string, unknown>;
    assert.equal(terminal.provider, "metered");
    assert.equal(terminal.fallback_reason, "primary_subscriptions_unavailable");
    assert.equal(terminal.stream_terminal_type, "response.completed");
  } finally {
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredApiKey === undefined) Deno.env.delete("METERED_API_KEY");
    else Deno.env.set("METERED_API_KEY", originalMeteredApiKey);
    if (originalSurplusApiKey === undefined) Deno.env.delete("SURPLUS_API_KEY");
    else Deno.env.set("SURPLUS_API_KEY", originalSurplusApiKey);
  }
});

Deno.test("paid fallback terminal telemetry records Metered lifecycle", async () => {
  kv.values.clear();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const token = `u_${"9".repeat(64)}`;
  await seedPaidFallbackKey(token, "fallback-terminal-telemetry");

  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalMeteredApiKey = Deno.env.get("METERED_API_KEY");
  const logs: unknown[][] = [];
  Deno.env.set("METERED_API_KEY", "metered-test-key");
  globalThis.fetch = (input) => {
    const url = fetchInputUrl(input);
    if (url === "https://api.openlux.ai/v1/responses") {
      return new Promise<Response>((resolve) =>
        setTimeout(() => {
          resolve(sse());
        }, 30)
      );
    }
    return Promise.resolve(authoritativeCodexQuotaResponse());
  };
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    const response = await handler(request(token));
    assert.equal(response.status, 200);
    await response.text();
    const terminalLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalLogs.length, 1);
    const terminal = JSON.parse(String(terminalLogs[0]?.[1])) as Record<string, unknown>;
    assert.equal(terminal.provider, "metered");
    assert.equal(terminal.fallback_reason, "primary_quota_blocked");
    assert.equal(terminal.stream_terminal_type, "response.completed");
    assert.equal(terminal.request_id, response.headers.get("x-uos-request-id"));
    const firstCodexHeadersMs = requiredTerminalTiming(terminal, "first_codex_headers_ms");
    const firstUpstreamSseEventMs = requiredTerminalTiming(terminal, "first_upstream_sse_event_ms");
    requiredTerminalTiming(terminal, "first_semantic_commitment_ms");
    assert.ok(firstUpstreamSseEventMs >= firstCodexHeadersMs + 10, "Metered upstream SSE time must remain outside first Codex timing");
    assert.equal(Object.prototype.hasOwnProperty.call(terminal, "upstream_headers_ms"), false);
  } finally {
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
    if (originalMeteredApiKey === undefined) Deno.env.delete("METERED_API_KEY");
    else Deno.env.set("METERED_API_KEY", originalMeteredApiKey);
  }
});

Deno.test("paid fallback cancellation telemetry records a cancelled Metered lifecycle", async () => {
  kv.values.clear();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
  const token = `u_${"a".repeat(64)}`;
  const keyId = "fallback-cancel-telemetry";
  const { hash, record } = await seedPaidFallbackKey(token, keyId);
  const policy = apiKeyPolicyFromHashRecord(hash, record, Date.now());
  assert.ok(policy);

  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalMeteredApiKey = Deno.env.get("METERED_API_KEY");
  const logs: unknown[][] = [];
  const encoder = new TextEncoder();
  let upstreamCancellations = 0;
  Deno.env.set("METERED_API_KEY", "metered-test-key");
  globalThis.fetch = (input) => {
    const url = fetchInputUrl(input);
    if (url === "https://api.openlux.ai/v1/responses") {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "cancelled" } })}\n\n`));
              controller.enqueue(encoder.encode(semanticSseEvent()));
            },
            cancel() {
              upstreamCancellations += 1;
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
      );
    }
    return Promise.resolve(authoritativeCodexQuotaResponse());
  };
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    const requestController = new AbortController();
    const completed = deferred();
    const delivery = createRequestDeliveryLifecycle(requestController.signal, completed.promise);
    const response = await handler(new Request(streamingRequest(token, "responses"), { signal: requestController.signal }), {
      completed: completed.promise,
      downstreamSignal: delivery.signal,
    });
    delivery.handoff();
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel("client disconnected");
    const deliveryFailure = new DOMException("client disconnected", "AbortError");
    completed.reject(deliveryFailure);
    await completed.promise.catch(() => {});
    await waitFor(() => logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal").length === 1, "cancelled terminal telemetry");

    const terminalLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalLogs.length, 1);
    const terminal = JSON.parse(String(terminalLogs[0]?.[1])) as Record<string, unknown>;
    assert.equal(terminal.provider, "metered");
    assert.equal(terminal.fallback_reason, "primary_quota_blocked");
    assert.equal(terminal.stream_terminal_type, "cancelled");
    assert.equal(terminal.delivery_outcome, "interrupted");
    assert.equal(delivery.signal.aborted, true);
    assert.equal(delivery.signal.reason, deliveryFailure);
    assert.equal(upstreamCancellations, 1);
    const requestId = response.headers.get("x-uos-request-id");
    assert.ok(requestId);
    const requestKey = paidFallbackRequestV3Key(keyId, requestId);
    await waitFor(
      () => (kv.values.get(encodeKey(requestKey)) as { terminal_state?: unknown } | undefined)?.terminal_state === "cancelled",
      "cancelled paid-fallback ledger state"
    );
    const stored = kv.values.get(encodeKey(requestKey)) as {
      dispatch_state?: unknown;
      terminal_state?: unknown;
      billing_state?: unknown;
    };
    assert.equal(stored.dispatch_state, "dispatched");
    assert.equal(stored.terminal_state, "cancelled");
    assert.equal(stored.billing_state, "pending");
    assert.equal([...kv.values.keys()].filter((key) => key.includes('"paid_fallback","v3","request"') && key.includes(keyId)).length, 1);
    assert.deepEqual(usageWindow(policy), {
      committed_requests: 1,
      reserved_requests: 0,
      window_reset_at_ms: policy.usage_reset_at_ms,
    });
  } finally {
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
    if (originalMeteredApiKey === undefined) Deno.env.delete("METERED_API_KEY");
    else Deno.env.set("METERED_API_KEY", originalMeteredApiKey);
  }
});

Deno.test("V3 limit-only changes preserve the active aggregate identity and committed usage", async () => {
  const token = `u_${"4".repeat(64)}`;
  const { hash, record } = await seedKey(token, "limit-change", 100);
  const original = apiKeyPolicyFromHashRecord(hash, record, now);
  const lowered = apiKeyPolicyFromHashRecord(hash, { ...record, usage_limit_requests: 10 }, now);
  assert.ok(original && lowered);
  assert.deepEqual(apiKeyUsageV3WindowKey(lowered), apiKeyUsageV3WindowKey(original));
  kv.values.set(encodeKey(apiKeyUsageV3WindowKey(original)), { ...makeApiKeyUsageWindowV3(original), committed_requests: 12 });
  kv.values.set(encodeKey(["ubq_ai", "api_keys", "hash", hash]), { ...record, usage_limit_requests: 10 });
  resetApiKeyPolicyCacheForTest();
  const decision = await authenticateApiKeyToken(token, { kv: kv as unknown as Deno.Kv, nowMs: now });
  assert.equal(decision.ok, true, "authentication must not perform inference quota admission");
  assert.equal(usageWindow(lowered).committed_requests, 12);
});

Deno.test("/uos/auth projects committed V3 usage while models stay quota-ledger independent", async () => {
  const { token, hash, record, policy } = await prepareApiKeyInference("5", "auth-projection", 10);
  kv.values.set(encodeKey(apiKeyUsageV3WindowKey(policy)), { ...makeApiKeyUsageWindowV3(policy), committed_requests: 7, reserved_requests: 1 });
  kv.values.set(encodeKey(["ubq_ai", "api_keys", "id", policy.key_id]), {
    ...record,
    id: policy.key_id,
    name: "Auth projection",
    prefix: token.slice(0, 12),
    hash,
    created_at_ms: Date.now(),
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_pricing_checked_at_ms: null,
  });

  const auth = await handler(new Request("https://ai.ubq.fi/uos/auth", { headers: { Authorization: `Bearer ${token}` } }));
  assert.equal(auth.status, 200);
  const authBody = (await auth.json()) as { auth?: { method?: { key?: { usage_requests?: number } } } };
  assert.equal(authBody.auth?.method?.key?.usage_requests, 7);

  kv.failApiKeyV3Reads = true;
  try {
    const models = await handler(new Request("https://ai.ubq.fi/v1/models", { headers: { Authorization: `Bearer ${token}` } }));
    assert.equal(models.status, 200, "non-inference routes must not read the V3 quota aggregate");

    const unavailableProjection = await handler(new Request("https://ai.ubq.fi/uos/auth", { headers: { Authorization: `Bearer ${token}` } }));
    assert.equal(unavailableProjection.status, 503, "/uos/auth must fail rather than report stale usage");
  } finally {
    kv.failApiKeyV3Reads = false;
  }
});

Deno.test("V3 automatic window advancement changes aggregate identity only when the effective window changes", async () => {
  const token = `u_${"6".repeat(64)}`;
  const { hash, record } = await seedKey(token, "window-advance", 100);
  const expired = { ...record, usage_reset_at_ms: now - 1 };
  const beforeAdvance = apiKeyPolicyFromHashRecord(hash, expired, now);
  assert.ok(beforeAdvance);
  const afterAdvance = apiKeyPolicyFromHashRecord(hash, { ...expired, usage_reset_at_ms: beforeAdvance.usage_reset_at_ms }, now);
  const explicitlyReset = apiKeyPolicyFromHashRecord(hash, { ...expired, usage_reset_at_ms: now + expired.window_ms }, now);
  assert.ok(afterAdvance && explicitlyReset);
  assert.deepEqual(apiKeyUsageV3WindowKey(afterAdvance), apiKeyUsageV3WindowKey(beforeAdvance));
  assert.notDeepEqual(apiKeyUsageV3WindowKey(explicitlyReset), apiKeyUsageV3WindowKey(beforeAdvance));
});

Deno.test("KV budget: runtime configuration revalidates after the bounded isolate TTL", async () => {
  resetRuntimeConfigCacheForTest();
  const first = structuredClone(runtime);
  const second = {
    ...runtime,
    default_model: "gpt-5-kv-budget-next",
    codex_models: {
      ...runtime.codex_models,
      models: [
        {
          slug: "gpt-5-kv-budget-next",
          default_reasoning_level: "high",
          supported_reasoning_levels: ["none", "high"],
        },
      ],
    },
    updated_at_ms: now + 1,
  };
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), first);
  kv.resetCounts();
  assert.equal((await loadRuntimeConfig(kv as unknown as Deno.Kv, now))?.default_model, MODEL);
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), second);
  assert.equal((await loadRuntimeConfig(kv as unknown as Deno.Kv, now + RUNTIME_CONFIG_CACHE_TTL_MS - 1))?.default_model, MODEL);
  const refreshed = await Promise.all(Array.from({ length: 20 }, () => loadRuntimeConfig(kv as unknown as Deno.Kv, now + RUNTIME_CONFIG_CACHE_TTL_MS + 1)));
  assert.ok(refreshed.every((config) => config?.default_model === second.default_model));
  assert.equal(kv.reads, 2);
});

Deno.test("KV budget: failed runtime configuration refresh backs off with stale configuration", async () => {
  resetRuntimeConfigCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  assert.equal((await loadRuntimeConfig(kv as unknown as Deno.Kv, now))?.default_model, MODEL);

  let failedReads = 0;
  const unavailableKv = {
    get: () => {
      failedReads += 1;
      return Promise.reject(new Error("runtime config KV unavailable"));
    },
  } as unknown as Deno.Kv;
  assert.equal((await loadRuntimeConfig(unavailableKv, now + RUNTIME_CONFIG_CACHE_TTL_MS + 1))?.default_model, MODEL);
  assert.equal((await loadRuntimeConfig(unavailableKv, now + RUNTIME_CONFIG_CACHE_TTL_MS * 2))?.default_model, MODEL);
  assert.equal(failedReads, 1);
});

Deno.test("KV budget: malformed tokens are rejected without KV and policy expiry refreshes revocation", async () => {
  const originalInfo = console.info;
  const logs: unknown[][] = [];
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    kv.resetCounts();
    const malformedResponse = await handler(request("malformed"));
    assert.equal(malformedResponse.status, 401);
    assert.deepEqual({ reads: kv.reads, writes: kv.writes }, { reads: 0, writes: 0 });
    const terminalLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalLogs.length, 1);
    const terminal = JSON.parse(String(terminalLogs[0]?.[1])) as Record<string, unknown>;
    assert.equal(terminal.status, 401);
    assert.equal(terminal.provider, "gateway");
    assert.equal(Object.prototype.hasOwnProperty.call(terminal, "key_id"), false);
    assert.equal(terminal.request_id, malformedResponse.headers.get("x-uos-request-id"));
    assert.equal(terminal.input_tokens, null);
    assert.equal(terminal.output_tokens, null);
    assert.equal(terminal.total_tokens, null);
    assert.equal(terminal.usage_telemetry_status, "missing");
    assert.equal(terminal.provider_request_id, null);
  } finally {
    console.info = originalInfo;
  }

  const token = `u_${"3".repeat(64)}`;
  const { hash, record } = await seedKey(token, "revoked", -1);
  resetApiKeyPolicyCacheForTest();
  assert.equal((await authenticateApiKeyToken(token, { kv: kv as unknown as Deno.Kv, nowMs: now })).ok, true);
  kv.values.set(encodeKey(["ubq_ai", "api_keys", "hash", hash]), { ...record, revoked_at_ms: now + 1 });
  assert.equal((await authenticateApiKeyToken(token, { kv: kv as unknown as Deno.Kv, nowMs: now + 29_999 })).ok, true);
  assert.equal((await authenticateApiKeyToken(token, { kv: kv as unknown as Deno.Kv, nowMs: now + 30_001 })).ok, false);
  invalidateApiKeyPolicy("revoked");
});

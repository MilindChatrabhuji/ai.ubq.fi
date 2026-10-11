import assert from "node:assert/strict";
import { fetchTemporaryFreeSurplusRoutedResponses } from "../src/paid-fallback/health.ts";
import { createResponseTelemetryState, type UsageContext } from "../src/openai-telemetry.ts";
import { restoreAnthropicChatReplay } from "../src/provider/anthropic-replay.ts";

const model = "claude-opus-5.5";

Deno.test("temporary Surplus routing forwards authenticated replay scope and records the selected native cache policy", async () => {
  const previousKey = Deno.env.get("SURPLUS_API_KEY");
  const previousFetch = globalThis.fetch;
  Deno.env.set("SURPLUS_API_KEY", "surplus-scoped-replay-test-key");
  try {
    for (const fixture of [
      { scope: "temporary-principal-a", keyId: "temporary-key-a", principal: "temporary-principal-a", explicit: false },
      { scope: "temporary-key-b", keyId: "temporary-key-b", principal: undefined, explicit: true },
    ]) {
      const telemetry = createResponseTelemetryState();
      telemetry.promptCacheMode = "legacy_retention";
      telemetry.explicitBreakpointCount = 9;
      const usageContext: UsageContext = {
        keyId: fixture.keyId,
        idempotencyPrincipal: fixture.principal,
        requestId: `${fixture.keyId}-request`,
        kernelRepo: null,
        kernelOrg: null,
        responseTelemetry: telemetry,
      };
      const body = {
        model,
        max_output_tokens: 128,
        stream: false,
        tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { value: { type: "string" } } } }],
        input: fixture.explicit
          ? [{ type: "message", role: "user", content: [{ type: "input_text", text: "use the tool", prompt_cache_breakpoint: { mode: "explicit" } }] }]
          : "use the tool",
      };
      let calls = 0;
      globalThis.fetch = (input, init) => {
        let url: string;
        if (typeof input === "string") url = input;
        else if (input instanceof URL) url = input.href;
        else url = input.url;
        const encodedBody = typeof init?.body === "string" ? init.body : null;
        calls += 1;
        assert.equal(url, "https://api.surplusintelligence.ai/v1/chat/completions");
        assert.equal(encodedBody?.includes(fixture.scope), false, "the authenticated replay scope must stay off the upstream wire");
        return Promise.resolve(
          Response.json({
            id: `chatcmpl_${fixture.keyId}`,
            object: "chat.completion",
            created: 1,
            model,
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  reasoning_details: [{ type: "reasoning.text", text: "Call the requested tool.", signature: `private-signature-${fixture.keyId}`, index: 0 }],
                  tool_calls: [{ id: `tool_${fixture.keyId}`, type: "function", function: { name: "lookup", arguments: '{"value":"fixture"}' } }],
                },
              },
            ],
            usage: {
              prompt_tokens: 1043,
              completion_tokens: 4,
              total_tokens: 1047,
              prompt_tokens_details: { cache_write_tokens: 1028 },
              buyer_cost_micro: 1056,
            },
          })
        );
      };
      const routed = await fetchTemporaryFreeSurplusRoutedResponses(body, { model, usageContext });
      assert.equal(calls, 1);
      assert.equal(routed.provider, "surplus");
      assert.equal(routed.paidFallback, null);
      const payload = (await routed.response.json()) as { output: Record<string, unknown>[] };
      assert.equal(JSON.stringify(payload).includes("private-signature"), false);
      assert.equal(telemetry.promptCacheMode, fixture.explicit ? "explicit" : "implicit");
      assert.equal(telemetry.explicitBreakpointCount, fixture.explicit ? 1 : 0);
      assert.ok(restoreAnthropicChatReplay(payload.output, { scope: fixture.scope, provider: "surplus", model }));
      assert.equal(restoreAnthropicChatReplay(payload.output, { scope: `${fixture.scope}-other`, provider: "surplus", model }), null);
      if (fixture.principal) assert.equal(restoreAnthropicChatReplay(payload.output, { scope: fixture.keyId, provider: "surplus", model }), null);
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) Deno.env.delete("SURPLUS_API_KEY");
    else Deno.env.set("SURPLUS_API_KEY", previousKey);
  }
});

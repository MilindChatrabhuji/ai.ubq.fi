import { test } from "bun:test";
import assert from "node:assert/strict";

import { toDeepSeekResponsesChatBody } from "../src/deepseek/chat-projection.ts";

test("deepseek responses: forwards sampling controls when thinking is disabled", () => {
  const disabled = toDeepSeekResponsesChatBody(
    { input: "hi", reasoning: { effort: "none" }, temperature: 0, top_p: 0.4 },
    "deepseek-flash",
    false
  );
  assert.equal(disabled.ok, true);
  assert.equal(Object.hasOwn(disabled.value.body, "temperature"), true);
  assert.equal(disabled.value.body.temperature, 0);
  assert.equal(Object.hasOwn(disabled.value.body, "top_p"), true);
  assert.equal(disabled.value.body.top_p, 0.4);
  assert.deepEqual(disabled.value.warnings, []);

  const disabledByThinking = toDeepSeekResponsesChatBody(
    { input: "hi", thinking: { type: "disabled" }, temperature: 0 },
    "deepseek-flash",
    false
  );
  assert.equal(disabledByThinking.ok, true);
  assert.equal(disabledByThinking.value.body.reasoning_effort, "none");
  assert.equal(disabledByThinking.value.body.temperature, 0);
  assert.deepEqual(disabledByThinking.value.warnings, []);

  const active = toDeepSeekResponsesChatBody(
    { input: "hi", reasoning: { effort: "high" }, temperature: 0, top_p: 0.4 },
    "deepseek-flash",
    false
  );
  assert.equal(active.ok, true);
  assert.equal("temperature" in active.value.body, false);
  assert.equal("top_p" in active.value.body, false);
  assert.deepEqual(active.value.warnings, ["temperature_ignored", "top_p_ignored"]);
});

import { test } from "bun:test";
import assert from "node:assert/strict";

import { normalizeCodexModelsPayload } from "../src/models/codex-models.ts";

import { deriveAutoCompactTokenLimit, resolvedAutoCompactTokenLimit } from "../src/recent-model-context.ts";

test("auto-compaction uses the earlier 85 percent or 50k-reserve boundary", () => {
  assert.equal(deriveAutoCompactTokenLimit(1_000_000), 850_000);
  assert.equal(deriveAutoCompactTokenLimit(400_000), 340_000);
  assert.equal(deriveAutoCompactTokenLimit(262_144), 212_144);
  assert.equal(deriveAutoCompactTokenLimit(204_800), 154_800);
  assert.throws(() => deriveAutoCompactTokenLimit(50_000), RangeError);
});

test("a declared auto-compaction threshold inside the window outranks the derived one", () => {
  assert.equal(resolvedAutoCompactTokenLimit(272_000, 200_000), 200_000);
  assert.equal(resolvedAutoCompactTokenLimit(272_000, null), 222_000);
  // A threshold larger than the window it belongs to is not a usable limit.
  assert.equal(resolvedAutoCompactTokenLimit(272_000, 892_500), 222_000);
  assert.equal(resolvedAutoCompactTokenLimit(272_000, undefined), 222_000);
});

test("Codex snapshot normalization preserves native effective context percentage", () => {
  const snapshot = normalizeCodexModelsPayload({
    models: [
      {
        slug: "gpt-5.6-terra",
        context_window: 272_000,
        max_context_window: 1_000_000,
        auto_compact_token_limit: null,
        effective_context_window_percent: 91,
      },
    ],
  });
  assert.equal(snapshot?.models[0]?.effective_context_window_percent, 91);
});

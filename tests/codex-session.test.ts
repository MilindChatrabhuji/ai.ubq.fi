import { test } from "bun:test";
import { type Kv } from "#kv";
import assert from "node:assert/strict";
import { observeCodexSession } from "../src/codex/session.ts";
import { setKvForTest } from "../src/kv.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

test("codex session observer classifies first, continuing, and hour-idle requests", async () => {
  const kv = new CountingKv();
  setKvForTest(kv as unknown as Kv);
  try {
    const first = await observeCodexSession("key-a", { session_id: "session-a" }, 1_000_000);
    assert.equal(first.state, "new");
    assert.equal(first.continuation_only_candidate, false);
    assert.equal(first.session_id_present, true);

    const continuing = await observeCodexSession("key-a", { session_id: "session-a" }, 1_000_001);
    assert.equal(continuing.state, "continuation");
    assert.equal(continuing.continuation_age_ms, 1);
    assert.equal(continuing.continuation_only_candidate, false);

    const hourIdle = await observeCodexSession("key-a", { session_id: "session-a" }, 1_000_000 + 60 * 60 * 1000);
    assert.equal(hourIdle.state, "continuation");
    assert.equal(hourIdle.continuation_age_ms, 60 * 60 * 1000);
    assert.equal(hourIdle.continuation_only_candidate, true);

    const otherApiKey = await observeCodexSession("key-b", { session_id: "session-a" }, 1_000_000 + 60 * 60 * 1000);
    assert.equal(otherApiKey.state, "new");
    assert.equal(otherApiKey.continuation_only_candidate, false);
    for (const entry of kv.entries.values()) {
      assert.doesNotMatch(JSON.stringify(entry.value), /session-a|key-a|key-b/);
      assert.doesNotMatch(JSON.stringify(entry.key), /session-a|key-a|key-b/);
    }
  } finally {
    setKvForTest(null);
  }
});

test("codex session observer resets the continuation window on a new session", async () => {
  const kv = new CountingKv();
  setKvForTest(kv as unknown as Kv);
  try {
    await observeCodexSession("key-a", { session_id: "session-a" }, 2_000_000);
    const newSession = await observeCodexSession("key-a", { session_id: "session-b" }, 2_000_000 + 60 * 60 * 1000);
    assert.equal(newSession.state, "new");
    assert.equal(newSession.continuation_only_candidate, false);

    const oldSession = await observeCodexSession("key-a", { session_id: "session-a" }, 2_000_000 + 60 * 60 * 1000 + 1);
    assert.equal(oldSession.state, "continuation");
    assert.equal(oldSession.continuation_age_ms, 1);
    assert.equal(oldSession.continuation_only_candidate, false);
  } finally {
    setKvForTest(null);
  }
});

test("codex session observer fails closed for missing metadata or KV", async () => {
  setKvForTest(null);
  const missing = await observeCodexSession("key-a", undefined, 3_000_000);
  assert.deepEqual(missing, {
    metadata_present: false,
    session_id_present: false,
    session_id_hash: null,
    state: "unknown",
    continuation_age_ms: null,
    continuation_only_candidate: false,
  });

  const malformed = await observeCodexSession("key-a", { request_kind: "turn" }, 3_000_000);
  assert.equal(malformed.metadata_present, true);
  assert.equal(malformed.state, "unknown");
  assert.equal(malformed.session_id_present, false);
});

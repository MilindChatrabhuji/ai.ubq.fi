import { test } from "bun:test";
import assert from "node:assert/strict";

import handler from "../src/handler/index.ts";
import { defaultSupervisorSource, normalizeEpochMs, parseSupervisorConfig } from "../src/codex/supervisor-config.ts";
import { extractFollowEntries, parseFollowCursor } from "../src/codex/supervisor-follow.ts";
import { classifySupervisorState, quotaFromRateLimits, sessionFromParts } from "../src/codex/supervisor-inventory.ts";

test("parseSupervisorConfig accepts a valid source list", () => {
  const parsed = parseSupervisorConfig({
    sources: [
      { id: "local", name: "This Mac", socketPath: "/var/lib/uos-supervisor/a.sock", codexHome: "/var/lib/uos-supervisor/.codex" },
      { id: "vps", name: "VPS", socketPath: "/var/lib/uos-supervisor/b.sock" },
    ],
  });
  assert.deepEqual(parsed.notes, []);
  assert.deepEqual(parsed.sources, [
    { id: "local", name: "This Mac", socketPath: "/var/lib/uos-supervisor/a.sock", codexHome: "/var/lib/uos-supervisor/.codex" },
    { id: "vps", name: "VPS", socketPath: "/var/lib/uos-supervisor/b.sock", codexHome: null },
  ]);
});

test("parseSupervisorConfig ignores unsafe or malformed sources", () => {
  const parsed = parseSupervisorConfig({
    sources: [
      { id: "Local", name: "Uppercase id", socketPath: "/var/lib/uos-supervisor/a.sock" },
      { id: "relative", name: "Relative socket", socketPath: "app-server.sock" },
      { id: "relative-home", name: "Relative home", socketPath: "/var/lib/uos-supervisor/c.sock", codexHome: "relative/.codex" },
      { id: "dupe", name: "First", socketPath: "/var/lib/uos-supervisor/d.sock" },
      { id: "dupe", name: "Second", socketPath: "/var/lib/uos-supervisor/e.sock" },
      { id: "ok", name: "OK", socketPath: "/var/lib/uos-supervisor/f.sock" },
    ],
  });
  assert.deepEqual(
    parsed.sources.map((source) => source.id),
    ["dupe", "ok"]
  );
  assert.equal(parsed.notes.length, 4);
});

test("parseSupervisorConfig requires a sources array", () => {
  assert.deepEqual(parseSupervisorConfig(null).sources, []);
  assert.deepEqual(parseSupervisorConfig({}).sources, []);
  assert.equal(parseSupervisorConfig({ sources: [] }).notes.length, 1);
});

test("defaultSupervisorSource prefers CODEX_HOME and falls back to HOME", () => {
  const notes: string[] = [];
  const fromCodexHome = defaultSupervisorSource((name) => (name === "CODEX_HOME" ? "/custom/codex" : "/home/tester"), notes);
  assert.deepEqual(fromCodexHome, {
    id: "local",
    name: "Local Codex",
    socketPath: "/custom/codex/app-server-control/app-server-control.sock",
    codexHome: "/custom/codex",
  });
  const fromHome = defaultSupervisorSource((name) => (name === "HOME" ? "/home/tester/" : undefined), notes);
  assert.ok(fromHome);
  assert.equal(fromHome.codexHome, "/home/tester/.codex");
  assert.equal(fromHome.socketPath, "/home/tester/.codex/app-server-control/app-server-control.sock");
  assert.deepEqual(
    defaultSupervisorSource(() => undefined, notes),
    null
  );
  assert.ok(notes.length >= 1);
});

test("normalizeEpochMs accepts seconds and milliseconds", () => {
  assert.equal(normalizeEpochMs(1_730_831_111), 1_730_831_111_000);
  assert.equal(normalizeEpochMs(1_730_831_111_000), 1_730_831_111_000);
  assert.equal(normalizeEpochMs(0), null);
  assert.equal(normalizeEpochMs(-5), null);
  assert.equal(normalizeEpochMs("1730831111"), null);
  assert.equal(normalizeEpochMs(null), null);
});

test("classifySupervisorState treats runtime status as authoritative", () => {
  assert.equal(classifySupervisorState({ runtimeStatus: "active", turnStatus: "inProgress", loaded: true }), "active");
  assert.equal(classifySupervisorState({ runtimeStatus: "systemError", turnStatus: null, loaded: true }), "system_error");
  assert.equal(classifySupervisorState({ runtimeStatus: "idle", turnStatus: null, loaded: false }), "idle");
  assert.equal(classifySupervisorState({ runtimeStatus: "notLoaded", turnStatus: "completed", loaded: false }), "idle");
});

test("classifySupervisorState never fabricates idle", () => {
  assert.equal(classifySupervisorState({ runtimeStatus: "notLoaded", turnStatus: "inProgress", loaded: false }), "stale");
  assert.equal(classifySupervisorState({ runtimeStatus: "notLoaded", turnStatus: null, loaded: false }), "unknown");
  assert.equal(classifySupervisorState({ runtimeStatus: null, turnStatus: "completed", loaded: false }), "unknown");
  assert.equal(classifySupervisorState({ runtimeStatus: null, turnStatus: "inProgress", loaded: true }), "active");
  assert.equal(classifySupervisorState({ runtimeStatus: null, turnStatus: "inProgress", loaded: false }), "stale");
  assert.equal(classifySupervisorState({ runtimeStatus: null, turnStatus: null, loaded: true }), "unknown");
});

test("extractFollowEntries keeps only assistant messages and command output", () => {
  const entries = extractFollowEntries("turn_1", [
    { type: "reasoning", id: "r1", summary: ["private reasoning"], content: ["private reasoning"] },
    { type: "userMessage", id: "u1", content: [{ type: "text", text: "hello" }] },
    { type: "agentMessage", id: "a1", text: "Working on it", phase: "commentary" },
    { type: "commandExecution", id: "c1", command: "deno task test", status: "completed", exitCode: 0, aggregatedOutput: "ok\n" },
    { type: "fileChange", id: "f1", changes: [] },
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["message", "command"]
  );
  assert.equal(entries[0].key, "turn_1:a1");
  assert.equal(entries[0].text, "Working on it");
  assert.equal(entries[0].status, "commentary");
  assert.equal(entries[0].index, 2);
  assert.equal(entries[1].key, "turn_1:c1");
  assert.equal(entries[1].command, "deno task test");
  assert.equal(entries[1].text, "ok\n");
  assert.equal(entries[1].exitCode, 0);
  assert.equal(entries[1].index, 3);
});

test("extractFollowEntries tolerates unknown payloads", () => {
  assert.deepEqual(extractFollowEntries("turn_1", null), []);
  assert.deepEqual(extractFollowEntries("turn_1", "not-an-array"), []);
  assert.deepEqual(
    extractFollowEntries("turn_1", [null, 7, { type: "agentMessage" }]).map((entry) => entry.text),
    [""]
  );
});

test("parseFollowCursor round-trips turn ids that contain separators", () => {
  assert.deepEqual(parseFollowCursor("turn_1:4"), { turnId: "turn_1", index: 4 });
  assert.deepEqual(parseFollowCursor("thr:a:b:0"), { turnId: "thr:a:b", index: 0 });
  assert.deepEqual(parseFollowCursor("turn_1:-1"), { turnId: "turn_1", index: -1 });
  assert.equal(parseFollowCursor(""), null);
  assert.equal(parseFollowCursor("turn_1"), null);
  assert.equal(parseFollowCursor("turn_1:x"), null);
});

test("the supervisor routes require admin auth in the real router", async () => {
  const sessions = await handler(new Request("https://ai.ubq.fi/admin/codex/supervisor/sessions"));
  assert.equal(sessions.status, 401, "an unauthenticated session read reaches the admin gate instead of sampling sources");
  const output = await handler(new Request("https://ai.ubq.fi/admin/codex/supervisor/output?source=local&id=thread-1"));
  assert.equal(output.status, 401, "an unauthenticated follow read reaches the admin gate");
});

test("remote rows use verified live thread fields and keep token usage unavailable", () => {
  const session = sessionFromParts({
    id: "01a0c7ae-5be8-7712-aaee-26638cf84a32",
    source: { id: "vps", name: "vps.pavlovcik.com", socketPath: "/var/lib/uos-supervisor/vps.sock", codexHome: null },
    metadata: null,
    listed: {
      id: "01a0c7ae-5be8-7712-aaee-26638cf84a32",
      name: null,
      preview: "Fix agent dispatch validation",
      cwd: "/home/codex/repos/ubiquity/ai.ubq.fi",
      model: "deepseek-flash",
      effort: "high",
      sourceKind: "cli",
      parentThreadId: "01a0b67c-parent",
      updatedAtMs: 1_789_852_742_000,
      modelProvider: "uos",
    },
    probe: { runtimeStatus: "active", activeFlags: [], turnStatus: "inProgress", thread: null, sampled: true },
    loaded: true,
    sampledAtMs: 1_790_056_921_788,
    childIds: [],
    unavailable: ["token usage is not reported by the source"],
  });
  assert.equal(session.title, "Fix agent dispatch validation");
  assert.equal(session.titleSource, "thread");
  assert.equal(session.cwd, "/home/codex/repos/ubiquity/ai.ubq.fi");
  assert.equal(session.model, "deepseek-flash");
  assert.equal(session.effort, "high");
  assert.equal(session.sourceKind, "cli");
  assert.equal(session.parentThreadId, "01a0b67c-parent");
  assert.equal(session.provider, "uos");
  assert.equal(session.state, "active");
  assert.equal(session.tokensUsed, null);
  assert.equal(session.usageSource, null);
  assert.deepEqual(session.unavailable, ["token usage is not reported by the source"]);
});

test("thread/read fields serve loaded threads and local metadata only enriches gaps", () => {
  const session = sessionFromParts({
    id: "01a0bd67-loaded-only",
    source: { id: "local", name: "m1.local", socketPath: "/var/lib/uos-supervisor/local.sock", codexHome: "/Users/example/.codex" },
    metadata: {
      title: null,
      preview: null,
      cwd: null,
      model: null,
      effort: null,
      tokensUsed: 10_424_391,
      gitBranch: "development",
      updatedAtMs: 1,
      archived: false,
      threadSource: "user",
      parentThreadId: null,
      agentNickname: null,
    },
    listed: null,
    probe: {
      runtimeStatus: "idle",
      activeFlags: [],
      turnStatus: "completed",
      thread: {
        id: "01a0bd67-loaded-only",
        name: "Named thread",
        preview: null,
        cwd: "/repo",
        model: "gpt-6-astra",
        effort: "max",
        sourceKind: "vscode",
        parentThreadId: null,
        updatedAtMs: 2,
        modelProvider: "uos",
      },
      sampled: true,
    },
    loaded: true,
    sampledAtMs: 3,
    childIds: null,
    unavailable: [],
  });
  assert.equal(session.title, "Named thread");
  assert.equal(session.cwd, "/repo");
  assert.equal(session.model, "gpt-6-astra");
  assert.equal(session.effort, "max");
  assert.equal(session.sourceKind, "vscode");
  assert.equal(session.state, "idle");
  assert.equal(session.branch, "development");
  assert.equal(session.tokensUsed, 10_424_391);
  assert.equal(session.usageSource, "state_db");
});

test("listed session gaps use probed fields before metadata and preserve nonnull listed values", () => {
  const thread = {
    id: "01a0bd67-listed-and-probed",
    name: "Probed title",
    preview: "Probed preview",
    cwd: "/probed-repo",
    model: "gpt-6.1-sol",
    effort: "ultra",
    sourceKind: "subagent",
    parentThreadId: "probed-parent",
    updatedAtMs: 2,
    modelProvider: "uos",
  };
  const listed = {
    id: thread.id,
    name: null,
    preview: null,
    cwd: null,
    model: null,
    effort: null,
    sourceKind: null,
    parentThreadId: null,
    updatedAtMs: null,
    modelProvider: null,
  };
  const input = {
    id: thread.id,
    source: { id: "local", name: "Test machine", socketPath: "/var/lib/uos-supervisor/local.sock", codexHome: "/Users/example/.codex" },
    metadata: {
      title: "Metadata title",
      preview: "Metadata preview",
      cwd: "/metadata-repo",
      model: "metadata-model",
      effort: "low",
      tokensUsed: 0,
      gitBranch: "development",
      updatedAtMs: 1,
      archived: false,
      threadSource: "metadata-source",
      parentThreadId: "metadata-parent",
      agentNickname: null,
    },
    probe: { runtimeStatus: "active", activeFlags: [], turnStatus: "inProgress", thread, sampled: true },
    loaded: true,
    sampledAtMs: 3,
    childIds: null,
    unavailable: [],
  };
  const filled = sessionFromParts({ ...input, listed });
  assert.equal(filled.title, thread.name);
  assert.equal(filled.titleSource, "thread");
  assert.equal(filled.cwd, thread.cwd);
  assert.equal(filled.model, thread.model);
  assert.equal(filled.effort, thread.effort);
  assert.equal(filled.provider, thread.modelProvider);
  assert.equal(filled.sourceKind, thread.sourceKind);
  assert.equal(filled.parentThreadId, thread.parentThreadId);
  assert.equal(filled.lastActivityAtMs, thread.updatedAtMs);
  const conflicting = {
    ...thread,
    name: "Listed title",
    preview: "Listed preview",
    cwd: "/listed-repo",
    model: "listed-model",
    effort: "high",
    sourceKind: "cli",
    parentThreadId: "listed-parent",
    updatedAtMs: 0,
    modelProvider: "listed-provider",
  };
  const retained = sessionFromParts({ ...input, listed: conflicting });
  assert.equal(retained.title, conflicting.name);
  assert.equal(retained.cwd, conflicting.cwd);
  assert.equal(retained.model, conflicting.model);
  assert.equal(retained.effort, conflicting.effort);
  assert.equal(retained.provider, conflicting.modelProvider);
  assert.equal(retained.sourceKind, conflicting.sourceKind);
  assert.equal(retained.parentThreadId, conflicting.parentThreadId);
  assert.equal(retained.lastActivityAtMs, 0);
  const mixed = sessionFromParts({ ...input, listed: { ...conflicting, model: null, parentThreadId: null } });
  assert.equal(mixed.title, conflicting.name);
  assert.equal(mixed.model, thread.model);
  assert.equal(mixed.parentThreadId, thread.parentThreadId);
  const preview = sessionFromParts({ ...input, listed, probe: { ...input.probe, thread: { ...thread, name: null } } });
  assert.equal(preview.title, thread.preview);
});

test("shared quota projection keeps one account-wide bucket per limit", () => {
  const quota = quotaFromRateLimits({
    rateLimits: { limitId: "codex", primary: { usedPercent: 29, windowDurationMins: 10080, resetsAt: 1_790_478_535 } },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 29, windowDurationMins: 10080, resetsAt: 1_790_478_535 },
        planType: "pro",
        rateLimitReachedType: null,
      },
    },
    rateLimitResetCredits: { availableCount: 1 },
  });
  assert.ok(quota);
  assert.equal(quota.accountScope, "shared_codex_account");
  assert.deepEqual(quota.buckets, [
    {
      limitId: "codex",
      limitName: null,
      usedPercent: 29,
      windowDurationMins: 10080,
      resetsAtMs: 1_790_478_535_000,
      planType: "pro",
      reachedType: null,
    },
  ]);
  assert.equal(quota.resetCreditsAvailable, 1);
  assert.equal(quotaFromRateLimits({}), null);
  assert.equal(quotaFromRateLimits(null), null);
});

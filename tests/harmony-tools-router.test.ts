import { test } from "bun:test";
import assert from "node:assert/strict";

import { type ToolBackends } from "../src/harmony/tools/backend.ts";
import { createFakeToolBackends, FakeShell, FakeWorkspaceBackend } from "../src/harmony/tools/fakes.ts";
import { type ToolResult } from "../src/harmony/tools/result.ts";
import { runTool } from "../src/harmony/tools/router.ts";

const files = {
  "src/config.txt": "PORT = 8000\nPORT = 8000\n",
  "docs/spec.txt": "Section 1: stable line content\nSection 2: nothing here\n",
  "docs/notes.txt": "nothing here either\n",
} as const;

function backends(opts?: Parameters<typeof createFakeToolBackends>[0]) {
  return createFakeToolBackends({ ...opts, files: { ...files, ...(opts?.files ?? {}) } });
}

function ok(result: ToolResult): asserts result is ToolResult & { ok: true } {
  assert.equal(result.ok, true, result.error ?? "expected success");
  assert.equal(result.error_code, undefined);
}

test("router: filesystem.read returns bounded file content verbatim", async () => {
  const result = await runTool(backends(), "filesystem.read", { path: "docs/spec.txt" });
  ok(result);
  assert.equal(result.output, "Section 1: stable line content\nSection 2: nothing here\n");
});

test("router: filesystem.read reports missing files and path escapes machine-readably", async () => {
  const missing = await runTool(backends(), "filesystem.read", { path: "docs/nope.txt" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error_code, "not_found");
  assert.match(missing.error ?? "", /not found/);

  for (const path of ["../secret.txt", "/etc/passwd", "a/../../b", "../../etc/passwd"]) {
    const escaped = await runTool(backends(), "filesystem.read", { path });
    assert.equal(escaped.ok, false, `${path} must not escape`);
    assert.equal(escaped.error_code, "path_escape", path);
    assert.match(escaped.error ?? "", /path escapes workspace root/);
  }
});

test("router: filesystem.find matches full paths and basenames", async () => {
  const full = await runTool(backends(), "filesystem.find", { path: "docs", pattern: "*.txt" });
  ok(full);
  assert.equal(full.output, "docs/notes.txt\ndocs/spec.txt");

  const deep = await runTool(backends(), "filesystem.find", { path: ".", pattern: "**/*.txt" });
  ok(deep);
  assert.deepEqual((deep.output ?? "").split("\n"), ["docs/notes.txt", "docs/spec.txt", "src/config.txt"]);

  const none = await runTool(backends(), "filesystem.find", { path: "docs", pattern: "*.md" });
  ok(none);
  assert.equal(none.output, "(no matches)");

  const defaultPattern = await runTool(backends(), "filesystem.find", { path: "docs" });
  ok(defaultPattern);
  assert.deepEqual((defaultPattern.output ?? "").split("\n"), ["docs/notes.txt", "docs/spec.txt"]);
});

test("router: filesystem.search is case-insensitive, line numbered and bounded", async () => {
  const result = await runTool(backends(), "filesystem.search", { path: "docs", query: "SECTION 1" });
  ok(result);
  assert.equal(result.output, "docs/spec.txt:1:Section 1: stable line content");

  const empty = await runTool(backends(), "filesystem.search", { path: "docs", query: "gibberish" });
  ok(empty);
  assert.equal(empty.output, "(no matches)");

  const escaped = await runTool(backends(), "filesystem.search", { path: "../", query: "x" });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.error_code, "path_escape");
});

test("router: shell.exec returns exit code, stdout, stderr and error codes", async () => {
  const shell = new FakeShell([
    { command: "echo hi", stdout: "hi\n" },
    { command: "both", stdout: "out\n", stderr: "err\n" },
    { command: "boom", exit_code: 3, stderr: "boom stderr\n" },
  ]);
  const backendsWithShell = createFakeToolBackends({ files, shell });

  const success = await runTool(backendsWithShell, "shell.exec", { command: "echo hi" });
  ok(success);
  assert.equal(success.exit_code, 0);
  assert.equal(success.stdout, "hi\n");
  assert.equal(success.stderr, "");
  assert.equal(success.output, "hi");

  const merged = await runTool(backendsWithShell, "shell.exec", { command: "both" });
  ok(merged);
  assert.equal(merged.output, "out\nerr");
  assert.equal(merged.stdout, "out\n");
  assert.equal(merged.stderr, "err\n");

  const failed = await runTool(backendsWithShell, "shell.exec", { command: "boom" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error_code, "exec_failed");
  assert.equal(failed.exit_code, 3);
  assert.equal(failed.stderr, "boom stderr\n");
  assert.match(failed.error ?? "", /boom stderr/);

  const unknown = await runTool(backendsWithShell, "shell.exec", { command: "nope" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error_code, "exec_failed");
  assert.equal(unknown.exit_code, 127);

  const timedOut = await runTool(createFakeToolBackends({ files, shell: new FakeShell([{ command: "sleep", timed_out: true }]) }), "shell.exec", {
    command: "sleep",
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error_code, "timeout");
  assert.equal(timedOut.exit_code, undefined);
  assert.match(timedOut.error ?? "", /timed out/);
});

test("router: editor.apply_patch creates, patches, and rejects scope and patch errors", async () => {
  const withScope = backends({ writeScope: ["**", "!protected/**"] });

  const created = await runTool(withScope, "editor.apply_patch", { path: "answer.txt", add: true, new: "done" });
  ok(created);
  assert.equal(created.output, "created answer.txt");
  const readBack = await runTool(withScope, "filesystem.read", { path: "answer.txt" });
  ok(readBack);
  assert.equal(readBack.output, "done");

  const addExisting = await runTool(withScope, "editor.apply_patch", { path: "answer.txt", add: true, new: "x" });
  assert.equal(addExisting.ok, false);
  assert.equal(addExisting.error_code, "patch_failed");
  assert.match(addExisting.error ?? "", /already exists/);

  const missing = await runTool(withScope, "editor.apply_patch", { path: "nope.txt", old: "x", new: "y" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error_code, "patch_failed");
  assert.match(missing.error ?? "", /does not exist/);

  // Ambiguous old text (occurring twice) must fail rather than guess.
  const ambiguous = await runTool(withScope, "editor.apply_patch", {
    path: "src/config.txt",
    old: "PORT = 8000",
    new: "PORT = 9000",
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error_code, "patch_failed");
  assert.match(ambiguous.error ?? "", /more than once/);

  const patched = await runTool(withScope, "editor.apply_patch", {
    path: "docs/spec.txt",
    old: "Section 1: stable line content",
    new: "Section 1: stable",
  });
  ok(patched);
  assert.equal(patched.output, "patched docs/spec.txt");
  const readPatched = await runTool(withScope, "filesystem.read", { path: "docs/spec.txt" });
  ok(readPatched);
  assert.match(readPatched.output ?? "", /^Section 1: stable\n/);

  const scope = await runTool(withScope, "editor.apply_patch", {
    path: "protected/keep.txt",
    old: "a",
    new: "b",
  });
  assert.equal(scope.ok, false);
  assert.equal(scope.error_code, "write_scope");
  assert.match(scope.error ?? "", /write scope violation/);

  const insert = await runTool(withScope, "editor.apply_patch", { path: "src/config.txt", old: "", new: "# top\n" });
  ok(insert);
  const afterInsert = await runTool(withScope, "filesystem.read", { path: "src/config.txt" });
  ok(afterInsert);
  assert.ok((afterInsert.output ?? "").startsWith("# top\n"));
});

test("router: task.update_plan stores the plan and reports its size", async () => {
  const result = await runTool(backends(), "task.update_plan", { plan: ["read", "edit", "verify"] });
  ok(result);
  assert.equal(result.output, "plan updated (3 items)");

  const empty = await runTool(backends(), "task.update_plan", { plan: [] });
  ok(empty);
  assert.equal(empty.output, "plan updated (0 items)");

  const invalid = await runTool(backends(), "task.update_plan", { plan: ["ok", ""] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error_code, "invalid_args");
  assert.match(invalid.error ?? "", /invalid arguments/);
});

test("router: browser tools use deterministic fake backends with current-page state", async () => {
  const backendsWithBrowser = createFakeToolBackends({
    files,
    browserPages: {
      "https://docs.example.com/guide": {
        url: "https://docs.example.com/guide",
        title: "Harmony Guide",
        content: "Tools are called here.\nThe final answer follows.\n",
      },
    },
    browserSearch: [
      {
        query: "harmony",
        results: [{ title: "Harmony Guide", url: "https://docs.example.com/guide", snippet: "Tools are called here." }],
      },
    ],
    browserSearchFallback: [{ title: "Anything", url: "https://example.com/any", snippet: "fallback result." }],
  });

  const search = await runTool(backendsWithBrowser, "browser.search", { query: "HARMONY" });
  ok(search);
  assert.equal(search.output, "- Harmony Guide\n  https://docs.example.com/guide\n  Tools are called here.");

  const fallback = await runTool(backendsWithBrowser, "browser.search", { query: "unknown-query" });
  ok(fallback);
  assert.match(fallback.output ?? "", /fallback result/);

  const noResults = await runTool(createFakeToolBackends({ files, browserSearchFallback: [] }), "browser.search", { query: "something" });
  ok(noResults);
  assert.equal(noResults.output, "(no results)");

  // find before any open is a machine-readable invalid state.
  const findFirst = await runTool(backendsWithBrowser, "browser.find", { query: "tool" });
  assert.equal(findFirst.ok, false);
  assert.equal(findFirst.error_code, "invalid_args");

  const opened = await runTool(backendsWithBrowser, "browser.open", { url: "https://docs.example.com/guide" });
  ok(opened);
  assert.ok((opened.output ?? "").startsWith("Harmony Guide\nhttps://docs.example.com/guide\n\n"));

  const found = await runTool(backendsWithBrowser, "browser.find", { query: "FINAL" });
  ok(found);
  assert.equal(found.output, "2:The final answer follows.");

  const notFound = await runTool(backendsWithBrowser, "browser.open", { url: "https://example.com/missing" });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error_code, "not_found");
});

test("router: unavailable backends and invalid calls return bounded envelopes", async () => {
  const layered = backends();
  const withoutBrowser: ToolBackends = { workspace: layered.workspace, plan: layered.plan };
  for (const tool of ["browser.search", "browser.open", "browser.find"]) {
    const result = await runTool(withoutBrowser, tool, tool === "browser.open" ? { url: "x" } : { query: "x" });
    assert.equal(result.ok, false, tool);
    assert.equal(result.error_code, "unavailable", tool);
  }

  const invalid = await runTool(layered, "filesystem.read", { path: 42 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error_code, "invalid_args");

  const unknown = await runTool(layered, "does.not.exist", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error_code, "invalid_args");
});

test("router: fake workspace write scope is enforced at the backend boundary too", () => {
  const workspace = new FakeWorkspaceBackend({ files, writeScope: ["src/**"] });
  assert.equal(workspace.isAllowedWrite("src/config.txt"), true);
  assert.equal(workspace.isAllowedWrite("docs/spec.txt"), false);
  assert.equal(workspace.isAllowedWrite("../outside"), false);
  assert.throws(() => {
    workspace.write("docs/spec.txt", "x");
  }, /write scope violation/);
  assert.throws(() => workspace.read("nope.txt"), /not found/);
  assert.equal(workspace.listFiles("docs").length, 2);
});

test("router: tool outputs are clipped to the configured output limit", async () => {
  const long = "x".repeat(10_000);
  const result = await runTool(createFakeToolBackends({ files: { "big.txt": long } }), "filesystem.read", {
    path: "big.txt",
  });
  ok(result);
  assert.equal(result.output?.length, 8000 + "…[truncated]".length);
  assert.match(result.output ?? "", /\[truncated\]$/);
});

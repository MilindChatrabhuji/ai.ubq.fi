import { test } from "bun:test";
import assert from "node:assert/strict";
import { extractCodexModelsFromText, resolveCodexBinaryPath } from "../scripts/codex-models.ts";

test("resolveCodexBinaryPath uses vendor binary for wrapper script", async () => {
  const wrapper = `#!/usr/bin/env node
const vendorRoot = "vendor";
const targetTriple = "aarch64-apple-darwin";
const codexBinaryName = "codex";
`;
  const resolved = await resolveCodexBinaryPath("/opt/bin/codex", () => Promise.resolve(wrapper), "darwin", "aarch64");
  assert.equal(resolved, "/opt/vendor/aarch64-apple-darwin/codex/codex");
});

test("resolveCodexBinaryPath falls back for non-wrapper input", async () => {
  const resolved = await resolveCodexBinaryPath("/usr/local/bin/codex", () => Promise.resolve("binary"), "darwin", "aarch64");
  assert.equal(resolved, "/usr/local/bin/codex");
});

test("resolveCodexBinaryPath uses realPath for symlink wrappers", async () => {
  const wrapper = `#!/usr/bin/env node
const vendorRoot = "vendor";
const targetTriple = "aarch64-apple-darwin";
const codexBinaryName = "codex";
`;
  let readPath = "";
  const resolved = await resolveCodexBinaryPath(
    "/usr/local/bin/codex",
    (path) => {
      readPath = path;
      return Promise.resolve(wrapper);
    },
    "darwin",
    "aarch64",
    () => Promise.resolve("/opt/lib/node_modules/@openai/codex/bin/codex.js")
  );
  assert.equal(readPath, "/opt/lib/node_modules/@openai/codex/bin/codex.js");
  assert.equal(resolved, "/opt/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex");
});

test("resolveCodexBinaryPath uses platform package for current npm wrapper", async () => {
  const wrapper = `#!/usr/bin/env node
const PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
};
let targetTriple = "x86_64-unknown-linux-musl";
const codexBinaryName = "codex";
const localVendorRoot = "vendor";
let vendorRoot;
`;
  const resolved = await resolveCodexBinaryPath(
    "/usr/local/bin/codex",
    () => Promise.resolve(wrapper),
    "linux",
    "x86_64",
    () => Promise.resolve("/usr/local/lib/node_modules/@openai/codex/bin/codex.js")
  );
  assert.equal(resolved, "/usr/local/lib/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex");
});

test("resolveCodexBinaryPath uses nested platform package for global npm wrapper", async () => {
  const wrapper = `#!/usr/bin/env node
const PLATFORM_PACKAGE_BY_TARGET = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
};
let targetTriple = "x86_64-unknown-linux-musl";
const codexBinaryName = "codex";
const localVendorRoot = "vendor";
let vendorRoot;
`;
  const nested = "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex";
  const resolved = await resolveCodexBinaryPath(
    "/usr/local/bin/codex",
    () => Promise.resolve(wrapper),
    "linux",
    "x86_64",
    () => Promise.resolve("/usr/local/lib/node_modules/@openai/codex/bin/codex.js"),
    (path) => Promise.resolve(path === nested)
  );
  assert.equal(resolved, nested);
});

test("extractCodexModelsFromText parses slugs and reasoning levels", () => {
  const text =
    'codex_cli_rs/0.99.0 {"slug":"gpt-5.2-codex","context_window":272000,"max_context_window":1000000,"auto_compact_token_limit":null,"supported_reasoning_levels":[{"effort":null},{"effort":"low"},{"effort":"high"},{"effort":"ultra"}]}';
  const extracted = extractCodexModelsFromText(text);
  assert.ok(extracted);
  assert.equal(extracted.clientVersion, "0.99.0");
  assert.equal(extracted.models[0]?.slug, "gpt-5.2-codex");
  assert.equal(extracted.models[0]?.context_window, 272000);
  assert.equal(extracted.models[0]?.max_context_window, 1000000);
  assert.equal(extracted.models[0]?.auto_compact_token_limit, null);
  assert.deepEqual(extracted.models[0]?.supported_reasoning_levels, ["none", "low", "high", "ultra"]);
});

test("extractCodexModelsFromText trims large fields", () => {
  const text =
    'codex_cli_rs/0.99.0 {"slug":"gpt-5.2-codex","display_name":"Codex","description":"desc","base_instructions":"big","supported_reasoning_levels":["low"]}';
  const extracted = extractCodexModelsFromText(text);
  const model = extracted?.models[0];
  assert.ok(model);
  assert.equal(model.slug, "gpt-5.2-codex");
  assert.equal(model.display_name, "Codex");
  assert.equal(model.description, "desc");
  assert.equal("base_instructions" in model, false);
});

test("extractCodexModelsFromText preserves API-supported hidden review models", () => {
  const text = [
    'codex_cli_rs/0.99.0 {"slug":"codex-auto-review","display_name":"Codex Auto Review","visibility":"hide","supported_in_api":true}',
    '{"slug":"codex-internal-evals","visibility":"hide","supported_in_api":false}',
    '{"slug":"gpt-5.5","display_name":"GPT-5.5","supported_reasoning_levels":["low"]}',
  ].join("\n");
  const extracted = extractCodexModelsFromText(text);
  assert.ok(extracted);
  assert.deepEqual(
    extracted.models.map((model) => model.slug),
    ["codex-auto-review", "gpt-5.5"]
  );
});

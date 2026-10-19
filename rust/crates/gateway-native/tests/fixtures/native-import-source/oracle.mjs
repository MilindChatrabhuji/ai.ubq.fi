// Invokes immutable original Bun helpers; it does not implement import policy.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Socket } from "node:net";

const [repoArg, vectorArg, outputArg, forbiddenArg] = process.argv.slice(2);
const repo = resolve(repoArg);
assert.equal(Bun.version, "1.4.0");
const sensitiveNames = Object.keys(process.env).filter((name) => /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(name));
assert.deepEqual(sensitiveNames, []);
const networkError = await new Promise((done) => {
  const socket = new Socket();
  socket.once("error", (error) => done(error.code));
  socket.once("connect", () => {
    socket.destroy();
    done("CONNECTED");
  });
  socket.connect(1, "127.0.0.1");
});
assert.notEqual(networkError, "CONNECTED", "no socket may connect; raw OS denial is measured independently by the launcher");
let forbiddenRead = "read";
try {
  readFileSync(forbiddenArg);
} catch (error) {
  forbiddenRead = error.code;
}
assert.equal(forbiddenRead, "EPERM", "synthetic .env read must be denied by OS");
Date.now = () => 1767225600000;
let uuidCounter = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`;
const source = (path) => import(pathToFileURL(resolve(repo, path)).href);
const harness = await source("tests/helpers/admin-auth-harness.ts");
const { setKvForTest } = await source("src/kv.ts");
const { readJsonBodyWithLimit, MAX_ACCEPTED_JSON_BODY_BYTES } = await source("src/request.ts");
const { parseCodexAuthFromAuthJson } = await source("src/codex/auth.ts");
const vectors = JSON.parse(readFileSync(vectorArg, "utf8"));
const positiveFixture = { models: [{ slug: "gpt-5.3-codex-spark", display_name: "Spark" }] };
const fixtureMarker = 'JSON.stringify({ models: [{ slug: "gpt-5.3-codex-spark", display_name: "Spark" }] })';
assert.ok(readFileSync(resolve(repo, "tests/admin-codex-coverage.test.ts"), "utf8").includes(fixtureMarker));
const fetchCalls = [];
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? input.toString()));
  assert.equal(url.hostname, "chatgpt.com", "only existing controlled source model fixture is allowed");
  assert.equal(url.pathname, "/backend-api/codex/models");
  fetchCalls.push({ pathname: url.pathname, client_version: url.searchParams.get("client_version") });
  return new Response(JSON.stringify(positiveFixture), { status: 200, headers: { "Content-Type": "application/json", ETag: "etag-1" } });
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function bytesFor(spec) {
  if (spec.kind === "hex") return Uint8Array.from(Buffer.from(spec.hex, "hex"));
  if (spec.kind === "fixture-line") {
    return new TextEncoder().encode(harness.stringEntryLine(["default", "model"], "gpt-5.5") + (spec.suffix ?? ""));
  }
  if (spec.kind === "repeat-byte") return new Uint8Array(spec.length).fill(spec.byte);
  if (spec.kind === "padded") {
    const prefix = new TextEncoder().encode(spec.prefix);
    const bytes = new Uint8Array(spec.length).fill(32);
    bytes.set(prefix);
    return bytes;
  }
  assert.equal(spec.kind, "text");
  return new TextEncoder().encode(spec.text);
}
function requestFor(vector, bytes, telemetry) {
  const headers = new Headers(vector.headers ?? {});
  const request = new Request(`https://ai.ubq.fi${vector.surface === "auth" ? "/admin/codex/auth" : "/admin/kv-migration/import"}${vector.query ?? ""}`, {
    method: "POST",
    headers,
    body: bytes,
  });
  const text = request.text.bind(request);
  request.text = () => {
    telemetry.text_calls++;
    return text();
  };
  return request;
}
const outcomes = [];
for (const vector of vectors.cases) {
  harness.resetHarness();
  uuidCounter = 0;
  fetchCalls.length = 0;
  if (vector.kv === "unavailable") setKvForTest(null);
  const bytes = bytesFor(vector.body);
  const telemetry = { text_calls: 0 };
  const parsed = vector.surface === "auth" ? await readJsonBodyWithLimit(requestFor(vector, bytes, { text_calls: 0 }), MAX_ACCEPTED_JSON_BODY_BYTES) : null;
  const parserOutcome = parsed?.ok
    ? {
        ok: true,
        value: parsed.value,
        bare_token_data: parseCodexAuthFromAuthJson(parsed.value),
        wrapped_token_data: parseCodexAuthFromAuthJson(parsed.value?.auth),
      }
    : parsed;
  const request = requestFor(vector, bytes, telemetry);
  const response = await (vector.surface === "auth" ? harness.handleAdminCodexAuth(request) : harness.handleAdminKvMigrationImport(request));
  const body = await response.json();
  outcomes.push({
    id: vector.id,
    source_surface: vector.surface,
    raw_body_bytes: bytes.byteLength,
    raw_body_sha256: sha(bytes),
    request: { query: vector.query ?? "", headers: vector.headers ?? {}, kv: vector.kv ?? "synthetic-existing-harness" },
    parser: parserOutcome,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body,
    text_calls: telemetry.text_calls,
    controlled_fetch_calls: [...fetchCalls],
    stored_default_model: harness.kvStore.get(harness.keyToString(["default", "model"])) ?? null,
    stored_row_count: harness.kvStore.size,
  });
  bytes.fill(0);
  Bun.gc(true);
}
harness.cleanupHarness();
const result = {
  schema: "native-import-original-bun-oracle-v1",
  claim: "Observed original Bun source plus existing synthetic KV/model fixture; NOT Rust receiver/gateway acceptance",
  runtime: Bun.version,
  controls: {
    sensitive_environment_present: false,
    bun_network_error: networkError,
    synthetic_env_read_error: forbiddenRead,
    real_network_fetches: 0,
    controlled_fetch_fixture: "tests/admin-codex-coverage.test.ts: admin codex auth stores the upstream catalog and reports catalog seeding",
    clock_ms: Date.now(),
    uuid_source: "deterministic synthetic sequence",
  },
  outcomes,
};
writeFileSync(outputArg, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify({
    cases: outcomes.length,
    status_counts: Object.fromEntries(
      [...new Set(outcomes.map((entry) => entry.status))].map((status) => [status, outcomes.filter((entry) => entry.status === status).length])
    ),
    output_sha256: sha(readFileSync(outputArg)),
    controls: result.controls,
  })
);

// Focused existing Worker/DO shipping dispatch proof; no provider/native process is used.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const [sha, build, binary, schema, parent] = process.argv.slice(2);
assert.match(sha ?? "", /^[a-f0-9]{40}$/);
assert.equal(Bun.version, "1.4.0");
const workspace = await mkdtemp(join(resolve(parent), "run-"));
await mkdir(join(workspace, "state"));
const q = JSON.stringify;
const config = `using Workerd = import ${q(resolve(schema))};
const config :Workerd.Config = (
 services = [(name="internet",network=(allow=[])),(name="state",disk=(path=${q(join(workspace, "state"))},writable=true)),(name="assets",disk=(path=${q(resolve("static"))})),
 (name="gateway",worker=(modules=[(name="index.js",esModule=embed ${q(join(resolve(build), "index.js"))}),(name="index_bg.wasm",wasm=embed ${q(join(resolve(build), "index_bg.wasm"))})],compatibilityDate="2026-10-18",compatibilityFlags=["enable_request_signal","request_signal_passthrough"],globalOutbound="internet",bindings=[(name="AUTHORITY",durableObjectNamespace=(className="GatewayAuthority")),(name="ASSETS",service="assets"),(name="UOS_MATRIX_SCENARIO",text="native-import"),(name="UOS_AI_TOKEN",text="fixture-access"),(name="DENO_DEPLOY_TOKEN",text="fixture-admin"),(name="DENO_TIMELINE",text="production"),(name="DENO_DEPLOY",text="fixture-workerd")],durableObjectNamespaces=[(className="GatewayAuthority",uniqueKey="uos-native-import-dispatch-v1",enableSql=true)],durableObjectStorage=(localDisk="state")))],
 sockets=[(name="main",http=(),service="gateway")]);`;
const configPath = join(workspace, "runtime.capnp");
await writeFile(configPath, config);
const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
const port = reserved.port;
reserved.stop(true);
const processHandle = Bun.spawn([resolve(binary), "serve", configPath, "--experimental", "--import-path", "/", `--socket-addr=main=127.0.0.1:${port}`], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  env: { PATH: "/usr/bin:/bin", TMPDIR: workspace },
});
const out = new Response(processHandle.stdout).text();
const err = new Response(processHandle.stderr).text();
const origin = `http://127.0.0.1:${port}`;
const cases = [];
const key = Buffer.alloc(32, 31);
const keyId = "fixture-matrix-key";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mac = (value) => createHmac("sha256", key).update(value).digest("base64url");
// The actual fixed path is read from the committed Rust protocol, not a new endpoint.
const nativeSource = await readFile("rust/crates/gateway-auth/src/native.rs", "utf8");
const pathMatch = nativeSource.match(/NATIVE_RENEWAL_AUTHORITY_PATH:\s*&str\s*=\s*"([^"]+)"/);
assert(pathMatch);
const authority = pathMatch[1];
const pubMatch = nativeSource.match(/NATIVE_PUBLICATION_PATH:\s*&str\s*=\s*"([^"]+)"/);
assert(pubMatch);
const publication = pubMatch[1];
async function send(path, data, options = {}) {
  const body = JSON.stringify(data);
  const nonce = options.nonce ?? randomBytes(32).toString("base64url");
  const time = Date.now();
  const signature = mac(`uos-native-http-v1\0POST\0${path}\0${keyId}\0${time}\0${nonce}\0${hash(body)}`);
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-uos-native-version": "1",
      "x-uos-native-key-id": keyId,
      "x-uos-native-time-ms": String(time),
      "x-uos-native-nonce": nonce,
      "x-uos-native-mac": options.badMac ? "A".repeat(43) : signature,
    },
    body,
  });
  const text = await response.text();
  if (options.refuse) {
    assert.notEqual(response.status, 200, `${options.refuse}: ${text}`);
    cases.push(options.refuse);
    return { response, text };
  }
  assert.equal(response.status, 200, text);
  const domain = path === publication ? "uos-native-publication-response-v1" : "uos-native-renewal-authority-response-v1";
  assert.equal(
    response.headers.get("x-uos-native-response-mac"),
    mac(`${domain}\0POST\0${path}\0${keyId}\0${nonce}\0${hash(body)}\0${response.status}\0${hash(text)}`)
  );
  return { response, text, value: JSON.parse(text) };
}
const req = (command) => ({ operation: "codex_auth_import_authority", v: 1, command });
try {
  let health;
  for (let i = 0; i < 100; i++) {
    if (processHandle.exitCode !== null) throw new Error("workerd exited before health");
    try {
      health = await fetch(origin + "/health");
      break;
    } catch {
      await Bun.sleep(25);
    }
  }
  assert(health);
  const healthBody = await health.text();
  assert.equal(health.status, 200, healthBody);
  assert(healthBody.includes(sha));
  const meta = JSON.parse(Buffer.from(health.headers.get("x-uos-fixture-import-metadata") ?? "", "base64url").toString());
  assert.deepEqual(meta.path_controls, { absolute: true, parent_refused: true, relative_refused: true });
  cases.push("wasm-posix-metadata-absolute-and-relative-controls-not-custody");
  cases.push("shipping-entrypoint-actual-public-normal-preparation");
  const admit = (
    await send(
      authority,
      req({ phase: "admit", metadata: { v: meta.metadata.v, operation_id: meta.metadata.operation_id, action_ref: meta.metadata.action_ref } })
    )
  ).value.result;
  const state = admit.state;
  assert.equal(state.action_version, 3);
  cases.push("closed-import-admit-through-worker-do");
  await send(authority, req({ phase: "finish_current", state }));
  const claim = (await send(authority, req({ phase: "claim", state }))).value.result;
  assert.equal(claim.mode, "import_once");
  assert(claim.start_permit);
  const start = (await send(authority, req({ phase: "start", state, claim_ref: claim.claim_ref, start_permit: claim.start_permit }))).value.result;
  assert(start.started_revision);
  cases.push("original-import-claim-single-start-through-shipping-dispatch");
  const started = {
    v: 1,
    operation_id: state.metadata.operation_id,
    action_ref: state.metadata.action_ref,
    claim_ref: claim.claim_ref,
    native_owner_id: state.native_owner_id,
    account_id_hash: state.account_id_hash,
    source_native_generation: state.source_native_generation,
    owner_revision: state.owner_revision,
    source_revision: state.source_revision,
    normalized_revision: state.normalized_revision,
    started_revision: start.started_revision,
    deadline_ms: state.deadline_ms,
  };
  const b1 = (await send(authority, started)).value;
  assert.deepEqual(b1.request, started);
  cases.push("bare-b1-real-current-started-not-stop-permission");
  const models = { models: [{ slug: "model-a", context_window: 1024, supported_reasoning_levels: [{ effort: "none", description: "none" }] }] };
  const publish = {
    operation: "codex_auth_import_publish",
    v: 1,
    action_ref: state.metadata.action_ref,
    operation_id: state.metadata.operation_id,
    claim_ref: claim.claim_ref,
    native_owner_id: state.native_owner_id,
    owner_revision: state.owner_revision,
    source_revision: state.source_revision,
    normalized_revision: state.normalized_revision,
    publication_revision: "fixture-import-publication-v1",
    account_id_hash: state.account_id_hash,
    previous_native_source_generation: state.source_native_generation,
    native_source_generation: meta.native_source_generation,
    access_generation: meta.access_generation,
    native_receipt_ref: "fixture-import-durable-receipt",
    document: { account_id: meta.account_id, access_token: meta.access_token, updated_at_ms: meta.updated_at_ms, native_refreshed_at: null },
    catalog: { kind: "normalized", snapshot: models, client_version: "1.1.0", upstream_status: 200 },
  };
  const published = (await send(publication, publish)).value;
  assert.equal(published.disposition, "applied");
  cases.push("real-trusted-input-import-publication-cas-through-worker");
  const terminalCommand = {
    phase: "terminal",
    state,
    claim_ref: claim.claim_ref,
    publication_revision: publish.publication_revision,
    native_receipt_ref: publish.native_receipt_ref,
    publication_request_digest: hash(JSON.stringify(publish)),
  };
  const terminal = (await send(authority, req(terminalCommand))).value.result;
  assert.equal(terminal.completion.updated_at_ms, meta.updated_at_ms);
  assert.deepEqual(terminal.completion.account_ids, [meta.account_id]);
  cases.push("actor-terminal-required-real-completion-and-selected-time");
  const custody = (await send(authority, req({ phase: "custody_terminal", started, publication_revision: publish.publication_revision }))).value.result;
  assert(!Object.hasOwn(custody, "completion"));
  cases.push("custody-terminal-unchanged-closed-payload");
  const seed = {
    operation: "codex_auth_import_catalog_seed",
    v: 1,
    state,
    claim_ref: claim.claim_ref,
    publication_revision: publish.publication_revision,
    native_receipt_ref: publish.native_receipt_ref,
    publication_request_digest: terminalCommand.publication_request_digest,
    client_version: "1.1.0",
    source_body: JSON.stringify({ ...models, original_extension: "x".repeat(100_000) }),
    etag: "fixture-original-etag",
    content_type: "application/json",
  };
  assert(Buffer.byteLength(JSON.stringify(seed)) > 98_304);
  assert.equal((await send(authority, seed)).value.seeded, true);
  cases.push("optional-original-catalog-seed-larger-than-old-renewal-bound");
  await send(authority, req(terminalCommand), { badMac: true, refuse: "wrong-mac-refuses-before-native-import-authority" });
  await send(authority, { operation: "unknown_native_operation", v: 1 }, { refuse: "unknown-operation-fails-closed" });
  await send(
    authority,
    { phase: "unknown", v: 1, operation_id: state.metadata.operation_id, claim_ref: claim.claim_ref },
    { refuse: "import-role-cannot-acquire-owner-renewal-permission" }
  );
  await send(authority, req({ phase: "unknown", state, claim_ref: claim.claim_ref, extra: true }), { refuse: "malformed-closed-operation-fails-closed" });
  await send(
    publication,
    { ...publish, document: { ...publish.document, refresh_token: "FORBIDDEN_RAW_NATIVE_REFRESH" } },
    { refuse: "raw-refresh-field-not-an-import-publication-document" }
  );
  await send(authority, { ...seed, publication_revision: "foreign" }, { refuse: "foreign-publication-cannot-seed" });
  await send(authority, { operation: "old_native_import_reset", padding: "x".repeat(100_000) }, { refuse: "unknown-operation-cannot-expand-old-body-limit" });
  await send(authority, { ...seed, source_body: "x".repeat(1_048_576) }, { refuse: "optional-seed-hard-frame-overflow-refuses" });
  const after = (await send(authority, req(terminalCommand))).value.result;
  assert.deepEqual(after, terminal);
  cases.push("refusals-preserve-original-current-publication");
  await writeFile(
    join(workspace, "receipt.json"),
    JSON.stringify(
      {
        source_sha: sha,
        status: "passed",
        cases,
        route:
          "gateway-worker-fixture constructors -> gateway_worker::fetch_with_bindings -> native_authority/publication shipping dispatch -> RemoteAuthorityStore -> GatewayAuthority SQLite DO -> existing M22 handlers",
        native_physical_acceptance: false,
      },
      null,
      2
    ) + "\n"
  );
  console.log(JSON.stringify({ source_sha: sha, status: "passed", cases, evidence: workspace }));
} finally {
  processHandle.kill("SIGTERM");
  await processHandle.exited;
  await writeFile(join(workspace, "workerd.stdout.log"), await out);
  await writeFile(join(workspace, "workerd.stderr.log"), await err);
}

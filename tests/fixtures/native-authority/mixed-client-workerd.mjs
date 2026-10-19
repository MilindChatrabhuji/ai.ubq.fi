import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import { runPrincipalControlCases } from "./principal-control-cases.mjs";
const sourceDirectory = dirname(fileURLToPath(import.meta.url)),
  root = resolve(sourceDirectory, "../../..");
assert.equal(process.cwd(), root, "fixture must execute from its own repository root");
const toolingRoot = resolve(process.argv[2] ?? root),
  bun = process.argv[3],
  mode = process.argv[4] ?? "portless";
assert.equal(toolingRoot, root, "fixture dependencies must use its verified repository root");
assert.equal(process.version, "v24.21.0");
assert.equal(mode, "mixed", "committed acceptance requires actual mixed Linux clients");
if (mode === "mixed") {
  assert.equal(process.platform, "linux", "actual mixed Bun HTTP acceptance is held for Linux");
  assert.equal(process.env.TEST_SCOPE_ACTIVE, "1", "mixed harness must inherit approved test-runner namespace");
  assert(bun, "pinned Bun executable required");
}
const require = createRequire(join(toolingRoot, "package.json"));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const versions = {
  node: process.version,
  miniflare: require("miniflare/package.json").version,
  workerd: require("miniflare/package.json").dependencies.workerd,
  esbuild: require("esbuild/package.json").version,
};
assert.deepEqual(versions, { node: "v24.21.0", miniflare: "5.20261012.1-beta", workerd: "1.20261012.1", esbuild: "0.28.2" });
const scratch = join(root, ".tmp", "native-authority-" + randomUUID(), "fixtures"),
  directory = dirname(scratch);
await mkdir(scratch, { recursive: true, mode: 0o700 });
for (const file of ["fixture-worker.mjs", "bun-client.ts", "principal-control-sources.mjs"])
  await writeFile(join(scratch, file), await readFile(join(sourceDirectory, file)));
const fixtureHashes = {};
for (const file of ["fixture-worker.mjs", "bun-client.ts", "mixed-client-workerd.mjs", "principal-control-cases.mjs", "principal-control-sources.mjs"])
  fixtureHashes[file] = createHash("sha256")
    .update(await readFile(join(sourceDirectory, file)))
    .digest("hex");
// Knip6.35.1 reports cloudflare:workers as an unlisted npm cloudflare dependency.
// Its one-file exception is valid only while these real runtime/product imports stay exact.
function assertFixtureImports(source) {
  const ts = require("typescript");
  const file = ts.createSourceFile("fixture-worker.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(file.parseDiagnostics.length, 0, "Worker fixture must parse before its import policy is checked");
  const imports = [];
  const inspect = (node) => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      assert(ts.isStringLiteral(node.moduleSpecifier), "Worker fixture requires literal module specifiers");
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node)) assert.fail("Worker fixture cannot use CommonJS import aliases");
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      assert.fail("Worker fixture cannot introduce dynamic or CommonJS imports");
    ts.forEachChild(node, inspect);
  };
  inspect(file);
  assert.deepEqual(imports.sort(), [
    "../../../src/authority/native-authority-contracts.ts",
    "../../../src/authority/native-authority-rpc.ts",
    "../../../src/authority/native-authority-sql.ts",
    "../../../src/authority/native-authority.ts",
    "../../../src/authority/native-codex-contracts.ts",
    "../../../src/authority/native-paid.ts",
    "./principal-control-sources.mjs",
    "cloudflare:workers",
  ]);
  return imports;
}
const fixtureImports = assertFixtureImports(await readFile(join(sourceDirectory, "fixture-worker.mjs"), "utf8"));
const graph = await build({
  entryPoints: [join(scratch, "fixture-worker.mjs")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "esnext",
  external: ["cloudflare:workers"],
  write: false,
  metafile: true,
});
const imports = Object.values(graph.metafile.outputs).flatMap((item) => item.imports);
assert(imports.every((item) => item.path === "cloudflare:workers"));
assert(!Object.keys(graph.metafile.inputs).some((path) => /src\/(?:storage|runtime|codex)\//.test(path)));
const hashes = {};
for (const path of Object.keys(graph.metafile.inputs))
  hashes[path] = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
await writeFile(join(directory, "workerd-metafile.json"), JSON.stringify(graph.metafile, null, 2) + "\n");
await writeFile(join(directory, "workerd-bundle.mjs"), graph.outputFiles[0].text);
const persistence = join(directory, "runtime-persistence-" + randomUUID());
let providerCalls = 0,
  server,
  upstreamOrigin = null;
if (mode === "mixed") {
  server = createServer(async (req, res) => {
    providerCalls++;
    for await (const chunk of req) assert(chunk.length < 65536);
    res.setHeader("x-request-id", "synthetic-" + providerCalls);
    if (req.url === "/sse") {
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"type":"response.output_text.delta","delta":"synthetic"}\n\n');
      setTimeout(() => res.end('data: {"type":"response.completed"}\n\n'), 100);
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "synthetic-" + providerCalls, status: "completed", output: [] }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  upstreamOrigin = "http://127.0.0.1:" + server.address().port;
}
const fixtureOwner = "synthetic-owner-" + randomUUID();
const options = () =>
  convertV4MiniflareOptions({
    name: "native-authority-fixture",
    modules: true,
    script: graph.outputFiles[0].text,
    compatibilityDate: "2026-10-18",
    compatibilityFlags: [],
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    resourcePersistencePath: persistence,
    durableObjects: {
      AUTHORITY: { className: "SharedNativeAuthority", useSQLite: true },
      PRINCIPAL: { className: "PrincipalNativeAuthority", useSQLite: true },
    },
    bindings: { FIXTURE_OWNER: fixtureOwner, ...(upstreamOrigin ? { SYNTHETIC_UPSTREAM: upstreamOrigin } : {}) },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (mode !== "mixed" || url.origin !== upstreamOrigin) throw new Error("deny-before-I/O fixture outbound " + url.origin);
      return await fetch(url, {
        method: request.method,
        headers: [...request.headers],
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        signal: request.signal,
      });
    },
  });
let runtime = new Miniflare(options()),
  children = 0;
const activeChildren = new Set();
const report = {
  protocol: "native-gateway-runtime-v3",
  privateRuntimeRevision: null,
  storageSchemaVersion: null,
  v3Assertions: [],
  versions,
  mode,
  fixtureHashes,
  fixtureImports,
  compatibilityDate: "2026-10-18",
  compatibilityFlags: [],
  sourceHashes: hashes,
  bundleSha256: createHash("sha256").update(graph.outputFiles[0].text).digest("hex"),
  imports,
  persistence,
  actualSQLiteDurableObject: true,
  actualBunHttpClients: 0,
  actualWorkerClients: true,
  mixedAcceptance: mode === "mixed" ? "executing" : "HELD_FOR_LINUX",
  providerCalls: 0,
  phases: [],
  assertions: [],
};
const epoch = "synthetic-native-do-epoch",
  fixedNow = 1_800_000_000_000;
const dispatch = (path, body, owner = false) =>
  runtime.dispatchFetch("http://native-authority-fixture.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(owner ? { "x-fixture-owner": fixtureOwner } : {}) },
    body: JSON.stringify(body),
  });
const raw = async (principal, command) => {
  const response = await dispatch("/rpc/" + principal, command);
  assert.equal(response.status, 200);
  return await response.json();
};
const rpc = async (principal, method, args, operationId = randomUUID()) => {
  const reply = await raw(principal, { epoch, operationId, method, args });
  if (reply.error) throw new Error(reply.error.code);
  return reply.result;
};
const sourcePhase = async (principal, operation) => {
  const response = await dispatch("/source-phase/" + principal, operation);
  assert.equal(response.status, 200);
  const reply = await response.json();
  if (reply.error) throw new Error(reply.error.code);
  return reply.result;
};
const requestPhase = (args, operationId = randomUUID(), phase = "admit-api") => ({
  fixturePhase: phase,
  request: { requestId: args.requestId, route: args.route, path: args.path ?? args.route },
  metadata: { model: args.model, stream: args.stream, reasoning: args.reasoning ?? null },
  operationId,
});
const reserve = async (principal, id) => {
  const reply = await sourcePhase(
    principal,
    requestPhase(
      { requestId: id, route: "/v1/responses", model: "fixture", stream: false },
      randomUUID(),
      ["a", "b"].includes(principal) ? "admit-api" : "open-api"
    )
  );
  assert(reply.handle, JSON.stringify(reply));
  return reply.handle;
};
const metadata = (principal, handle, model = "fixture") =>
  sourcePhase(principal, { fixturePhase: "metadata", handle, metadata: { model, stream: false, reasoning: null } });
const inspect = async () => {
  const response = await dispatch("/__fixture/inspect", {}, true);
  assert.equal(response.status, 200);
  return await response.json();
};
const crash = async (name) => {
  const before = await inspect();
  try {
    await dispatch("/__fixture/crash", {}, true);
  } catch {}
  const after = await inspect();
  assert.notEqual(before.incarnation, after.incarnation);
  const clean = (x) => ({ ...x, incarnation: null });
  assert.deepEqual(clean(after), clean(before));
  console.log(JSON.stringify({ phase: name, durableRows: after.rows }));
  report.phases.push({ name, incarnationBefore: before.incarnation, incarnationAfter: after.incarnation, projection: after });
};
const bunCall = async (principal, operations, scenario = null, extra = {}) => {
  const url = String(await runtime.ready).replace(/\/$/, "") + (extra.controlCase ? "/control/" + extra.controlCase : scenario ? "/review/" + scenario : "");
  const child = spawn(bun, ["--no-env-file", "--no-install", join(scratch, "bun-client.ts")], {
    cwd: root,
    env: { PATH: dirname(bun) + ":/usr/bin:/bin", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeChildren.add(child);
  children = activeChildren.size;
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  try {
    child.stdin.end(JSON.stringify({ url, principal, epoch, operations, ...extra }));
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.runtime, "1.4.0");
    if (extra.surface !== "native-bindings") report.actualBunHttpClients++;
    const failure = result.results.find((item) => item?.fixtureError);
    if (failure)
      throw Object.assign(new Error(failure.fixtureError.code), { fixtureRefusal: true, code: failure.fixtureError.code, status: failure.fixtureError.status });
    const fault = result.results.find((item) => item?.fixtureFault);
    if (fault) throw Object.assign(new Error(fault.fixtureFault.message), { fixtureFault: true });
    return result.results;
  } finally {
    activeChildren.delete(child);
    children = activeChildren.size;
  }
};
async function runReviewCases({ setup, control, evidence, callFor, restart, denied, providerSuccess }) {
  const results = [];
  let firstNamespaceHandle;
  const refused = async (promise) => {
    try {
      await promise;
    } catch (error) {
      assert.equal(error.fixtureRefusal, true, "transport/process errors must not count as native semantic refusals");
      assert.equal(typeof error.code, "string");
      assert.notEqual(error.code, "authority_operation_failed");
      return error.code;
    }
    assert.fail("expected an actual closed native refusal");
  };
  const finish = async (id, call, before = null, extra = {}) => {
    const after = await evidence(id);
    assert(call.clients.bun > 0 && call.clients.worker > 0, id + " must use both actual transports");
    results.push({ id, clients: call.clients, before, after, ...extra });
  };
  const fresh = async (id) => {
    await setup(id);
    return callFor(id);
  };
  const reserveReview = async (call, id, model = "fixture") => {
    const reply = await call.sourcePhase(
      requestPhase({ requestId: id, route: "/v1/responses", model, stream: false }, randomUUID(), call.kernel ? "open-api" : "admit-api")
    );
    assert.equal(reply.kind, "reserved");
    assert(reply.handle);
    return reply.handle;
  };
  const paidReview = async (call, id) => {
    const handle = await reserveReview(call, id);
    const paid = await call("reservePaidAttempt", { handle, hopId: "openlux-hop" });
    assert.equal(paid.kind, "reserved");
    assert(paid.attemptHandle);
    return { handle, attemptHandle: paid.attemptHandle };
  };
  const billing = (request_id, quota) => ({ request_id, quota, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: fixedNow / 1000 });
  {
    const id = "F01",
      call = await fresh(id),
      paid = await paidReview(call, "terminal-release");
    assert.equal((await call("recordPaidAttemptLifecycle", { attemptHandle: paid.attemptHandle, patch: { terminal_state: "completed" } })).kind, "updated");
    firstNamespaceHandle = paid.handle;
    await refused(call("releasePaidBeforeFetch", { attemptHandle: paid.attemptHandle }));
    const before = await evidence(id);
    assert.deepEqual(before.paidStates, [{ terminal: "completed", billing: "pending" }]);
    assert.equal(before.paidReserved, 40);
    await call("recordPaidAttemptLifecycle", { attemptHandle: paid.attemptHandle, patch: { provider_request_id: "late-after-terminal" } });
    assert.equal((await call("recordVerifiedPaidBilling", { attemptHandle: paid.attemptHandle, log: billing("late-after-terminal", 9) })).kind, "settled");
    const after = await evidence(id);
    assert.equal(after.paidReserved, 0);
    assert.equal(after.paidSettled, 9);
    await finish(id, call, before);
  }
  for (const mode of ["terminal", "delivery", "start", "provider"]) {
    const id = "F02-" + mode,
      call = await fresh(id),
      handle = await reserveReview(call, "nonpaid");
    const provider = mode === "provider" ? "chatgpt_codex" : "lithos";
    if (mode === "provider") {
      assert.equal((await call("selectCodexAccount", { handle })).kind, "eligible");
      assert.equal((await call("refreshCodexAdmission", { handle })).kind, "current");
    }
    assert.equal((await call("markApiDispatch", { handle, provider })).kind, "dispatched");
    if (mode === "terminal") await call("recordSemanticTerminal", { handle, outcome: "completed" });
    if (mode === "delivery") await call("recordDeliveryObservation", { handle, observation: "delivered" });
    if (mode === "start") assert.equal((await call("recordTransportStarted", { handle, provider })).kind, "started");
    if (mode === "provider") {
      await providerSuccess();
      await call("recordCodexAttemptSignal", { handle, signal: "success" });
    }
    await refused(call("recordApiDispatchCancellation", { handle }));
    const state = await evidence(id);
    assert.equal(state.apiCommitted, 1);
    if (mode === "provider") {
      assert.equal(state.transport, null);
      assert.equal(state.providerObserved, true);
    }
    await finish(id, call, null, { independentEvidence: mode, intentionallyOmittedStart: mode === "provider" });
  }
  {
    const id = "F03",
      call = await fresh(id),
      handle = await reserveReview(call, "no-codex-admission");
    await refused(call("markApiDispatch", { handle, provider: "chatgpt_codex" }));
    const state = await evidence(id);
    assert.equal(state.apiCommitted, 0);
    assert.equal(state.apiReserved, 1);
    await denied(id, handle);
    const crossNamespaceRefusal = await refused(call("readRequestStatus", { handle: firstNamespaceHandle, limit: 1 }));
    assert.equal((await evidence(id)).apiReserved, 1);
    await finish(id, call, null, { crossNamespaceRefusal });
  }
  {
    const id = "F04",
      call = await fresh(id),
      handle = await reserveReview(call, "compensated");
    assert.equal((await call("markApiDispatch", { handle, provider: "lithos" }, "dispatch-receipt")).kind, "dispatched");
    assert.equal((await call("recordApiDispatchCancellation", { handle })).kind, "released");
    await refused(call("markApiDispatch", { handle, provider: "lithos" }, "dispatch-receipt"));
    const state = await evidence(id);
    assert.equal(state.apiCommitted, 0);
    assert.deepEqual(state.apiStates, ["released"]);
    await finish(id, call);
  }
  {
    const id = "F05",
      call = await fresh(id),
      handle = await reserveReview(call, "own-refresh-receipt");
    assert.equal((await call("selectCodexAccount", { handle })).kind, "eligible");
    assert.equal((await call("refreshCodexAdmission", { handle }, "refresh-C1")).kind, "current");
    const before = await evidence(id);
    await control(id, "rotate");
    assert.equal((await call("refreshCodexAdmission", { handle }, "refresh-C2")).kind, "current");
    await refused(call("refreshCodexAdmission", { handle }, "refresh-C1"));
    const after = await evidence(id);
    assert.equal(after.credentialVersion, "e".repeat(64));
    assert.notEqual(after.routingRevision, before.routingRevision);
    assert.notEqual(after.routingValueSha256, before.routingValueSha256);
    await finish(id, call, before);
  }
  {
    const id = "F06",
      call = await fresh(id),
      handle = await reserveReview(call, "current-invalid");
    assert.equal((await call("selectCodexAccount", { handle })).kind, "eligible");
    await call("refreshCodexAdmission", { handle }, "invalid-refresh");
    const before = await evidence(id);
    assert.equal((await call("recordCodexAttemptSignal", { handle, signal: "credential_invalid" })).kind, "recorded");
    await refused(call("markApiDispatch", { handle, provider: "chatgpt_codex" }));
    await refused(call("refreshCodexAdmission", { handle }, "invalid-refresh"));
    const after = await evidence(id);
    assert.equal(after.slotGeneration, before.slotGeneration);
    assert.equal(after.apiCommitted, 0);
    await finish(id, call, before);
  }
  {
    const id = "F07",
      call = await fresh(id),
      paid = await paidReview(call, "claimable"),
      before = await evidence(id);
    await restart();
    const after = await evidence(id);
    assert.notEqual(after.incarnation, before.incarnation);
    assert.equal(after.paidCount, 1);
    const claim = await call("claimPaidReconciliation", { limit: 10 });
    assert.equal(claim.kind, "claimed");
    assert.equal(claim.detail.length, 1);
    const item = claim.detail[0];
    assert.equal(item.attemptHandle, paid.attemptHandle);
    assert.equal(item.requestHandle, paid.handle);
    await refused(call("deferPaidReconciliation", { attemptHandle: item.attemptHandle }, undefined, "growth"));
    assert.equal((await call("deferPaidReconciliation", { attemptHandle: item.attemptHandle })).kind, "write");
    assert.equal((await call("finishPaidReconciliation", { lease: claim.lease })).kind, "finished");
    assert((await evidence(id)).pendingDue[0] > fixedNow);
    await finish(id, call, before, { restartedClaim: item });
  }
  {
    const id = "F08",
      call = await fresh(id),
      blocked = await reserveReview(call, "probe-block");
    assert.equal((await call("selectCodexAccount", { handle: blocked })).kind, "eligible");
    await call("recordCodexAttemptSignal", {
      handle: blocked,
      signal: "quota",
      response: { status: 429, headers: [], body: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: (fixedNow + 1000) / 1000 } }) },
    });
    await control(id, "advance");
    const handle = await reserveReview(call, "owned-probe");
    assert.equal((await call("selectCodexAccount", { handle })).kind, "eligible");
    const before = await evidence(id);
    assert.equal(typeof before.probeToken, "string");
    await control(id, "rotate");
    assert.equal((await call("refreshCodexAdmission", { handle })).kind, "current");
    const after = await evidence(id);
    assert.equal(after.probeToken, before.probeToken);
    assert.equal(after.probeGeneration, after.routingGeneration);
    assert.equal((await call("markApiDispatch", { handle, provider: "chatgpt_codex" })).kind, "dispatched");
    assert.equal((await call("releaseCodexProbe", { handle })).kind, "released");
    await finish(id, call, before);
  }
  {
    const id = "F09",
      call = await fresh(id),
      response = { status: 429, headers: [], body: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: (fixedNow + 3600000) / 1000 } }) };
    for (const requestId of ["proof-a", "proof-b"]) {
      const handle = await reserveReview(call, requestId);
      assert.equal((await call("selectCodexAccount", { handle })).kind, "eligible");
      await call("recordCodexAttemptSignal", { handle, signal: "quota", response });
    }
    const blocked = await reserveReview(call, "proof-blocked");
    assert.equal((await call("selectCodexAccount", { handle: blocked })).kind, "quota_blocked");
    await control(id, "install-reset");
    const cross = await reserveReview(call, "reserve-model", "gpt-reserve"),
      before = await evidence(id);
    assert.equal((await call("electCodexResetProbe", { handle: cross, proofId: "review-proof" })).kind, "refused");
    const refused = await evidence(id);
    assert.equal(refused.proofVerified, true);
    assert.equal(refused.routingRevision, before.routingRevision);
    const alias = await reserveReview(call, "standard-alias", "another-standard");
    assert.equal((await call("electCodexResetProbe", { handle: alias, proofId: "review-proof" })).kind, "probe_elected");
    await finish(id, call, before);
  }
  {
    const id = "F10",
      call = await fresh(id),
      handle = await reserveReview(call, "responding-paid");
    await call("selectCodexAccount", { handle });
    await call("refreshCodexAdmission", { handle });
    assert.equal((await call("markApiDispatch", { handle, provider: "chatgpt_codex" })).kind, "dispatched");
    const paid = await call("reservePaidAttempt", { handle, hopId: "openlux-hop" });
    assert.equal(paid.kind, "reserved");
    assert.equal((await call("markApiDispatch", { handle, provider: "metered" })).kind, "already_dispatched");
    await call("recordPaidAttemptLifecycle", {
      attemptHandle: paid.attemptHandle,
      patch: { provider_request_id: "paid-response", terminal_state: "completed" },
    });
    await call("recordSemanticTerminal", {
      handle,
      attemptHandle: paid.attemptHandle,
      outcome: "completed",
      usage: { input_tokens: 3, cached_input_tokens: null, output_tokens: 2 },
    });
    assert.equal((await call("recordVerifiedPaidBilling", { attemptHandle: paid.attemptHandle, log: billing("paid-response", 7) })).kind, "settled");
    const state = await evidence(id);
    assert.equal(state.rollups.length, 1);
    assert.deepEqual(state.rollups[0], { provider: "metered", request_count: 1, input_tokens: 3, output_tokens: 2, spend_microcredits: 7 });
    await finish(id, call);
  }
  {
    const id = "F11",
      call = await fresh(id),
      paid = await paidReview(call, "terminal-expedite");
    assert.equal((await call("deferPaidReconciliation", { attemptHandle: paid.attemptHandle })).kind, "write");
    const before = await evidence(id);
    assert(before.pendingDue[0] > fixedNow);
    await control(id, "advance");
    await call("recordPaidAttemptLifecycle", { attemptHandle: paid.attemptHandle, patch: { terminal_state: "completed" } });
    const after = await evidence(id);
    assert.equal(after.pendingDue[0], fixedNow + 1);
    assert.notEqual(after.gateRevision, before.gateRevision);
    const claim = await call("claimPaidReconciliation", { limit: 10 });
    assert.equal(claim.kind, "claimed");
    assert.equal(claim.detail[0].attemptHandle, paid.attemptHandle);
    await call("finishPaidReconciliation", { lease: claim.lease });
    await finish(id, call, before);
  }
  {
    const id = "F12",
      call = await fresh(id),
      handle = await reserveReview(call, "kernel-lifetime");
    assert.equal((await call("reserveKernelUsage", { handle })).kind, "reserved");
    const before = await evidence(id);
    await control(id, "advance");
    assert.equal((await call("reserveKernelUsage", { handle })).kind, "refused");
    const after = await evidence(id);
    assert.equal(after.kernelBinding, before.kernelBinding);
    assert.equal(after.kernelCount, 1);
    assert.equal((await call("settleKernelUsage", { handle, terminalState: "committed", reason: "late original terminal" })).kind, "settle");
    await finish(id, call, before);
  }
  {
    const id = "F13",
      call = await fresh(id),
      paid = await paidReview(call, "retention-tombstone"),
      before = await evidence(id);
    await control(id, "advance");
    assert.equal((await call("reservePaidAttempt", { handle: paid.handle, hopId: "openlux-hop" })).kind, "blocked");
    const after = await evidence(id);
    assert.equal(after.attemptCount, 1);
    assert.equal(after.paidCount, 0);
    assert.equal(after.paidWindowIdentity, before.paidWindowIdentity);
    await finish(id, call, before);
  }
  {
    const id = "transport-tuple",
      call = await fresh(id),
      handle = await reserveReview(call, "nonpaid");
    await call("markApiDispatch", { handle, provider: "lithos" });
    assert.deepEqual(await call("recordTransportStarted", { handle, provider: "lithos" }, "first-start"), {
      kind: "started",
      detail: { provider: "lithos", attemptHandle: null },
    });
    const paid = await call("reservePaidAttempt", { handle, hopId: "openlux-hop" });
    assert.equal(paid.kind, "reserved");
    await call("recordPaidAttemptLifecycle", { attemptHandle: paid.attemptHandle, patch: { provider_request_id: "another-response" } });
    const before = await evidence(id);
    assert.equal(before.responding.provider, "metered");
    assert.deepEqual(await call("recordTransportStarted", { handle, provider: "lithos" }, "repeat-start"), {
      kind: "unchanged",
      detail: { provider: "lithos", attemptHandle: null },
    });
    await call("recordSemanticTerminal", { handle, attemptHandle: paid.attemptHandle, outcome: "completed" });
    await refused(call("recordTransportStarted", { handle, provider: "lithos" }, "first-start"));
    const after = await evidence(id);
    assert.deepEqual(after.transport, { provider: "lithos", attemptHandle: null });
    assert.equal(after.apiCommitted, 1);
    await finish(id, call, before);
  }
  {
    const id = "R2-paid-start",
      call = await fresh(id),
      paid = await paidReview(call, "cached-paid-start");
    await call("markApiDispatch", { handle: paid.handle, provider: "metered" });
    assert.equal(
      (await call("recordTransportStarted", { handle: paid.handle, provider: "metered", attemptHandle: paid.attemptHandle }, "paid-start-receipt")).kind,
      "started"
    );
    await call("recordPaidAttemptLifecycle", {
      attemptHandle: paid.attemptHandle,
      patch: { provider_request_id: "settled-start", terminal_state: "completed" },
    });
    await refused(call("recordTransportStarted", { handle: paid.handle, provider: "metered", attemptHandle: paid.attemptHandle }, "paid-start-receipt"));
    assert.equal((await evidence(id)).paidReserved, 40);
    assert.equal((await call("recordVerifiedPaidBilling", { attemptHandle: paid.attemptHandle, log: billing("settled-start", 7) })).kind, "settled");
    await refused(call("recordTransportStarted", { handle: paid.handle, provider: "metered", attemptHandle: paid.attemptHandle }, "paid-start-receipt"));
    const state = await evidence(id);
    assert.equal(state.paidReserved, 0);
    assert.equal(state.paidSettled, 7);
    await finish(id, call);
  }
  {
    const id = "R2-shared-pagination",
      call = await fresh(id);
    const foreign = await call.sourcePhase(requestPhase({ requestId: "00-foreign", route: "/v1/responses", model: "fixture", stream: false }), "b");
    const foreignPaid = await call("reservePaidAttempt", { handle: foreign.handle, hopId: "openlux-hop" }, undefined, "b");
    assert.equal(foreignPaid.kind, "reserved");
    const own = await call.sourcePhase(requestPhase({ requestId: "zz-own", route: "/v1/responses", model: "fixture", stream: false }), "a");
    const ownPaid = await call("reservePaidAttempt", { handle: own.handle, hopId: "openlux-hop" }, undefined, "a");
    assert.equal(ownPaid.kind, "reserved");
    const owned = [];
    let cursor,
      pages = 0;
    do {
      const claim = await call("claimPaidReconciliation", { limit: 1, ...(cursor ? { cursor } : {}) }, undefined, "a");
      assert.equal(claim.kind, "claimed");
      for (const item of claim.detail) {
        assert.equal(item.attemptHandle, ownPaid.attemptHandle);
        assert.equal(item.requestHandle, own.handle);
        owned.push(item);
      }
      cursor = claim.cursor;
      await call("finishPaidReconciliation", { lease: claim.lease }, undefined, "a");
      pages++;
      assert(pages <= 4);
    } while (cursor);
    assert.equal(owned.length, 1);
    const after = await evidence(id);
    assert.equal(after.paidCount, 2);
    assert.equal(after.pendingDue.length, 2);
    assert.equal(after.paidReserved, 80);
    await finish(id, call, null, { pages, ownAttemptHandle: ownPaid.attemptHandle, foreignAttemptHandle: foreignPaid.attemptHandle });
  }
  {
    const id = "R2-provider-usage",
      call = await fresh(id),
      handle = await reserveReview(call, "codex-success-usage");
    await call("selectCodexAccount", { handle });
    await call("refreshCodexAdmission", { handle });
    await call("markApiDispatch", { handle, provider: "chatgpt_codex" });
    await providerSuccess();
    await call("recordCodexAttemptSignal", { handle, signal: "success" });
    assert.equal((await evidence(id)).transport, null);
    await call("recordSemanticTerminal", { handle, outcome: "completed", usage: { input_tokens: 3, cached_input_tokens: null, output_tokens: 2 } });
    const state = await evidence(id);
    assert.equal(state.rollups.length, 1);
    assert.equal(state.rollups[0].provider, "chatgpt_codex");
    assert.equal(state.rollups[0].request_count, 1);
    assert.equal(state.rollups[0].input_tokens, 3);
    assert.equal(state.rollups[0].output_tokens, 2);
    await finish(id, call);
  }
  {
    const id = "R2-prefetch-release",
      call = await fresh(id),
      paid = await paidReview(call, "prefetch-release");
    await call("markApiDispatch", { handle: paid.handle, provider: "metered" });
    assert.equal((await call("releasePaidBeforeFetch", { attemptHandle: paid.attemptHandle })).kind, "released");
    await call("recordPaidAttemptLifecycle", { attemptHandle: paid.attemptHandle, patch: { dispatch_state: "not_dispatched" } });
    const before = await evidence(id);
    assert.equal(before.providerObserved, false);
    assert.equal(before.responding, null);
    assert.equal(before.transport, null);
    assert.equal((await call("recordApiDispatchCancellation", { handle: paid.handle })).kind, "released");
    const after = await evidence(id);
    assert.equal(after.apiCommitted, 0);
    assert.equal(after.paidReserved, 0);
    await finish(id, call, before);
  }
  {
    const id = "R2-refresh-revision",
      call = await fresh(id),
      handle = await reserveReview(call, "unchanged-refresh");
    await call("selectCodexAccount", { handle });
    const before = await evidence(id);
    assert.equal((await call("refreshCodexAdmission", { handle })).kind, "current");
    assert.equal((await call("refreshCodexAdmission", { handle })).kind, "current");
    const after = await evidence(id);
    assert.equal(after.routingRevision, before.routingRevision);
    assert.equal(after.routingValueSha256, before.routingValueSha256);
    await finish(id, call, before, { revisionBoundProofRetained: before.routingRevision });
  }

  return results;
}

try {
  const beforeRetired = await inspect();
  assert.equal(beforeRetired.runtimeSchemaVersion, 3);
  assert.deepEqual(beforeRetired.runtimeBindingRevisions, [3]);
  report.storageSchemaVersion = beforeRetired.runtimeSchemaVersion;
  report.privateRuntimeRevision = beforeRetired.runtimeBindingRevisions[0];
  report.v3Assertions.push("actual SQLite meta and private binding grants report revision3");
  const retired = await raw("a", {
    epoch,
    operationId: "v3-retired-admission",
    method: "reserveApiUsage",
    args: { requestId: "old-v2", route: "/v1/responses", model: "fixture", stream: false },
  });
  assert.equal(retired.error.code, "invalid_authority_arguments");
  assert.deepEqual(await inspect(), beforeRetired);
  report.v3Assertions.push("retired v2 admission DTO refuses with unchanged actual SQLite projection");
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      sourcePhase(
        i % 2 ? "a" : "b",
        requestPhase({
          requestId: "api-contention-" + i,
          route: "/v1/responses",
          model: i % 2 ? "fixture" : "different-model",
          stream: false,
        })
      )
    )
  );
  assert.equal(results.filter((item) => item.kind === "reserved").length, 2);
  assert.equal(results.filter((item) => item.kind === "full").length, 18);
  report.assertions.push("20 independent Worker protocol clients share native API quota2");
  await crash("API reserve");
  const kernelHandles = await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(i % 2 ? "kernel-a" : "kernel-b", "kernel-contention-" + i)));
  const kernel = await Promise.all(kernelHandles.map((handle, i) => rpc(i % 2 ? "kernel-a" : "kernel-b", "reserveKernelUsage", { handle })));
  assert.equal(kernel.filter((item) => item.kind === "reserved").length, 2);
  for (let i = 0; i < kernel.length; i++)
    if (kernel[i].kind !== "reserved")
      await rpc(i % 2 ? "kernel-a" : "kernel-b", "releaseApiUndispatched", { handle: kernelHandles[i], reason: "kernel_quota_refused" });
  report.assertions.push("20 kernel contenders share limit2;18 refusals retain explicit native API release histories");
  const ledger = await reserve("ledger", "ledger-completed");
  await rpc("ledger", "reserveKernelUsage", { handle: ledger });
  await metadata("ledger", ledger);
  const selected = await rpc("ledger", "selectCodexAccount", { handle: ledger });
  assert.equal(selected.detail.accountIdHash, "a".repeat(64));
  const paid = await rpc("ledger", "reservePaidAttempt", { handle: ledger, hopId: "openlux-hop" }, "durable-paid-intent");
  assert(paid.attemptHandle);
  await crash("paid dispatch intent");
  assert.deepEqual(await rpc("ledger", "reservePaidAttempt", { handle: ledger, hopId: "openlux-hop" }, "durable-paid-intent"), paid);
  await rpc("ledger", "markApiDispatch", { handle: ledger, provider: "metered" });
  await rpc("ledger", "recordTransportStarted", { handle: ledger, provider: "metered", attemptHandle: paid.attemptHandle });
  await rpc("ledger", "recordPaidAttemptLifecycle", {
    attemptHandle: paid.attemptHandle,
    patch: { provider_request_id: "synthetic-billing" },
    fetchStarted: true,
  });
  await crash("provider dispatch observation");
  await assert.rejects(rpc("ledger", "releasePaidBeforeFetch", { attemptHandle: paid.attemptHandle }), /paid_fetch_may_have_started/);
  await rpc("ledger", "recordPaidAttemptLifecycle", { attemptHandle: paid.attemptHandle, patch: { terminal_state: "completed" } });
  await rpc("ledger", "recordSemanticTerminal", { handle: ledger, attemptHandle: paid.attemptHandle, outcome: "completed" });
  await rpc("ledger", "recordKernelTerminalIntent", { handle: ledger, terminalState: "committed" });
  await rpc("ledger", "settleKernelUsage", { handle: ledger, terminalState: "committed", reason: "completed" });
  await rpc("ledger", "recordDeliveryObservation", { handle: ledger, observation: "unobserved" });
  await crash("semantic/kernel terminal independent of billing");
  const log = { request_id: "synthetic-billing", quota: 7, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: fixedNow / 1000 };
  const billed = await rpc("ledger", "recordVerifiedPaidBilling", { attemptHandle: paid.attemptHandle, log }, "durable-billing");
  assert.equal(billed.kind, "settled");
  assert.equal(billed.detail.spend_microcredits, 7);
  await crash("billing settlement");
  assert.deepEqual(await rpc("ledger", "recordVerifiedPaidBilling", { attemptHandle: paid.attemptHandle, log }, "durable-billing"), billed);
  assert.equal((await rpc("ledger", "recordVerifiedPaidBilling", { attemptHandle: paid.attemptHandle, log })).kind, "cleanup");
  const pending = await reserve("ledger", "unresolved-hop");
  await rpc("ledger", "reserveKernelUsage", { handle: pending });
  await metadata("ledger", pending);
  await rpc("ledger", "selectCodexAccount", { handle: pending });
  const pendingPaid = await rpc("ledger", "reservePaidAttempt", { handle: pending, hopId: "surplus-hop" });
  await rpc("ledger", "markApiDispatch", { handle: pending, provider: "surplus" });
  await rpc("ledger", "recordTransportStarted", { handle: pending, provider: "surplus", attemptHandle: pendingPaid.attemptHandle });
  await rpc("ledger", "recordPaidAttemptLifecycle", { attemptHandle: pendingPaid.attemptHandle, patch: {}, fetchStarted: true });
  assert.equal((await rpc("ledger", "beginPaidKeyDeletion", {})).kind, "blocked");
  await rpc("growth", "setKernelQuota", { scope: "org", usageLimitRequests: -1, options: { expiresAtMs: -1 } });
  for (let i = 0; i < 400; i++) {
    const handle = await reserve("growth", "retained-" + i);
    assert.equal((await rpc("growth", "reserveKernelUsage", { handle })).kind, "reserved");
    await metadata("growth", handle);
    await rpc("growth", "selectCodexAccount", { handle });
    assert.equal((await rpc("growth", "reservePaidAttempt", { handle, hopId: "openlux-hop" })).kind, "reserved");
    if (i % 100 === 99) console.log(JSON.stringify({ retainedRequests: i + 1 }));
  }
  const retained = await inspect();
  assert(retained.paidRequestBytes > 262144);
  assert.equal(retained.paidRequestCount, 402);
  assert.equal(retained.permanentRollups, 1);
  assert.equal(retained.permanentGuards, 1);
  const firstPage = await rpc("growth", "foldPaidBackfillPage", { limit: 100 });
  assert(firstPage.cursor);
  const beforeDispose = await inspect();
  await runtime.dispose();
  runtime = new Miniflare(options());
  const afterDispose = await inspect();
  assert.notEqual(afterDispose.incarnation, beforeDispose.incarnation);
  assert.deepEqual({ ...afterDispose, incarnation: null }, { ...beforeDispose, incarnation: null });
  let cursor = firstPage.cursor,
    pages = 1;
  while (cursor) {
    const page = await rpc("growth", "foldPaidBackfillPage", { limit: 100, cursor });
    cursor = page.cursor;
    pages++;
  }
  assert.equal(pages, 5);
  assert.equal((await inspect()).paidRequestCount, 402);
  report.assertions.push(
    "actual SQLite retains402paid rows above262144bytes, permanent rollup/deletion guard, paged backfill resumes after full runtime disposal"
  );
  const invalid = await raw("ledger", { epoch, operationId: "malicious", method: "snapshot", args: {} });
  assert.equal(invalid.error.code, "invalid_authority_operation");
  if (mode === "mixed") {
    const held = (
      await bunCall("mixed-a", [
        requestPhase({ requestId: "mixed-held-bun", route: "/v1/responses", model: "fixture", stream: false }, randomUUID(), "open-api"),
      ])
    )[0];
    assert.equal(held.kind, "reserved");
    const mixed = await Promise.all(
      Array.from({ length: 19 }, async (_, i) => {
        const principal = i % 2 ? "mixed-a" : "mixed-b";
        const args = { requestId: "mixed-contender-" + i, route: "/v1/responses", model: i % 2 ? "fixture" : "different-model", stream: false };
        const reply =
          i % 2
            ? (await bunCall(principal, [requestPhase(args, randomUUID(), "open-api")]))[0]
            : await sourcePhase(principal, requestPhase(args, randomUUID(), "open-api"));
        return { principal, reply };
      })
    );
    assert.equal(mixed.filter((item) => item.reply.kind === "reserved").length, 1);
    assert.equal(mixed.filter((item) => item.reply.kind === "full").length, 18);
    const winner = mixed.find((item) => item.reply.kind === "reserved");
    const [leftKernel, rightKernel] = await Promise.all([
      bunCall("mixed-a", [{ method: "reserveKernelUsage", args: { handle: held.handle } }]),
      rpc(winner.principal, "reserveKernelUsage", { handle: winner.reply.handle }),
    ]);
    assert.equal(leftKernel[0].kind, "reserved");
    assert.equal(rightKernel.kind, "reserved");
    const overflow = await reserve("mixed-overflow", "mixed-kernel-overflow");
    assert.equal((await rpc("mixed-overflow", "reserveKernelUsage", { handle: overflow })).kind, "full");
    await rpc("workflow", "setKernelQuota", { scope: "org", usageLimitRequests: -1, options: { expiresAtMs: -1 } });
    report.assertions.push("20 actual mixed Bun HTTP/Worker contenders share APIlimit2 and concurrent kernel limit2 across principals and keys");
    const original = await reserve("growth", "bun-shared");
    const [bunResult, workerResult] = await Promise.all([
      bunCall("growth", [{ method: "selectCodexAccount", args: { handle: original } }]),
      rpc("ledger", "selectCodexAccount", { handle: pending }),
    ]);
    assert.equal(bunResult[0].detail.accountIdHash, workerResult.detail.accountIdHash);
    const [jsonResponse, sseResponse] = await Promise.all([
      runtime.dispatchFetch("http://native-authority-fixture.test/workflow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "actual-json", stream: false }),
      }),
      runtime.dispatchFetch("http://native-authority-fixture.test/workflow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "actual-sse", stream: true }),
      }),
    ]);
    assert.equal(jsonResponse.status, 200);
    assert.equal((await jsonResponse.json()).status, "completed");
    assert.equal(sseResponse.status, 200);
    assert((await sseResponse.text()).includes("response.completed"));
    const url = String(await runtime.ready).replace(/\/$/, "");
    const aborted = await fetch(url + "/workflow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "actual-abort", stream: true }),
    });
    const handle = aborted.headers.get("x-fixture-handle");
    assert(handle);
    await aborted.body.cancel("observed synthetic client cancellation");
    const status = await rpc("workflow", "readRequestStatus", { handle, limit: 1 });
    assert(["interrupted", "unobserved", null].includes(status.detail.lifetime.delivery));
    report.assertions.push(
      "simultaneous real Bun HTTP and Worker clients shareDO; actual synthetic JSON/SSE plus abort preserve observed/pending delivery truth"
    );
    report.mixedAcceptance = "passed";
  }
  report.originalProviderCalls = providerCalls;
  assert.equal(providerCalls, 3, "original JSON/SSE/abort provider calls remain exact");
  const ownerReview = async (id, action, body = {}) => {
    const response = await dispatch("/review/" + id + "/__fixture/" + action, body, true);
    assert.equal(response.status, 200);
    return await response.json();
  };
  const reviewCalls = new Map();
  report.reviews = await runReviewCases({
    setup: (id) => ownerReview(id, "setup"),
    control: (id, action) => ownerReview(id, "control", { action }),
    evidence: (id) => ownerReview(id, "evidence"),
    callFor: (id) => {
      const clients = { bun: 0, worker: 0 };
      let sequence = 0;
      const call = async (method, args, operationId = randomUUID(), principal = "ledger") => {
        if (sequence++ % 2 === 0) {
          clients.bun++;
          return (await bunCall(principal, [{ method, args, operationId }], id))[0];
        }
        clients.worker++;
        const response = await dispatch("/review/" + id + "/client/" + principal, { epoch, method, args, operationId });
        assert.equal(response.status, 200);
        const reply = await response.json();
        if (reply.error) throw Object.assign(new Error(reply.error.code), { fixtureRefusal: true, code: reply.error.code });
        return reply.result;
      };
      call.sourcePhase = async (operation, principal = "ledger") => {
        if (sequence++ % 2 === 0) {
          clients.bun++;
          return (await bunCall(principal, [operation], id))[0];
        }
        clients.worker++;
        const response = await dispatch("/review/" + id + "/source-phase/" + principal, operation);
        assert.equal(response.status, 200);
        const reply = await response.json();
        if (reply.error) throw Object.assign(new Error(reply.error.code), { fixtureRefusal: true, code: reply.error.code });
        return reply.result;
      };
      call.kernel = id === "F12";
      call.clients = clients;
      reviewCalls.set(id, clients);
      return call;
    },
    restart: async () => {
      await runtime.dispose();
      runtime = new Miniflare(options());
    },
    denied: async (id, handle) => {
      assert.equal((await dispatch("/review/unknown/rpc/ledger", {})).status, 403);
      assert.equal((await dispatch("/review/" + id + "/__fixture/control", { action: "rotate" })).status, 403);
      const invalid = await dispatch("/review/" + id + "/rpc/ledger", {
        epoch: "wrong-epoch",
        operationId: randomUUID(),
        method: "readRequestStatus",
        args: { handle, limit: 1 },
      });
      assert.equal((await invalid.json()).error.code, "authority_epoch_mismatch");
    },
    providerSuccess: async () => {
      const response = await fetch(upstreamOrigin + "/json", { method: "POST", body: "{}" });
      const body = await response.text();
      assert.equal(response.status, 200);
      return { status: response.status, headers: [...response.headers], body };
    },
  });
  assert.equal(report.reviews.length, 22);
  assert.equal(providerCalls, 5);
  report.originalActualBunHttpClients = report.actualBunHttpClients;
  const nativeBindings = (await bunCall("control", [], null, { surface: "native-bindings" }))[0];
  report.nativeBindingVerificationClients = 1;
  for (const path of [
    "src/api-keys.ts",
    "src/paid-fallback/index.ts",
    "src/auth/local-development-key.ts",
    "src/provider/metered.ts",
    "src/authority/native-principal-contracts.ts",
  ])
    hashes[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  report.control = await runPrincipalControlCases({
    epoch,
    nativeBindings,
    owner: async (id, action, body = {}) => {
      const response = await dispatch("/control/" + id + "/__fixture/" + action, body, true);
      assert.equal(response.status, 200);
      return await response.json();
    },
    remote: async ({ id, surface, profile, command, client, raw }) => {
      if (client === "bun")
        return (await bunCall(profile, [command], null, { controlCase: id, ...(["principal", "retained"].includes(surface) ? { surface } : {}), raw }))[0];
      const path =
        surface === "principal"
          ? raw
            ? "control-raw"
            : "control-client"
          : surface === "source-phase"
            ? "source-phase"
            : surface === "retained"
              ? "retained-client"
              : "client";
      const response = await dispatch("/control/" + id + "/" + path + "/" + profile, command);
      assert.equal(response.status, 200);
      const reply = await response.json();
      if (raw) return reply;
      if (reply.error) throw Object.assign(new Error(reply.error.code), { fixtureRefusal: true, code: reply.error.code, status: reply.error.status });
      if (reply.fixtureFault) throw Object.assign(new Error(reply.fixtureFault.message), { fixtureFault: true });
      return reply.result;
    },
    restart: async () => {
      await runtime.dispose();
      runtime = new Miniflare(options());
    },
  });
  assert.equal(providerCalls, 5, "principal-control acceptance must not add provider I/O");
  report.reviewIsolation = "named synthetic test namespaces; each Bun/Worker pair shares one persistent SQLite DO; no live owner publisher acceptance";
  report.final = await inspect();
  report.providerCalls = providerCalls;
  report.children = children;
  report.persistedFiles = await readdir(persistence, { recursive: true });
  assert(report.persistedFiles.some((file) => file.endsWith(".sqlite")));
  report.state = "local-native-authority-runtime-pass";
  await writeFile(join(directory, mode + "-runtime-result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    "UOS_NATIVE_AUTHORITY_MIXED=" +
      JSON.stringify({
        reportPath: join(directory, mode + "-runtime-result.json"),
        state: report.state,
        mode,
        versions,
        paidRows: report.final.paidRequestCount,
        paidBytes: report.final.paidRequestBytes,
        assertions: report.assertions,
        mixedAcceptance: report.mixedAcceptance,
        providerCalls,
        children,
      })
  );
} finally {
  const pendingChildren = [...activeChildren].map((child) => new Promise((resolve) => child.once("close", resolve)));
  for (const child of activeChildren) child.kill("SIGTERM");
  await Promise.allSettled(pendingChildren);
  await runtime.dispose();
  await require("esbuild").stop();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(children, 0);
}

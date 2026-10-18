import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
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
for (const file of ["fixture-worker.mjs", "bun-client.ts"]) await writeFile(join(scratch, file), await readFile(join(sourceDirectory, file)));
const fixtureHashes = {};
for (const file of ["fixture-worker.mjs", "bun-client.ts", "mixed-client-workerd.mjs"])
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
  assert.deepEqual(imports.sort(), ["../../../src/authority/native-authority-rpc.ts", "../../../src/authority/native-authority.ts", "cloudflare:workers"]);
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
    durableObjects: { AUTHORITY: { className: "SharedNativeAuthority", useSQLite: true } },
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
const reserve = async (principal, id) => {
  const reply = await rpc(principal, "reserveApiUsage", { requestId: id, route: "/v1/responses", model: "fixture", stream: false });
  assert(reply.handle, JSON.stringify(reply));
  return reply.handle;
};
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
const bunCall = async (principal, operations) => {
  const url = String(await runtime.ready).replace(/\/$/, "");
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
    child.stdin.end(JSON.stringify({ url, principal, epoch, operations }));
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.runtime, "1.4.0");
    report.actualBunHttpClients++;
    return result.results;
  } finally {
    activeChildren.delete(child);
    children = activeChildren.size;
  }
};
try {
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      rpc(i % 2 ? "a" : "b", "reserveApiUsage", {
        requestId: "api-contention-" + i,
        route: "/v1/responses",
        model: i % 2 ? "fixture" : "different-model",
        stream: false,
      })
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
  const selected = await rpc("ledger", "selectCodexAccount", { handle: ledger });
  assert.equal(selected.detail.accountIdHash, "a".repeat(64));
  const paid = await rpc("ledger", "reservePaidAttempt", { handle: ledger, hopId: "openlux-hop" }, "durable-paid-intent");
  assert(paid.attemptHandle);
  await crash("paid dispatch intent");
  assert.deepEqual(await rpc("ledger", "reservePaidAttempt", { handle: ledger, hopId: "openlux-hop" }, "durable-paid-intent"), paid);
  await rpc("ledger", "markApiDispatch", { handle: ledger, provider: "metered" });
  await rpc("ledger", "recordPaidAttemptLifecycle", {
    attemptHandle: paid.attemptHandle,
    patch: { provider_request_id: "synthetic-billing" },
    fetchStarted: true,
  });
  await crash("provider dispatch observation");
  await assert.rejects(rpc("ledger", "releasePaidBeforeFetch", { attemptHandle: paid.attemptHandle }), /paid_fetch_may_have_started/);
  await rpc("ledger", "recordPaidAttemptLifecycle", { attemptHandle: paid.attemptHandle, patch: { terminal_state: "completed" } });
  await rpc("ledger", "recordSemanticTerminal", { handle: ledger, outcome: "completed" });
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
  await rpc("ledger", "selectCodexAccount", { handle: pending });
  const pendingPaid = await rpc("ledger", "reservePaidAttempt", { handle: pending, hopId: "surplus-hop" });
  await rpc("ledger", "recordPaidAttemptLifecycle", { attemptHandle: pendingPaid.attemptHandle, patch: {}, fetchStarted: true });
  assert.equal((await rpc("ledger", "beginPaidKeyDeletion", {})).kind, "blocked");
  await rpc("growth", "setKernelQuota", { scope: "org", usageLimitRequests: -1, options: { expiresAtMs: -1 } });
  for (let i = 0; i < 400; i++) {
    const handle = await reserve("growth", "retained-" + i);
    assert.equal((await rpc("growth", "reserveKernelUsage", { handle })).kind, "reserved");
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
      await bunCall("mixed-a", [{ method: "reserveApiUsage", args: { requestId: "mixed-held-bun", route: "/v1/responses", model: "fixture", stream: false } }])
    )[0];
    assert.equal(held.kind, "reserved");
    const mixed = await Promise.all(
      Array.from({ length: 19 }, async (_, i) => {
        const principal = i % 2 ? "mixed-a" : "mixed-b";
        const args = { requestId: "mixed-contender-" + i, route: "/v1/responses", model: i % 2 ? "fixture" : "different-model", stream: false };
        const reply = i % 2 ? (await bunCall(principal, [{ method: "reserveApiUsage", args }]))[0] : await rpc(principal, "reserveApiUsage", args);
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

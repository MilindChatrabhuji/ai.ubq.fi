import { test } from "bun:test";
import assert from "node:assert/strict";
const serverSource = await Bun.file(new URL("../serve.ts", import.meta.url)).text();
const handlerSource = await Bun.file(new URL("../src/handler/index.ts", import.meta.url)).text();
const terminalRouteSource = await Bun.file(new URL("../src/handler/terminal-route.ts", import.meta.url)).text();
const catalogSource = await Bun.file(new URL("../src/catalog/index.ts", import.meta.url)).text();
const deploymentWorkflow = await Bun.file(new URL("../.github/workflows/deno-deploy.yml", import.meta.url)).text();
const verificationScript = await Bun.file(new URL("../scripts/verify.sh", import.meta.url)).text();

test("gateway entry points start no Sentinel automation but keep the authorized capture/export", () => {
  assert.doesNotMatch(serverSource, /sentinel/i);
  // m06 adds only the passive, read-only incident index GET: no automation,
  // dispatch, control or claim/ack/defer wiring may return. The route is now a
  // table entry rather than an inline `method === "GET" && path === ...` chain,
  // so this pins the entry itself.
  assert.match(handlerSource, /path: "\/admin\/sentinel\/incidents", run: \(req\) => handleAdminSentinelIncidents\(req\)/u);
  assert.match(handlerSource, /handleAdminSentinelIncidents/u);
  assert.doesNotMatch(handlerSource, /coalesceSentinelIncidentFailureEvents/u);
  assert.doesNotMatch(handlerSource, /\?\? recordSentinelProviderDegradationFromEnvironment/u);
  assert.doesNotMatch(catalogSource, /\?\? recordSentinelProviderDegradationFromEnvironment/u);
  assert.match(deploymentWorkflow, /sh scripts\/verify\.sh/u);
  assert.match(verificationScript, /test-runner\.ts sentinel/u);
  assert.doesNotMatch(deploymentWorkflow, /provider-sentinel|sentinel-revision-control|scripts\/sentinel/u);
  assert.match(terminalRouteSource, /captureAcceptedSentinelReplayInput/u);
  assert.match(handlerSource, /\/admin\/sentinel\/replay-captures/u);
});

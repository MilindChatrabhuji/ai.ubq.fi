import { serveHttp } from "#http";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { assertPublicRelease, PUBLIC_HEALTH_URL, reloadCaddyIngress } from "../ops/vps-ingress.ts";

const REVISION = "a1b2c3d4".repeat(5);
const OTHER_REVISION = "b".repeat(40);
const DEPLOYMENT_ID = `vps-${REVISION}`;

const identityHeaders = (overrides: Record<string, string | null> = {}): Headers => {
  const headers = new Headers({
    "content-type": "application/json",
    "x-uos-git-sha": REVISION,
    "x-uos-deployment-id": DEPLOYMENT_ID,
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
};

const releaseResponse = (options: { status?: number; body?: string; headers?: Headers } = {}): Response =>
  new Response(options.body ?? JSON.stringify({ release: { git_sha: REVISION, deployment_id: DEPLOYMENT_ID } }), {
    status: options.status ?? 200,
    headers: options.headers ?? identityHeaders(),
  });

/**
 * Serve every request from one loopback listener so the fixture exercises the
 * real fetch and HTTP path of `assertPublicRelease` without touching the
 * production route or the host's gateway port.
 */
const withLoopbackServer = async (respond: () => Response, run: (url: string) => Promise<void>): Promise<void> => {
  const listening = Promise.withResolvers<number>();
  const server = serveHttp(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: ({ port }) => {
        listening.resolve(port);
      },
    },
    () => respond()
  );
  try {
    const port = await listening.promise;
    await run(`http://127.0.0.1:${port}/health`);
  } finally {
    await server.shutdown();
  }
};

/**
 * A route that answers 200 with the wrong revision, or with a truncated
 * revision, must not be accepted: `AGENTS.md` requires the exact full Git SHA
 * and its `vps-<sha>` deployment id in both the body and the identity headers.
 */
const mismatches: { label: string; response: () => Response }[] = [
  { label: "a non-200 status", response: () => releaseResponse({ status: 503 }) },
  {
    label: "a truncated body revision",
    response: () => releaseResponse({ body: JSON.stringify({ release: { git_sha: REVISION.slice(0, 12), deployment_id: DEPLOYMENT_ID } }) }),
  },
  {
    label: "a body deployment id for a different revision",
    response: () => releaseResponse({ body: JSON.stringify({ release: { git_sha: REVISION, deployment_id: `vps-${OTHER_REVISION}` } }) }),
  },
  { label: "a body without the release identity", response: () => releaseResponse({ body: JSON.stringify({ release: {} }) }) },
  { label: "a truncated identity header", response: () => releaseResponse({ headers: identityHeaders({ "x-uos-git-sha": REVISION.slice(0, 12) }) }) },
  { label: "a missing identity header", response: () => releaseResponse({ headers: identityHeaders({ "x-uos-deployment-id": null }) }) },
  { label: "a non-JSON body", response: () => releaseResponse({ body: "502 Bad Gateway" }) },
];

test("the deploy contract targets the documented public health route", () => {
  assert.equal(PUBLIC_HEALTH_URL, "https://ai.ubq.fi/health");
});

test("the public health check accepts the exact release identity over HTTP", async () => {
  await withLoopbackServer(
    () => releaseResponse(),
    async (url) => {
      await assertPublicRelease(REVISION, url);
    }
  );
});

test("the public health check fails closed on every identity mismatch", async () => {
  let current = releaseResponse();
  await withLoopbackServer(
    () => current,
    async (url) => {
      await assertPublicRelease(REVISION, url);
      for (const mismatch of mismatches) {
        current = mismatch.response();
        await assert.rejects(() => assertPublicRelease(REVISION, url), /did not serve release/, `${mismatch.label} must fail the public check`);
      }
      // Positive control in the same fixture: the exact identity still passes
      // after the rejected responses.
      current = releaseResponse();
      await assertPublicRelease(REVISION, url);
    }
  );
});

test("the Caddy reload applies the validated configuration and a reload failure fails the deployment", async () => {
  const calls: { program: string; args: string[] }[] = [];
  await reloadCaddyIngress((program, args) => {
    calls.push({ program, args });
    return Promise.resolve("");
  });
  assert.deepEqual(calls, [{ program: "sudo", args: ["-n", "systemctl", "reload", "caddy"] }]);
  await assert.rejects(() => reloadCaddyIngress(() => Promise.reject(new Error("caddy reload refused"))), /caddy reload refused/);
});

import { expect, test } from "bun:test";
import { createAuthorityState, PortableAuthority } from "../src/authority/admission-state.ts";
import { AuthorityError, type AuthorityStore, type TerminalEvidence } from "../src/authority/contracts.ts";
import { createWorkerBoundary } from "../src/worker/entrypoint.ts";
import { HttpUpstreamTransport, type UpstreamResult } from "../src/worker/transport.ts";

const observe = (response: Response): UpstreamResult => {
  const { promise: terminal, resolve } = Promise.withResolvers<TerminalEvidence>();
  const reader = response.body?.getReader();
  let text = "";
  const decoder = new TextDecoder();
  const evidence = (outcome: TerminalEvidence["outcome"]): TerminalEvidence => ({
    outcome,
    providerRequestId: response.headers.get("x-request-id"),
    spendMicrocredits: null,
    fallback: null,
  });
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) {
            resolve(evidence(text.includes('"status":"completed"') || text.includes('"finish_reason":"stop"') ? "completed" : "incomplete"));
            controller.close();
            return;
          }
          text += decoder.decode(chunk.value, { stream: true });
          if (text.length > 32_768) throw new Error("synthetic observation limit");
          if (text.includes("response.completed")) resolve(evidence("completed"));
          controller.enqueue(chunk.value);
        } catch (error) {
          resolve(evidence("cancelled"));
          controller.error(error);
        }
      },
      async cancel(reason) {
        resolve(evidence("cancelled"));
        await reader?.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return { response: new Response(body, response), terminal };
};

const fixture = () => {
  const scope = { namespace: "synthetic-boundary", epoch: 1 };
  let state = createAuthorityState(
    scope,
    [
      {
        accountId: "a",
        fingerprint: "fp",
        credentialGeneration: 1,
        routingGeneration: 1,
        resetGeneration: 1,
        overageVersion: 1,
        overageEnabled: false,
        enabled: true,
        models: ["fixture"],
        proof: null,
      },
    ],
    [
      {
        principalId: "p",
        version: 1,
        deleted: false,
        windowResetAtMs: 1_000_000,
        requestLimit: 20,
        kernelLimit: 20,
        concurrencyLimit: 20,
        paidLimitMicrocredits: 0,
      },
    ]
  );
  let revision = 0;
  let calls = 0;
  let outage = false;
  const tasks: Promise<unknown>[] = [];
  const store: AuthorityStore = {
    read() {
      if (outage) throw new Error("synthetic authority outage");
      return Promise.resolve({ revision, state: structuredClone(state) });
    },
    compareAndSwap(expected, value) {
      if (expected !== revision) return Promise.resolve(false);
      state = structuredClone(value);
      revision += 1;
      return Promise.resolve(true);
    },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls += 1;
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-upstream");
      const body: { stream?: boolean } = await request.json();
      if (!body.stream)
        return Response.json(
          { id: "fixture-id", status: "completed", choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] },
          { headers: { "x-request-id": "fixture-upstream" } }
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"pong"}\n\n'));
            timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"response":{"status":"completed"}}\n\n'));
              controller.close();
            }, 30);
          },
          cancel() {
            clearTimeout(timer);
          },
        }),
        { headers: { "content-type": "text/event-stream", "x-request-id": "fixture-upstream" } }
      );
    },
  });
  const upstream = new HttpUpstreamTransport({
    provider: "codex",
    fetch,
    baseUrl: server.url.origin,
    maximumExposureMicrocredits: 0,
    headers: () => Promise.resolve(new Headers({ authorization: "Bearer synthetic-upstream" })),
    observe,
    validate(route, body) {
      const fields = new Set(["model", "stream", route === "/v1/responses" ? "input" : "messages"]);
      if (body.model !== "fixture" || Object.keys(body).some((key) => !fields.has(key)) || (body.stream !== undefined && typeof body.stream !== "boolean"))
        throw new AuthorityError("invalid_fixture_schema", 400);
      return Promise.resolve({ route, model: "fixture", stream: body.stream === true, body });
    },
  });
  const boundary = createWorkerBoundary({
    scope,
    authority: new PortableAuthority(store, scope),
    upstream,
    now: () => 100,
    authenticate: (request) =>
      Promise.resolve(request.headers.get("authorization") === "Bearer synthetic-client" ? { principalId: "p", policyVersion: 1 } : null),
  });
  return {
    boundary,
    lifetime: {
      waitUntil(task: Promise<unknown>) {
        tasks.push(task);
      },
    },
    async drain() {
      while (tasks.length) await Promise.all(tasks.splice(0));
    },
    stop: () => server.stop(true),
    calls: () => calls,
    state: () => state,
    outage: () => {
      outage = true;
    },
  };
};
const request = (body: unknown, options: { path?: string; auth?: string; signal?: AbortSignal } = {}) =>
  new Request(`https://fixture.invalid${options.path ?? "/v1/responses"}`, {
    method: "POST",
    headers: { authorization: options.auth ?? "Bearer synthetic-client", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });

test("authenticated Responses/chat JSON and progressive SSE use actual loopback HTTP; EOF remains unobserved delivery", async () => {
  expect(["CODEX_AUTH_JSON_B64", "SURPLUS_API_KEY", "METERED_API_KEY", "OPENROUTER_API_KEY"].some((key) => Boolean(process.env[key]))).toBe(false);
  const f = fixture();
  try {
    for (const path of ["/v1/responses", "/v1/chat/completions"]) {
      const response = await f.boundary.fetch(
        request({ model: "fixture", ...(path === "/v1/responses" ? { input: "ping" } : { messages: [] }) }, { path }),
        f.lifetime
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("pong");
    }
    const response = await f.boundary.fetch(request({ model: "fixture", input: "ping", stream: true }), f.lifetime);
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("response.output_text.delta");
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("response.completed");
    expect((await reader?.read())?.done).toBe(true);
    await f.drain();
    expect(f.calls()).toBe(3);
    expect(Object.values(f.state().admissions).every((value) => value.semantic === "completed" && value.delivery === "unobserved" && value.settled)).toBe(true);
    expect(Object.values(f.state().windows)[0].kernelCompleted).toBe(3);
  } finally {
    await f.stop();
  }
});

test("auth/schema/unsupported route, early cancellation and authority outage dispatch zero calls", async () => {
  const f = fixture();
  try {
    expect((await f.boundary.fetch(request({ model: "fixture" }, { auth: "invalid" }), f.lifetime)).status).toBe(401);
    expect((await f.boundary.fetch(request({ model: "fixture", upstreamUrl: "https://forbidden.invalid" }), f.lifetime)).status).toBe(400);
    expect((await f.boundary.fetch(request({}, { path: "/admin/native/refresh" }), f.lifetime)).status).toBe(501);
    const abort = new AbortController();
    abort.abort();
    expect((await f.boundary.fetch(request({ model: "fixture" }, { signal: abort.signal }), f.lifetime)).status).toBe(499);
    f.outage();
    expect((await f.boundary.fetch(request({ model: "fixture" }), f.lifetime)).status).toBe(502);
    expect(f.calls()).toBe(0);
  } finally {
    await f.stop();
  }
});

test("midstream body cancellation propagates abort and settles one admission", async () => {
  const f = fixture();
  try {
    const response = await f.boundary.fetch(request({ model: "fixture", stream: true }), f.lifetime);
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel("synthetic disconnect");
    await f.drain();
    expect(f.calls()).toBe(1);
    const admission = Object.values(f.state().admissions)[0];
    expect(admission.delivery).toBe("interrupted");
    expect(admission.settled).toBe(true);
    expect(Object.values(f.state().windows)[0]).toMatchObject({ active: 0, dispatched: 1, kernelReserved: 0 });
  } finally {
    await f.stop();
  }
});

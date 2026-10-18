// Test-only controlled upstream and private binding driver. Never deployed.
import { DurableObject } from "cloudflare:workers";

export class FixtureControl extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)");
  }

  async fetch(request) {
    if (request.method === "POST") {
      this.ctx.storage.sql.exec("INSERT INTO events(value) VALUES (?)", await request.text());
      return new Response(null, { status: 204 });
    }
    return Response.json(
      this.ctx.storage.sql
        .exec("SELECT value FROM events ORDER BY seq")
        .toArray()
        .map((row) => JSON.parse(row.value))
    );
  }
}

const log = (env, event) =>
  env.CONTROL.getByName("runtime-control-v1").fetch("https://control.internal/events", { method: "POST", body: JSON.stringify(event) });

async function upstream(request, env, context) {
  const url = new URL(request.url);
  const body = await request.json();
  const prompt = JSON.stringify(body.messages ?? body.input);
  const cerebras = url.hostname === "api.cerebras.ai";
  if (url.pathname !== (cerebras ? "/v1/chat/completions" : "/chat/completions")) return new Response("Unexpected upstream path", { status: 400 });
  if (request.headers.get("authorization") !== "Bearer fixture-provider-secret") return new Response("Unexpected credential", { status: 401 });
  await log(env, { kind: "dispatch", hostname: url.hostname, path: url.pathname, body });
  if (prompt.includes("fixture:refusal-empty")) return new Response(null, { status: 416, headers: { "x-fixture-refusal": "empty" } });
  if (prompt.includes("fixture:refusal-progressive")) {
    let timer;
    let finish;
    const lifetime = new Promise((resolve) => (finish = resolve));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0x00, 0x41]));
        timer = setTimeout(() => {
          controller.enqueue(new Uint8Array([0x42, 0xfe, 0x43]));
          controller.close();
          finish();
        }, 350);
      },
      cancel() {
        clearTimeout(timer);
        finish();
      },
    });
    context.waitUntil(lifetime);
    const headers = new Headers({ "content-type": "application/octet-stream", "x-fixture-refusal": "raw", "x-request-id": "fixture-refusal-id" });
    headers.append("set-cookie", "first=1; Secure; HttpOnly");
    headers.append("set-cookie", "second=2; Secure; HttpOnly");
    return new Response(stream, { status: 418, headers });
  }
  if (body.stream !== true) {
    return Response.json(
      {
        id: "chatcmpl_fixture",
        object: "chat.completion",
        created: 1_791_244_800,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "fixture answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_cache_hit_tokens: 4 },
      },
      { headers: { "x-request-id": "provider-fixture-id" } }
    );
  }
  const encoder = new TextEncoder();
  const chunk = (delta, finish = null, usage) =>
    encoder.encode(
      `data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1_791_244_800, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
    );
  let timer;
  let closed = false;
  let finish;
  const lifetime = new Promise((resolve) => {
    finish = resolve;
  });
  const cancelled = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    context.waitUntil(log(env, { kind: "upstream_cancelled", prompt }));
    finish();
  };
  request.signal.addEventListener("abort", cancelled, { once: true });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk({ role: "assistant", content: "fixture " }));
      if (prompt.includes("fixture:abort")) {
        timer = setTimeout(() => {
          if (closed) return;
          closed = true;
          context.waitUntil(log(env, { kind: "fixture_safety_timeout", prompt }));
          controller.error(new Error("Controlled upstream safety timeout"));
          finish();
        }, 60_000);
        return;
      }
      timer = setTimeout(() => {
        if (closed) return;
        closed = true;
        if (!prompt.includes("fixture:truncate")) {
          controller.enqueue(chunk({ content: "answer" }));
          controller.enqueue(chunk({}, "stop", { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_cache_hit_tokens: 4 }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
        finish();
      }, 350);
    },
    cancel: cancelled,
  });
  context.waitUntil(lifetime.finally(() => request.signal.removeEventListener("abort", cancelled)));
  return new Response(stream, { headers: { "content-type": "text/event-stream", "x-request-id": "provider-fixture-id" } });
}

async function extrasUpstream(request, env) {
  const url = new URL(request.url);
  if (request.headers.get("authorization") !== "Bearer fixture-provider-secret") return new Response("Unexpected credential", { status: 401 });
  if (url.hostname === "openrouter.ai" && url.pathname === "/api/v1/models" && request.method === "GET") {
    return Response.json({ data: [{ id: "typesafe/jev-fast", name: "Fixture Jev" }] });
  }
  const body = await request.json();
  await log(env, { kind: "extras_dispatch", hostname: url.hostname, path: url.pathname, body });
  if (url.hostname === "api.voyageai.com" && url.pathname === "/v1/embeddings") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    if (inputs.some((input) => input.includes("fixture:job-retry"))) {
      const prior = await env.CONTROL.getByName("runtime-control-v1").fetch("https://control.internal/events");
      const calls = (await prior.json()).filter((event) => event.kind === "extras_dispatch" && JSON.stringify(event.body.input).includes("fixture:job-retry"));
      if (calls.length === 1) return Response.json({ error: "Controlled retry" }, { status: 429, headers: { "retry-after": "0.01" } });
    }
    return Response.json({ data: inputs.map((_, index) => ({ index, embedding: Array(body.output_dimension).fill(0.125) })), usage: { total_tokens: 7 } });
  }
  if (url.hostname === "openrouter.ai" && url.pathname === "/api/v1/systemone") {
    return Response.json({
      answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, { probability: 0.75 }])),
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  }
  return new Response("Unexpected extras upstream path", { status: 400 });
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.hostname === "api.github.com" && url.pathname === "/repos/fixture-owner/fixture-repo") {
      if (request.headers.get("authorization") !== "Bearer ghs_fixture_kernel_access") return new Response(null, { status: 401 });
      if (request.headers.get("accept") !== "application/vnd.github+json" || request.headers.get("x-github-api-version") !== "2022-11-28")
        return new Response(null, { status: 400 });
      return Response.json({ full_name: "fixture-owner/fixture-repo" });
    }
    if (["api.deepseek.com", "api.cerebras.ai"].includes(url.hostname)) return upstream(request, env, context);
    if (["api.voyageai.com", "openrouter.ai"].includes(url.hostname)) return extrasUpstream(request, env);
    if (url.pathname.startsWith("/public/")) {
      if (request.headers.get("x-fixture-disconnect") === "1") {
        request.signal.addEventListener("abort", () => console.error(JSON.stringify({ event: "fixture_incoming_abort", at_ms: Date.now() })), { once: true });
      }
      if (request.headers.get("x-fixture-explicit-signal") === "1") {
        const cancellation = new AbortController();
        context.waitUntil(
          new Promise((resolve) =>
            setTimeout(() => {
              console.error(JSON.stringify({ event: "fixture_explicit_signal_abort", at_ms: Date.now() }));
              cancellation.abort();
              resolve();
            }, 250)
          )
        );
        return env.GATEWAY.fetch(
          new Request(`https://gateway.internal/${url.pathname.slice(8)}${url.search}`, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: cancellation.signal,
          })
        );
      }
      return env.GATEWAY.fetch(new Request(`https://gateway.internal/${url.pathname.slice(8)}${url.search}`, request));
    }
    if (url.pathname === "/control") return env.CONTROL.getByName("runtime-control-v1").fetch("https://control.internal/events");
    const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName("gateway-authority-v1"));
    return stub.fetch(
      new Request("https://authority.internal/v1/store", {
        method: "POST",
        headers: { "content-type": "application/json", "x-uos-authority-wire-version": "1" },
        body: request.body,
      })
    );
  },
};

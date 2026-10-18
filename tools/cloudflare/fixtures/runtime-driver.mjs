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
        timer = setTimeout(cancelled, 10_000);
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

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (["api.deepseek.com", "api.cerebras.ai"].includes(url.hostname)) return upstream(request, env, context);
    if (url.pathname.startsWith("/public/")) {
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

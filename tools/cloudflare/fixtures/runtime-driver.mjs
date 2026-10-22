// Test-only controlled upstream and private binding driver. Never deployed.
import { DurableObject } from "cloudflare:workers";
import { handleProviderMatrix } from "./provider-matrix.mjs";

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
  if (prompt.includes("fixture:cerebras:402")) {
    const headers = new Headers({
      "content-type": "application/json",
      "retry-after": "7",
      server: "cerebras-origin",
      "cf-ray": "fixture-ray",
      "x-arbitrary": "must-not-relay",
    });
    headers.append("set-cookie", "provider_secret=never");
    return new Response(
      JSON.stringify({
        error: { message: "Payment required: add credits to this account to continue now!!!!", code: "payment_required" },
        secret: "must-not-relay",
      }),
      { status: 402, headers }
    );
  }
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

function fixtureCodexAccount(request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /u, "");
  try {
    const parts = token?.split(".");
    if (!parts || parts.length !== 3 || parts[2] !== "fixture") return null;
    const parse = (part) => JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/")));
    const header = parse(parts[0]);
    const claims = parse(parts[1]);
    const auth = claims["https://api.openai.com/auth"];
    if (
      header.alg !== "none" ||
      header.typ !== "JWT" ||
      claims.iss !== "uos-runtime-matrix" ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= Date.now() / 1000 + 120
    )
      return null;
    if (
      auth?.chatgpt_user_id !== "fixture-matrix-user" ||
      auth?.chatgpt_plan_type !== "plus" ||
      !["fixture-matrix-a", "fixture-matrix-b"].includes(auth.chatgpt_account_id)
    )
      return null;
    return request.headers.get("chatgpt-account-id") === auth.chatgpt_account_id ? auth.chatgpt_account_id : null;
  } catch {
    return null;
  }
}

async function liveUpstream(request, env) {
  if (!fixtureCodexAccount(request)) return new Response(null, { status: 401 });
  const body = await request.json();
  if (
    body.sdp !== "fixture SDP offer" ||
    body.session?.unknown !== "\ud800" ||
    request.headers.get("x-session-id") !== "fixture-live-session" ||
    request.headers.get("openai-alpha") !== "quicksilver=v2"
  )
    return new Response("Unexpected live translation", { status: 400 });
  await log(env, { kind: "live_dispatch", body });
  return new Response("fixture SDP answer\u0000tail", {
    status: 201,
    statusText: "Fixture Accepted",
    headers: { "content-type": "application/sdp", location: "https://chatgpt.com/realtime/calls/rtc_fixture_live" },
  });
}

async function imageUpstream(request, env) {
  const url = new URL(request.url);
  if (!fixtureCodexAccount(request)) return new Response(null, { status: 401 });
  if (request.method === "GET" && url.pathname === "/backend-api/codex/models")
    return Response.json({ models: [{ slug: "gpt-matrix-test", supported_reasoning_levels: [{ effort: "none" }], default_reasoning_level: "none" }] });
  if (url.pathname !== "/backend-api/codex/responses") return new Response("Unexpected Codex path", { status: 400 });
  const body = await request.json();
  await log(env, { kind: "image_dispatch", body });
  const response = {
    id: "resp_fixture_image",
    object: "response",
    created_at: 1800000000,
    model: "gpt-matrix-test",
    status: "completed",
    output: [{ id: "ig_fixture", type: "image_generation_call", status: "completed", result: "aW1hZ2U=", output_format: "png" }],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  };
  return new Response(
    `data: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } })}\n\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response })}\n\n`,
    { headers: { "content-type": "text/event-stream", "x-request-id": "fixture-image-provider-id" } }
  );
}

const encoder = new TextEncoder();
const base64url = (bytes) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const base64urlJson = (value) => base64url(encoder.encode(JSON.stringify(value)));

let passportIdentityPromise = null;
const passportIdentity = async () => {
  if (!passportIdentityPromise) {
    passportIdentityPromise = (async () => {
      const pair = await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
        true,
        ["sign", "verify"]
      );
      const key = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const kid = "fixture-passport-key";
      return { pair, kid, jwk: { ...key, kid, alg: "RS256", use: "sig" } };
    })();
  }
  return passportIdentityPromise;
};
const signPassport = async (code) => {
  const identity = await passportIdentity();
  const now = Math.floor(Date.now() / 1000);
  const admin = code.startsWith("admin");
  const claims = {
    iss: "https://passport.ubq.fi",
    sub: `fixture-${code}`,
    handle: admin ? "fixture-admin" : "fixture-user",
    isAdmin: admin,
    scopes: ["ai"],
    aud: "ai",
    clientId: "ai",
    auth: "sso",
    iat: now,
    exp: now + 3600,
    jti: `fixture-${code}-${now}`,
  };
  const header = base64urlJson({ alg: "RS256", typ: "JWT", kid: identity.kid });
  const payload = base64urlJson(claims);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", identity.pair.privateKey, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(signature)}`;
};
async function passportUpstream(request) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/auth/jwks") {
    const identity = await passportIdentity();
    return Response.json({ keys: [identity.jwk] });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/sso/exchange") {
    const body = await request.json();
    if (
      body.clientId !== "ai" ||
      body.audience !== "ai" ||
      body.origin !== "https://ai.ubq.fi" ||
      body.redirectUri !== "https://ai.ubq.fi/auth/callback" ||
      typeof body.code !== "string" ||
      body.code.length === 0
    ) {
      return Response.json({ error: "invalid_code" }, { status: 400 });
    }
    const accessToken = await signPassport(body.code);
    return Response.json({ accessToken, tokenType: "Bearer", expiresAt: new Date((Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString() });
  }
  return new Response("Unexpected Passport path", { status: 404 });
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.hostname === "passport.ubq.fi") return passportUpstream(request);
    const matrix = await handleProviderMatrix(request, env, context, (event) => log(env, event));
    if (matrix) return matrix;
    if (url.hostname === "api.github.com" && url.pathname === "/repos/fixture-owner/fixture-repo") {
      if (request.headers.get("authorization") !== "Bearer ghs_fixture_kernel_access") return new Response(null, { status: 401 });
      if (request.headers.get("accept") !== "application/vnd.github+json" || request.headers.get("x-github-api-version") !== "2022-11-28")
        return new Response(null, { status: 400 });
      return Response.json({ full_name: "fixture-owner/fixture-repo" });
    }
    if (["api.deepseek.com", "api.cerebras.ai"].includes(url.hostname)) return upstream(request, env, context);
    if (["api.voyageai.com", "openrouter.ai"].includes(url.hostname)) return extrasUpstream(request, env);
    if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/realtime/calls") return liveUpstream(request, env);
    if (url.hostname === "chatgpt.com") return imageUpstream(request, env);
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

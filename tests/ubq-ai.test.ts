import { test } from "bun:test";
import assert from "node:assert/strict";
import { runUbqAi, type UbqAiRuntime } from "../scripts/ubq-ai.ts";

type RecordedRequest = Readonly<{
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyText: string | null;
}>;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const concatBytes = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
};

const decodeChunks = (chunks: Uint8Array[]): string => TEXT_DECODER.decode(concatBytes(chunks));

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const sseStream = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(TEXT_ENCODER.encode(chunk));
      controller.close();
    },
  });

const makeRuntime = (
  options: Readonly<{
    env?: Record<string, string>;
    readTextFile?: (path: string) => Promise<string>;
    fetch: (req: Request, recorded: RecordedRequest) => Promise<Response> | Response;
  }>
): {
  runtime: UbqAiRuntime;
  requests: RecordedRequest[];
  outText: () => string;
  errText: () => string;
} => {
  const requests: RecordedRequest[] = [];
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];

  const env = options.env ?? {};
  const readTextFile = options.readTextFile ?? ((_: string) => Promise.reject(new Error("readTextFile not implemented")));

  const runtime: UbqAiRuntime = {
    fetch: async (req: Request) => {
      const bodyText = req.method === "GET" || req.method === "HEAD" ? null : await req.text().catch(() => null);
      const recorded: RecordedRequest = {
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(req.headers.entries()),
        bodyText,
      };
      requests.push(recorded);
      return await options.fetch(req, recorded);
    },
    envGet: (key: string) => env[key],
    readTextFile,
    stdinIsTerminal: true,
    readStdin: () => Promise.resolve(""),
    out: (chunk: Uint8Array) => {
      outChunks.push(chunk);
      return Promise.resolve();
    },
    err: (chunk: Uint8Array) => {
      errChunks.push(chunk);
      return Promise.resolve();
    },
  };

  return {
    runtime,
    requests,
    outText: () => decodeChunks(outChunks),
    errText: () => decodeChunks(errChunks),
  };
};

test("ubq-ai: health prints JSON", async () => {
  const { runtime, outText, errText, requests } = makeRuntime({
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/health"));
      assert.equal(recorded.method, "GET");
      return jsonResponse(200, {
        status: "available",
        release: {
          git_sha: "0123456789012345678901234567890123456789",
          deployment_id: "test-deployment",
        },
      });
    },
  });

  const code = await runUbqAi(["health"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"status": "available"'));
  assert.ok(outText().includes('"release"'));
  assert.equal(requests.length, 1);
});

test("ubq-ai: info prints JSON", async () => {
  const { runtime, outText, errText, requests } = makeRuntime({
    fetch: (_req, recorded) => {
      assert.equal(new URL(recorded.url).pathname, "/");
      assert.equal(recorded.method, "GET");
      return jsonResponse(200, { ok: true, service: "ai.ubq.fi" });
    },
  });

  const code = await runUbqAi(["info"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"service": "ai.ubq.fi"'));
  assert.equal(requests.length, 1);
});

test("ubq-ai: whoami uses client token and prints JSON", async () => {
  const { runtime, outText, errText, requests } = makeRuntime({
    env: { UOS_AI_TOKEN: "ubq_ai_test_token_1234567890" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/uos/auth"));
      assert.equal(recorded.method, "GET");
      assert.equal(recorded.headers.authorization, "Bearer ubq_ai_test_token_1234567890");
      return jsonResponse(200, { ok: true, service: "ai.ubq.fi", auth: { mode: "required" } });
    },
  });

  const code = await runUbqAi(["whoami"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"service": "ai.ubq.fi"'));
  assert.equal(requests.length, 1);
});

test("ubq-ai: whoami falls back to admin token when client token missing", async () => {
  const { runtime, outText, errText, requests } = makeRuntime({
    env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/uos/auth"));
      assert.equal(recorded.method, "GET");
      assert.equal(recorded.headers.authorization, "Bearer deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz");
      return jsonResponse(200, { ok: true, service: "ai.ubq.fi", auth: { mode: "required" } });
    },
  });

  const code = await runUbqAi(["whoami"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"service": "ai.ubq.fi"'));
  assert.equal(requests.length, 1);
});

test("ubq-ai: models uses client token and prints JSON", async () => {
  const { runtime, outText, errText, requests } = makeRuntime({
    env: { UOS_AI_TOKEN: "ubq_ai_test_token_1234567890" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/v1/models"));
      assert.equal(recorded.method, "GET");
      assert.equal(recorded.headers.authorization, "Bearer ubq_ai_test_token_1234567890");
      return jsonResponse(200, { object: "list", data: [{ id: "gpt-5.2" }] });
    },
  });

  const code = await runUbqAi(["models"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"id": "gpt-5.2"'));
  assert.equal(requests.length, 1);
});

test("ubq-ai: models falls back to admin token when client token missing", async () => {
  const { runtime, outText, errText, requests } = makeRuntime({
    env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/v1/models"));
      assert.equal(recorded.method, "GET");
      assert.equal(recorded.headers.authorization, "Bearer deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz");
      return jsonResponse(200, { object: "list", data: [{ id: "gpt-5.2" }] });
    },
  });

  const code = await runUbqAi(["models"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"id": "gpt-5.2"'));
  assert.equal(requests.length, 1);
});

test("ubq-ai: -v prints debug without leaking secrets", async () => {
  const secret = "ubq_ai_test_token_super_secret_1234567890";
  const { runtime, outText, errText } = makeRuntime({
    env: { UOS_AI_TOKEN: secret },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/v1/models"));
      return jsonResponse(200, { object: "list", data: [] });
    },
  });

  const code = await runUbqAi(["-v", "models"], runtime);
  assert.equal(code, 0);
  assert.ok(outText().includes('"object": "list"'));
  assert.ok(errText().includes("env UOS_AI_TOKEN="));
  assert.equal(errText().includes(secret), false);
});

test("ubq-ai: chat --stream does not consume prompt and prints deltas", async () => {
  const { runtime, requests, outText, errText } = makeRuntime({
    env: { UOS_AI_TOKEN: "ubq_ai_test_token_1234567890" },
    fetch: (_req, recorded) => {
      if (!recorded.url.endsWith("/v1/chat/completions")) {
        return jsonResponse(404, { error: { message: "not found" } });
      }
      const body = JSON.parse(recorded.bodyText ?? "null") as Record<string, unknown>;
      assert.equal("model" in body, false);
      assert.equal(body.stream, true);
      assert.ok(Array.isArray(body.messages));
      const first = (body.messages as { role?: unknown; content?: unknown }[])[0];
      assert.equal(first.role, "system");
      const last = (body.messages as { role?: unknown; content?: unknown }[]).at(-1);
      assert.equal(last?.role, "user");
      assert.equal(last.content, "Say hello in 2 ways.");

      return new Response(
        sseStream([
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`,
          "data: [DONE]\n\n",
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  const code = await runUbqAi(["chat", "--stream", "--system", "You are a helpful assistant.", "Say hello in 2 ways."], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.equal(outText(), "Hello world\n");
  assert.equal(requests.length, 1);
  assert.match(requests[0].headers.authorization, /^Bearer /i);
});

test("ubq-ai: chat (non-stream) prints assistant content", async () => {
  const { runtime, outText, errText } = makeRuntime({
    env: { UOS_AI_TOKEN: "ubq_ai_test_token_1234567890" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/v1/chat/completions"));
      const body = JSON.parse(recorded.bodyText ?? "null") as Record<string, unknown>;
      assert.equal("model" in body, false);
      return jsonResponse(200, {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: 0,
        model: "gpt-5-fixture-default",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      });
    },
  });

  const code = await runUbqAi(["chat", "--system", "You are a helpful assistant.", "Tell me a short joke."], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.equal(outText(), "hi\n");
});

test("ubq-ai: chat passes a Codex CLI reasoning tier through", async () => {
  const { runtime, outText, errText, requests } = makeRuntime({
    env: { UOS_AI_TOKEN: "ubq_ai_test_token_1234567890" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/v1/chat/completions"));
      const body = JSON.parse(recorded.bodyText ?? "null") as Record<string, unknown>;
      assert.equal("model" in body, false);
      assert.equal(body.reasoning_effort, "ultra");
      return jsonResponse(200, {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: 0,
        model: "gpt-5-fixture-default",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    },
  });

  const code = await runUbqAi(["chat", "--reasoning-effort", "ultra", "--system", "You are a helpful assistant.", "Tell me a short joke."], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.equal(outText(), "ok\n");
  assert.equal(requests.length, 1);
});

test("ubq-ai: chat falls back to admin token when client token missing", async () => {
  const { runtime, outText, errText } = makeRuntime({
    env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/v1/chat/completions"));
      assert.equal(recorded.headers.authorization, "Bearer deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz");
      const body = JSON.parse(recorded.bodyText ?? "null") as Record<string, unknown>;
      assert.equal("model" in body, false);
      return jsonResponse(200, {
        id: "chatcmpl_test",
        object: "chat.completion",
        created: 0,
        model: "gpt-5-fixture-default",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      });
    },
  });

  const code = await runUbqAi(["chat", "--system", "You are a helpful assistant.", "Tell me a short joke."], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.equal(outText(), "hi\n");
});

test("ubq-ai: responses (non-stream) prints extracted assistant text", async () => {
  const { runtime, outText, errText } = makeRuntime({
    env: { UOS_AI_TOKEN: "ubq_ai_test_token_1234567890" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/v1/responses"));
      const body = JSON.parse(recorded.bodyText ?? "null") as Record<string, unknown>;
      assert.equal(body.instructions, "You are a helpful assistant.");
      assert.equal(body.model, "gpt-5.2");
      return jsonResponse(200, {
        id: "resp_test",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Summary." }],
          },
        ],
      });
    },
  });

  const code = await runUbqAi(["responses", "--model", "gpt-5.2", "--instructions", "You are a helpful assistant.", "Summarize this."], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.equal(outText(), "Summary.\n");
});

test("ubq-ai: responses passes a Codex CLI reasoning tier through", async () => {
  const { runtime, outText, errText, requests } = makeRuntime({
    env: { UOS_AI_TOKEN: "ubq_ai_test_token_1234567890" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/v1/responses"));
      const body = JSON.parse(recorded.bodyText ?? "null") as Record<string, unknown>;
      assert.equal("model" in body, false);
      assert.deepEqual(body.reasoning, { effort: "ultra" });
      assert.equal(body.instructions, "You are a helpful assistant.");
      return jsonResponse(200, {
        id: "resp_test",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done." }],
          },
        ],
      });
    },
  });

  const code = await runUbqAi(["responses", "--reasoning-effort", "ultra", "--instructions", "You are a helpful assistant.", "Summarize this."], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.equal(outText(), "Done.\n");
  assert.equal(requests.length, 1);
});

test("ubq-ai: responses falls back to admin token when client token missing", async () => {
  const { runtime, outText, errText } = makeRuntime({
    env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/v1/responses"));
      assert.equal(recorded.headers.authorization, "Bearer deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz");
      const body = JSON.parse(recorded.bodyText ?? "null") as Record<string, unknown>;
      assert.equal(body.instructions, "You are a helpful assistant.");
      assert.equal(body.model, "gpt-5.2");
      return jsonResponse(200, {
        id: "resp_test",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Summary." }],
          },
        ],
      });
    },
  });

  const code = await runUbqAi(["responses", "--model", "gpt-5.2", "--instructions", "You are a helpful assistant.", "Summarize this."], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.equal(outText(), "Summary.\n");
});

test("ubq-ai: admin keys list uses admin token (DENO_DEPLOY_TOKEN)", async () => {
  const { runtime, outText, errText, requests } = makeRuntime({
    env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/admin/api-keys"));
      assert.equal(recorded.method, "GET");
      assert.equal(recorded.headers.authorization, `Bearer deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz`);
      return jsonResponse(200, { object: "list", data: [] });
    },
  });

  const code = await runUbqAi(["admin", "keys", "list"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"object": "list"'));
  assert.equal(requests.length, 1);
});

test("ubq-ai: admin keys create prints token", async () => {
  const { runtime, outText, errText } = makeRuntime({
    env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/admin/api-keys"));
      assert.equal(recorded.method, "POST");
      const body = JSON.parse(recorded.bodyText ?? "null") as { name?: unknown; token?: unknown };
      assert.equal(body.name, "key for ai.ubq.fi ci");
      assert.equal(body.token, undefined);
      return jsonResponse(200, { ok: true, id: "id1", name: "key for ai.ubq.fi ci", token: "ubq_ai_token_value" });
    },
  });

  const code = await runUbqAi(["admin", "keys", "create", "key for ai.ubq.fi ci"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.equal(outText(), "ubq_ai_token_value\n");
});

test("ubq-ai: admin keys create --expires week sends expires_at_ms", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const { runtime, outText, errText } = makeRuntime({
      env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
      fetch: (_req, recorded) => {
        assert.ok(recorded.url.endsWith("/admin/api-keys"));
        assert.equal(recorded.method, "POST");
        const body = JSON.parse(recorded.bodyText ?? "null") as { name?: unknown; expires_at_ms?: unknown };
        assert.equal(body.name, "week key");
        assert.equal(body.expires_at_ms, 1_000_000 + 7 * 24 * 60 * 60 * 1000);
        return jsonResponse(200, { ok: true, token: "ubq_ai_token_value" });
      },
    });

    const code = await runUbqAi(["admin", "keys", "create", "week key", "--expires", "week"], runtime);
    assert.equal(code, 0);
    assert.equal(errText(), "");
    assert.equal(outText(), "ubq_ai_token_value\n");
  } finally {
    Date.now = originalNow;
  }
});

test("ubq-ai: admin keys create --expires forever sends -1", async () => {
  const { runtime, outText, errText } = makeRuntime({
    env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/admin/api-keys"));
      assert.equal(recorded.method, "POST");
      const body = JSON.parse(recorded.bodyText ?? "null") as { name?: unknown; expires_at_ms?: unknown };
      assert.equal(body.name, "forever key");
      assert.equal(body.expires_at_ms, -1);
      return jsonResponse(200, { ok: true, token: "ubq_ai_token_value" });
    },
  });

  const code = await runUbqAi(["admin", "keys", "create", "forever key", "--expires", "forever"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.equal(outText(), "ubq_ai_token_value\n");
});

test("ubq-ai: admin keys create errors when both expires flags are set", async () => {
  const { runtime, errText, requests } = makeRuntime({
    env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
    fetch: () => {
      throw new Error("fetch should not be called");
    },
  });

  const code = await runUbqAi(["admin", "keys", "create", "bad key", "--expires", "week", "--expires-at-ms", "123"], runtime);
  assert.equal(code, 2);
  assert.ok(errText().includes("Pass only one of --expires-at-ms or --expires"));
  assert.equal(requests.length, 0);
});

test("ubq-ai: admin keys create --json prints full JSON response", async () => {
  const { runtime, outText, errText } = makeRuntime({
    env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/admin/api-keys"));
      assert.equal(recorded.method, "POST");
      return jsonResponse(200, { ok: true, id: "id1", name: "example", token: "token_value" });
    },
  });

  const code = await runUbqAi(["--json", "admin", "keys", "create", "example"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"id": "id1"'));
  assert.ok(outText().includes('"token": "token_value"'));
});

test("ubq-ai: admin keys revoke posts id", async () => {
  const { runtime, outText, errText, requests } = makeRuntime({
    env: { DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz" },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/admin/api-keys/revoke"));
      assert.equal(recorded.method, "POST");
      assert.equal(recorded.headers.authorization, "Bearer deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz");
      const body = JSON.parse(recorded.bodyText ?? "null") as { id?: unknown };
      assert.equal(body.id, "id_123");
      return jsonResponse(200, { ok: true, id: "id_123", revoked_at_ms: 123 });
    },
  });

  const code = await runUbqAi(["admin", "keys", "revoke", "--id", "id_123"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"revoked_at_ms": 123'));
  assert.equal(requests.length, 1);
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

test("ubq-ai: admin upload-auth reads file and posts JSON", async () => {
  const authObject = { tokens: { access_token: "a", refresh_token: "r", account_id: "acct" } };
  const authJson = JSON.stringify(authObject);
  const { runtime, outText, errText, requests } = makeRuntime({
    env: {
      DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz",
      HOME: "/home/test",
      PATH: "/opt/bin",
    },
    readTextFile: (path: string) => {
      if (path === "/home/test/.codex/auth.json") return Promise.resolve(authJson);
      return Promise.reject(new Error(`unexpected path ${path}`));
    },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/admin/codex/auth"));
      assert.equal(recorded.method, "POST");
      assert.equal(recorded.headers.authorization, `Bearer deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz`);
      const parsed = JSON.parse(recorded.bodyText ?? "null") as { auth?: unknown; models?: unknown };
      assert.deepEqual(parsed.auth, authObject);
      assert.equal(isRecord(parsed.models), true);
      const models = parsed.models as Record<string, unknown>;
      assert.equal(models.source, "chatgpt_codex");
      assert.equal("models" in models, false);
      return jsonResponse(200, { ok: true });
    },
  });

  const code = await runUbqAi(["admin", "upload-auth"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"ok": true'));
  assert.equal(requests.length, 1);
});

test("ubq-ai: admin upload-auth includes codex client version hint", async () => {
  const authObject = { tokens: { access_token: "a", refresh_token: "r", account_id: "acct" } };
  const authJson = JSON.stringify(authObject);
  const { runtime, outText, errText, requests } = makeRuntime({
    env: {
      DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz",
      HOME: "/home/test",
      PATH: "/opt/lib/node_modules/@openai/codex/bin",
    },
    readTextFile: (path: string) => {
      if (path === "/home/test/.codex/auth.json") return Promise.resolve(authJson);
      if (path === "/opt/lib/node_modules/@openai/codex/package.json") {
        return Promise.resolve(JSON.stringify({ version: "0.99.0" }));
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/admin/codex/auth"));
      assert.equal(recorded.method, "POST");
      assert.equal(recorded.headers.authorization, `Bearer deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz`);
      const parsed = JSON.parse(recorded.bodyText ?? "null") as {
        auth?: unknown;
        models?: unknown;
      };
      assert.deepEqual(parsed.auth, authObject);
      assert.equal(isRecord(parsed.models), true);
      assert.equal("instructions" in parsed, false);
      const models = parsed.models as Record<string, unknown>;
      assert.equal(models.source, "chatgpt_codex");
      assert.equal(models.client_version, "0.99.0");
      assert.ok(typeof models.updated_at_ms === "number");
      assert.equal("models" in models, false);
      return jsonResponse(200, { ok: true, models: { count: 1 } });
    },
  });

  const code = await runUbqAi(["admin", "upload-auth"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"ok": true'));
  assert.equal(requests.length, 1);
});

test("ubq-ai: admin upload-auth prefers Codex model cache version over stale npm metadata", async () => {
  const authObject = { tokens: { access_token: "a", refresh_token: "r", account_id: "acct" } };
  const authJson = JSON.stringify(authObject);
  let packageMetadataRead = false;
  const { runtime, errText, requests } = makeRuntime({
    env: {
      DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz",
      HOME: "/home/test",
      PATH: "/opt/lib/node_modules/@openai/codex/bin",
    },
    readTextFile: (path: string) => {
      if (path === "/home/test/.codex/auth.json") return Promise.resolve(authJson);
      if (path === "/home/test/.codex/models_cache.json") {
        return Promise.resolve(JSON.stringify({ client_version: "0.144.3" }));
      }
      if (path === "/opt/lib/node_modules/@openai/codex/package.json") {
        packageMetadataRead = true;
        return Promise.resolve(JSON.stringify({ version: "0.135.0" }));
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    },
    fetch: (_req, recorded) => {
      const parsed = JSON.parse(recorded.bodyText ?? "null") as { models?: Record<string, unknown> };
      assert.equal(parsed.models?.client_version, "0.144.3");
      return jsonResponse(200, { stored: true, models: { count: 7 } });
    },
  });

  const code = await runUbqAi(["admin", "upload-auth"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.equal(packageMetadataRead, false);
  assert.equal(requests.length, 1);
});

test("ubq-ai: admin upload-auth falls back to local version file", async () => {
  const authObject = { tokens: { access_token: "a", refresh_token: "r", account_id: "acct" } };
  const authJson = JSON.stringify(authObject);
  const versionJson = JSON.stringify({ latest_version: "0.88.1" });
  const { runtime, outText, errText, requests } = makeRuntime({
    env: {
      DENO_DEPLOY_TOKEN: "deploy_token_1234567890_abcdefghijklmnopqrstuvwxyz",
      HOME: "/home/test",
      PATH: "/opt/bin",
    },
    readTextFile: (path: string) => {
      if (path === "/home/test/.codex/auth.json") return Promise.resolve(authJson);
      if (path === "/home/test/.codex/version.json") return Promise.resolve(versionJson);
      return Promise.reject(new Error(`unexpected path ${path}`));
    },
    fetch: (_req, recorded) => {
      assert.ok(recorded.url.endsWith("/admin/codex/auth"));
      assert.equal(recorded.method, "POST");
      const parsed = JSON.parse(recorded.bodyText ?? "null") as {
        auth?: unknown;
        models?: unknown;
      };
      assert.deepEqual(parsed.auth, authObject);
      assert.equal(isRecord(parsed.models), true);
      assert.equal("instructions" in parsed, false);
      const models = parsed.models as Record<string, unknown>;
      assert.equal(models.source, "chatgpt_codex");
      assert.equal(models.client_version, "0.88.1");
      assert.ok(typeof models.updated_at_ms === "number");
      assert.equal("models" in models, false);
      return jsonResponse(200, { ok: true, models: { count: 1 } });
    },
  });

  const code = await runUbqAi(["admin", "upload-auth"], runtime);
  assert.equal(code, 0);
  assert.equal(errText(), "");
  assert.ok(outText().includes('"ok": true'));
  assert.equal(requests.length, 1);
});

test("ubq-ai: missing admin token returns exit code 2", async () => {
  const { runtime, outText, errText } = makeRuntime({
    env: {},
    fetch: () => jsonResponse(500, { error: "fetch should not be called" }),
  });

  const code = await runUbqAi(["admin", "keys", "list"], runtime);
  assert.equal(code, 2);
  assert.equal(outText(), "");
  assert.match(errText(), /Missing admin token/);
});

test("ubq-ai: user token does not grant admin access", async () => {
  const { runtime, outText, errText } = makeRuntime({
    env: { UOS_AI_TOKEN: "client_only_token" },
    fetch: () => {
      throw new Error("fetch should not be called");
    },
  });

  const code = await runUbqAi(["admin", "keys", "list"], runtime);
  assert.equal(code, 2);
  assert.equal(outText(), "");
  assert.match(errText(), /Missing admin token/);
});

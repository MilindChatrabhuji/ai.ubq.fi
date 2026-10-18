import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { serveHttp, trackRequestTask } from "#http";
import WebSocket from "ws";

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
};

test("HTTP admin handler failures are marked no-store", async () => {
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, () => {
    throw new Error("fixture handler failure");
  });
  try {
    const address = await server.ready;
    for (const path of ["/admin/fixture-failure", "/admin.html"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      assert.equal(response.status, 500, path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      assert.equal(await response.text(), "Internal Server Error", path);
    }
  } finally {
    await server.shutdown();
  }
});

test("HTTP sends fragmented streams, preserves cookies and observes transport completion", async () => {
  const credentialNames = ["UOS_AI_TOKEN", "DENO_DEPLOY_TOKEN", "CODEX_AUTH_JSON_B64", "OPENROUTER_API_KEY", "SURPLUS_API_KEY", "METERED_API_KEY"];
  const credentialsPresent = credentialNames.some((name) => Boolean(process.env[name]));
  expect(credentialsPresent).toBe(false);
  const received = deferred<{ request: Request; peer: string; completed: Promise<void> }>();
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, (request, info) => {
    received.resolve({ request, peer: info.remoteAddr.transport === "tcp" ? info.remoteAddr.hostname : "", completed: info.completed });
    let index = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (index === 3) {
            controller.close();
            return;
          }
          await Bun.sleep(15);
          controller.enqueue(new TextEncoder().encode(`data: ${index++}\n\n`));
        },
      }),
      { headers: { "content-type": "text/event-stream", "set-cookie": "first=1; Path=/" } }
    );
  });
  try {
    const address = await server.ready;
    const response = await fetch(`http://127.0.0.1:${address.port}/fragmented`, { headers: { cookie: "fixture=1" } });
    const observation = await received.promise;
    expect(observation.peer).toBe("127.0.0.1");
    expect(observation.request.headers.get("cookie")).toBe("fixture=1");
    expect(response.headers.getSetCookie()).toEqual(["first=1; Path=/"]);
    expect(await response.text()).toBe("data: 0\n\ndata: 1\n\ndata: 2\n\n");
    await observation.completed;
  } finally {
    await server.shutdown();
  }
});

test("HTTP disconnect rejects delivery and cancels a pending response pull", async () => {
  const cancelled = deferred<undefined>();
  const receipt = deferred<{ completed: Promise<void>; signal: AbortSignal }>();
  const pending = deferred<undefined>();
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, (request, info) => {
    receipt.resolve({ completed: info.completed, signal: request.signal });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        },
        async pull() {
          await pending.promise;
        },
        cancel() {
          cancelled.resolve(undefined);
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  });
  try {
    const address = await server.ready;
    const closed = deferred<undefined>();
    const socket = connect({ host: "127.0.0.1", port: address.port });
    socket.once("connect", () => socket.write("GET /disconnect HTTP/1.1\r\nHost: localhost\r\n\r\n"));
    socket.once("data", () => socket.destroy());
    socket.once("error", () => {});
    socket.once("close", () => {
      closed.resolve(undefined);
    });
    await closed.promise;
    await cancelled.promise;
    const observation = await receipt.promise;
    await assert.rejects(observation.completed, /disconnected/);
    expect(observation.signal.aborted).toBe(true);
  } finally {
    pending.resolve(undefined);
    await server.shutdown();
  }
}, 5000);

test("HTTP retains POST bodies and strips HEAD and bodyless response bodies", async () => {
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, async (request) => {
    if (request.method === "POST") return new Response(await request.text());
    if (new URL(request.url).pathname === "/empty") return new Response(null, { status: 204 });
    const headers = new Headers({ "content-type": "text/plain", "content-length": "7" });
    headers.append("set-cookie", "one=1; Path=/");
    headers.append("set-cookie", "two=2; Path=/");
    return new Response("fixture", { headers });
  });
  try {
    const address = await server.ready;
    const origin = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(origin, { method: "POST", body: "posted body" })).text()).toBe("posted body");
    const head = await fetch(origin, { method: "HEAD" });
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe("7");
    expect(head.headers.getSetCookie()).toEqual(["one=1; Path=/", "two=2; Path=/"]);
    expect(await (await fetch(`${origin}/empty`)).text()).toBe("");
  } finally {
    await server.shutdown();
  }
});

test("HTTP gracefully drains an active stream before finished resolves", async () => {
  const release = deferred<undefined>();
  const started = deferred<undefined>();
  const server = serveHttp(
    { hostname: "127.0.0.1", port: 0 },
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            started.resolve(undefined);
            await release.promise;
            controller.enqueue(new TextEncoder().encode("last"));
            controller.close();
          },
        })
      )
  );
  try {
    const address = await server.ready;
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    await started.promise;
    let stopped = false;
    const shutdown = server.shutdown().then(() => {
      stopped = true;
    });
    await Bun.sleep(20);
    expect(stopped).toBe(false);
    release.resolve(undefined);
    expect(await response.text()).toBe("firstlast");
    await shutdown;
    expect(stopped).toBe(true);
  } finally {
    release.resolve(undefined);
    await server.shutdown();
  }
});

test("HTTP shutdown waits for delivery-triggered durable application writes", async () => {
  const writeStarted = deferred<undefined>();
  const releaseWrite = deferred<undefined>();
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, (_request, info) => {
    trackRequestTask(
      info.completed,
      info.completed.then(async () => {
        writeStarted.resolve(undefined);
        await releaseWrite.promise;
      })
    );
    return new Response("delivered");
  });
  try {
    const address = await server.ready;
    expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("delivered");
    await writeStarted.promise;
    let stopped = false;
    const shutdown = server.shutdown().then(() => {
      stopped = true;
    });
    await Bun.sleep(25);
    expect(stopped).toBe(false);
    releaseWrite.resolve(undefined);
    await shutdown;
    expect(stopped).toBe(true);
  } finally {
    releaseWrite.resolve(undefined);
    await server.shutdown();
  }
});

test("HTTP quiet streams survive Bun's native ten-second default idle timeout", async () => {
  const server = serveHttp(
    { hostname: "127.0.0.1", port: 0 },
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            await Bun.sleep(10_500);
            controller.enqueue(new TextEncoder().encode("last"));
            controller.close();
          },
        })
      )
  );
  try {
    const address = await server.ready;
    expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe("firstlast");
  } finally {
    await server.shutdown();
  }
}, 15_000);

test("WebSocket authorization refuses before upgrade and preserves real bidirectional frames", async () => {
  const accepted = deferred<undefined>();
  const server = serveHttp(
    {
      hostname: "127.0.0.1",
      port: 0,
      upgrade(request, info) {
        expect(info.remoteAddr.hostname).toBe("127.0.0.1");
        if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response("unauthorized", { status: 401 });
        return {
          maxPayloadBytes: 1024,
          accept(socket) {
            socket.on("message", (bytes) => {
              socket.send(bytes);
            });
            accepted.resolve(undefined);
          },
        };
      },
    },
    () => new Response("ordinary HTTP")
  );
  const clients: WebSocket[] = [];
  try {
    const address = await server.ready;
    const origin = `ws://127.0.0.1:${address.port}/upgrade`;
    const refusal = deferred<number>();
    const denied = new WebSocket(origin);
    clients.push(denied);
    denied.on("error", () => {});
    denied.on("unexpected-response", (_request, response) => {
      refusal.resolve(response.statusCode ?? 0);
      response.resume();
      denied.terminate();
    });
    expect(await refusal.promise).toBe(401);
    const echoed = deferred<string>();
    const client = new WebSocket(origin, { headers: { authorization: "Bearer fixture-token" } });
    clients.push(client);
    client.once("open", () => {
      client.send("fixture frame");
    });
    client.once("message", (bytes) => {
      const buffer = Array.isArray(bytes) ? Buffer.concat(bytes) : bytes;
      const value = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : buffer;
      echoed.resolve(value.toString());
    });
    client.once("error", (error) => {
      echoed.reject(error);
    });
    await accepted.promise;
    expect(await echoed.promise).toBe("fixture frame");
    const closed = deferred<number>();
    client.once("close", (code) => {
      closed.resolve(code);
    });
    await server.shutdown();
    expect(await closed.promise).toBe(1001);
  } finally {
    for (const client of clients) client.terminate();
    await server.shutdown();
  }
}, 5000);

test("WebSocket hard payload limit preserves the route's failure close contract", async () => {
  let messages = 0;
  const server = serveHttp(
    {
      hostname: "127.0.0.1",
      port: 0,
      upgrade() {
        return {
          maxPayloadBytes: 1024,
          payloadLimitClose: { code: 1011, reason: "fixture payload limit" },
          accept(socket) {
            socket.on("message", () => {
              messages++;
            });
            socket.on("error", () => {});
          },
        };
      },
    },
    () => new Response("ordinary HTTP")
  );
  let client: WebSocket | null = null;
  try {
    const address = await server.ready;
    const closed = deferred<{ code: number; reason: string }>();
    const timeout = setTimeout(() => {
      closed.reject(new Error(`Payload fixture did not close: messages=${messages}, readyState=${client?.readyState}`));
    }, 1000);
    void closed.promise
      .finally(() => {
        clearTimeout(timeout);
      })
      .catch(() => {});
    client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    client.once("open", () => client?.send(new Uint8Array(1025)));
    client.once("close", (code, reason) => {
      closed.resolve({ code, reason: reason.toString() });
    });
    client.once("error", (error) => {
      closed.reject(error);
    });
    expect(await closed.promise).toEqual({ code: 1011, reason: "fixture payload limit" });
    expect(messages).toBe(0);
  } finally {
    client?.terminate();
    await server.shutdown();
  }
}, 5000);

test("HTTP bounds producer reads when a real socket applies backpressure", async () => {
  const observed = deferred<{ completed: Promise<void> }>();
  const chunk = new Uint8Array(64 * 1024);
  let pulls = 0;
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, (_request, info) => {
    observed.resolve({ completed: info.completed });
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls === 512) controller.close();
          else {
            pulls++;
            controller.enqueue(chunk);
          }
        },
      })
    );
  });
  const address = await server.ready;
  const socket = connect({ host: "127.0.0.1", port: address.port });
  socket.on("error", () => {});
  try {
    socket.pause();
    socket.once("connect", () => socket.write("GET /slow HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
    const receipt = await observed.promise;
    let settled = false;
    void receipt.completed.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Bun.sleep(50);
    expect(pulls).toBeGreaterThan(0);
    expect(pulls).toBeLessThan(512);
    expect(settled).toBe(false);
    socket.on("data", () => {});
    socket.resume();
    await receipt.completed;
  } finally {
    socket.destroy();
    await server.shutdown();
  }
}, 5000);

test("HTTP cancelled request body sends an early 413 while the upload is unfinished", async () => {
  const observed = deferred<{ completed: Promise<void>; signal: AbortSignal }>();
  const body = JSON.stringify({ error: "payload_too_large" });
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, async (request, info) => {
    observed.resolve({ completed: info.completed, signal: request.signal });
    if (Number(request.headers.get("content-length")) > 1024) {
      await request.body?.cancel();
      return new Response(body, { status: 413, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } });
    }
    return new Response(await request.text());
  });
  const address = await server.ready;
  const socket = connect({ host: "127.0.0.1", port: address.port });
  const response = deferred<string>();
  const timer = setTimeout(() => {
    response.reject(new Error("The cancelled upload did not receive its early response"));
  }, 1500);
  let wire = "";
  socket.once("connect", () => socket.write("POST /oversize HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1025\r\nConnection: close\r\n\r\nx"));
  socket.on("data", (chunk: Buffer) => {
    wire += chunk.toString();
    if (wire.includes(body)) response.resolve(wire);
  });
  socket.once("error", (error) => {
    response.reject(error);
  });
  try {
    const received = await response.promise;
    const receipt = await observed.promise;
    expect(received.startsWith("HTTP/1.1 413")).toBe(true);
    expect(received).toContain("application/json");
    expect(received).toContain(body);
    await receipt.completed;
    expect(receipt.signal.aborted).toBe(false);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await server.shutdown();
  }
}, 4000);

test("HTTP unfinished POST disconnect interrupts input and rejects delivery", async () => {
  const observed = deferred<{ completed: Promise<void>; signal: AbortSignal }>();
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, async (request, info) => {
    observed.resolve({ completed: info.completed, signal: request.signal });
    return new Response(await request.text());
  });
  const address = await server.ready;
  const socket = connect({ host: "127.0.0.1", port: address.port });
  socket.on("error", () => {});
  socket.once("connect", () => socket.write("POST /disconnect HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1024\r\n\r\nx"));
  try {
    const receipt = await observed.promise;
    socket.destroy();
    await assert.rejects(receipt.completed);
    expect(receipt.signal.aborted).toBe(true);
  } finally {
    socket.destroy();
    await server.shutdown();
  }
}, 4000);

test("HTTP unread POST refusal completes its response and server shutdown", async () => {
  let phase = "request";
  const observed = deferred<{ completed: Promise<void>; signal: AbortSignal }>();
  const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, async (request, info) => {
    if (new URL(request.url).pathname === "/accept") return request.text().then((body) => new Response(body));
    observed.resolve({ completed: info.completed, signal: request.signal });
    await Bun.sleep(25);
    return new Response("content type refused", { status: 400 });
  });
  const address = await server.ready;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/refuse`, { method: "POST", body: "not multipart" });
    phase = "response";
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("content type refused");
    phase = "second request";
    const accepted = await fetch(`http://127.0.0.1:${address.port}/accept`, { method: "POST", body: "second request body" });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("second request body");
    const receipt = await observed.promise;
    await receipt.completed;
    phase = "shutdown";
    expect(receipt.signal.aborted).toBe(false);
    await server.shutdown();
    phase = "settled";
  } finally {
    if (phase !== "settled") console.error(`unread POST stopped at ${phase}`);
    await server.shutdown();
  }
}, 2500);

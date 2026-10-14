import { expect, test } from "bun:test";
import { connect } from "node:net";
import { serveHttp } from "#http";

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
};

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
  const cancelled = deferred<void>();
  const receipt = deferred<{ completed: Promise<void>; signal: AbortSignal }>();
  const pending = deferred<void>();
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
          cancelled.resolve();
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  });
  try {
    const address = await server.ready;
    const closed = deferred<void>();
    const socket = connect({ host: "127.0.0.1", port: address.port });
    socket.once("connect", () => socket.write("GET /disconnect HTTP/1.1\r\nHost: localhost\r\n\r\n"));
    socket.once("data", () => socket.destroy());
    socket.once("error", () => {});
    socket.once("close", () => closed.resolve());
    await closed.promise;
    await cancelled.promise;
    const observation = await receipt.promise;
    await expect(observation.completed).rejects.toThrow("disconnected");
    expect(observation.signal.aborted).toBe(true);
  } finally {
    pending.resolve();
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
  const release = deferred<void>();
  const started = deferred<void>();
  const server = serveHttp(
    { hostname: "127.0.0.1", port: 0 },
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            started.resolve();
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
    release.resolve();
    expect(await response.text()).toBe("firstlast");
    await shutdown;
    expect(stopped).toBe(true);
  } finally {
    release.resolve();
    await server.shutdown();
  }
});

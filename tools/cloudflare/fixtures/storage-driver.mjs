// Test-only binding driver. This module is never part of the deployed Worker.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/public/")) {
      return env.GATEWAY.fetch(new Request(`https://gateway.internal/${url.pathname.slice(8)}`, request));
    }
    const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName("storage-conformance"));
    return stub.fetch(
      new Request("https://authority.internal/v1/store", {
        method: "POST",
        headers: { "content-type": "application/json", "x-uos-authority-wire-version": request.headers.get("x-fixture-wire-version") ?? "1" },
        body: request.body,
      })
    );
  },
};

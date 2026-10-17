import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runAdminModels } from "../scripts/admin-models.ts";

const MISSING_TOKEN = /DENO_DEPLOY_TOKEN_UBIQUITY_DAO \(or DENO_DEPLOY_TOKEN\) is required for non-loopback admin endpoints\./;

type Call = Readonly<{ url: string; authorization: string | null }>;

const harness = (response: () => Response = () => Response.json({ ok: true, data: { models: [] } })) => {
  const calls: Call[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const run = (env: Record<string, string>, args: readonly string[] = []) =>
    runAdminModels(args, {
      env,
      fetcher: (input, init) => {
        calls.push({ url: input.href, authorization: new Headers(init.headers).get("authorization") });
        return Promise.resolve(response());
      },
      log: (message) => output.push(message),
      error: (message) => errors.push(message),
    });
  return { calls, output, errors, run };
};

test("admin:models scripts call the hostname-classifying helper instead of a shell URL prefix match", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.equal(scripts["admin:models"], "bun --no-env-file scripts/admin-models.ts");
  assert.equal(scripts["admin:models:spark"], "bun --no-env-file scripts/admin-models.ts --spark");
});

test("a non-loopback BASE_URL that merely starts like a loopback one still requires a token", async () => {
  for (const baseUrl of [
    "http://localhost.example.com",
    "http://localhost.example.com:8000",
    "http://127.0.0.1.example.com",
    "http://127.example.com",
    "https://ai.ubq.fi",
    "https://198.51.100.1:8000",
    "https://0.0.0.0:8000",
  ]) {
    for (const args of [[], ["--spark"]]) {
      const { calls, errors, run } = harness();
      assert.equal(await run({ BASE_URL: baseUrl }, args), 1, `${baseUrl} ${args.join(" ")}`);
      assert.equal(calls.length, 0, baseUrl);
      assert.match(errors.join("\n"), MISSING_TOKEN, baseUrl);
    }
  }
});

test("a loopback BASE_URL is recognized from its parsed hostname, whatever its case or IPv6 spelling", async () => {
  const cases: readonly (readonly [Record<string, string>, string])[] = [
    [{}, "http://localhost:8000/admin/codex/models"],
    [{ BASE_URL: "" }, "http://localhost:8000/admin/codex/models"],
    [{ BASE_URL: "http://LOCALHOST:8000" }, "http://localhost:8000/admin/codex/models"],
    [{ BASE_URL: "http://LocalHost:8000/" }, "http://localhost:8000/admin/codex/models"],
    [{ BASE_URL: "http://[0:0:0:0:0:0:0:1]:8000" }, "http://[::1]:8000/admin/codex/models"],
    [{ BASE_URL: "http://[::1]:8000" }, "http://[::1]:8000/admin/codex/models"],
    [{ BASE_URL: "http://127.42.9.3:8000" }, "http://127.42.9.3:8000/admin/codex/models"],
    [{ BASE_URL: "https://localhost:8443" }, "https://localhost:8443/admin/codex/models"],
  ];
  for (const [env, expectedUrl] of cases) {
    const { calls, errors, run } = harness();
    assert.equal(await run(env), 0, JSON.stringify(env));
    assert.deepEqual(errors, [], JSON.stringify(env));
    assert.deepEqual(calls, [{ url: expectedUrl, authorization: null }], JSON.stringify(env));
  }
});

test("an exported admin token is sent to the parsed endpoint, with the UBIQUITY_DAO variable preferred", async () => {
  const remote = harness();
  assert.equal(await remote.run({ BASE_URL: "https://ai.ubq.fi", DENO_DEPLOY_TOKEN: "deploy-token" }), 0);
  assert.deepEqual(remote.calls, [{ url: "https://ai.ubq.fi/admin/codex/models", authorization: "Bearer deploy-token" }]);

  const preferred = harness();
  assert.equal(await preferred.run({ BASE_URL: "http://LOCALHOST:8000", DENO_DEPLOY_TOKEN_UBIQUITY_DAO: "dao-token", DENO_DEPLOY_TOKEN: "deploy-token" }), 0);
  assert.deepEqual(preferred.calls, [{ url: "http://localhost:8000/admin/codex/models", authorization: "Bearer dao-token" }]);
});

test("invalid admin tokens fail without appearing in output", async () => {
  for (const token of ["deploy\ntoken", "deploy\u200btoken"]) {
    const { calls, errors, run } = harness();
    assert.equal(await run({ BASE_URL: "https://ai.ubq.fi", DENO_DEPLOY_TOKEN: token }), 1);
    assert.equal(calls.length, 0);
    assert.match(errors.join("\n"), /DENO_DEPLOY_TOKEN/);
    assert.equal(errors.join("\n").includes(token), false);
  }
});

test("request errors redact a valid admin token", async () => {
  const token = "deploy-token";
  const errors: string[] = [];
  const result = await runAdminModels([], {
    env: { BASE_URL: "https://ai.ubq.fi", DENO_DEPLOY_TOKEN: token },
    fetcher: async () => {
      throw new Error(`Header 'Authorization' has invalid value: 'Bearer ${token}'`);
    },
    log: () => undefined,
    error: (message) => errors.push(message),
  });
  assert.equal(result, 1);
  assert.equal(errors.join("\n").includes(token), false);
  assert.match(errors.join("\n"), /Request failed/);
});

test("loopback requests add their hostname to NO_PROXY while fetching", async () => {
  const previousNoProxy = process.env.NO_PROXY;
  const previousLowerNoProxy = process.env.no_proxy;
  process.env.NO_PROXY = "";
  process.env.no_proxy = "";
  try {
    let noProxy: string | undefined;
    const result = await runAdminModels([], {
      env: { BASE_URL: "http://LOCALHOST:8000" },
      fetcher: async () => {
        noProxy = process.env.NO_PROXY;
        return Response.json({ ok: true, data: { models: [] } });
      },
      log: () => undefined,
      error: () => undefined,
    });
    assert.equal(result, 0);
    assert.equal(noProxy, "localhost");
  } finally {
    if (previousNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy;
    if (previousLowerNoProxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = previousLowerNoProxy;
  }
});

test("admin:models prints the catalog body and :spark prints only spark slugs", async () => {
  const payload = { ok: true, data: { models: [{ slug: "gpt-6-astra" }, { slug: "gpt-6-astra-spark" }, { slug: null }, {}, { slug: "codex-spark-mini" }] } };
  const full = harness(() => Response.json(payload));
  assert.equal(await full.run({}), 0);
  assert.deepEqual(full.output, [JSON.stringify(payload)]);

  const spark = harness(() => Response.json(payload));
  assert.equal(await spark.run({}, ["--spark"]), 0);
  assert.deepEqual(spark.output, ["gpt-6-astra-spark", "codex-spark-mini"]);

  const empty = harness(() => Response.json({ ok: true, data: null }));
  assert.equal(await empty.run({}, ["--spark"]), 0);
  assert.deepEqual(empty.output, []);
});

test("an HTTP failure is reported with a non-zero exit instead of an empty spark list", async () => {
  const unauthorized = harness(() => Response.json({ error: "unauthorized" }, { status: 401 }));
  assert.equal(await unauthorized.run({ BASE_URL: "https://ai.ubq.fi", DENO_DEPLOY_TOKEN: "stale-token" }, ["--spark"]), 1);
  assert.deepEqual(unauthorized.output, []);
  assert.match(unauthorized.errors.join("\n"), /HTTP 401/);
});

test("invalid BASE_URL values and unknown arguments fail before any request", async () => {
  for (const [env, args, pattern] of [
    [{ BASE_URL: "localhost:8000" }, [], /must use http or https/],
    [{ BASE_URL: "http://" }, [], /not a valid URL/],
    [{ BASE_URL: "file:///tmp" }, [], /must use http or https/],
    [{}, ["--sparks"], /Unknown argument '--sparks'/],
  ] as const) {
    const { calls, errors, run } = harness();
    assert.equal(await run(env, args), 1, JSON.stringify(env));
    assert.equal(calls.length, 0);
    assert.match(errors.join("\n"), pattern);
  }
});

test("the script process rejects a lookalike loopback host without a token", async () => {
  for (const args of [[], ["--spark"]]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/admin-models.ts", ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { PATH: process.env.PATH ?? "", BASE_URL: "http://localhost.example.com" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 1, args.join(" "));
    assert.equal(stdout, "");
    assert.match(stderr, MISSING_TOKEN);
  }
});

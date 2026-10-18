import { createHash } from "node:crypto";
import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseWorkflow } from "@std/yaml";

import {
  checkRuntimeAgainstPin,
  extractRequestSurfaces,
  pinnedSpecSource,
  readOpenAiSpecPin,
  runSpecDriftCheck,
  verifySpecAgainstPin,
  type OpenAiSpecPin,
} from "../scripts/check-openai-spec-drift.ts";
import { CHAT_COMPLETIONS_REQUEST_KEYS, RESPONSES_REQUEST_KEYS } from "../src/openai-schema.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const sorted = (values: Iterable<string>): string[] => Array.from(values).sort((left, right) => left.localeCompare(right));

// A minimal official-shaped document: CreateResponse reaches its keys through allOf and $ref, as the real one does.
const SYNTHETIC_SPEC = `openapi: 3.1.0
components:
  schemas:
    CreateChatCompletionRequest:
      allOf:
        - $ref: "#/components/schemas/CreateModelResponseProperties"
        - type: object
          properties:
            messages: { type: array }
            model: { type: string }
    CreateModelResponseProperties:
      allOf:
        - $ref: "#/components/schemas/ModelResponseProperties"
    ModelResponseProperties:
      properties:
        temperature: { type: number }
    CreateResponse:
      allOf:
        - $ref: "#/components/schemas/CreateModelResponseProperties"
        - properties:
            input: { type: string }
`;
const SYNTHETIC_SURFACES = {
  CreateChatCompletionRequest: ["messages", "model", "temperature"],
  CreateResponse: ["input", "temperature"],
};
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const syntheticPin = (overrides: Partial<OpenAiSpecPin> = {}): OpenAiSpecPin => ({
  repository: "openai/openai-openapi",
  commit: COMMIT,
  path: "openapi.yaml",
  source: pinnedSpecSource(COMMIT),
  sha256: sha256(SYNTHETIC_SPEC),
  surfaces: SYNTHETIC_SURFACES,
  ...overrides,
});

const REPOSITORY_API = "https://api.github.com/repos/openai/openai-openapi";
const officialHistory = (status = "ahead", requests: string[] = [], branch = "main") => {
  return (location: string): Promise<unknown> => {
    requests.push(location);
    if (location === REPOSITORY_API) return Promise.resolve({ default_branch: branch });
    assert.match(location, new RegExp(`^${REPOSITORY_API}/compare/[0-9a-f]{40}\\.\\.\\.${encodeURIComponent(branch)}$`));
    return Promise.resolve({ status });
  };
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const forbidNetwork = (): void => {
  globalThis.fetch = Object.assign((): Promise<Response> => Promise.reject(new Error("the offline drift gate must not use the network")), {
    preconnect: originalFetch.preconnect,
  });
};

test("the pin names one immutable official revision, its digest, and both request surfaces", async () => {
  const pin = await readOpenAiSpecPin();
  assert.equal(pin.repository, "openai/openai-openapi");
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pin.path, "openapi.yaml");
  assert.equal(pin.source, `https://raw.githubusercontent.com/openai/openai-openapi/${pin.commit}/openapi.yaml`);
  assert.deepEqual(sorted(Object.keys(pin.surfaces)), ["CreateChatCompletionRequest", "CreateResponse"]);
});

test("the runtime request allowlists equal the pinned official surfaces", async () => {
  const pin = await readOpenAiSpecPin();
  assert.deepEqual(checkRuntimeAgainstPin(pin), []);
  assert.deepEqual(sorted(pin.surfaces.CreateChatCompletionRequest), sorted(CHAT_COMPLETIONS_REQUEST_KEYS));
  assert.deepEqual(sorted(pin.surfaces.CreateResponse), sorted(RESPONSES_REQUEST_KEYS));
});

test("a runtime allowlist that differs from the pin is reported in both directions", async () => {
  const pin = await readOpenAiSpecPin();
  const drifted: OpenAiSpecPin = {
    ...pin,
    surfaces: {
      ...pin.surfaces,
      CreateResponse: [...pin.surfaces.CreateResponse.filter((key) => key !== "truncation"), "access_programs"],
    },
  };
  const failures = checkRuntimeAgainstPin(drifted).join("\n");
  assert.match(failures, /responses\.create: request-key drift against CreateResponse/);
  assert.match(failures, /missing locally: access_programs/);
  assert.match(failures, /extra locally: truncation/);
  assert.doesNotMatch(failures, /chat\.completions\.create/);
});

test("surface extraction follows $ref and allOf like the official document", () => {
  assert.deepEqual(extractRequestSurfaces(SYNTHETIC_SPEC), SYNTHETIC_SURFACES);
  assert.throws(() => extractRequestSurfaces("openapi: 3.1.0\ncomponents: {}\n"), /components\.schemas/);
});

test("a specification is accepted only when its digest and surfaces match the pin", () => {
  assert.deepEqual(verifySpecAgainstPin(syntheticPin(), SYNTHETIC_SPEC), []);

  const edited = SYNTHETIC_SPEC.replace("input: { type: string }", "input: { type: string }\n            access_programs: { type: array }");
  const digestFailures = verifySpecAgainstPin(syntheticPin(), edited).join("\n");
  assert.match(digestFailures, /digest mismatch/);
  assert.match(digestFailures, new RegExp(sha256(edited)));

  const misrecorded = syntheticPin({ surfaces: { ...SYNTHETIC_SURFACES, CreateResponse: ["input"] } });
  assert.match(verifySpecAgainstPin(misrecorded, SYNTHETIC_SPEC).join("\n"), /CreateResponse: pinned surface differs .*temperature/);
});

test("the default gate is offline and deterministic", async () => {
  forbidNetwork();
  const lines: string[] = [];
  const exitCode = await runSpecDriftCheck([], { log: (line) => lines.push(line), error: (line) => lines.push(line) });
  assert.equal(exitCode, 0, lines.join("\n"));
  assert.match(lines.join("\n"), /chat\.completions\.create: aligned/);
  assert.match(lines.join("\n"), /responses\.create: aligned/);
});

test("verifying a copy of the specification refuses one that is not the pinned revision", async () => {
  forbidNetwork();
  const errors: string[] = [];
  const read: string[] = [];
  const exitCode = await runSpecDriftCheck(["--spec", "copy.yaml"], {
    readSpec: (location) => {
      read.push(location);
      return Promise.resolve(SYNTHETIC_SPEC);
    },
    log: () => undefined,
    error: (line) => errors.push(line),
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(read, ["copy.yaml"]);
  assert.match(errors.join("\n"), /digest mismatch/);
});

test("re-pinning records the new revision and then gates the runtime against it", async () => {
  forbidNetwork();
  let written: OpenAiSpecPin | null = null;
  const read: string[] = [];
  const errors: string[] = [];
  const historyRequests: string[] = [];
  const exitCode = await runSpecDriftCheck(["--repin", COMMIT], {
    readGitHub: officialHistory("ahead", historyRequests, "official/spec"),
    readSpec: (location) => {
      read.push(location);
      return Promise.resolve(SYNTHETIC_SPEC);
    },
    writePin: (pin) => {
      written = pin;
      return Promise.resolve();
    },
    log: () => undefined,
    error: (line) => errors.push(line),
  });
  assert.deepEqual(read, [pinnedSpecSource(COMMIT)]);
  assert.deepEqual(written, syntheticPin());
  assert.deepEqual(historyRequests, [REPOSITORY_API, `${REPOSITORY_API}/compare/${COMMIT}...official%2Fspec`]);
  // The synthetic surfaces differ from the runtime allowlists, so the gate reports drift after re-pinning.
  assert.equal(exitCode, 1);
  assert.match(errors.join("\n"), /extra locally: /);
  assert.equal(await runSpecDriftCheck(["--repin", "not-a-commit"], { log: () => undefined, error: () => undefined }), 2);
});

const quiet = { log: () => undefined, error: () => undefined };
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

const CI_TOKEN = "fixture-only-github-token";
const runtimeSpec = JSON.stringify({
  openapi: "3.1.0",
  components: {
    schemas: {
      CreateChatCompletionRequest: { properties: Object.fromEntries(CHAT_COMPLETIONS_REQUEST_KEYS.map((key) => [key, {}])) },
      CreateResponse: { properties: Object.fromEntries(RESPONSES_REQUEST_KEYS.map((key) => [key, {}])) },
    },
  },
});

test("CI spec verification confines its bearer to official API requests and verifies the full source", async () => {
  const requests: string[] = [];
  let written: OpenAiSpecPin | undefined;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      requests.push(url);
      const authorization = new Headers(init?.headers).get("authorization");
      if (url === REPOSITORY_API || url === `${REPOSITORY_API}/compare/${COMMIT}...main`) {
        assert.equal(authorization, `Bearer ${CI_TOKEN}`, "official API requests require the step-scoped token");
        assert.equal(init?.redirect, "error", "authenticated API requests must refuse redirects");
        assert.ok(init.signal instanceof AbortSignal);
        return Promise.resolve(Response.json(url === REPOSITORY_API ? { default_branch: "main" } : { status: "ahead" }));
      }
      assert.equal(url, pinnedSpecSource(COMMIT));
      assert.equal(authorization, null, "raw source must never receive the CI token");
      return Promise.resolve(new Response(runtimeSpec));
    },
    { preconnect: originalFetch.preconnect }
  );
  const dependencies = {
    ...quiet,
    githubToken: CI_TOKEN,
    sleep: () => Promise.resolve(),
    writePin: (pin: OpenAiSpecPin) => {
      written = pin;
      return Promise.resolve();
    },
  };
  assert.equal(await runSpecDriftCheck(["--repin", COMMIT], dependencies), 0);
  assert.deepEqual(requests, [REPOSITORY_API, `${REPOSITORY_API}/compare/${COMMIT}...main`, pinnedSpecSource(COMMIT)]);
  assert.equal(written?.sha256, sha256(runtimeSpec));
  assert.deepEqual(written.surfaces.CreateResponse, sorted(RESPONSES_REQUEST_KEYS));
});

type DriftWorkflow = {
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, { env?: Record<string, string>; permissions?: Record<string, string>; steps: { run?: string; env?: Record<string, string> }[] }>;
};

test("CI GitHub token belongs only to the source-verification step", async () => {
  const source = await Bun.file(new URL("../.github/workflows/deno-deploy.yml", import.meta.url)).text();
  const workflow = parseWorkflow(source) as DriftWorkflow;
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.validate.permissions, undefined);
  const driftCommand = "bun --no-env-file --no-install run spec:drift --verify-source";
  let driftSteps = 0;
  for (const environment of [workflow.env, ...Object.values(workflow.jobs).map((job) => job.env)]) {
    assert.equal(environment?.GITHUB_TOKEN, undefined);
    assert.equal(environment?.GH_TOKEN, undefined);
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.run === driftCommand) {
        driftSteps++;
        assert.deepEqual(step.env, { GITHUB_TOKEN: "${{ github.token }}" });
      } else {
        assert.equal(step.env?.GITHUB_TOKEN, undefined);
        assert.equal(step.env?.GH_TOKEN, undefined);
      }
    }
  }
  assert.equal(driftSteps, 1);
  assert.equal(source.match(/github\.token/g)?.length, 1);
});

test("CI GitHub tokens and dotenv credentials stay out of actual application test children", async () => {
  const root = resolve(".cleanup-evidence");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "spec-token-"));
  try {
    const file = join(directory, "credential.test.ts");
    writeFileSync(join(directory, ".env"), "DOTENV_TOKEN_PROBE=fixture-only\n");
    writeFileSync(
      file,
      'import { test } from "bun:test"; import assert from "node:assert/strict"; test("scrubbed token child", () => { for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "DOTENV_TOKEN_PROBE"]) assert.equal(process.env[name], undefined, name); });\n'
    );
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "scripts/test-runner.ts", "files", file, "--portable"], {
      env: { PATH: process.env.PATH ?? "", TEST_SCOPE_FORCE: "1", GITHUB_TOKEN: CI_TOKEN, GH_TOKEN: "fixture-only-other-token" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout + stderr, /test:files: 1 files, 0 failures/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a CI token is never attached to custom specification URLs, including GitHub-looking hosts", async () => {
  const locations = [pinnedSpecSource(COMMIT), REPOSITORY_API, "https://api.github.com.evil.invalid/spec.yaml", "https://example.invalid/spec.yaml"];
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(requestUrl(input));
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      return Promise.resolve(new Response(SYNTHETIC_SPEC));
    },
    { preconnect: originalFetch.preconnect }
  );
  const dependencies = { ...quiet, githubToken: CI_TOKEN };
  for (const location of locations) assert.equal(await runSpecDriftCheck(["--spec", location], dependencies), 1, "the source digest must still be verified");
  assert.deepEqual(requests, locations);
});

test("local official-source verification stays unauthenticated without a CI token", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests++;
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      const url = requestUrl(input);
      if (url === REPOSITORY_API) return Promise.resolve(Response.json({ default_branch: "main" }));
      if (url.includes("/compare/")) return Promise.resolve(Response.json({ status: "identical" }));
      return Promise.resolve(new Response(runtimeSpec));
    },
    { preconnect: originalFetch.preconnect }
  );
  assert.equal(await runSpecDriftCheck(["--repin", COMMIT], { ...quiet, writePin: () => Promise.resolve() }), 0);
  assert.equal(requests, 3);
});

test("authenticated ancestry refuses redirects without following them or exposing its token", async () => {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(requestUrl(input));
      assert.equal(init?.redirect, "error");
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://example.invalid/stolen" } }));
    },
    { preconnect: originalFetch.preconnect }
  );
  const dependencies = { ...quiet, githubToken: CI_TOKEN };
  await assert.rejects(runSpecDriftCheck(["--verify-source"], dependencies), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /302/);
    assert.equal(error.message.includes(CI_TOKEN), false);
    return true;
  });
  assert.deepEqual(requests, [REPOSITORY_API]);
});

test("malformed CI tokens are refused before transport without revealing their value", async () => {
  forbidNetwork();
  const dependencies = { ...quiet, githubToken: CI_TOKEN + "\n" };
  await assert.rejects(runSpecDriftCheck(["--verify-source"], dependencies), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Invalid GitHub API token");
    assert.equal(error.message.includes(CI_TOKEN), false);
    return true;
  });
});

test("CI verifies the pin against its commit-addressed official source, not only against the repository copy", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/deno-deploy.yml", import.meta.url)).text();
  const driftRuns = workflow
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("run:") && line.includes("spec:drift"))
    .map((line) => line.slice("run:".length).trim());
  assert.deepEqual(driftRuns, ["bun --no-env-file --no-install run spec:drift --verify-source"]);
});

test("fetching the pinned source retries a transient failure, then verifies what it received", async () => {
  const attempts: string[] = [];
  const delays: number[] = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL): Promise<Response> => {
      attempts.push(requestUrl(input));
      if (attempts.length === 1) return Promise.reject(new TypeError("fetch failed: connection reset"));
      if (attempts.length === 2) return Promise.resolve(new Response("busy", { status: 503, statusText: "Service Unavailable" }));
      return Promise.resolve(new Response(SYNTHETIC_SPEC, { status: 200 }));
    },
    { preconnect: originalFetch.preconnect }
  );
  const errors: string[] = [];
  const exitCode = await runSpecDriftCheck(["--verify-source"], {
    readGitHub: officialHistory(),
    sleep: (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
    log: () => undefined,
    error: (line) => errors.push(line),
  });
  const pin = await readOpenAiSpecPin();
  assert.deepEqual(attempts, [pin.source, pin.source, pin.source]);
  assert.equal(delays.length, 2);
  // The synthetic document is not the pinned revision, so the third, successful fetch is refused on its digest.
  assert.equal(exitCode, 1);
  assert.match(errors.join("\n"), /digest mismatch/);
});

test("fetching the pinned source gives up after bounded attempts and does not retry a permanent refusal", async () => {
  let attempts = 0;
  globalThis.fetch = Object.assign(
    (): Promise<Response> => {
      attempts += 1;
      return Promise.reject(new TypeError("fetch failed: network unreachable"));
    },
    { preconnect: originalFetch.preconnect }
  );
  const sleep = (): Promise<void> => Promise.resolve();
  await assert.rejects(runSpecDriftCheck(["--verify-source"], { ...quiet, sleep, readGitHub: officialHistory() }), /network unreachable/);
  assert.equal(attempts, 3);

  attempts = 0;
  globalThis.fetch = Object.assign(
    (): Promise<Response> => {
      attempts += 1;
      return Promise.resolve(new Response("missing", { status: 404, statusText: "Not Found" }));
    },
    { preconnect: originalFetch.preconnect }
  );
  await assert.rejects(runSpecDriftCheck(["--verify-source"], { ...quiet, sleep, readGitHub: officialHistory() }), /404 Not Found/);
  assert.equal(attempts, 1);
});

test("repin and verify-source refuse fork-only, newer or malformed ancestry before reading or writing a spec", async () => {
  forbidNetwork();
  for (const args of [["--repin", COMMIT], ["--verify-source"]]) {
    for (const status of ["diverged", "behind", "unknown", "", undefined]) {
      let sourceReads = 0;
      let writes = 0;
      await assert.rejects(
        runSpecDriftCheck(args, {
          ...quiet,
          readGitHub: (location) => Promise.resolve(location === REPOSITORY_API ? { default_branch: "main" } : { status }),
          readSpec: () => {
            sourceReads += 1;
            return Promise.resolve(SYNTHETIC_SPEC);
          },
          writePin: () => {
            writes += 1;
            return Promise.resolve();
          },
        }),
        /not contained in openai\/openai-openapi's default branch/
      );
      assert.equal(sourceReads, 0, `${args[0]} must refuse ${String(status)} before fetching fork-network bytes`);
      assert.equal(writes, 0, "a rejected ancestry check must never rewrite the pin");
    }
  }
});

test("repin accepts a commit identical to the official default branch and fails closed on unavailable metadata", async () => {
  forbidNetwork();
  let writes = 0;
  const exitCode = await runSpecDriftCheck(["--repin", COMMIT], {
    ...quiet,
    readGitHub: officialHistory("identical"),
    readSpec: () => Promise.resolve(SYNTHETIC_SPEC),
    writePin: () => {
      writes += 1;
      return Promise.resolve();
    },
  });
  assert.equal(writes, 1);
  assert.equal(exitCode, 1, "the synthetic source still differs from the runtime surface");
  for (const metadata of [null, {}, { default_branch: "" }, { default_branch: 42 }]) {
    await assert.rejects(runSpecDriftCheck(["--repin", COMMIT], { ...quiet, readGitHub: () => Promise.resolve(metadata) }), /official default branch/);
  }
  await assert.rejects(
    runSpecDriftCheck(["--repin", COMMIT], { ...quiet, readGitHub: () => Promise.reject(new Error("GitHub metadata unavailable")) }),
    /GitHub metadata unavailable/
  );
});

test("official ancestry requests use bounded retries and never repin after a permanent API refusal", async () => {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      requests.push(url);
      if (requests.length === 1) return Promise.resolve(new Response("busy", { status: 503 }));
      if (url === REPOSITORY_API) return Promise.resolve(Response.json({ default_branch: "main" }));
      return Promise.resolve(new Response("missing", { status: 404 }));
    },
    { preconnect: originalFetch.preconnect }
  );
  const delays: number[] = [];
  let writes = 0;
  await assert.rejects(
    runSpecDriftCheck(["--repin", COMMIT], {
      ...quiet,
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
      writePin: () => {
        writes += 1;
        return Promise.resolve();
      },
    }),
    /404/
  );
  assert.deepEqual(requests, [REPOSITORY_API, REPOSITORY_API, `${REPOSITORY_API}/compare/${COMMIT}...main`]);
  assert.deepEqual(delays, [5000]);
  assert.equal(writes, 0);
});

test("a malformed invocation is a usage error, never a silent fall back to the offline gate", async () => {
  forbidNetwork();
  const invocations: readonly (readonly string[])[] = [
    ["verify-source"],
    ["--spec"],
    ["--spec="],
    ["--spec", "--verify-source"],
    ["--repin"],
    ["--verify-source=yes"],
    ["--verify-source", "--verify-source"],
    ["--spec", "a.yaml", "--spec", "b.yaml"],
    ["--spec", "copy.yaml", "--verify-source"],
    ["--unknown"],
  ];
  for (const args of invocations) {
    const errors: string[] = [];
    const read: string[] = [];
    const exitCode = await runSpecDriftCheck(args, {
      readSpec: (location) => {
        read.push(location);
        return Promise.resolve(SYNTHETIC_SPEC);
      },
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    assert.equal(exitCode, 2, `${JSON.stringify(args)} must be a usage error`);
    assert.ok(errors.length > 0, `${JSON.stringify(args)} must say what is wrong`);
    assert.deepEqual(read, [], `${JSON.stringify(args)} must not read a specification`);
  }
});

test("re-pinning reads only the commit's own source, so a local file cannot be recorded under the official URL", async () => {
  forbidNetwork();
  let written: OpenAiSpecPin | null = null;
  const read: string[] = [];
  const errors: string[] = [];
  const exitCode = await runSpecDriftCheck(["--repin", COMMIT, "--spec", "local-edit.yaml"], {
    readSpec: (location) => {
      read.push(location);
      return Promise.resolve(SYNTHETIC_SPEC);
    },
    writePin: (pin) => {
      written = pin;
      return Promise.resolve();
    },
    log: () => undefined,
    error: (line) => errors.push(line),
  });
  assert.equal(exitCode, 2);
  assert.deepEqual(read, []);
  assert.equal(written, null);
  assert.match(errors.join("\n"), /--repin/);
});

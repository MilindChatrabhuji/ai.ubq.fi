import { createHash } from "node:crypto";
import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";

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
  const exitCode = await runSpecDriftCheck(["--repin", COMMIT], {
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
  await assert.rejects(runSpecDriftCheck(["--verify-source"], { ...quiet, sleep }), /network unreachable/);
  assert.equal(attempts, 3);

  attempts = 0;
  globalThis.fetch = Object.assign(
    (): Promise<Response> => {
      attempts += 1;
      return Promise.resolve(new Response("missing", { status: 404, statusText: "Not Found" }));
    },
    { preconnect: originalFetch.preconnect }
  );
  await assert.rejects(runSpecDriftCheck(["--verify-source"], { ...quiet, sleep }), /404 Not Found/);
  assert.equal(attempts, 1);
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

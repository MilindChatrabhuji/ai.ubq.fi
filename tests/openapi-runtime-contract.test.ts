import { readdirSync, readFileSync } from "node:fs";
import { test } from "bun:test";
import assert from "node:assert/strict";

import { UOS_EMBEDDINGS_JOB_ALLOWED_KEYS, UOS_SYNC_EMBEDDINGS_ALLOWED_KEYS } from "../src/embeddings/ledger.ts";
import handler from "../src/handler/index.ts";
import { setKvForTest } from "../src/kv.ts";
import { resetOpenRouterModelsCacheForTest } from "../src/models/openrouter-models.ts";
import { CODEX_RESPONSES_EXTENSION_KEYS, DEEPSEEK_CHAT_EXTENSION_KEYS } from "../src/openai.ts";
import { CHAT_COMPLETIONS_REQUEST_KEYS, RESPONSES_REQUEST_KEYS } from "../src/openai-schema.ts";
import { resetMeteredModelsCacheForTest } from "../src/provider/metered.ts";
import { OPENROUTER_CLAUDE_REQUEST_EXTENSION_KEYS } from "../src/provider/openrouter-request-controls.ts";
import { resetSurplusModelsCacheForTest } from "../src/provider/surplus.ts";
import { validateResponsesRequestFields } from "../src/responses-request.ts";
import type { ResponsesRequest } from "../src/types.ts";

// The published contract is checked against the runtime source it describes: the request allowlists and extension
// sets the validators read, the routes the handler dispatches, and the endpoint list in the agent contract.

type SchemaProperty = Readonly<{ description?: string; "x-uos-extension"?: string }>;
type ObjectSchema = Readonly<{
  description?: string;
  properties: Record<string, SchemaProperty>;
  required?: readonly string[];
  additionalProperties?: unknown;
  "x-uos-official-schema"?: string;
}>;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
type ParameterRef = Readonly<{ $ref?: string; name?: string; in?: string; required?: boolean }>;
type Operation = Readonly<{ operationId?: string; description?: string; security?: readonly unknown[]; parameters?: readonly ParameterRef[] }>;
type OpenApiDocument = Readonly<{
  paths: Record<string, Partial<Record<HttpMethod, Operation>>>;
  components: Readonly<{ schemas: Record<string, ObjectSchema>; parameters: Record<string, ParameterRef> }>;
}>;

const document = JSON.parse(readFileSync(new URL("../static/openapi.json", import.meta.url), "utf8")) as OpenApiDocument;
const agentContract = readFileSync(new URL("../static/docs/llms-agents.md", import.meta.url), "utf8");
// The modules that dispatch UOS routes today. Every other module under src/ is scanned as well, so a route dispatched
// from a new module is still compared with the published contract.
const ROUTER_SOURCES = ["handler/index.ts", "handler/terminal-route.ts"] as const;
const SOURCE_ROOT = new URL("../src/", import.meta.url);
const SOURCE_FILES: readonly string[] = (readdirSync(SOURCE_ROOT, { recursive: true }) as string[])
  .filter((file) => file.endsWith(".ts"))
  .sort((left, right) => left.localeCompare(right));
const sourceText = (file: string): string => readFileSync(new URL(file, SOURCE_ROOT), "utf8");

const sorted = (values: Iterable<string>): string[] => Array.from(values).sort((left, right) => left.localeCompare(right));
const schemaNamed = (name: string): ObjectSchema => {
  if (!Object.hasOwn(document.components.schemas, name)) throw new Error(`OpenAPI schema ${name} is missing`);
  return document.components.schemas[name];
};
const officialProperties = (schema: ObjectSchema): string[] =>
  sorted(Object.keys(schema.properties).filter((name) => schema.properties[name]["x-uos-extension"] === undefined));
const extensionProperties = (schema: ObjectSchema): Record<string, string> => {
  const extensions: Record<string, string> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const kind = property["x-uos-extension"];
    if (kind !== undefined) extensions[name] = kind;
  }
  return extensions;
};
const extensionsFrom = (...groups: readonly (readonly [ReadonlySet<string>, string])[]): Record<string, string> => {
  const extensions: Record<string, string> = {};
  for (const [keys, kind] of groups) for (const key of keys) extensions[key] = kind;
  return extensions;
};

const REQUEST_CONTRACTS = [
  {
    schema: "ChatCompletionRequest",
    official: "CreateChatCompletionRequest",
    allowlist: CHAT_COMPLETIONS_REQUEST_KEYS,
    extensions: extensionsFrom([DEEPSEEK_CHAT_EXTENSION_KEYS, "deepseek"], [OPENROUTER_CLAUDE_REQUEST_EXTENSION_KEYS, "openrouter-claude"]),
  },
  {
    schema: "ResponseRequest",
    official: "CreateResponse",
    allowlist: RESPONSES_REQUEST_KEYS,
    extensions: extensionsFrom([CODEX_RESPONSES_EXTENSION_KEYS, "codex-cli"], [OPENROUTER_CLAUDE_REQUEST_EXTENSION_KEYS, "openrouter-claude"]),
  },
] as const;

test("published Chat and Responses request properties are exactly the runtime allowlists plus named extensions", () => {
  for (const contract of REQUEST_CONTRACTS) {
    const schema = schemaNamed(contract.schema);
    assert.equal(schema.additionalProperties, false, `${contract.schema} must not claim that arbitrary properties are accepted`);
    assert.equal(schema["x-uos-official-schema"], contract.official, `${contract.schema} must name the official schema its allowlist follows`);
    assert.deepEqual(officialProperties(schema), sorted(contract.allowlist), `${contract.schema} official properties must equal the runtime allowlist`);
    assert.deepEqual(extensionProperties(schema), contract.extensions, `${contract.schema} must mark exactly the runtime extensions`);
    for (const name of Object.keys(contract.extensions)) {
      assert.match(schema.properties[name].description ?? "", /not an official OpenAI field/, `${contract.schema}.${name} must be labeled as an extension`);
    }
    assert.doesNotMatch(schema.description ?? "", /Additional documented OpenAI fields may be accepted/);
  }
  // Codex CLI fields are Responses-only; the Chat contract must not inherit them.
  for (const key of CODEX_RESPONSES_EXTENSION_KEYS) assert.equal(schemaNamed("ChatCompletionRequest").properties[key], undefined);
});

test("the Responses validator accepts every published property and rejects an unpublished one", () => {
  const schema = schemaNamed("ResponseRequest");
  // The OpenRouter Claude extension is admitted only for an enabled OpenRouter Claude model, so it is checked by the
  // contract test above rather than offered to the unconditional validator here.
  const record: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    if (property["x-uos-extension"] !== "openrouter-claude") record[name] = undefined;
  }
  // The few fields validated on presence take their simplest valid value.
  Object.assign(record, { prompt_cache_key: "contract", prompt_cache_options: {}, prompt_cache_retention: "in_memory", client_metadata: {} });
  assert.equal(validateResponsesRequestFields(record, record as ResponsesRequest), null);

  const unpublished = { ...record, contract_probe_unpublished: true };
  const rejected = validateResponsesRequestFields(unpublished, unpublished as ResponsesRequest);
  assert.equal(rejected?.status, 400);
});

test("published UOS embeddings request properties are exactly the runtime allowlists", () => {
  for (const [name, allowlist] of [
    ["EmbeddingsRequest", UOS_SYNC_EMBEDDINGS_ALLOWED_KEYS],
    ["EmbeddingJobRequest", UOS_EMBEDDINGS_JOB_ALLOWED_KEYS],
  ] as const) {
    const schema = schemaNamed(name);
    assert.equal(schema.additionalProperties, false, `${name} must reject undocumented properties`);
    assert.deepEqual(sorted(Object.keys(schema.properties)), sorted(allowlist), `${name} must equal the runtime allowlist`);
  }
  assert.deepEqual(sorted(schemaNamed("EmbeddingJobRequest").required ?? []), ["input", "input_type", "model"]);
  assert.deepEqual(sorted(schemaNamed("EmbeddingsRequest").required ?? []), ["input", "model"]);
});

/** "METHOD /path" for every UOS operation one source file dispatches, with a prefix route as `{id}`. */
const dispatchedUosOperations = (text: string): string[] => {
  const operations = new Set<string>();
  for (const match of text.matchAll(/req\.method === "([A-Z]+)" && path === "(\/uos\/[^"]+)"/g)) operations.add(`${match[1]} ${match[2]}`);
  for (const match of text.matchAll(/path === "(\/uos\/[^"]+)" && req\.method === "([A-Z]+)"/g)) operations.add(`${match[2]} ${match[1]}`);
  for (const match of text.matchAll(/req\.method === "([A-Z]+)" && path\.startsWith\("(\/uos\/[^"]+\/)"\)/g)) operations.add(`${match[1]} ${match[2]}{id}`);
  return sorted(operations);
};

/** Every UOS operation dispatched anywhere under src/. */
const runtimeUosOperations = (): string[] => {
  const operations = new Set<string>();
  for (const file of SOURCE_FILES) for (const operation of dispatchedUosOperations(sourceText(file))) operations.add(operation);
  for (const file of ROUTER_SOURCES) {
    assert.ok(dispatchedUosOperations(sourceText(file)).length > 0, `src/${file} must still dispatch UOS routes in a form this contract test can read`);
  }
  return sorted(operations);
};

type PublishedOperation = Readonly<{ method: HttpMethod; path: string; operation: Operation }>;
const PUBLISHED_OPERATIONS: readonly PublishedOperation[] = Object.entries(document.paths).flatMap(([path, item]) =>
  HTTP_METHODS.flatMap((method) => {
    const operation = item[method];
    return operation ? [{ method, path, operation }] : [];
  })
);
const publishedUosOperations = (): string[] =>
  sorted(PUBLISHED_OPERATIONS.filter(({ path }) => path.startsWith("/uos/")).map(({ method, path }) => `${method.toUpperCase()} ${path}`));

const agentContractUosOperations = (): string[] => {
  const section = /UOS gateway endpoints:\n\n((?:- `[^`\n]+`[^\n]*\n)+)/.exec(agentContract)?.[1];
  if (!section) throw new Error("The agent contract must list its UOS gateway endpoints");
  return sorted(Array.from(section.matchAll(/- `([A-Z]+ \/uos\/[^`]+)`/g), (match) => match[1]));
};

test("OpenAPI publishes exactly the UOS routes the runtime dispatches and the agent contract lists", () => {
  const runtime = runtimeUosOperations();
  assert.deepEqual(publishedUosOperations(), runtime, "OpenAPI UOS operations must equal the runtime router");
  assert.deepEqual(agentContractUosOperations(), runtime, "the agent contract's UOS endpoint list must equal the runtime router");
  for (const { method, path, operation } of PUBLISHED_OPERATIONS) {
    if (!path.startsWith("/uos/")) continue;
    assert.equal(typeof operation.operationId, "string", `${method.toUpperCase()} ${path} needs an operation id`);
    assert.ok((operation.description ?? "").length > 80, `${method.toUpperCase()} ${path} needs a useful description`);
  }
});

test("every /uos/ path literal anywhere under src/ is a published route", () => {
  // This also covers a route dispatched in a form the patterns above cannot read, such as a path held in a constant.
  const publishedPaths = new Set(PUBLISHED_OPERATIONS.map(({ path }) => path));
  const unpublished: string[] = [];
  for (const file of SOURCE_FILES) {
    for (const match of sourceText(file).matchAll(/(["'`])(\/uos\/[^"'`\s]*)\1/g)) {
      const literal = match[2];
      const published = publishedPaths.has(literal) || (literal.endsWith("/") && publishedPaths.has(`${literal}{id}`));
      if (!published) unpublished.push(`src/${file}: ${literal}`);
    }
  }
  assert.deepEqual(unpublished, [], "a UOS path in the runtime source must be published in static/openapi.json");
});

test("agent-messages publishes the kernel attestation header as required and the repository headers as optional cross-checks", () => {
  // At runtime the kernel token alone authenticates the request and names the repository; X-GitHub-Owner and
  // X-GitHub-Repo are compared with the attestation only when both are sent (tests/kernel-coverage.test.ts).
  const requiredHeaders = (operation: Operation): Record<string, boolean> => {
    const headers: Record<string, boolean> = {};
    for (const reference of operation.parameters ?? []) {
      const name = reference.$ref?.split("/").at(-1);
      if (name !== undefined && !Object.hasOwn(document.components.parameters, name)) throw new Error(`OpenAPI parameter ${name} is missing`);
      const parameter = name === undefined ? reference : document.components.parameters[name];
      if (parameter.in === "header" && parameter.name) headers[parameter.name] = parameter.required === true;
    }
    return headers;
  };
  for (const method of ["get", "post"] as const) {
    const operation = document.paths["/uos/agent-messages"][method];
    assert.ok(operation, `${method.toUpperCase()} /uos/agent-messages must be published`);
    assert.deepEqual(requiredHeaders(operation), {
      "X-GitHub-Owner": false,
      "X-GitHub-Repo": false,
      "X-Ubiquity-Kernel-Token": true,
      "X-GitHub-Installation-Id": false,
    });
  }
});

test("every published route reaches its runtime handler with the published authentication", async () => {
  // Unauthenticated requests stop at authentication, except the public catalog, which builds from empty storage. A
  // rejecting fetch keeps its model-discovery refreshes off the network; the caches they touch are reset afterwards.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign((): Promise<Response> => Promise.reject(new Error("contract probes must not reach the network")), {
    preconnect: originalFetch.preconnect,
  });
  setKvForTest(null);
  try {
    for (const { method, path, operation } of PUBLISHED_OPERATIONS) {
      const body = method === "get" ? undefined : "{}";
      const headers: Record<string, string> = body === undefined ? {} : { "Content-Type": "application/json" };
      const response = await handler(
        new Request(`https://ai.ubq.fi${path.replace("{id}", "contract-probe")}`, { method: method.toUpperCase(), headers, body })
      );
      await response.body?.cancel();
      const isPublic = operation.security?.length === 0;
      assert.equal(response.status, isPublic ? 200 : 401, `${method.toUpperCase()} ${path} must be dispatched with its published authentication`);
    }
    const unpublished = await handler(new Request("https://ai.ubq.fi/uos/contract-probe-unpublished"));
    await unpublished.body?.cancel();
    assert.equal(unpublished.status, 404, "an unpublished UOS path must not be dispatched");
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetMeteredModelsCacheForTest();
    resetOpenRouterModelsCacheForTest();
    resetSurplusModelsCacheForTest();
  }
});

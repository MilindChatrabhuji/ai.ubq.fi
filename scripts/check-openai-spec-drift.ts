import { readFile } from "node:fs/promises";
import { parse } from "@std/yaml";
import { CHAT_COMPLETIONS_REQUEST_KEYS, RESPONSES_REQUEST_KEYS } from "../src/openai-schema.ts";

const DEFAULT_SPEC_URL = "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null;

const getArgValue = (name: string): string | null => {
  const prefix = `${name}=`;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) return args[i + 1] ?? null;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
};

const readSpecText = async (location: string): Promise<string> => {
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location);
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAI spec: ${response.status} ${response.statusText}`);
    }
    return await response.text();
  }
  return await readFile(location, "utf8");
};

const sortedUnique = (values: Iterable<string>): string[] => Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));

const schemaNameFromRef = (ref: string): string => {
  const name = ref.split("/").pop();
  if (!name) throw new Error(`Unsupported schema ref: ${ref}`);
  return name;
};

const collectProperties = (schema: unknown, schemas: Record<string, unknown>, seen = new Set<unknown>()): Set<string> => {
  const properties = new Set<string>();
  if (!isRecord(schema) || seen.has(schema)) return properties;
  seen.add(schema);

  const ref = typeof schema.$ref === "string" ? schema.$ref : null;
  if (ref) return collectProperties(schemas[schemaNameFromRef(ref)], schemas, seen);

  if (isRecord(schema.properties)) {
    for (const key of Object.keys(schema.properties)) properties.add(key);
  }

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      for (const key of collectProperties(part, schemas, seen)) properties.add(key);
    }
  }

  return properties;
};

const diff = (left: readonly string[], right: readonly string[]): string[] => left.filter((key) => !right.includes(key));

const checkSurface = (label: string, schemaName: string, localKeys: readonly string[], schemas: Record<string, unknown>): string[] => {
  const officialKeys = sortedUnique(collectProperties(schemas[schemaName], schemas));
  const local = sortedUnique(localKeys);
  const missing = diff(officialKeys, local);
  const extra = diff(local, officialKeys);
  if (!missing.length && !extra.length) {
    console.log(`${label}: aligned (${local.length} request keys)`);
    return [];
  }

  const errors = [`${label}: request-key drift against ${schemaName}`];
  if (missing.length) errors.push(`  missing locally: ${missing.join(", ")}`);
  if (extra.length) errors.push(`  extra locally: ${extra.join(", ")}`);
  return errors;
};

const specLocation = getArgValue("--spec") ?? DEFAULT_SPEC_URL;
const spec = parse(await readSpecText(specLocation));
if (!isRecord(spec) || !isRecord(spec.components) || !isRecord(spec.components.schemas)) {
  throw new Error("OpenAI spec did not contain components.schemas");
}

const schemas = spec.components.schemas;
const failures = [
  ...checkSurface("chat.completions.create", "CreateChatCompletionRequest", CHAT_COMPLETIONS_REQUEST_KEYS, schemas),
  ...checkSurface("responses.create", "CreateResponse", RESPONSES_REQUEST_KEYS, schemas),
];

if (failures.length) {
  console.error(`OpenAI spec drift detected from ${specLocation}`);
  console.error(failures.join("\n"));
  process.exitCode = 1;
}

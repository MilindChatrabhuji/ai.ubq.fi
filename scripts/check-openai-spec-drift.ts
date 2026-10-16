/**
 * Official OpenAI request-schema drift gate.
 *
 * The runtime request allowlists in src/openai-schema.ts must equal the request properties of one pinned revision of
 * the official specification (openai/openai-openapi). The pin in scripts/openai-spec-pin.json records that revision's
 * commit, the SHA-256 of its openapi.yaml, and the two request surfaces extracted from it, so the default gate is
 * offline and deterministic.
 *
 *   bun run spec:drift                       compare the runtime allowlists with the pinned surfaces (CI gate)
 *   bun run spec:drift --spec <file|url>     also verify a copy of the pinned specification: digest and surfaces
 *   bun run spec:drift --verify-source       the same, fetching the pinned source URL
 *   bun run spec:drift --repin <commit>      fetch that revision (or read --spec), rewrite the pin, then gate
 *
 * Gateway compatibility extensions (Codex CLI, DeepSeek, OpenRouter) are separate sets and never enter this check.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "@std/yaml";
import { CHAT_COMPLETIONS_REQUEST_KEYS, RESPONSES_REQUEST_KEYS } from "../src/openai-schema.ts";

const OFFICIAL_REPOSITORY = "openai/openai-openapi";
const OFFICIAL_PATH = "openapi.yaml";
const PIN_URL = new URL("./openai-spec-pin.json", import.meta.url);
const OFFICIAL_SCHEMAS = ["CreateChatCompletionRequest", "CreateResponse"] as const;
type OfficialSchema = (typeof OFFICIAL_SCHEMAS)[number];

export type OpenAiSpecPin = Readonly<{
  repository: string;
  commit: string;
  path: string;
  source: string;
  sha256: string;
  surfaces: Readonly<Record<OfficialSchema, readonly string[]>>;
}>;

type RuntimeSurface = Readonly<{ label: string; schema: OfficialSchema; keys: readonly string[] }>;
const RUNTIME_REQUEST_SURFACES: readonly RuntimeSurface[] = [
  { label: "chat.completions.create", schema: "CreateChatCompletionRequest", keys: CHAT_COMPLETIONS_REQUEST_KEYS },
  { label: "responses.create", schema: "CreateResponse", keys: RESPONSES_REQUEST_KEYS },
];

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const sortedUnique = (values: Iterable<string>): string[] => Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
const diff = (left: readonly string[], right: readonly string[]): string[] => left.filter((key) => !right.includes(key));
const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

export const pinnedSpecSource = (commit: string): string => `https://raw.githubusercontent.com/${OFFICIAL_REPOSITORY}/${commit}/${OFFICIAL_PATH}`;

const parsePin = (value: unknown): OpenAiSpecPin => {
  if (!isRecord(value) || !isRecord(value.surfaces)) throw new Error("The OpenAI spec pin must be an object with surfaces");
  const { repository, commit, path, source, sha256, surfaces } = value;
  if (repository !== OFFICIAL_REPOSITORY || path !== OFFICIAL_PATH) throw new Error(`The OpenAI spec pin must name ${OFFICIAL_REPOSITORY}/${OFFICIAL_PATH}`);
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("The OpenAI spec pin must name a full commit SHA");
  if (source !== pinnedSpecSource(commit)) throw new Error("The OpenAI spec pin source must be the pinned commit's openapi.yaml");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("The OpenAI spec pin must record a SHA-256 digest");
  const parsed = {} as Record<OfficialSchema, readonly string[]>;
  for (const schema of OFFICIAL_SCHEMAS) {
    const keys = surfaces[schema];
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key) => typeof key === "string")) {
      throw new Error(`The OpenAI spec pin must record the ${schema} request surface`);
    }
    parsed[schema] = keys;
  }
  return { repository, commit, path, source, sha256, surfaces: parsed };
};

export const readOpenAiSpecPin = async (): Promise<OpenAiSpecPin> => parsePin(JSON.parse(await readFile(PIN_URL, "utf8")));

const schemaNameFromRef = (ref: string): string => {
  const name = ref.split("/").pop();
  if (!name) throw new Error(`Unsupported schema ref: ${ref}`);
  return name;
};

const collectProperties = (schema: unknown, schemas: JsonRecord, seen = new Set<unknown>()): Set<string> => {
  const properties = new Set<string>();
  if (!isRecord(schema) || seen.has(schema)) return properties;
  seen.add(schema);
  if (typeof schema.$ref === "string") return collectProperties(schemas[schemaNameFromRef(schema.$ref)], schemas, seen);
  if (isRecord(schema.properties)) for (const key of Object.keys(schema.properties)) properties.add(key);
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) for (const key of collectProperties(part, schemas, seen)) properties.add(key);
  }
  return properties;
};

/** The sorted request properties of each official request schema in a specification document. */
export const extractRequestSurfaces = (specText: string): Record<OfficialSchema, string[]> => {
  const spec = parse(specText);
  if (!isRecord(spec) || !isRecord(spec.components) || !isRecord(spec.components.schemas)) {
    throw new Error("OpenAI spec did not contain components.schemas");
  }
  const schemas = spec.components.schemas;
  const surfaces = {} as Record<OfficialSchema, string[]>;
  for (const schema of OFFICIAL_SCHEMAS) {
    if (!isRecord(schemas[schema])) throw new Error(`OpenAI spec did not define ${schema}`);
    surfaces[schema] = sortedUnique(collectProperties(schemas[schema], schemas));
  }
  return surfaces;
};

/** Failures, empty when every runtime allowlist equals its pinned official surface. */
export const checkRuntimeAgainstPin = (pin: OpenAiSpecPin, runtime: readonly RuntimeSurface[] = RUNTIME_REQUEST_SURFACES): string[] => {
  const failures: string[] = [];
  for (const surface of runtime) {
    const official = sortedUnique(pin.surfaces[surface.schema]);
    const local = sortedUnique(surface.keys);
    const missing = diff(official, local);
    const extra = diff(local, official);
    if (!missing.length && !extra.length) continue;
    failures.push(`${surface.label}: request-key drift against ${surface.schema}`);
    if (missing.length) failures.push(`  missing locally: ${missing.join(", ")}`);
    if (extra.length) failures.push(`  extra locally: ${extra.join(", ")}`);
  }
  return failures;
};

/** Failures, empty when the specification text is the pinned revision and yields the pinned surfaces. */
export const verifySpecAgainstPin = (pin: OpenAiSpecPin, specText: string): string[] => {
  const digest = sha256Hex(specText);
  if (digest !== pin.sha256) {
    return [`OpenAI spec digest mismatch: pinned ${pin.sha256} (${pin.repository}@${pin.commit}), received ${digest}`];
  }
  const extracted = extractRequestSurfaces(specText);
  const failures: string[] = [];
  for (const schema of OFFICIAL_SCHEMAS) {
    const pinned = sortedUnique(pin.surfaces[schema]);
    const missing = diff(extracted[schema], pinned);
    const extra = diff(pinned, extracted[schema]);
    if (!missing.length && !extra.length) continue;
    const details = [missing.length ? `missing from pin: ${missing.join(", ")}` : "", extra.length ? `not in specification: ${extra.join(", ")}` : ""];
    failures.push(`${schema}: pinned surface differs from the specification (${details.filter(Boolean).join("; ")})`);
  }
  return failures;
};

type SpecDriftDependencies = Readonly<{
  readSpec?: (location: string) => Promise<string>;
  writePin?: (pin: OpenAiSpecPin) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}>;

const readSpecLocation = async (location: string): Promise<string> => {
  if (!location.startsWith("https://")) return await readFile(location, "utf8");
  const response = await fetch(location);
  if (!response.ok) throw new Error(`Failed to fetch OpenAI spec: ${response.status} ${response.statusText}`);
  return await response.text();
};

const writePinFile = async (pin: OpenAiSpecPin): Promise<void> => {
  await writeFile(PIN_URL, `${JSON.stringify(pin, null, 2)}\n`);
};

const argumentValue = (args: readonly string[], name: string): string | null => {
  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1] ?? null;
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline === undefined ? null : inline.slice(name.length + 1);
};

/** Runs the gate and returns its exit code: 0 aligned, 1 drift or verification failure, 2 usage error. */
export const runSpecDriftCheck = async (args: readonly string[], dependencies: SpecDriftDependencies = {}): Promise<number> => {
  const log =
    dependencies.log ??
    ((line: string) => {
      console.log(line);
    });
  const error =
    dependencies.error ??
    ((line: string) => {
      console.error(line);
    });
  const readSpec = dependencies.readSpec ?? readSpecLocation;
  const known = new Set(["--spec", "--verify-source", "--repin"]);
  const unknown = args.find((arg) => arg.startsWith("--") && !known.has(arg.split("=")[0]));
  if (unknown) {
    error(`Unknown argument: ${unknown}`);
    return 2;
  }

  const specLocation = argumentValue(args, "--spec");
  const repin = argumentValue(args, "--repin");
  let pin: OpenAiSpecPin;
  if (args.includes("--repin") || args.some((arg) => arg.startsWith("--repin="))) {
    if (!repin || !/^[0-9a-f]{40}$/.test(repin)) {
      error("--repin requires a full 40-character openai/openai-openapi commit SHA");
      return 2;
    }
    const source = pinnedSpecSource(repin);
    const specText = await readSpec(specLocation ?? source);
    pin = {
      repository: OFFICIAL_REPOSITORY,
      commit: repin,
      path: OFFICIAL_PATH,
      source,
      sha256: sha256Hex(specText),
      surfaces: extractRequestSurfaces(specText),
    };
    await (dependencies.writePin ?? writePinFile)(pin);
    log(`Pinned ${OFFICIAL_REPOSITORY}@${repin} (${pin.sha256})`);
  } else if (specLocation !== null || args.includes("--verify-source")) {
    pin = await readOpenAiSpecPin();
    const location = specLocation ?? pin.source;
    const failures = verifySpecAgainstPin(pin, await readSpec(location));
    if (failures.length) {
      error(`OpenAI spec verification failed for ${location}`);
      for (const failure of failures) error(failure);
      return 1;
    }
    log(`Verified ${location} against ${pin.repository}@${pin.commit}`);
  } else {
    pin = await readOpenAiSpecPin();
  }

  const failures = checkRuntimeAgainstPin(pin);
  if (failures.length) {
    error(`OpenAI request-schema drift against ${pin.repository}@${pin.commit}`);
    for (const failure of failures) error(failure);
    return 1;
  }
  for (const surface of RUNTIME_REQUEST_SURFACES) log(`${surface.label}: aligned (${surface.keys.length} request keys) with ${pin.repository}@${pin.commit}`);
  return 0;
};

if (import.meta.main) process.exitCode = await runSpecDriftCheck(process.argv.slice(2));

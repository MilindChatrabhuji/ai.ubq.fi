/**
 * Official OpenAI request-schema drift gate.
 *
 * The runtime request allowlists in src/openai-schema.ts must equal the request properties of one pinned revision of
 * the official specification (openai/openai-openapi). The pin in scripts/openai-spec-pin.json records that revision's
 * commit, the SHA-256 of its openapi.yaml, and the two request surfaces extracted from it, so the default gate is
 * offline and deterministic.
 *
 *   bun run spec:drift                       compare the runtime allowlists with the pinned surfaces, offline
 *   bun run spec:drift --verify-source       also fetch the pinned source URL and verify its digest and surfaces (CI gate)
 *   bun run spec:drift --spec <file|url>     the same, verifying a local or mirrored copy instead of the pinned URL
 *   bun run spec:drift --repin <commit>      fetch that revision's official source, rewrite the pin, then gate
 *
 * The offline mode proves only that the runtime allowlists and the hand-editable pin agree; --verify-source proves the
 * pin is the official revision it names. The source URL is commit-addressed, so only its availability can change, and
 * a transient fetch failure is retried. Each mode takes its own flags; any other argument is a usage error (exit 2).
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
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}>;

const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 5_000;
const FETCH_ATTEMPT_TIMEOUT_MS = 60_000;
const sleepFor = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

class PermanentFetchFailure extends Error {}

/** Fetches one specification URL, retrying network failures, timeouts, 429 and 5xx; any other refusal is final. */
const fetchSpecText = async (location: string, sleep: (milliseconds: number) => Promise<void>): Promise<string> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(location, { signal: AbortSignal.timeout(FETCH_ATTEMPT_TIMEOUT_MS) });
      const failure = `Failed to fetch OpenAI spec: ${response.status} ${response.statusText}`;
      if (response.ok) return await response.text();
      await response.body?.cancel();
      if (response.status !== 429 && response.status < 500) throw new PermanentFetchFailure(failure);
      throw new Error(failure);
    } catch (error) {
      if (error instanceof PermanentFetchFailure || attempt >= FETCH_ATTEMPTS) throw error;
    }
    await sleep(FETCH_RETRY_DELAY_MS * attempt);
  }
};

const readSpecLocation = async (location: string, sleep: (milliseconds: number) => Promise<void>): Promise<string> =>
  location.startsWith("https://") ? await fetchSpecText(location, sleep) : await readFile(location, "utf8");

const writePinFile = async (pin: OpenAiSpecPin): Promise<void> => {
  await writeFile(PIN_URL, `${JSON.stringify(pin, null, 2)}\n`);
};

const VALUE_FLAGS = new Set(["--spec", "--repin"]);
const KNOWN_FLAGS = new Set([...VALUE_FLAGS, "--verify-source"]);

type FlagReading = Readonly<{ flags: ReadonlyMap<string, string | null>; error: string | null }>;

/** Each flag once with its value: inline after "=", or for --spec and --repin the next argument. */
const readFlags = (args: readonly string[]): FlagReading => {
  const flags = new Map<string, string | null>();
  const pending = [...args];
  for (let arg = pending.shift(); arg !== undefined; arg = pending.shift()) {
    const separator = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = separator === -1 ? arg : arg.slice(0, separator);
    if (!KNOWN_FLAGS.has(name)) return { flags, error: `Unknown argument: ${arg}` };
    if (flags.has(name)) return { flags, error: `${name} may be given only once` };
    const inline = separator === -1 ? null : arg.slice(separator + 1);
    flags.set(name, inline ?? (VALUE_FLAGS.has(name) ? (pending.shift() ?? null) : null));
  }
  return { flags, error: null };
};

/** The usage error in a set of known flags, or null when they select exactly one mode. */
const flagError = (flags: ReadonlyMap<string, string | null>): string | null => {
  for (const [name, value] of flags) {
    if (!VALUE_FLAGS.has(name) && value !== null) return `${name} takes no value`;
    if (VALUE_FLAGS.has(name) && (!value || value.startsWith("--"))) return `${name} requires a value`;
  }
  if (flags.has("--repin") && flags.size > 1) {
    return "--repin reads only the commit's own official source; it cannot be combined with --spec or --verify-source";
  }
  if (flags.has("--spec") && flags.has("--verify-source")) return "--spec verifies a copy instead of the pinned source; use either --spec or --verify-source";
  return null;
};

type SpecDriftArguments = Readonly<{ spec: string | null; verifySource: boolean; repin: string | null; error: string | null }>;

/** The selected mode, with the usage error that makes the invocation exit 2 instead of running a different check. */
const parseArguments = (args: readonly string[]): SpecDriftArguments => {
  const { flags, error } = readFlags(args);
  return {
    spec: flags.get("--spec") ?? null,
    verifySource: flags.has("--verify-source"),
    repin: flags.get("--repin") ?? null,
    error: error ?? flagError(flags),
  };
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
  const sleep = dependencies.sleep ?? sleepFor;
  const readSpec = dependencies.readSpec ?? ((location: string) => readSpecLocation(location, sleep));
  const parsed = parseArguments(args);
  if (parsed.error !== null) {
    error(parsed.error);
    error("Usage: spec:drift [--verify-source | --spec <file|url> | --repin <commit>]");
    return 2;
  }

  const { spec: specLocation, repin } = parsed;
  let pin: OpenAiSpecPin;
  if (repin !== null) {
    if (!/^[0-9a-f]{40}$/.test(repin)) {
      error("--repin requires a full 40-character openai/openai-openapi commit SHA");
      return 2;
    }
    const source = pinnedSpecSource(repin);
    const specText = await readSpec(source);
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
  } else if (specLocation !== null || parsed.verifySource) {
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

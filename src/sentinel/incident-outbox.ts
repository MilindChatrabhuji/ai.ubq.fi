import type { Kv, KvEntry, KvEntryMaybe, KvKey } from "#kv";
import { getKv } from "../kv.ts";
import { isRecord, sha256Hex } from "../utils.ts";
export const SENTINEL_INCIDENT_CAPTURE_REF_PREFIX = ["uos_ai", "sentinel_incident", "v1", "capture_ref"] as const;
export const SENTINEL_INCIDENT_EVENT_PREFIX = ["uos_ai", "sentinel_incident", "v1", "event"] as const;
export const SENTINEL_INCIDENT_TTL_MS = 48 * 60 * 60 * 1_000;

const INCIDENT_ID = /^provider-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export type SentinelIncidentCaptureReference = Readonly<{
  version: 1;
  manifest_key: KvKey;
}>;

export type SentinelIncidentFailureEvent = Readonly<{
  version: 1;
  incident_id: string;
  state: "capturing" | "ready";
  observed_at_ms: number;
  created_at_ms: number;
  ready_at_ms: number | null;
  capture_status: "pending" | "stored" | "duplicate" | "unavailable";
  capture_fingerprint: string | null;
  manifest_key: KvKey | null;
}>;

type EnvironmentReader = Readonly<{ get(name: string): string | undefined }>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type SentinelIncidentDependencies = Readonly<{
  now?: () => number;
  randomUuid?: () => string;
  fetcher?: Fetcher;
  createTimeoutSignal?: (milliseconds: number) => AbortSignal;
  randomAckNonce?: () => string;
}>;

const safeEnvironment: EnvironmentReader = {
  get(name) {
    try {
      const value = process.env[name]?.trim();
      if (!value) return undefined;
      return value;
    } catch {
      return undefined;
    }
  },
};

const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const isSentinelIncidentId = (value: unknown): value is string => typeof value === "string" && INCIDENT_ID.test(value);

export const isSentinelIncidentCaptureReference = (value: unknown): value is SentinelIncidentCaptureReference =>
  isRecord(value) && value.version === 1 && Array.isArray(value.manifest_key) && value.manifest_key.length === 7;

export const isSentinelIncidentFailureEvent = (value: unknown): value is SentinelIncidentFailureEvent => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isSentinelIncidentId(value.incident_id) ||
    !positiveInteger(value.observed_at_ms) ||
    !positiveInteger(value.created_at_ms) ||
    value.created_at_ms < value.observed_at_ms ||
    (value.ready_at_ms !== null && !positiveInteger(value.ready_at_ms)) ||
    (value.capture_fingerprint !== null && (typeof value.capture_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.capture_fingerprint))) ||
    (value.manifest_key !== null && (!Array.isArray(value.manifest_key) || value.manifest_key.length !== 7))
  )
    return false;
  if (value.state === "capturing") {
    return value.ready_at_ms === null && value.capture_status === "pending" && value.capture_fingerprint === null && value.manifest_key === null;
  }
  if (value.state !== "ready" || value.ready_at_ms === null || value.ready_at_ms < value.created_at_ms) return false;
  if (value.capture_status === "unavailable") {
    return value.capture_fingerprint === null && value.manifest_key === null;
  }
  return (value.capture_status === "stored" || value.capture_status === "duplicate") && value.capture_fingerprint !== null && value.manifest_key !== null;
};

export const isSentinelProductionRuntime = (environment: EnvironmentReader = safeEnvironment): boolean =>
  environment.get("DENO_DEPLOY_ORG_SLUG") === "ubiquity-dao" &&
  environment.get("DENO_DEPLOY_APP_SLUG") === "ai-ubq-fi" &&
  environment.get("DENO_TIMELINE") === "production";

const defaultRandomUuid = (): string => crypto.randomUUID();

const incidentEventKey = (incidentId: string): KvKey => [...SENTINEL_INCIDENT_EVENT_PREFIX, incidentId];

export const createSentinelIncidentFailureEvent = async (
  kv: Kv,
  observedAtMs: number,
  dependencies: Pick<SentinelIncidentDependencies, "randomUuid"> = {}
): Promise<KvEntry<SentinelIncidentFailureEvent>> => {
  if (!positiveInteger(observedAtMs)) throw new Error("Sentinel incident timestamp is invalid");
  const incidentId = `provider-${(dependencies.randomUuid ?? defaultRandomUuid)().toLowerCase()}`;
  if (!isSentinelIncidentId(incidentId)) throw new Error("Sentinel incident UUID is invalid");
  const key = incidentEventKey(incidentId);
  const value: SentinelIncidentFailureEvent = {
    version: 1,
    incident_id: incidentId,
    state: "capturing",
    observed_at_ms: observedAtMs,
    created_at_ms: observedAtMs,
    ready_at_ms: null,
    capture_status: "pending",
    capture_fingerprint: null,
    manifest_key: null,
  };
  const committed = await kv.atomic().check({ key, versionstamp: null }).set(key, value, { expireIn: SENTINEL_INCIDENT_TTL_MS }).commit();
  if (!committed.ok) throw new Error("Sentinel incident event identifier conflicted");
  return { key, value, versionstamp: committed.versionstamp };
};

export const recordSentinelProviderDegradation = async (
  kv: Kv,
  observedAtMs: number,
  dependencies: Pick<SentinelIncidentDependencies, "randomUuid"> = {}
): Promise<string> => {
  if (!positiveInteger(observedAtMs)) throw new Error("Sentinel incident timestamp is invalid");
  const incidentId = `provider-${(dependencies.randomUuid ?? defaultRandomUuid)().toLowerCase()}`;
  if (!isSentinelIncidentId(incidentId)) throw new Error("Sentinel incident UUID is invalid");
  const key = incidentEventKey(incidentId);
  const value: SentinelIncidentFailureEvent = {
    version: 1,
    incident_id: incidentId,
    state: "ready",
    observed_at_ms: observedAtMs,
    created_at_ms: observedAtMs,
    ready_at_ms: observedAtMs,
    capture_status: "unavailable",
    capture_fingerprint: null,
    manifest_key: null,
  };
  const committed = await kv.atomic().check({ key, versionstamp: null }).set(key, value, { expireIn: SENTINEL_INCIDENT_TTL_MS }).commit();
  if (!committed.ok) throw new Error("Sentinel incident event identifier conflicted");
  return incidentId;
};

type IncidentCaptureCompletion = Readonly<{ status: "stored" | "duplicate"; fingerprint: string; manifestKey: KvKey }> | Readonly<{ status: "unavailable" }>;

export const readySentinelIncidentFailureEvent = (
  entry: KvEntry<SentinelIncidentFailureEvent>,
  readyAtMs: number,
  capture: IncidentCaptureCompletion
): SentinelIncidentFailureEvent => {
  if (!isSentinelIncidentFailureEvent(entry.value) || entry.value.state !== "capturing") {
    throw new Error("Sentinel incident event is not awaiting capture");
  }
  if (!positiveInteger(readyAtMs) || readyAtMs < entry.value.created_at_ms) {
    throw new Error("Sentinel incident ready timestamp is invalid");
  }
  const value: SentinelIncidentFailureEvent =
    capture.status === "unavailable"
      ? {
          ...entry.value,
          state: "ready",
          ready_at_ms: readyAtMs,
          capture_status: "unavailable",
        }
      : {
          ...entry.value,
          state: "ready",
          ready_at_ms: readyAtMs,
          capture_status: capture.status,
          capture_fingerprint: capture.fingerprint,
          manifest_key: [...capture.manifestKey],
        };
  if (!isSentinelIncidentFailureEvent(value)) throw new Error("Sentinel incident capture completion is invalid");
  return value;
};

export const completeSentinelIncidentFailureEvent = async (
  kv: Kv,
  entry: KvEntry<SentinelIncidentFailureEvent>,
  readyAtMs: number,
  capture: IncidentCaptureCompletion
): Promise<boolean> => {
  const value = readySentinelIncidentFailureEvent(entry, readyAtMs, capture);
  const committed = await kv
    .atomic()
    .check({ key: entry.key, versionstamp: entry.versionstamp })
    .set(entry.key, value, { expireIn: SENTINEL_INCIDENT_TTL_MS })
    .commit();
  return committed.ok;
};

export const linkSentinelReplayToIncident = async (kv: Kv, incidentId: string, fingerprint: string, manifestKey: KvKey): Promise<void> => {
  if (!isSentinelIncidentId(incidentId) || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error("Sentinel incident capture reference is invalid");
  }
  const reference: SentinelIncidentCaptureReference = { version: 1, manifest_key: [...manifestKey] };
  if (!isSentinelIncidentCaptureReference(reference)) throw new Error("Sentinel replay manifest key is invalid");
  await kv.set([...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, incidentId, fingerprint], reference, {
    expireIn: SENTINEL_INCIDENT_TTL_MS,
  });
};

export const createSentinelIncidentFailureEventFromEnvironment = async (
  kv: Kv,
  observedAtMs: number,
  environment: EnvironmentReader = safeEnvironment
): Promise<KvEntry<SentinelIncidentFailureEvent> | null> =>
  isSentinelProductionRuntime(environment) ? await createSentinelIncidentFailureEvent(kv, observedAtMs) : null;

export const recordSentinelProviderDegradationFromEnvironment = async (
  observedAtMs: number,
  dependencies: Readonly<{
    environment?: EnvironmentReader;
    kv?: Kv;
    randomUuid?: () => string;
  }> = {}
): Promise<boolean> => {
  const environment = dependencies.environment ?? safeEnvironment;
  if (!isSentinelProductionRuntime(environment)) return false;
  const kv = dependencies.kv ?? (await getKv());
  if (!kv) return false;
  await recordSentinelProviderDegradation(kv, observedAtMs, dependencies);
  return true;
};

// ---------------------------------------------------------------------------
// Durable passive incident index (m06). Index rows have NO TTL so durable
// discovery survives the 48-hour capture lifetime; they are never derived from
// the retired transient event/control/ack records. The row key is a stable
// failure group: SHA-256 over a canonical, explicitly safe classification
// (recognized endpoint/method, numeric status, boolean stream/completion/
// framing, fixed terminal category). No raw body, request ID, compatibility
// header, query string, user/model input or error text is hashed or copied to
// public records.
// ---------------------------------------------------------------------------

export const SENTINEL_INCIDENT_INDEX_PREFIX = ["uos_ai", "sentinel_incident", "v1", "index"] as const;
// Frozen gateway query contract: server page limit is any integer 1..100.
export const SENTINEL_INCIDENT_INDEX_MAX_PAGE_LIMIT = 100;
export const SENTINEL_INCIDENT_INDEX_DEFAULT_PAGE_LIMIT = 20;
export const SENTINEL_INCIDENT_INDEX_MAX_CAS_ATTEMPTS = 8;

export const SENTINEL_INCIDENT_TERMINAL_CATEGORIES = [
  "stream_framing",
  "http_error",
  "response_failed",
  "response_incomplete",
  "error",
  "deadline",
  "eof",
  "unknown",
] as const;
export type SentinelIncidentTerminalCategory = (typeof SENTINEL_INCIDENT_TERMINAL_CATEGORIES)[number];

export const isSentinelIncidentTerminalCategory = (value: unknown): value is SentinelIncidentTerminalCategory =>
  typeof value === "string" && (SENTINEL_INCIDENT_TERMINAL_CATEGORIES as readonly string[]).includes(value);

const INDEX_CURSOR = /^[A-Za-z0-9_-]+={0,2}$/;
const INDEX_REF = /^capture:[A-Za-z0-9_-]{1,128}$/;
const INDEX_MESSAGE = "Gateway observed a provider failure for this incident group.";
const INDEX_ENDPOINTS: readonly string[] = ["/v1/responses", "/v1/chat/completions"];

export type SentinelIncidentIndexObservation = Readonly<{
  status: number;
  stream: boolean;
  completed: boolean;
  framing_valid: boolean;
  terminal_type: string | null;
}>;

export type SentinelIncidentIndexEvidenceRef = Readonly<{
  ref: string;
  digest: string | null;
}>;

/** Bounded classification of the most recent observation in one incident group. */
export type SentinelIncidentIndexLatest = Readonly<{
  observed_at_ms: number;
  revision: string | null;
  provider: string | null;
  route: string;
  model: string | null;
  reasoning: string | null;
  failure_kind: string | null;
  terminal: SentinelIncidentTerminalCategory;
  status: number;
  stream: boolean;
}>;

export type SentinelIncidentIndexRow = Readonly<{
  version: 1;
  incident_id: string;
  fingerprint: string;
  severity: "P2";
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  count: number;
  failing_revision: string | null;
  error_type: string;
  context: Readonly<{ message: string; location: null; sample: readonly string[] }>;
  provenance: Readonly<{ endpoint: string; captured_at_ms: number; captured_by: null }>;
  evidence_ref: SentinelIncidentIndexEvidenceRef | null;
  evidence_expires_at_ms: number | null;
  latest?: SentinelIncidentIndexLatest;
}>;

export const isSentinelIncidentIndexEvidenceRef = (value: unknown): value is SentinelIncidentIndexEvidenceRef =>
  isRecord(value) &&
  typeof value.ref === "string" &&
  INDEX_REF.test(value.ref) &&
  (value.digest === null || (typeof value.digest === "string" && /^[0-9a-f]{64}$/.test(value.digest)));

export const isSentinelIncidentIndexEndpoint = (value: unknown): value is string =>
  typeof value === "string" && (INDEX_ENDPOINTS.includes(value) || value === "other");

const INDEX_SLUG = /^[A-Za-z0-9_.:-]{1,128}$/;
const INDEX_REASONING = /^[A-Za-z0-9_.:-]{1,32}$/;

const boundedIndexText = (value: unknown, pattern: RegExp): string | null => (typeof value === "string" && pattern.test(value) ? value : null);

const isSentinelIncidentIndexLatest = (value: unknown): value is SentinelIncidentIndexLatest =>
  isRecord(value) &&
  positiveInteger(value.observed_at_ms) &&
  (value.revision === null || (typeof value.revision === "string" && FULL_SHA.test(value.revision))) &&
  (value.provider === null || boundedIndexText(value.provider, INDEX_SLUG) !== null) &&
  isSentinelIncidentIndexEndpoint(value.route) &&
  (value.model === null || boundedIndexText(value.model, INDEX_SLUG) !== null) &&
  (value.reasoning === null || boundedIndexText(value.reasoning, INDEX_REASONING) !== null) &&
  (value.failure_kind === null || boundedIndexText(value.failure_kind, INDEX_SLUG) !== null) &&
  isSentinelIncidentTerminalCategory(value.terminal) &&
  typeof value.status === "number" &&
  Number.isSafeInteger(value.status) &&
  value.status >= 0 &&
  value.status <= 599 &&
  typeof value.stream === "boolean";

export const isSentinelIncidentIndexRow = (value: unknown): value is SentinelIncidentIndexRow => {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    isSentinelIncidentId(value.incident_id) &&
    typeof value.fingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(value.fingerprint) &&
    value.severity === "P2" &&
    positiveInteger(value.first_seen_at_ms) &&
    positiveInteger(value.last_seen_at_ms) &&
    value.last_seen_at_ms >= value.first_seen_at_ms &&
    positiveInteger(value.count) &&
    (value.failing_revision === null || (typeof value.failing_revision === "string" && FULL_SHA.test(value.failing_revision))) &&
    isSentinelIncidentTerminalCategory(value.error_type) &&
    isRecord(value.context) &&
    value.context.message === INDEX_MESSAGE &&
    value.context.location === null &&
    Array.isArray(value.context.sample) &&
    value.context.sample.length === 0 &&
    isRecord(value.provenance) &&
    isSentinelIncidentIndexEndpoint(value.provenance.endpoint) &&
    positiveInteger(value.provenance.captured_at_ms) &&
    value.provenance.captured_by === null &&
    (value.evidence_ref === null || isSentinelIncidentIndexEvidenceRef(value.evidence_ref)) &&
    (value.evidence_expires_at_ms === null || positiveInteger(value.evidence_expires_at_ms)) &&
    (value.evidence_ref === null) === (value.evidence_expires_at_ms === null) &&
    (value.latest === undefined || isSentinelIncidentIndexLatest(value.latest))
  );
};

/** Normalize a captured endpoint: recognized path without query, else a fixed safe label. */
export const normalizeSentinelIncidentEndpoint = (endpoint: string): string => {
  const path = endpoint.split("?", 1)[0] ?? "";
  return INDEX_ENDPOINTS.includes(path) ? path : "other";
};

export const normalizeSentinelIncidentMethod = (method: string): string => (method === "POST" ? "POST" : "other");

/** Fixed safe terminal/failure category; truly unrecognized values are "unknown". */
export const classifySentinelIncidentTerminal = (observation: SentinelIncidentIndexObservation): SentinelIncidentTerminalCategory => {
  if (observation.stream && !observation.framing_valid) return "stream_framing";
  switch (observation.terminal_type) {
    case "http.error":
      return "http_error";
    case "response.failed":
      return "response_failed";
    case "response.incomplete":
      return "response_incomplete";
    case "error":
      return "error";
    case "deadline":
      return "deadline";
    case "eof":
      return "eof";
    default:
      return "unknown";
  }
};

export const sentinelIncidentClassification = (input: { endpoint: string; method: string; observation: SentinelIncidentIndexObservation }): string => {
  if (!Number.isSafeInteger(input.observation.status) || input.observation.status < 0 || input.observation.status > 599)
    throw new Error("Sentinel incident classification status is invalid");
  return JSON.stringify({
    endpoint: normalizeSentinelIncidentEndpoint(input.endpoint),
    method: normalizeSentinelIncidentMethod(input.method),
    status: input.observation.status,
    stream: input.observation.stream,
    completed: input.observation.completed,
    framing_valid: input.observation.framing_valid,
    terminal: classifySentinelIncidentTerminal(input.observation),
  });
};

/** Stable group fingerprint: SHA-256 of the canonical safe classification. */
export const sentinelIncidentFingerprint = (input: { endpoint: string; method: string; observation: SentinelIncidentIndexObservation }): Promise<string> =>
  sha256Hex(sentinelIncidentClassification(input));

const indexRowKey = (fingerprint: string): KvKey => [...SENTINEL_INCIDENT_INDEX_PREFIX, fingerprint];

/** Bounded latest-observation classification accepted by the index writer. */
export type SentinelIncidentIndexClassification = Readonly<{
  provider: string | null;
  model: string | null;
  reasoning: string | null;
  failure_kind: string | null;
}>;

/**
 * The bounded latest classification of one observation. Every field is
 * sanitized against its own pattern; a value that does not fit is recorded as
 * absent rather than copied, and no body, header, request id or error text is
 * ever part of it.
 */
const latestObservation = (
  input: Readonly<{
    observedAtMs: number;
    gitSha: string;
    endpoint: string;
    observation: SentinelIncidentIndexObservation;
    classification: SentinelIncidentIndexClassification | undefined;
  }>
): SentinelIncidentIndexLatest => {
  const classification = input.classification;
  return {
    observed_at_ms: input.observedAtMs,
    revision: FULL_SHA.test(input.gitSha) ? input.gitSha : null,
    provider: boundedIndexText(classification?.provider, INDEX_SLUG),
    route: normalizeSentinelIncidentEndpoint(input.endpoint),
    model: boundedIndexText(classification?.model, INDEX_SLUG),
    reasoning: boundedIndexText(classification?.reasoning, INDEX_REASONING),
    failure_kind: boundedIndexText(classification?.failure_kind, INDEX_SLUG),
    terminal: classifySentinelIncidentTerminal(input.observation),
    status: input.observation.status,
    stream: input.observation.stream,
  };
};

const newIndexRow = (
  input: Readonly<{
    fingerprint: string;
    incidentId: string;
    gitSha: string;
    observedAtMs: number;
    endpoint: string;
    method: string;
    observation: SentinelIncidentIndexObservation;
    classification?: SentinelIncidentIndexClassification;
  }>
): SentinelIncidentIndexRow => ({
  version: 1,
  incident_id: input.incidentId,
  fingerprint: input.fingerprint,
  severity: "P2",
  first_seen_at_ms: input.observedAtMs,
  last_seen_at_ms: input.observedAtMs,
  count: 1,
  failing_revision: FULL_SHA.test(input.gitSha) ? input.gitSha : null,
  error_type: classifySentinelIncidentTerminal(input.observation),
  context: { message: INDEX_MESSAGE, location: null, sample: [] },
  provenance: {
    endpoint: normalizeSentinelIncidentEndpoint(input.endpoint),
    captured_at_ms: input.observedAtMs,
    captured_by: null,
  },
  evidence_ref: null,
  evidence_expires_at_ms: null,
  latest: latestObservation({
    observedAtMs: input.observedAtMs,
    gitSha: input.gitSha,
    endpoint: input.endpoint,
    observation: input.observation,
    classification: input.classification,
  }),
});

/**
 * The next index row for one observation: create a new group, or merge into the
 * existing one. First-seen identity stays; only the newest observation refreshes
 * the latest classification.
 */
const nextSentinelIncidentIndexRow = (
  entry: KvEntryMaybe<SentinelIncidentIndexRow>,
  input: Readonly<{
    endpoint: string;
    method: string;
    gitSha: string;
    observedAtMs: number;
    observation: SentinelIncidentIndexObservation;
    classification?: SentinelIncidentIndexClassification;
  }>,
  fingerprint: string,
  latest: SentinelIncidentIndexLatest,
  randomUuid: () => string
): Readonly<{ next: SentinelIncidentIndexRow; checkVersionstamp: string | null }> => {
  if (entry.value === null) {
    const incidentId = `provider-${randomUuid().toLowerCase()}`;
    if (!isSentinelIncidentId(incidentId)) throw new Error("Sentinel incident UUID is invalid");
    return { next: newIndexRow({ ...input, fingerprint, incidentId }), checkVersionstamp: null };
  }
  if (!isSentinelIncidentIndexRow(entry.value)) throw new Error("Sentinel incident index record is invalid");
  return {
    next: {
      ...entry.value,
      first_seen_at_ms: Math.min(entry.value.first_seen_at_ms, input.observedAtMs),
      last_seen_at_ms: Math.max(entry.value.last_seen_at_ms, input.observedAtMs),
      count: entry.value.count + 1,
      latest: entry.value.last_seen_at_ms > input.observedAtMs ? entry.value.latest : latest,
    },
    checkVersionstamp: entry.versionstamp,
  };
};

/**
 * Record one actual observation for the stable failure group. Bounded
 * optimistic CAS (8 attempts) guarantees a single group row under concurrent
 * observations; each call counts exactly once and first/last times stay
 * monotonic. Later observations never retag evidence or revision metadata.
 */
export const recordSentinelIncidentIndexObservation = async (
  kv: Kv,
  input: Readonly<{
    endpoint: string;
    method: string;
    gitSha: string;
    observedAtMs: number;
    observation: SentinelIncidentIndexObservation;
    classification?: SentinelIncidentIndexClassification;
  }>,
  dependencies: Pick<SentinelIncidentDependencies, "randomUuid"> = {}
): Promise<KvEntry<SentinelIncidentIndexRow>> => {
  if (!positiveInteger(input.observedAtMs)) throw new Error("Sentinel incident timestamp is invalid");
  const fingerprint = await sentinelIncidentFingerprint(input);
  const key = indexRowKey(fingerprint);
  const latest = latestObservation({
    observedAtMs: input.observedAtMs,
    gitSha: input.gitSha,
    endpoint: input.endpoint,
    observation: input.observation,
    classification: input.classification,
  });
  for (let attempt = 0; attempt < SENTINEL_INCIDENT_INDEX_MAX_CAS_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<SentinelIncidentIndexRow>(key);
    const { next, checkVersionstamp } = nextSentinelIncidentIndexRow(entry, input, fingerprint, latest, dependencies.randomUuid ?? defaultRandomUuid);
    if (!isSentinelIncidentIndexRow(next)) throw new Error("Sentinel incident index record is invalid");
    const committed = await kv.atomic().check({ key, versionstamp: checkVersionstamp }).set(key, next).commit();
    if (committed.ok) return { key, value: next, versionstamp: committed.versionstamp };
  }
  throw new Error("Sentinel incident index update conflicted repeatedly");
};

/** Input accepted by {@link bindSentinelIncidentIndexEvidence}. */
type SentinelIncidentIndexEvidenceBinding = Readonly<{
  observedAtMs: number;
  captureId: string;
  gitSha: string | null;
  referenceFingerprint: string;
  manifestKey: KvKey;
  manifestVersionstamp: string | null;
  capturedAtMs: number;
  digest: string;
  expiresAtMs: number;
}>;

const isSentinelIncidentIndexEvidenceBinding = (indexFingerprint: string, input: SentinelIncidentIndexEvidenceBinding): boolean => {
  if (!/^[0-9a-f]{64}$/.test(indexFingerprint)) return false;
  if (!/^[0-9a-f]{64}$/.test(input.referenceFingerprint)) return false;
  if (!/^[0-9a-f]{64}$/.test(input.digest)) return false;
  if (!positiveInteger(input.observedAtMs)) return false;
  if (!positiveInteger(input.capturedAtMs)) return false;
  if (!positiveInteger(input.expiresAtMs)) return false;
  if (!Array.isArray(input.manifestKey)) return false;
  if (input.manifestKey.length !== 7) return false;
  return input.manifestVersionstamp === null || typeof input.manifestVersionstamp === "string";
};

/** One bounded CAS attempt; returns null when the attempt lost the race. */
const commitSentinelIncidentIndexEvidence = async (
  kv: Kv,
  key: KvKey,
  input: SentinelIncidentIndexEvidenceBinding,
  reference: SentinelIncidentCaptureReference,
  remainingMs: number
): Promise<KvEntry<SentinelIncidentIndexRow> | null> => {
  const entry = await kv.get<SentinelIncidentIndexRow>(key);
  if (entry.value === null) throw new Error("Sentinel incident index record is missing");
  if (!isSentinelIncidentIndexRow(entry.value)) throw new Error("Sentinel incident index record is invalid");
  const evidence: SentinelIncidentIndexEvidenceRef = {
    ref: `capture:${input.captureId}`,
    digest: input.digest,
  };
  if (!isSentinelIncidentIndexEvidenceRef(evidence)) throw new Error("Sentinel incident index evidence is invalid");
  const next: SentinelIncidentIndexRow = {
    ...entry.value,
    failing_revision: input.gitSha !== null && FULL_SHA.test(input.gitSha) ? input.gitSha : null,
    provenance: { ...entry.value.provenance, captured_at_ms: input.capturedAtMs },
    evidence_ref: evidence,
    evidence_expires_at_ms: input.expiresAtMs,
  };
  if (!isSentinelIncidentIndexRow(next)) throw new Error("Sentinel incident index record is invalid");
  let operation = kv.atomic().check({ key, versionstamp: entry.versionstamp }).set(key, next);
  if (input.manifestVersionstamp !== null) {
    operation = operation.check({ key: input.manifestKey, versionstamp: input.manifestVersionstamp });
  }
  if (remainingMs > 0) {
    operation = operation.set([...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, next.incident_id, input.referenceFingerprint], reference, { expireIn: remainingMs });
  }
  const committed = await operation.commit();
  if (!committed.ok) return null;
  return { key, value: next, versionstamp: committed.versionstamp };
};

/**
 * Bind a real capture to the stable index row. `evidence` is the SHA-256 of
 * the decoded concatenated ciphertext bytes (never the manifest HMAC
 * fingerprint or JSON hash); `ref` is opaque (`capture:<capture_id>`).
 * The binding is exact: `gitSha` is the winning capture's original plaintext
 * revision (valid full SHA or null) and `capturedAtMs` is that manifest's
 * captured_at_ms — never the index's first/last observation or the current
 * duplicate request. The atomic CAS-checks the winning manifest versionstamp
 * so an observed binding cannot silently attach to a replaced/deleted
 * manifest; ref/evidence/index are one transaction, no non-atomic pairing.
 */
export const bindSentinelIncidentIndexEvidence = async (
  kv: Kv,
  indexFingerprint: string,
  input: SentinelIncidentIndexEvidenceBinding
): Promise<KvEntry<SentinelIncidentIndexRow>> => {
  if (!isSentinelIncidentIndexEvidenceBinding(indexFingerprint, input)) {
    throw new Error("Sentinel incident index evidence binding is invalid");
  }
  const key = indexRowKey(indexFingerprint);
  const remainingMs = input.expiresAtMs - input.observedAtMs;
  const reference: SentinelIncidentCaptureReference = { version: 1, manifest_key: [...input.manifestKey] };
  if (!isSentinelIncidentCaptureReference(reference)) throw new Error("Sentinel replay manifest key is invalid");
  for (let attempt = 0; attempt < SENTINEL_INCIDENT_INDEX_MAX_CAS_ATTEMPTS; attempt += 1) {
    const bound = await commitSentinelIncidentIndexEvidence(kv, key, input, reference, remainingMs);
    if (bound !== null) return bound;
  }
  throw new Error("Sentinel incident index evidence binding conflicted repeatedly");
};

/**
 * Read-only bounded pagination over the durable index. Every success is a
 * complete page: `cursor` is null only when the scan is exhausted, never when
 * a record is malformed or storage fails (callers fail closed). An incident
 * filter still obeys bounded pagination: a matching row after this page's
 * bound is reached by following the non-null cursor, never silently dropped.
 */
export const listSentinelIncidentIndexRows = async (
  kv: Kv,
  options: Readonly<{ incidentId?: string; cursor?: string; limit?: number }> = {}
): Promise<Readonly<{ rows: SentinelIncidentIndexRow[]; cursor: string | null }>> => {
  const limit = options.limit ?? SENTINEL_INCIDENT_INDEX_DEFAULT_PAGE_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SENTINEL_INCIDENT_INDEX_MAX_PAGE_LIMIT ||
    (options.cursor !== undefined && (options.cursor.length < 1 || options.cursor.length > 2_048 || !INDEX_CURSOR.test(options.cursor)))
  )
    throw new Error("Sentinel incident index pagination is invalid");
  const iterator = kv.list<SentinelIncidentIndexRow>({ prefix: SENTINEL_INCIDENT_INDEX_PREFIX }, { cursor: options.cursor, limit });
  const rows: SentinelIncidentIndexRow[] = [];
  for await (const entry of iterator) {
    const expectedKey = [...SENTINEL_INCIDENT_INDEX_PREFIX, entry.value.fingerprint];
    if (!isSentinelIncidentIndexRow(entry.value) || entry.key.length !== expectedKey.length || expectedKey.some((part, index) => entry.key[index] !== part))
      throw new Error("Sentinel incident index record is invalid");
    if (options.incidentId !== undefined && entry.value.incident_id !== options.incidentId) continue;
    rows.push(entry.value);
    if (rows.length >= limit) break;
  }
  return { rows, cursor: iterator.cursor || null };
};

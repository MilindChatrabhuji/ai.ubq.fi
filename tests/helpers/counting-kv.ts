import { KvU64 } from "#kv";
import type {
  AtomicOperation,
  KvCommitError,
  KvCommitResult,
  KvEntry,
  KvEntryMaybe,
  KvKey,
  KvKeyPart,
  KvListIterator,
  KvListOptions,
  KvListSelector,
} from "#kv";
type StoredEntry = {
  key: KvKey;
  value: unknown;
  versionstamp: string;
};

type AtomicMutation = { kind: "set"; key: KvKey; value: unknown } | { kind: "delete"; key: KvKey } | { kind: "sum"; key: KvKey; value: bigint };

export type KvMeasurementClassification = "mandatory_correctness" | "optional_telemetry" | "background";

export type KvMeasurementContext = Readonly<{
  authKind: string;
  outcome: string;
}>;

export type KvCommandName = "get" | "getMany" | "set" | "delete" | "list" | "atomic.commit";

export type KvCommandRecord = Readonly<{
  scenario: string | null;
  command: KvCommandName;
  classification: KvMeasurementClassification;
  keys: readonly KvKey[];
  keyCount: number;
  atomicChecks: number;
  atomicMutations: number;
  atomicResult: "committed" | "conflict" | "failed" | null;
}>;

export type KvOperationBudget = Readonly<{
  scenario: string;
  auth_kind: string;
  outcome: string;
  commands: number;
  read_commands: number;
  write_mutations: number;
  atomic_commits: number;
  atomic_checks: number;
  atomic_mutations: number;
  mandatory_correctness_commands: number;
  optional_telemetry_commands: number;
  background_commands: number;
  serialized_request_bytes: number;
  upstream_response_bytes: number;
  latency_ms: number | null;
}>;

const encodeKey = (key: KvKey): string => JSON.stringify(key);

const clone = <T>(value: T): T => {
  if (value instanceof KvU64) return new KvU64(value.value) as T;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

const startsWithKey = (key: KvKey, prefix: KvKey): boolean => prefix.every((part, index) => Object.is(part, key[index]));

const keyPartText = (part: KvKeyPart): string => {
  if (typeof part === "string" || typeof part === "number" || typeof part === "bigint" || typeof part === "boolean") {
    return String(part);
  }
  if (part instanceof Uint8Array) return Array.from(part).join(",");
  return String(part);
};

/**
 * Categories are intentionally conservative. A key that is not known to be
 * optional stays outside the optional-telemetry bucket, so test reports never
 * present a correctness write as safely removable telemetry.
 */
export const classifyKvKey = (key: KvKey): KvMeasurementClassification => {
  const parts = key.map(keyPartText);
  const joined = parts.join("/").toLowerCase();
  if (joined.includes("prompt_cache") || joined.includes("telemetry") || joined.includes("provider_health") || joined.includes("provider_capacity")) {
    return "optional_telemetry";
  }
  if (
    joined.includes("api_key_usage") ||
    joined.includes("api_keys") ||
    joined.includes("runtime_config") ||
    joined.includes("codex_auth") ||
    joined.includes("kernel") ||
    joined.includes("idempotency")
  ) {
    return "mandatory_correctness";
  }
  return "background";
};

const atomicClassification = (checks: { key: KvKey }[], mutations: AtomicMutation[]): KvMeasurementClassification => {
  const classifications = [...checks.map((entry) => classifyKvKey(entry.key)), ...mutations.map((mutation) => classifyKvKey(mutation.key))];
  if (classifications.includes("mandatory_correctness")) return "mandatory_correctness";
  if (classifications.includes("optional_telemetry")) return "optional_telemetry";
  return "background";
};

const emptyBudget = (context: KvMeasurementContext): KvOperationBudget => ({
  scenario: `${context.authKind}:${context.outcome}`,
  auth_kind: context.authKind,
  outcome: context.outcome,
  commands: 0,
  read_commands: 0,
  write_mutations: 0,
  atomic_commits: 0,
  atomic_checks: 0,
  atomic_mutations: 0,
  mandatory_correctness_commands: 0,
  optional_telemetry_commands: 0,
  background_commands: 0,
  serialized_request_bytes: 0,
  upstream_response_bytes: 0,
  latency_ms: null,
});

/**
 * A test-only in-memory Kv substitute. It records every public KV
 * command and each atomic commit while keeping the same CAS boundary used by
 * the V3 ledger tests. Seeds are deliberately uncounted so a scenario budget
 * starts at ingress rather than fixture construction.
 */
export class CountingKv {
  readonly commands: KvCommandRecord[] = [];
  readonly entries = new Map<string, StoredEntry>();
  #nextVersion = 0;
  #activeScenario: string | null = null;
  #budgets = new Map<string, KvOperationBudget>();

  clearData(): void {
    this.entries.clear();
    this.#nextVersion = 0;
  }

  clearMeasurements(): void {
    this.commands.length = 0;
    this.#budgets.clear();
    this.#activeScenario = null;
  }

  seed(key: KvKey, value: unknown): void {
    this.entries.set(encodeKey(key), {
      key: clone(key),
      value: clone(value),
      versionstamp: this.#nextVersionstamp(),
    });
  }

  beginMeasurement(context: KvMeasurementContext): () => void {
    if (this.#activeScenario !== null) throw new Error(`measurement already active: ${this.#activeScenario}`);
    const scenario = `${context.authKind}:${context.outcome}`;
    if (!this.#budgets.has(scenario)) this.#budgets.set(scenario, emptyBudget(context));
    this.#activeScenario = scenario;
    return () => {
      if (this.#activeScenario !== scenario) throw new Error(`measurement ended out of order: ${scenario}`);
      this.#activeScenario = null;
    };
  }

  setLatency(milliseconds: number): void {
    const budget = this.#activeBudget();
    if (!budget) return;
    this.#budgets.set(budget.scenario, { ...budget, latency_ms: Math.max(0, Math.round(milliseconds)) });
  }

  recordSerializedRequestBytes(bytes: number): void {
    this.#addBytes("serialized_request_bytes", bytes);
  }

  recordUpstreamResponseBytes(bytes: number): void {
    this.#addBytes("upstream_response_bytes", bytes);
  }

  budgets(): KvOperationBudget[] {
    return [...this.#budgets.values()].sort((left, right) => left.scenario.localeCompare(right.scenario));
  }

  get<T = unknown>(key: KvKey, _options?: Readonly<{ consistency?: "strong" | "eventual" }>): Promise<KvEntryMaybe<T>> {
    this.#record("get", classifyKvKey(key), [key]);
    const entry = this.entries.get(encodeKey(key));
    return Promise.resolve({
      key: clone(key),
      value: entry ? (clone(entry.value) as T) : null,
      versionstamp: entry?.versionstamp ?? null,
    } as KvEntryMaybe<T>);
  }

  getMany<T extends readonly unknown[]>(
    keys: readonly KvKey[],
    _options?: Readonly<{ consistency?: "strong" | "eventual" }>
  ): Promise<{ [K in keyof T]: KvEntryMaybe<T[K]> }> {
    const classification = this.#classifyCommands(keys);
    this.#record("getMany", classification, keys);
    return Promise.resolve(
      keys.map((key) => {
        const entry = this.entries.get(encodeKey(key));
        return {
          key: clone(key),
          value: entry ? clone(entry.value) : null,
          versionstamp: entry?.versionstamp ?? null,
        };
      }) as { [K in keyof T]: KvEntryMaybe<T[K]> }
    );
  }

  set(key: KvKey, value: unknown, _options?: Readonly<{ expireIn?: number }>): Promise<KvCommitResult> {
    this.#record("set", classifyKvKey(key), [key], { writeMutations: 1 });
    const versionstamp = this.#nextVersionstamp();
    this.entries.set(encodeKey(key), { key: clone(key), value: clone(value), versionstamp });
    return Promise.resolve({ ok: true, versionstamp });
  }

  delete(key: KvKey): Promise<void> {
    this.#record("delete", classifyKvKey(key), [key], { writeMutations: 1 });
    this.entries.delete(encodeKey(key));
    this.#nextVersionstamp();
    return Promise.resolve();
  }

  list<T = unknown>(selector: KvListSelector, _options?: KvListOptions): KvListIterator<T> {
    const prefix = "prefix" in selector ? selector.prefix : [];
    this.#record("list", classifyKvKey(prefix), [prefix]);
    const selected = [...this.entries.values()]
      .filter((entry) => startsWithKey(entry.key, prefix))
      .sort((left, right) => encodeKey(left.key).localeCompare(encodeKey(right.key)));
    const iterator = (function* (): Generator<KvEntry<T>> {
      for (const entry of selected) {
        yield {
          key: clone(entry.key),
          value: clone(entry.value) as T,
          versionstamp: entry.versionstamp,
        };
      }
    })() as unknown as KvListIterator<T>;
    Object.defineProperty(iterator, "cursor", { get: () => "" });
    return iterator;
  }

  atomic(): AtomicOperation {
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const mutations: AtomicMutation[] = [];
    const operation = {
      check: (entry: { key: KvKey; versionstamp: string | null }) => {
        checks.push({ key: clone(entry.key), versionstamp: entry.versionstamp });
        return operation;
      },
      set: (key: KvKey, value: unknown, _options?: Readonly<{ expireIn?: number }>) => {
        mutations.push({ kind: "set", key: clone(key), value: clone(value) });
        return operation;
      },
      delete: (key: KvKey) => {
        mutations.push({ kind: "delete", key: clone(key) });
        return operation;
      },
      sum: (key: KvKey, value: bigint) => {
        mutations.push({ kind: "sum", key: clone(key), value });
        return operation;
      },
      commit: (): Promise<KvCommitResult | KvCommitError> => {
        const classification = atomicClassification(checks, mutations);
        const changed = checks.some((check) => {
          const current = this.entries.get(encodeKey(check.key));
          return (current?.versionstamp ?? null) !== check.versionstamp;
        });
        if (changed) {
          this.#record("atomic.commit", classification, [...checks.map((check) => check.key), ...mutations.map((mutation) => mutation.key)], {
            atomicChecks: checks.length,
            atomicMutations: mutations.length,
            atomicResult: "conflict",
          });
          return Promise.resolve({ ok: false } as KvCommitError);
        }
        const versionstamp = this.#nextVersionstamp();
        for (const mutation of mutations) {
          const encoded = encodeKey(mutation.key);
          if (mutation.kind === "delete") {
            this.entries.delete(encoded);
          } else if (mutation.kind === "set") {
            this.entries.set(encoded, { key: clone(mutation.key), value: clone(mutation.value), versionstamp });
          } else {
            const current = this.entries.get(encoded)?.value;
            const currentValue = current instanceof KvU64 ? current.value : 0n;
            this.entries.set(encoded, {
              key: clone(mutation.key),
              value: new KvU64(currentValue + mutation.value),
              versionstamp,
            });
          }
        }
        this.#record("atomic.commit", classification, [...checks.map((check) => check.key), ...mutations.map((mutation) => mutation.key)], {
          writeMutations: mutations.length,
          atomicChecks: checks.length,
          atomicMutations: mutations.length,
          atomicResult: "committed",
        });
        return Promise.resolve({ ok: true, versionstamp });
      },
    };
    return operation as unknown as AtomicOperation;
  }

  close(): void {}

  #classifyCommands(keys: readonly KvKey[]): KvMeasurementClassification {
    if (keys.some((key) => classifyKvKey(key) === "mandatory_correctness")) return "mandatory_correctness";
    if (keys.some((key) => classifyKvKey(key) === "optional_telemetry")) return "optional_telemetry";
    return "background";
  }

  #nextVersionstamp(): string {
    this.#nextVersion += 1;
    return String(this.#nextVersion).padStart(20, "0");
  }

  #activeBudget(): KvOperationBudget | null {
    return this.#activeScenario ? (this.#budgets.get(this.#activeScenario) ?? null) : null;
  }

  #addBytes(field: "serialized_request_bytes" | "upstream_response_bytes", bytes: number): void {
    const budget = this.#activeBudget();
    if (!budget) return;
    const amount = Math.max(0, Math.trunc(bytes));
    this.#budgets.set(budget.scenario, { ...budget, [field]: budget[field] + amount });
  }

  #record(
    command: KvCommandName,
    classification: KvMeasurementClassification,
    keys: readonly KvKey[],
    details: Readonly<{
      writeMutations?: number;
      atomicChecks?: number;
      atomicMutations?: number;
      atomicResult?: "committed" | "conflict" | "failed";
    }> = {}
  ): void {
    this.commands.push({
      scenario: this.#activeScenario,
      command,
      classification,
      keys: keys.map((key) => clone(key)),
      keyCount: keys.length,
      atomicChecks: details.atomicChecks ?? 0,
      atomicMutations: details.atomicMutations ?? 0,
      atomicResult: details.atomicResult ?? null,
    });
    const budget = this.#activeBudget();
    if (!budget) return;
    const next = {
      ...budget,
      commands: budget.commands + 1,
      read_commands: budget.read_commands + (command === "get" || command === "getMany" || command === "list" ? keys.length : 0),
      write_mutations: budget.write_mutations + (details.writeMutations ?? 0),
      atomic_commits: budget.atomic_commits + (command === "atomic.commit" ? 1 : 0),
      atomic_checks: budget.atomic_checks + (details.atomicChecks ?? 0),
      atomic_mutations: budget.atomic_mutations + (details.atomicMutations ?? 0),
      mandatory_correctness_commands: budget.mandatory_correctness_commands + (classification === "mandatory_correctness" ? 1 : 0),
      optional_telemetry_commands: budget.optional_telemetry_commands + (classification === "optional_telemetry" ? 1 : 0),
      background_commands: budget.background_commands + (classification === "background" ? 1 : 0),
    };
    this.#budgets.set(budget.scenario, next);
  }
}

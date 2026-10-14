import { openKv } from "#kv";
import type {
  AtomicCheck,
  AtomicOperation,
  Kv,
  KvCommitError,
  KvCommitResult,
  KvEntry,
  KvEntryMaybe,
  KvKey,
  KvKeyPart,
  KvListIterator,
  KvListOptions,
  KvListSelector,
  KvMutation,
} from "#kv";
/**
 * In-memory `Kv` substitute for the sentinel replay coverage tests.
 *
 * This specialized fake keeps the
 * versionstamp/CAS boundary the production code depends on, hands out
 * versionstamps in strictly increasing order, returns the same
 * `{ key, value: null, versionstamp: null }` shape for absent keys, and orders
 * `list` results the way Deno KV does (byte arrays, then strings, then
 * numbers) with a resumable cursor.
 *
 * Deliberately unsupported: TTLs (`expireIn` is accepted and ignored, because
 * neither the real KV nor this store exposes remaining TTL to a reader),
 * `watch`, `enqueue`/`listenQueue` and the `sum`/`min`/`max` mutations are not
 * used by any sentinel module and throw when called, so a future caller
 * cannot mistake silence for support.
 */

type StoredEntry = Readonly<{ key: KvKey; value: unknown; versionstamp: string }>;

/** Internal storage shared with the atomic-operation implementation. */
export type SentinelKvStorage = {
  entries: Map<string, StoredEntry>;
  nextVersionstamp: () => string;
};

const UNSUPPORTED = "Sentinel in-memory KV does not support this operation";

const clone = <T>(value: T): T => structuredClone(value);

const keyPartValue = (part: KvKeyPart): unknown => {
  if (part instanceof Uint8Array) return ["bytes", [...part]];
  if (typeof part === "bigint") return ["bigint", part.toString()];
  return part;
};

const keyText = (key: KvKey): string => JSON.stringify(key.map(keyPartValue));

/** Deno KV orders key parts by type first: bytes, string, number, bigint, boolean. */
const partRank = (part: KvKeyPart): number => {
  if (part instanceof Uint8Array) return 0;
  if (typeof part === "string") return 1;
  if (typeof part === "number") return 2;
  if (typeof part === "bigint") return 3;
  return 4;
};

const compareOrdered = (left: string | bigint, right: string | bigint): number => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

/** Byte-array parts compare on their comma-joined text, which is monotonic for whole bytes. */
const keyPartText = (part: KvKeyPart): string => (part instanceof Uint8Array ? [...part].join(",") : String(part));

const compareParts = (left: KvKeyPart, right: KvKeyPart): number => {
  const rank = partRank(left) - partRank(right);
  if (rank !== 0) return rank;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "bigint" && typeof right === "bigint") return compareOrdered(left, right);
  return compareOrdered(keyPartText(left), keyPartText(right));
};

const compareKeys = (left: KvKey, right: KvKey): number => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = compareParts(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
};

const matchesPrefix = (key: KvKey, prefix: KvKey): boolean => {
  if (prefix.length > key.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (compareParts(prefix[index], key[index]) !== 0) return false;
  }
  return true;
};

/** One iteration over a frozen snapshot of the matching keys, with a resumable cursor. */
class SentinelKvListIterator<T> implements KvListIterator<T> {
  #entries: StoredEntry[];
  #index = 0;
  #cursor = "";

  constructor(entries: StoredEntry[]) {
    this.#entries = entries;
  }

  get cursor(): string {
    if (this.#index === 0) throw new Error("Cannot get cursor before first iteration");
    return this.#cursor;
  }

  next(): Promise<IteratorResult<KvEntry<T>, undefined>> {
    const entry: StoredEntry | undefined = this.#entries.at(this.#index);
    this.#index += 1;
    if (entry === undefined) {
      this.#cursor = "";
      return Promise.resolve({ done: true, value: undefined });
    }
    this.#cursor = encodeCursor(entry.key);
    return Promise.resolve({ done: false, value: { ...entry, value: entry.value as T } });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<KvEntry<T>> {
    return this;
  }
}

// Base64 padding only ever trails, so removing every "=" is the same operation
// as stripping the 1-2 character pad, without a backtracking pattern.
const encodeCursor = (after: KvKey): string => btoa(keyText(after)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const decodeCursor = (cursor: string): KvKey => JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))) as KvKey;

class SentinelAtomicOperation implements AtomicOperation {
  #storage: SentinelKvStorage;
  #checks: AtomicCheck[] = [];
  #mutations: KvMutation[] = [];

  constructor(storage: SentinelKvStorage) {
    this.#storage = storage;
  }

  check(...checks: AtomicCheck[]): this {
    this.#checks.push(...checks);
    return this;
  }

  mutate(...mutations: KvMutation[]): this {
    this.#mutations.push(...mutations);
    return this;
  }

  sum(_key: KvKey, _n: bigint): this {
    throw new Error(UNSUPPORTED);
  }

  min(_key: KvKey, _n: bigint): this {
    throw new Error(UNSUPPORTED);
  }

  max(_key: KvKey, _n: bigint): this {
    throw new Error(UNSUPPORTED);
  }

  set(key: KvKey, value: unknown, _options?: { expireIn?: number }): this {
    return this.mutate({ type: "set", key, value });
  }

  delete(key: KvKey): this {
    return this.mutate({ type: "delete", key });
  }

  enqueue(_value: unknown, _options?: { delay?: number; keysIfUndelivered?: KvKey[] }): this {
    throw new Error(UNSUPPORTED);
  }

  commit(): Promise<KvCommitResult | KvCommitError> {
    const conflicted = this.#checks.some((check) => (this.#storage.entries.get(keyText(check.key))?.versionstamp ?? null) !== check.versionstamp);
    if (conflicted) return Promise.resolve({ ok: false });
    const versionstamp = this.#storage.nextVersionstamp();
    for (const mutation of this.#mutations) {
      if (mutation.type === "delete") this.#storage.entries.delete(keyText(mutation.key));
      else if (mutation.type === "set")
        this.#storage.entries.set(keyText(mutation.key), { key: [...mutation.key], value: clone(mutation.value), versionstamp });
      else throw new Error(UNSUPPORTED);
    }
    return Promise.resolve({ ok: true, versionstamp });
  }
}

export class SentinelKvStub implements Kv {
  readonly storage: SentinelKvStorage = { entries: new Map<string, StoredEntry>(), nextVersionstamp: () => this.#nextVersionstamp() };
  #sequence = 0;

  #nextVersionstamp(): string {
    this.#sequence += 1;
    return String(this.#sequence).padStart(20, "0");
  }

  get<T = unknown>(key: KvKey): Promise<KvEntryMaybe<T>> {
    const entry = this.storage.entries.get(keyText(key));
    if (entry === undefined) return Promise.resolve({ key: [...key], value: null, versionstamp: null } as KvEntryMaybe<T>);
    return Promise.resolve({ key: [...key], value: clone(entry.value) as T, versionstamp: entry.versionstamp });
  }

  getMany<T extends readonly unknown[]>(keys: readonly [...{ [K in keyof T]: KvKey }]): Promise<{ [K in keyof T]: KvEntryMaybe<T[K]> }> {
    const entries = keys.map((key) => {
      const entry = this.storage.entries.get(keyText(key));
      return entry === undefined
        ? ({ key: [...key], value: null, versionstamp: null } as KvEntryMaybe<unknown>)
        : ({ key: [...key], value: clone(entry.value), versionstamp: entry.versionstamp } as KvEntryMaybe<unknown>);
    });
    return Promise.resolve(entries as unknown as { [K in keyof T]: KvEntryMaybe<T[K]> });
  }

  set(key: KvKey, value: unknown, _options?: { expireIn?: number }): Promise<KvCommitResult> {
    const versionstamp = this.#nextVersionstamp();
    this.storage.entries.set(keyText(key), { key: [...key], value: clone(value), versionstamp });
    return Promise.resolve({ ok: true, versionstamp });
  }

  delete(key: KvKey): Promise<void> {
    this.storage.entries.delete(keyText(key));
    return Promise.resolve();
  }

  list<T = unknown>(selector: KvListSelector, options?: KvListOptions): KvListIterator<T> {
    const prefix = "prefix" in selector ? selector.prefix : [];
    const start = "start" in selector ? selector.start : undefined;
    const end = "end" in selector ? selector.end : undefined;
    const after = options?.cursor ? decodeCursor(options.cursor) : undefined;
    const limit = options?.limit ?? 100;
    const selected = [...this.storage.entries.values()]
      .filter((entry) => matchesPrefix(entry.key, prefix))
      .filter((entry) => start === undefined || compareKeys(entry.key, start) >= 0)
      .filter((entry) => end === undefined || compareKeys(entry.key, end) < 0)
      .filter((entry) => after === undefined || compareKeys(entry.key, after) > 0)
      .sort((left, right) => compareKeys(left.key, right.key));
    const ordered = options?.reverse ? selected.toReversed() : selected;
    const page = ordered.slice(0, limit).map((entry) => ({ key: clone(entry.key), value: clone(entry.value), versionstamp: entry.versionstamp }));
    return new SentinelKvListIterator<T>(page);
  }

  atomic(): AtomicOperation {
    return new SentinelAtomicOperation(this.storage);
  }

  watch<T extends readonly unknown[]>(
    _keys: readonly [...{ [K in keyof T]: KvKey }],
    _options?: { raw?: boolean }
  ): ReadableStream<{ [K in keyof T]: KvEntryMaybe<T[K]> }> {
    throw new Error(UNSUPPORTED);
  }

  commitVersionstamp(): symbol {
    throw new Error(UNSUPPORTED);
  }

  enqueue(_value: unknown, _options?: { delay?: number; keysIfUndelivered?: KvKey[] }): Promise<KvCommitResult> {
    return Promise.reject(new Error(UNSUPPORTED));
  }

  listenQueue(_handler: (value: unknown) => Promise<void> | void): Promise<void> {
    return Promise.reject(new Error(UNSUPPORTED));
  }

  close(): void {
    this.storage.entries.clear();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/** Native Bun storage is required by the migrated acceptance suite. */
export const hasRuntimeKv = (): boolean => true;

/** Open real disposable storage; tests needing injected faults construct SentinelKvStub directly. */
export const openSentinelTestKv = async (): Promise<Kv> => await openKv(":memory:");

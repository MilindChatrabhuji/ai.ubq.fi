import {
  KvU64,
  type AtomicCheck,
  type AtomicOperation,
  type Kv,
  type KvKey,
  type KvListIterator,
  type KvListOptions,
  type KvListSelector,
  type KvMutation,
} from "@deno/kv";

/** SQLite's native addon reports busy errors rather than waiting for another writer. */
export const retrySqliteBusy = async <T>(run: () => Promise<T> | T): Promise<T> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("database is locked") || Date.now() >= deadline) throw error;
      await Bun.sleep(10);
    }
  }
};

const equalKey = (left: KvKey, right: KvKey): boolean =>
  left.length === right.length &&
  left.every((part, index) => {
    const other = right[index];
    return part instanceof Uint8Array && other instanceof Uint8Array
      ? part.length === other.length && part.every((byte, offset) => byte === other[offset])
      : Object.is(part, other);
  });

/** Validate arithmetic before dispatch and fence every read used by that validation. */
const checkedAtomic = (kv: Kv): AtomicOperation => {
  const checks: AtomicCheck[] = [];
  const mutations: KvMutation[] = [];
  const enqueues: { value: unknown; options: Parameters<AtomicOperation["enqueue"]>[1] }[] = [];
  const operation: AtomicOperation = {
    check: (...items) => {
      checks.push(...items);
      return operation;
    },
    mutate: (...items) => {
      mutations.push(...items);
      return operation;
    },
    set: (key, value, options) => operation.mutate({ type: "set", key, value, ...options }),
    delete: (key) => operation.mutate({ type: "delete", key }),
    sum: (key, value) => operation.mutate({ type: "sum", key, value: new KvU64(value) }),
    min: (key, value) => operation.mutate({ type: "min", key, value: new KvU64(value) }),
    max: (key, value) => operation.mutate({ type: "max", key, value: new KvU64(value) }),
    enqueue: (value, options) => {
      enqueues.push({ value, options });
      return operation;
    },
    commit: () =>
      retrySqliteBusy(async () => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const arithmeticChecks: AtomicCheck[] = [];
          for (let index = 0; index < mutations.length; index += 1) {
            const mutation = mutations[index];
            if (mutation.type !== "sum" && mutation.type !== "min" && mutation.type !== "max") continue;
            if (!(mutation.value instanceof KvU64)) throw new TypeError("Atomic arithmetic requires KvU64 operands");
            const previous = mutations.slice(0, index).findLast((item) => equalKey(item.key, mutation.key));
            if (previous?.type === "delete") continue;
            if (previous?.type === "set") {
              if (!(previous.value instanceof KvU64)) throw new TypeError("Atomic arithmetic requires an absent key or KvU64 value");
              continue;
            }
            if (previous) continue;
            const entry = await kv.get(mutation.key, { consistency: "strong" });
            if (entry.versionstamp !== null && !(entry.value instanceof KvU64)) throw new TypeError("Atomic arithmetic requires an absent key or KvU64 value");
            arithmeticChecks.push(entry);
          }
          const native = kv
            .atomic()
            .check(...checks, ...arithmeticChecks)
            .mutate(...mutations);
          for (const item of enqueues) native.enqueue(item.value, item.options);
          const result = await native.commit();
          if (result.ok || arithmeticChecks.length === 0) return result;
          // A caller's stale CAS is final; only our added arithmetic fences retry.
          const current = await kv.getMany(
            checks.map((item) => item.key),
            { consistency: "strong" }
          );
          if (checks.some((item, index) => item.versionstamp !== current[index].versionstamp)) return result;
          if (Date.now() >= deadline) throw new Error("Atomic arithmetic contention did not settle before its deadline");
        }
      }),
  };
  return operation;
};

const checkedList = <T>(kv: Kv, selector: KvListSelector, options: KvListOptions = {}): KvListIterator<T> => {
  // Retain the SDK's selector/option validation before adjusting its scan start.
  const validated = kv.list<T>(selector, options);
  let nativeSelector = selector;
  if ("prefix" in selector && !("start" in selector)) {
    // An exact-prefix row can stall the SDK when it consumes the whole batch.
    // Empty bytes are the smallest legal extension part in the native tuple codec.
    const start = [...selector.prefix, new Uint8Array()];
    nativeSelector = "end" in selector ? { start, end: selector.end } : { prefix: selector.prefix, start };
  }
  const iterator = nativeSelector === selector ? validated : kv.list<T>(nativeSelector, options);
  let cursor = options.cursor || undefined;
  let yielded = 0;
  return {
    get cursor() {
      if (cursor === undefined) throw new Error("Cannot get cursor before first iteration");
      return cursor;
    },
    next: async () => {
      const result = await retrySqliteBusy(() => iterator.next());
      if (result.done) {
        // Hitting the requested page limit retains a continuation; exhausting
        // the underlying range clears it, including a scan with no rows.
        if (options.limit === undefined || yielded < options.limit) cursor = "";
      } else {
        yielded += 1;
        cursor = iterator.cursor;
      }
      return result;
    },
    return: async () => (await iterator.return?.()) ?? { done: true, value: undefined },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
};

/** Preserve the native API while guarding arithmetic rollback and SQLite contention. */
export const guardNativeKv = (kv: Kv): Kv => {
  // Capture methods before a caller can instrument the writable public facade.
  const native: Kv = {
    get: kv.get.bind(kv),
    getMany: kv.getMany.bind(kv),
    set: kv.set.bind(kv),
    delete: kv.delete.bind(kv),
    list: kv.list.bind(kv),
    atomic: kv.atomic.bind(kv),
    enqueue: kv.enqueue.bind(kv),
    listenQueue: kv.listenQueue.bind(kv),
    watch: kv.watch.bind(kv),
    close: kv.close.bind(kv),
    [Symbol.dispose]: kv[Symbol.dispose].bind(kv),
  };
  return {
    ...native,
    atomic: () => checkedAtomic(native),
    set: async (key, value, options) => {
      const result = await checkedAtomic(native).set(key, value, options).commit();
      if (!result.ok) throw new Error("Unconditional KV set failed");
      return result;
    },
    delete: async (key) => {
      if (!(await checkedAtomic(native).delete(key).commit()).ok) throw new Error("Unconditional KV delete failed");
    },
    get: <T>(...args: Parameters<Kv["get"]>) => retrySqliteBusy(() => native.get<T>(...args)),
    getMany: <T extends readonly unknown[]>(keys: readonly [...{ [K in keyof T]: KvKey }], options?: Parameters<Kv["getMany"]>[1]) =>
      retrySqliteBusy(() => native.getMany<T>(keys, options)),
    list: <T>(selector: KvListSelector, options?: KvListOptions) => checkedList<T>(native, selector, options),
  };
};

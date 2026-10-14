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
  return {
    get cursor() {
      return iterator.cursor;
    },
    next: () => retrySqliteBusy(() => iterator.next()),
    return: async () => (await iterator.return?.()) ?? { done: true, value: undefined },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
};

/** Preserve the native API while guarding arithmetic rollback and SQLite contention. */
export const guardNativeKv = (kv: Kv): Kv =>
  new Proxy(kv, {
    get(target, property) {
      if (property === "atomic") return () => checkedAtomic(target);
      if (property === "set") return (key: KvKey, value: unknown, options?: { expireIn?: number }) => checkedAtomic(target).set(key, value, options).commit();
      if (property === "delete") return async (key: KvKey) => void (await checkedAtomic(target).delete(key).commit());
      if (property === "get") return <T>(...args: Parameters<Kv["get"]>) => retrySqliteBusy(() => target.get<T>(...args));
      if (property === "getMany") return (...args: Parameters<Kv["getMany"]>) => retrySqliteBusy(() => target.getMany(...args));
      if (property === "list") return <T>(selector: KvListSelector, options?: KvListOptions) => checkedList<T>(target, selector, options);
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

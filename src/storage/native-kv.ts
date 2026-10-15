import { type AtomicOperation, type Kv, type KvKey, type KvListIterator, type KvListOptions, type KvListSelector } from "@deno/kv";

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

/** The verified backend rolls back each failed write; preserve caller budgets exactly. */
const checkedAtomic = (kv: Kv): AtomicOperation => {
  const operation = kv.atomic();
  const commit = operation.commit.bind(operation);
  operation.commit = async () => {
    try {
      return await retrySqliteBusy(commit);
    } catch (error) {
      if (error instanceof Error && /^Failed to perform '(sum|min|max)' mutation on a non-U64 value in the database$/.test(error.message)) {
        throw new TypeError("Atomic arithmetic requires an absent key or KvU64 value", { cause: error });
      }
      throw error;
    }
  };
  return operation;
};

const checkedList = (kv: Kv, selector: KvListSelector, options: KvListOptions = {}): KvListIterator<unknown> => {
  // Retain the SDK's selector/option validation before adjusting its scan start.
  const validated = kv.list(selector, options);
  let nativeSelector = selector;
  if ("prefix" in selector && !("start" in selector)) {
    // An exact-prefix row can stall the SDK when it consumes the whole batch.
    // Empty bytes are the smallest legal extension part in the native tuple codec.
    const start = [...selector.prefix, new Uint8Array()];
    nativeSelector = "end" in selector ? { start, end: selector.end } : { prefix: selector.prefix, start };
  }
  const iterator = nativeSelector === selector ? validated : kv.list(nativeSelector, options);
  let cursor = options.cursor ?? undefined;
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
    list: <T>(selector: KvListSelector, options?: KvListOptions) => checkedList(native, selector, options) as KvListIterator<T>,
  };
};

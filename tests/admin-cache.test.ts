import { test } from "bun:test";
import assert from "node:assert/strict";

import { createAdminSnapshotCache } from "../static/admin-cache.js";

type StorageTransaction = Readonly<{ oncomplete?: () => void }>;

type CursorRequest = {
  onerror?: () => void;
  onsuccess?: () => void;
  result?: null;
};

/** IndexedDB settles a transaction one microtask after its request completes. */
const completeTransactionSoon = (transaction: StorageTransaction): void => {
  queueMicrotask(() => transaction.oncomplete?.());
};

/** Empties the store through an empty cursor and settles the transaction. */
const emptyCursorRequest = (records: Map<string, unknown>, transaction: StorageTransaction): CursorRequest => {
  const request: CursorRequest = {};
  queueMicrotask(() => {
    records.clear();
    request.result = null;
    request.onsuccess?.();
    completeTransactionSoon(transaction);
  });
  return request;
};

/** Same as {@link emptyCursorRequest}, settled after a delay (deferred invalidation). */
const deferredEmptyCursorRequest = (records: Map<string, unknown>, transaction: StorageTransaction): CursorRequest => {
  const request: CursorRequest = {};
  setTimeout(() => {
    records.clear();
    request.result = null;
    request.onsuccess?.();
    completeTransactionSoon(transaction);
  }, 10);
  return request;
};

test("admin cache retries IndexedDB after a temporary open failure", async () => {
  let openCalls = 0;
  const transaction: {
    onabort?: () => void;
    oncomplete?: () => void;
    onerror?: () => void;
    objectStore: () => { put: () => void };
  } = {
    objectStore: () => ({
      put: () => {
        queueMicrotask(() => transaction.oncomplete?.());
      },
    }),
  };
  const database = { transaction: () => transaction };
  const indexedDb = {
    open: () => {
      openCalls += 1;
      if (openCalls === 1) {
        const request = {
          error: new Error("temporarily blocked"),
          onerror: undefined as (() => void) | undefined,
        };
        queueMicrotask(() => request.onerror?.());
        return request;
      }
      const request = {
        onsuccess: undefined as (() => void) | undefined,
        result: database,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  const cache = createAdminSnapshotCache({ indexedDB: indexedDb });

  assert.equal(await cache.write("scope", "key", { cached: true }), false);
  assert.equal(await cache.write("scope", "key", { cached: true }), true);
  assert.equal(openCalls, 2);
});

test("admin cache serializes invalidation behind a pending write", async () => {
  const records = new Map<string, unknown>();
  const database = {
    transaction: () => {
      const transaction: {
        onabort?: () => void;
        oncomplete?: () => void;
        onerror?: () => void;
        objectStore: () => {
          put: (record: { id: string }) => void;
          index: () => {
            openCursor: () => {
              onerror?: () => void;
              onsuccess?: () => void;
              result?: null;
            };
          };
        };
      } = {
        objectStore: () => store,
      };
      const store = {
        put: (record: { id: string }) => {
          setTimeout(() => {
            records.set(record.id, record);
            transaction.oncomplete?.();
          }, 10);
        },
        index: () => ({
          openCursor: () => emptyCursorRequest(records, transaction),
        }),
      };
      return transaction;
    },
  };
  const indexedDb = {
    open: () => {
      const request = {
        onsuccess: undefined as (() => void) | undefined,
        result: database,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  const cache = createAdminSnapshotCache({
    indexedDB: indexedDb,
    keyRange: { only: (scope: string) => scope },
  });

  const pendingWrite = cache.write("scope", "key", { cached: true });
  const pendingClear = cache.clear("scope");

  assert.equal(await pendingWrite, true);
  assert.equal(await pendingClear, true);
  assert.equal(records.size, 0);
});

test("admin cache reads wait for a queued invalidation", async () => {
  const records = new Map<string, unknown>();
  const database = {
    transaction: () => {
      const transaction: {
        onabort?: () => void;
        oncomplete?: () => void;
        onerror?: () => void;
        objectStore: () => {
          get: (id: string) => {
            onerror?: () => void;
            onsuccess?: () => void;
            result?: unknown;
          };
          index: () => {
            openCursor: () => {
              onerror?: () => void;
              onsuccess?: () => void;
              result?: null;
            };
          };
          put: (record: { id: string }) => void;
        };
      } = {
        objectStore: () => store,
      };
      const store = {
        get: (id: string) => {
          const request: {
            onerror?: () => void;
            onsuccess?: () => void;
            result?: unknown;
          } = {};
          queueMicrotask(() => {
            request.result = records.get(id);
            request.onsuccess?.();
            completeTransactionSoon(transaction);
          });
          return request;
        },
        index: () => ({
          openCursor: () => deferredEmptyCursorRequest(records, transaction),
        }),
        put: (record: { id: string }) => {
          records.set(record.id, record);
          completeTransactionSoon(transaction);
        },
      };
      return transaction;
    },
  };
  const indexedDb = {
    open: () => {
      const request = {
        onsuccess: undefined as (() => void) | undefined,
        result: database,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  const cache = createAdminSnapshotCache({
    indexedDB: indexedDb,
    keyRange: { only: (scope: string) => scope },
  });

  assert.equal(await cache.write("scope", "key", { cached: true }), true);
  const pendingClear = cache.clear("scope");
  const readAfterClear = cache.read("scope", "key");

  assert.equal(await pendingClear, true);
  assert.equal(await readAfterClear, null);
});

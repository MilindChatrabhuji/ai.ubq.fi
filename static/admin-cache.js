const DATABASE_NAME = "uos_ai.admin-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "responses";
const SCOPE_INDEX = "scope";

/**
 * @template Result
 * @typedef {object} AdminSnapshotRequest
 * @property {Result} [result]
 * @property {unknown} [error]
 * @property {((event: Event) => void) | null} [onsuccess]
 * @property {((event: Event) => void) | null} [onerror]
 */

/**
 * @typedef {object} AdminSnapshotCursor
 * @property {() => unknown} delete
 * @property {() => void} continue
 */

/**
 * @typedef {object} AdminSnapshotStore
 * @property {(key: string) => AdminSnapshotRequest<unknown>} [get]
 * @property {(record: { id: string, scope: string, key: string, payload: unknown, savedAt: number }) => unknown} [put]
 * @property {(name: string) => { openCursor(query: IDBValidKey | IDBKeyRange): AdminSnapshotRequest<AdminSnapshotCursor | null> }} [index]
 * @property {{ contains(name: string): boolean }} [indexNames]
 * @property {(name: string, path: string, options: { unique: boolean }) => unknown} [createIndex]
 */

/**
 * @typedef {object} AdminSnapshotTransaction
 * @property {(name: string) => AdminSnapshotStore} objectStore
 * @property {unknown} [error]
 * @property {((event: Event) => void) | null} [oncomplete]
 * @property {((event: Event) => void) | null} [onabort]
 * @property {((event: Event) => void) | null} [onerror]
 */

/**
 * @typedef {object} AdminSnapshotDatabase
 * @property {(name: string, mode: "readonly" | "readwrite") => AdminSnapshotTransaction} transaction
 * @property {{ contains(name: string): boolean }} [objectStoreNames]
 * @property {(name: string, options: { keyPath: string }) => AdminSnapshotStore} [createObjectStore]
 */

/**
 * @typedef {AdminSnapshotRequest<AdminSnapshotDatabase> & {
 *   transaction?: AdminSnapshotTransaction | null,
 *   onupgradeneeded?: ((event: IDBVersionChangeEvent) => void) | null,
 *   onblocked?: ((event: IDBVersionChangeEvent) => void) | null
 * }} AdminSnapshotOpenRequest
 */

/**
 * Optional capabilities match the existing failure paths and feature-specific fixtures.
 * @typedef {object} AdminSnapshotEnvironment
 * @property {{ open(name: string, version?: number): AdminSnapshotOpenRequest }} [indexedDB]
 * @property {{ only(scope: string): IDBValidKey | IDBKeyRange }} [keyRange]
 */

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

const requestResult = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });

const transactionDone = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });

/**
 * Stores admin read responses only. Callers must provide a scoped, non-secret
 * principal fingerprint; raw tokens, cookies, and auth responses never enter
 * this database.
 * @param {AdminSnapshotEnvironment} [environment]
 */
export const createAdminSnapshotCache = ({
  indexedDB = globalThis.indexedDB,
  keyRange = globalThis.IDBKeyRange,
} = {}) => {
  let databasePromise = null;
  let mutationQueue = Promise.resolve();

  const openDatabase = () => {
    if (!indexedDB || typeof indexedDB.open !== "function") return Promise.resolve(null);
    if (databasePromise) return databasePromise;
    const opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "id" });
        if (!store.indexNames.contains(SCOPE_INDEX)) store.createIndex(SCOPE_INDEX, "scope", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable"));
      request.onblocked = () => reject(new Error("IndexedDB is blocked"));
    });
    const failedOpen = opening.catch(() => {
      if (databasePromise === failedOpen) databasePromise = null;
      return null;
    });
    databasePromise = failedOpen;
    return databasePromise;
  };

  const enqueueMutation = (operation) => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  };

  const read = async (scope, key) => {
    if (!isNonEmptyString(scope) || !isNonEmptyString(key)) return null;
    try {
      await mutationQueue;
      const database = await openDatabase();
      if (!database) return null;
      const transaction = database.transaction(STORE_NAME, "readonly");
      const record = await requestResult(transaction.objectStore(STORE_NAME).get(`${scope}\u0000${key}`));
      await transactionDone(transaction);
      if (
        !record ||
        record.scope !== scope ||
        record.key !== key ||
        !Number.isFinite(record.savedAt) ||
        !("payload" in record)
      )
        return null;
      return { payload: record.payload, savedAt: record.savedAt };
    } catch {
      return null;
    }
  };

  const write = (scope, key, payload, savedAt = Date.now()) => {
    if (!isNonEmptyString(scope) || !isNonEmptyString(key) || !Number.isFinite(savedAt)) return false;
    return enqueueMutation(async () => {
      try {
        const database = await openDatabase();
        if (!database) return false;
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put({
          id: `${scope}\u0000${key}`,
          scope,
          key,
          payload,
          savedAt,
        });
        await transactionDone(transaction);
        return true;
      } catch {
        return false;
      }
    });
  };

  const clear = (scope) => {
    if (!isNonEmptyString(scope)) return false;
    if (!keyRange || typeof keyRange.only !== "function") return false;
    return enqueueMutation(async () => {
      try {
        const database = await openDatabase();
        if (!database) return false;
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index(SCOPE_INDEX);
        const request = index.openCursor(keyRange.only(scope));
        await new Promise((resolve, reject) => {
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve();
              return;
            }
            cursor.delete();
            cursor.continue();
          };
          request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
        });
        await transactionDone(transaction);
        return true;
      } catch {
        return false;
      }
    });
  };

  return { read, write, clear };
};

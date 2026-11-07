/**
 * Local-only screenshot storage.
 *
 * Captured screenshots are handed from the service worker to the editor tab
 * through IndexedDB (same extension origin, shared by the worker and all
 * extension pages). Nothing is ever uploaded.
 *
 * Records are kept as a small local history instead of being deleted when the
 * editor opens them, so refreshing the editor tab (or reopening a capture from
 * history) keeps working. The blob is stored as a real `Blob` (structured clone)
 * instead of base64 so multi-megabyte screenshots don't inflate by ~33%.
 */
import type {
  ScreenshotHistoryEntry,
  ScreenshotRecord,
} from "../types";

const DATABASE_NAME = "snapdraw";
const DATABASE_VERSION = 1;
const SCREENSHOTS_STORE = "screenshots";
const CREATED_AT_INDEX = "createdAt";

/**
 * How many captures the local history keeps. Older entries (and anything older
 * than `HISTORY_RETENTION_MS`) are pruned automatically so the extension can
 * never grow unbounded.
 */
export const HISTORY_LIMIT = 20;
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Local storage (IndexedDB) is not available."));
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SCREENSHOTS_STORE)) {
        const store = database.createObjectStore(SCREENSHOTS_STORE, {
          keyPath: "id",
        });
        store.createIndex(CREATED_AT_INDEX, "createdAt");
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };

    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("Could not open local storage."));
    };

    request.onblocked = () => {
      // Another tab still holds an old version open – it will close itself on
      // `versionchange`, so we simply keep waiting for `onsuccess`.
    };
  });

  return databasePromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local storage request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Local storage transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Local storage transaction was aborted."));
  });
}

/** Persists a capture. Overwrites an existing record with the same id. */
export async function putScreenshot(record: ScreenshotRecord): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SCREENSHOTS_STORE, "readwrite");
  transaction.objectStore(SCREENSHOTS_STORE).put(record);
  await transactionDone(transaction);
}

/** Reads a capture by session id. Resolves `undefined` when it is gone. */
export async function getScreenshot(
  id: string,
): Promise<ScreenshotRecord | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(SCREENSHOTS_STORE, "readonly");
  const request = transaction.objectStore(SCREENSHOTS_STORE).get(id);
  const record = await requestToPromise<ScreenshotRecord | undefined>(request);
  return record;
}

/** Deletes one capture (used by the history list). */
export async function deleteScreenshot(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SCREENSHOTS_STORE, "readwrite");
  transaction.objectStore(SCREENSHOTS_STORE).delete(id);
  await transactionDone(transaction);
}

/**
 * Lists the saved captures, newest first. Includes the small thumbnail preview
 * but never the full screenshot blob, so the history list stays cheap.
 */
export async function listScreenshots(): Promise<ScreenshotHistoryEntry[]> {
  const database = await openDatabase();
  const transaction = database.transaction(SCREENSHOTS_STORE, "readonly");
  const request = transaction
    .objectStore(SCREENSHOTS_STORE)
    .index(CREATED_AT_INDEX)
    .getAll();

  const records = await requestToPromise<ScreenshotRecord[]>(request);

  return records
    .map((record) => {
      const { blob: _blob, ...entry } = record;
      return entry;
    })
    .sort((left, right) => right.createdAt - left.createdAt);
}

/**
 * Keeps only the newest `maxEntries` captures (and their blobs). Returns the
 * number of records removed.
 */
export async function trimScreenshots(
  maxEntries: number = HISTORY_LIMIT,
): Promise<number> {
  if (!Number.isFinite(maxEntries) || maxEntries < 1) {
    return 0;
  }

  const total = await countScreenshots();
  const excess = total - maxEntries;
  if (excess <= 0) {
    return 0;
  }

  const database = await openDatabase();
  const transaction = database.transaction(SCREENSHOTS_STORE, "readwrite");
  const index = transaction.objectStore(SCREENSHOTS_STORE).index(CREATED_AT_INDEX);
  const keysRequest = index.getAllKeys();

  keysRequest.onsuccess = () => {
    // The index is ordered oldest → newest; drop the oldest entries.
    for (const key of keysRequest.result.slice(0, excess)) {
      transaction.objectStore(SCREENSHOTS_STORE).delete(key);
    }
  };

  await transactionDone(transaction);
  return excess;
}

/** Removes every saved capture (history "Clear all"). */
export async function clearScreenshots(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SCREENSHOTS_STORE, "readwrite");
  transaction.objectStore(SCREENSHOTS_STORE).clear();
  await transactionDone(transaction);
}

/**
 * Removes captures older than the retention window (30 days by default).
 * Returns the number of records removed.
 */
export async function purgeExpiredScreenshots(
  maxAgeMs: number = HISTORY_RETENTION_MS,
  now: number = Date.now(),
): Promise<number> {
  const database = await openDatabase();
  const transaction = database.transaction(SCREENSHOTS_STORE, "readwrite");
  const store = transaction.objectStore(SCREENSHOTS_STORE);
  const request = store.index(CREATED_AT_INDEX).openCursor();
  const expiredIds: string[] = [];

  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      return;
    }
    const record = cursor.value as ScreenshotRecord;
    if (now - record.createdAt > maxAgeMs) {
      expiredIds.push(record.id);
      cursor.delete();
    }
    cursor.continue();
  };

  await transactionDone(transaction);
  return expiredIds.length;
}

/** Number of stored screenshots. Handy for diagnostics and tests. */
export async function countScreenshots(): Promise<number> {
  const database = await openDatabase();
  const transaction = database.transaction(SCREENSHOTS_STORE, "readonly");
  const request = transaction.objectStore(SCREENSHOTS_STORE).count();
  return requestToPromise(request);
}

/** Closes the cached connection (used by tests and on service worker teardown). */
export async function closeDatabase(): Promise<void> {
  if (!databasePromise) {
    return;
  }
  try {
    const database = await databasePromise;
    database.close();
  } catch {
    // Nothing to close when opening failed.
  } finally {
    databasePromise = null;
  }
}

/**
 * IndexedDB-backed OfflineQueueStore (#12) — the durable browser store that lets a
 * queued action survive a reload / app restart while offline. A tiny hand-rolled
 * wrapper (no `idb` dependency): one object store keyed by the action id.
 *
 * Browser-only (touches `indexedDB`). The pure policy + replay engine live in
 * lib/offline-queue.ts; this is just persistence. `createOfflineQueueStore()`
 * degrades to the in-memory store when IndexedDB is missing or blocked (Safari
 * private mode, hardened WebViews), so queueing always works for the session even
 * if it can't survive a reload there.
 */

import {
  type OfflineAction,
  type OfflineQueueStore,
  MemoryOfflineQueueStore,
} from "./offline-queue";

const DB_NAME = "stoa-offline-queue";
const DB_VERSION = 1;
const STORE = "actions";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class IdbOfflineQueueStore implements OfflineQueueStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  async getAll(): Promise<OfflineAction[]> {
    const db = await this.db();
    const tx = db.transaction(STORE, "readonly");
    return promisify(
      tx.objectStore(STORE).getAll() as IDBRequest<OfflineAction[]>
    );
  }

  async put(action: OfflineAction): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE, "readwrite");
    await promisify(tx.objectStore(STORE).put(action));
  }

  async remove(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE, "readwrite");
    await promisify(tx.objectStore(STORE).delete(id));
  }
}

/** Is a usable IndexedDB present? (Absent in SSR and some private/WebView modes.) */
export function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

/** The durable store when IndexedDB is available, else an in-memory fallback. */
export function createOfflineQueueStore(): OfflineQueueStore {
  return hasIndexedDb()
    ? new IdbOfflineQueueStore()
    : new MemoryOfflineQueueStore();
}

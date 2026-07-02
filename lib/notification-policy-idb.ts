/**
 * IndexedDB mirror of the per-device NotificationPolicy (#52), so the service
 * worker can read quiet-hours + per-session mute at push DISPLAY time — a push
 * fires with NO tab open, and the SW can't read the client's localStorage, so
 * IndexedDB is the one store both sides can reach.
 *
 * A tiny hand-rolled wrapper (mirrors lib/offline-queue-idb.ts — no `idb` dep):
 * one object store holding a SINGLE row under a fixed key. The client writes it
 * whenever the policy changes (savePolicyToIdb); the SW reads it on each push
 * (readPolicyFromIdb) and falls back to the default policy (fail-loud: notify)
 * if the store is missing/blocked. The PURE policy logic lives in
 * lib/notification-policy.ts; this is only persistence.
 */

import {
  type NotificationPolicy,
  defaultNotificationPolicy,
} from "./notification-policy";

const DB_NAME = "stoa-notification-policy";
const DB_VERSION = 1;
const STORE = "policy";
const KEY = "current";

function hasIdb(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
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

/**
 * Coerce an unknown stored blob into a valid NotificationPolicy, filling any
 * missing/garbage field from the default. A hostile/old shape can't crash the SW
 * or smuggle a non-array mute-list into `.includes(...)`. Exported for unit tests
 * (it's the pure hostile-input guard; the IDB I/O around it isn't unit-tested).
 */
export function coercePolicy(raw: unknown): NotificationPolicy {
  const d = defaultNotificationPolicy;
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const q = (o.quietHours ?? {}) as Record<string, unknown>;
  const muted = Array.isArray(o.mutedSessionIds)
    ? o.mutedSessionIds.filter((x): x is string => typeof x === "string")
    : [];
  return {
    quietHours: {
      enabled:
        typeof q.enabled === "boolean" ? q.enabled : d.quietHours.enabled,
      startMin:
        typeof q.startMin === "number" ? q.startMin : d.quietHours.startMin,
      endMin: typeof q.endMin === "number" ? q.endMin : d.quietHours.endMin,
    },
    mutedSessionIds: muted,
  };
}

/** Persist the policy so the SW can read it on the next push. Best-effort. */
export async function savePolicyToIdb(
  policy: NotificationPolicy
): Promise<void> {
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    await promisify(tx.objectStore(STORE).put(policy, KEY));
  } catch {
    // Best-effort: a blocked IndexedDB (Safari private / hardened WebView) just
    // means the SW falls back to the default (loud) policy — never a crash.
  }
}

/**
 * Read the policy the SW should apply. Fails LOUD: any error / empty store
 * returns the default policy (quiet-hours off, no mutes) so a storage glitch
 * never silently swallows a needs-you notification.
 */
export async function readPolicyFromIdb(): Promise<NotificationPolicy> {
  if (!hasIdb()) return defaultNotificationPolicy;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const raw = await promisify(tx.objectStore(STORE).get(KEY));
    return coercePolicy(raw);
  } catch {
    return defaultNotificationPolicy;
  }
}

// Per-file "viewed" state for the diff review (tick off files you've already
// reviewed in a big multi-file agent change). Persisted in localStorage, keyed
// by (session id + file path) so it survives reloads but stays per-session.
// Pure + testable: every helper takes an injected Storage-like object so the
// browser's localStorage is the only impure caller (the React hook below).

/** The slice of the DOM Storage interface we use (localStorage at runtime). */
export interface ViewedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// One key per session holds the set of viewed paths as a JSON string array.
// Paths can contain any character, so JSON-encoding the whole set is safer than
// packing path into the key (avoids separator collisions).
export function viewedStorageKey(sessionId: string): string {
  return `stoa-diff-viewed:${sessionId}`;
}

/** Read the set of viewed file paths for a session (empty on miss/corrupt). */
export function getViewedFiles(
  storage: ViewedStorage,
  sessionId: string
): Set<string> {
  try {
    const raw = storage.getItem(viewedStorageKey(sessionId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    // Defend against a hand-edited / legacy value of the wrong shape.
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

/** True if a single file path is marked viewed for this session. */
export function isFileViewed(
  storage: ViewedStorage,
  sessionId: string,
  path: string
): boolean {
  return getViewedFiles(storage, sessionId).has(path);
}

/**
 * Flip a file's viewed flag and persist it. Returns the new full set so a caller
 * can update React state without a second read. Storage failures are swallowed
 * (private mode / quota) — the returned set still reflects the intended toggle.
 */
export function toggleFileViewed(
  storage: ViewedStorage,
  sessionId: string,
  path: string
): Set<string> {
  const next = getViewedFiles(storage, sessionId);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  try {
    storage.setItem(viewedStorageKey(sessionId), JSON.stringify([...next]));
  } catch {
    // localStorage might be unavailable or over quota — keep the in-memory set.
  }
  return next;
}

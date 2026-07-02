// Quick Switcher memory: most-recently-used session ids plus user-pinned ids,
// so the ⌘K palette's default (empty-query) list surfaces what you actually
// jump to. Mirrors lib/prompt-history.ts: persisted in localStorage, pure +
// testable — every helper takes an injected Storage-like object, so the
// browser's localStorage is the only impure caller (the QuickSwitcher).
//
// Ranking contract: recents/pins ONLY reorder the default list when the query
// is EMPTY. With an active query, fuzzy ranking stays king — see
// rankWithRecents below.

/** Most recent ids kept — old entries fall off the end. */
export const RECENTS_CAP = 20;

/** The slice of the DOM Storage interface we use (localStorage at runtime). */
export interface PaletteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Recents are global (not per-session): one key holds the MRU id list. */
export const RECENTS_KEY = "stoa-palette-recents";
/** Pinned session ids, in the order they were pinned. */
export const PINS_KEY = "stoa-palette-pins";

/** Read a JSON string-array key, degrading to [] on miss/corrupt/wrong shape
 * (a hand-edited or legacy value must never throw into the palette). */
function readIdList(storage: PaletteStorage, key: string): string[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** Persist a string-array key, swallowing failures (private mode / quota) —
 * callers keep the returned in-memory list either way. */
function writeIdList(storage: PaletteStorage, key: string, list: string[]) {
  try {
    storage.setItem(key, JSON.stringify(list));
  } catch {
    // localStorage might be unavailable or over quota — in-memory list stands.
  }
}

/** Read the MRU session-id list (most recent first; empty on miss/corrupt). */
export function getRecents(storage: PaletteStorage): string[] {
  return readIdList(storage, RECENTS_KEY);
}

/**
 * Record a session selection: move/insert `id` at the front of the MRU list
 * (deduped — a re-selected id never appears twice), capped to RECENTS_CAP, and
 * persist. Returns the new list so a caller can update React state without a
 * second read. A blank id is a no-op.
 */
export function recordRecent(
  storage: PaletteStorage,
  id: string,
  cap: number = RECENTS_CAP
): string[] {
  const prev = getRecents(storage);
  if (!id) return prev;
  const next = [id, ...prev.filter((r) => r !== id)].slice(0, cap);
  writeIdList(storage, RECENTS_KEY, next);
  return next;
}

/** Read the pinned session-id list (empty on miss/corrupt). */
export function getPins(storage: PaletteStorage): string[] {
  return readIdList(storage, PINS_KEY);
}

/**
 * Pin `id` if unpinned, unpin it if pinned; persist and return the new list
 * (same return-the-list contract as recordRecent).
 */
export function togglePin(storage: PaletteStorage, id: string): string[] {
  const prev = getPins(storage);
  const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
  writeIdList(storage, PINS_KEY, next);
  return next;
}

/**
 * Rank palette items using the palette's memory. Pure — never mutates inputs.
 *
 * - EMPTY query (no `scoreFn`): pinned items first, then recents in MRU order,
 *   then the rest in their existing order. Within the pinned group, MRU order
 *   then existing order breaks ties, so your most-used pin tops the list.
 *   Stale ids (recents/pins pointing at deleted sessions) are simply ignored.
 * - ACTIVE query (`scoreFn` provided): fuzzy ranking stays king — items are
 *   stably sorted by score alone (nulls last) and recents/pins DO NOT reorder
 *   anything. Passing an already-fuzzy-ranked list (e.g. searchSessions
 *   output) through here is therefore an order-preserving no-op; a deliberate
 *   search is never hijacked by a pin.
 */
export function rankWithRecents<T extends { id: string }>(
  items: T[],
  recents: string[],
  pins: string[],
  scoreFn?: (item: T) => number | null
): T[] {
  const indexed = items.map((item, i) => ({ item, i }));

  if (scoreFn) {
    // Query active: score is the only key; ties keep their input order.
    const scored = indexed.map(({ item, i }) => ({
      item,
      i,
      score: scoreFn(item) ?? Number.NEGATIVE_INFINITY,
    }));
    scored.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.i - b.i
    );
    return scored.map((x) => x.item);
  }

  const pinSet = new Set(pins);
  const recentRank = new Map<string, number>();
  recents.forEach((id, i) => {
    if (!recentRank.has(id)) recentRank.set(id, i);
  });

  indexed.sort((a, b) => {
    const aPin = pinSet.has(a.item.id) ? 0 : 1;
    const bPin = pinSet.has(b.item.id) ? 0 : 1;
    if (aPin !== bPin) return aPin - bPin;
    const aRecent = recentRank.get(a.item.id) ?? Number.POSITIVE_INFINITY;
    const bRecent = recentRank.get(b.item.id) ?? Number.POSITIVE_INFINITY;
    if (aRecent !== bRecent) return aRecent - bRecent;
    return a.i - b.i;
  });
  return indexed.map((x) => x.item);
}

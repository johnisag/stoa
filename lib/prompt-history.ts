// Per-session recent-prompt history (re-fire a long prompt without retyping).
// Records each prompt as it's enqueued/sent, capped newest-first with no two
// consecutive duplicates. Persisted in localStorage, keyed by session id so it
// survives reloads but stays per-session. Pure + testable: the list helpers are
// plain array ops and the storage helpers take an injected Storage-like object,
// so the browser's localStorage is the only impure caller (the picker below).

import { fuzzyScore } from "./session-search";

/** Most prompts kept per session — old entries fall off the end. */
export const HISTORY_CAP = 50;
/** Max chars stored per entry, so a few huge pasted prompts can't blow the
 * per-origin localStorage quota (prompts can be 100KB+; the history just needs
 * enough to recognize + re-fire one). */
export const MAX_ENTRY_CHARS = 4000;

/** The slice of the DOM Storage interface we use (localStorage at runtime). */
export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** One key per session holds the prompt list as a JSON string array. */
export function historyStorageKey(sessionId: string): string {
  return `stoa-prompt-history:${sessionId}`;
}

/**
 * Push `text` onto the front of `list`, returning a NEW array (never mutates the
 * input). A blank/whitespace-only prompt is ignored. A consecutive repeat of the
 * current newest entry is collapsed (re-firing the same prompt won't pile up
 * duplicates), and the result is capped to HISTORY_CAP newest-first.
 */
export function addToHistory(
  list: string[],
  text: string,
  cap: number = HISTORY_CAP
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return list;
  // Cap per-entry size so a few giant prompts can't exhaust the storage quota.
  const t =
    trimmed.length > MAX_ENTRY_CHARS
      ? trimmed.slice(0, MAX_ENTRY_CHARS)
      : trimmed;
  if (list.length > 0 && list[0] === t) return list; // no consecutive dupes
  return [t, ...list].slice(0, cap);
}

/**
 * Filter `list` by `query` using the QuickSwitcher's fuzzy matcher, ranked best
 * first. An empty/whitespace query returns the list unchanged (newest-first).
 * Ties keep their original (more-recent) order — sort is stable, so a later
 * entry never jumps ahead of an equal-scoring earlier one.
 */
export function searchHistory(list: string[], query: string): string[] {
  const q = query.trim();
  if (!q) return [...list];
  const scored: { text: string; score: number; i: number }[] = [];
  list.forEach((text, i) => {
    const score = fuzzyScore(q, text);
    if (score != null) scored.push({ text, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((x) => x.text);
}

/** Read a session's prompt history (empty on miss/corrupt), newest-first. */
export function getHistory(
  storage: HistoryStorage,
  sessionId: string
): string[] {
  try {
    const raw = storage.getItem(historyStorageKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Defend against a hand-edited / legacy value of the wrong shape.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

/**
 * Record a prompt for a session and persist it. Returns the new full list so a
 * caller can update React state without a second read. Storage failures are
 * swallowed (private mode / quota) — the returned list still reflects the push.
 */
export function recordPrompt(
  storage: HistoryStorage,
  sessionId: string,
  text: string
): string[] {
  const next = addToHistory(getHistory(storage, sessionId), text);
  try {
    storage.setItem(historyStorageKey(sessionId), JSON.stringify(next));
  } catch {
    // localStorage might be unavailable or over quota — keep the in-memory list.
  }
  return next;
}

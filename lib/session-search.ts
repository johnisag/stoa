/**
 * Fuzzy session search/ranking for the ⌘/Ctrl-K QuickSwitcher.
 *
 * Pure and deterministic (no Date.now/IO) so it's unit-testable. Replaces the
 * switcher's old plain-substring filter with a subsequence matcher that ranks
 * results: a query matches if its characters appear in order in a field, scored
 * higher for contiguous runs, word-boundary/prefix hits, and tighter matches.
 *
 * Client-safe: only a type-import from ./db plus the browser-safe baseName.
 */

import type { Session } from "./db";
import { baseName } from "./path-display";

/**
 * Score `query` against `text` (case-insensitive). Returns null when `query` is
 * NOT an in-order subsequence of `text`; otherwise a number where higher = better.
 * An empty query scores 0 (matches everything).
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  if (!text) return null;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let bonus = 1;
    if (ti === prevMatch + 1) bonus += 3; // contiguous with the previous match
    if (ti === 0)
      bonus += 5; // matches the very start
    else if (/[\s\-_/.\\]/.test(t[ti - 1])) bonus += 3; // word start (incl. Windows \)
    score += bonus;
    prevMatch = ti;
    qi++;
  }
  if (qi < q.length) return null; // not all query chars consumed -> no match

  // Reward tighter matches (less leftover text), never below zero.
  score += Math.max(0, 10 - (t.length - q.length) * 0.1);
  return score;
}

/** The fields of a session that the switcher searches. */
function searchableFields(session: Session): string[] {
  const dir = session.working_directory || "";
  return [
    session.name || "",
    dir ? baseName(dir) : "",
    dir,
    session.agent_type || "",
    session.branch_name || "",
    // NOT group_path: it's deprecated and defaults to the literal "sessions" for
    // ~every row, so as a fuzzy subsequence it would match almost any short query
    // (s, ss, sin, ses, ...) and defeat filtering entirely.
  ].filter((f) => f.length > 0);
}

/**
 * Best fuzzy score for a session across its searchable fields, or null if none
 * match. An empty query matches every session (score 0).
 */
export function scoreSession(query: string, session: Session): number | null {
  const q = query.trim();
  if (!q) return 0;
  let best: number | null = null;
  for (const field of searchableFields(session)) {
    const s = fuzzyScore(q, field);
    if (s != null && (best == null || s > best)) best = s;
  }
  return best;
}

/**
 * Filter + rank sessions for a query. Empty query returns the input order
 * unchanged (the switcher's default list); otherwise matches sorted by score
 * desc, breaking ties by most-recently-updated.
 */
export function searchSessions(sessions: Session[], query: string): Session[] {
  const q = query.trim();
  if (!q) return [...sessions];

  const scored: { session: Session; score: number }[] = [];
  for (const session of sessions) {
    const score = scoreSession(q, session);
    if (score != null) scored.push({ session, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.session.updated_at || "").localeCompare(a.session.updated_at || "")
  );
  return scored.map((x) => x.session);
}

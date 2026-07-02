/**
 * Pure logic for @-mention file autocomplete in the send bar (#24).
 *
 * Typing `@` in a compose/queue textarea opens an inline dropdown over the
 * session working directory's file tree (the same bounded recursive listing
 * the file picker's fuzzy search uses); picking an entry replaces the `@token`
 * with the file's RELATIVE path. Everything here is pure and client-safe —
 * the React glue (caret tracking, the dropdown, the query hook) lives in
 * components/FileMentions.tsx.
 */

import { fuzzyScore } from "./session-search";
import { formatPathsForAgent } from "./path-display";
import {
  flattenFileNodes,
  relativeDisplayPath,
  type FileNode,
} from "./file-utils";

/** An active @-mention being typed: `start` is the index of the `@`, `query`
 *  is the text between it and the caret. */
export interface MentionState {
  start: number;
  query: string;
}

const MAX_QUERY = 64;

/**
 * The @-mention the caret currently sits in, or null. A mention starts at an
 * `@` that begins a token (start of text or after whitespace — so emails and
 * scoped npm packages like `foo@1.2` / `@types/node@2` mid-word don't
 * trigger), runs to the caret, and contains no whitespace or second `@`.
 */
export function detectMention(
  text: string,
  caret: number
): MentionState | null {
  if (caret < 1 || caret > text.length) return null;
  const from = Math.max(0, caret - (MAX_QUERY + 1));
  for (let i = caret - 1; i >= from; i--) {
    const ch = text[i];
    if (ch === "@") {
      const before = i > 0 ? text[i - 1] : "";
      if (before && !/\s/.test(before)) return null; // mid-word @
      return { start: i, query: text.slice(i + 1, caret) };
    }
    if (/[\s@]/.test(ch)) return null; // whitespace/@ between @ and caret
  }
  return null;
}

/** A pickable file: display name + the relative path that gets inserted. */
export interface MentionCandidate {
  name: string;
  rel: string;
}

/**
 * Flatten a recursive /api/files tree into mention candidates. `base` is the
 * listing's resolved root (the session cwd) — paths under it become relative,
 * forward-slashed (the form agents expect, cross-platform).
 */
export function mentionCandidatesFromTree(
  nodes: FileNode[],
  base: string
): MentionCandidate[] {
  return flattenFileNodes(nodes).map((f) => ({
    name: f.name,
    rel: relativeDisplayPath(base, f.path),
  }));
}

/**
 * Rank candidates for a mention query. Matches on the file NAME (weighted —
 * "budget" should surface budget.ts before some path merely containing the
 * letters) falling back to the relative path (so "lib/bud" works). An empty
 * query lists the first `limit` candidates alphabetically by path.
 */
export function filterMentionFiles(
  candidates: MentionCandidate[],
  query: string,
  limit = 8
): MentionCandidate[] {
  if (!query) {
    return [...candidates]
      .sort((a, b) => a.rel.localeCompare(b.rel))
      .slice(0, limit);
  }
  const scored: Array<{ c: MentionCandidate; score: number }> = [];
  for (const c of candidates) {
    const byName = fuzzyScore(query, c.name);
    const byPath = fuzzyScore(query, c.rel);
    const score =
      byName != null
        ? Math.max(byName * 2, byPath ?? -Infinity)
        : (byPath ?? null);
    if (score != null) scored.push({ c, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.c.rel.localeCompare(b.c.rel))
    .slice(0, limit)
    .map((s) => s.c);
}

/**
 * Replace the active `@token` with the picked relative path plus a trailing
 * space. The insert goes through formatPathsForAgent — the SAME hardening the
 * 📎 picker uses: C0 control chars stripped (a hostile POSIX filename with a
 * newline/ESC must not become a keystroke when the prompt is pasted into the
 * pty), quoted when it contains whitespace. Returns the new text and caret.
 */
export function applyMention(
  text: string,
  mention: MentionState,
  caret: number,
  rel: string
): { next: string; caret: number } {
  const insert = formatPathsForAgent(rel);
  const next = text.slice(0, mention.start) + insert + text.slice(caret);
  return { next, caret: mention.start + insert.length };
}

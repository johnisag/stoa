/**
 * Cross-session output search — the pure matcher. "Which of my agents mentioned
 * `TypeError`?" answered by scanning each session's already-structured Claude
 * transcript text, NOT by shelling out to `grep` (amux's approach, a Windows-
 * invariant violation here). Reading the JSONL conversation turns means we match
 * the agent's own words and return clean, role-labelled snippets — cross-platform
 * by construction (pure JS string ops, no child process) and rankable.
 *
 * This module is the PURE core (no I/O): given a transcript's JSONL and a query
 * it returns ranked snippets + a total match count. The route owns reading the
 * transcript off disk (lib/claude-transcript.ts) and fanning out over sessions.
 *
 * Matching is a case-insensitive SUBSTRING scan (includes) — never a RegExp built
 * from user input, so an operator typing `.*` or `a(b` can't ReDoS the server or
 * change the match semantics. Snippets are control-stripped so a transcript line
 * carrying raw ANSI/escape bytes can't render as garbage or smuggle an escape
 * sequence into the UI.
 */

import { extractTranscriptEntries } from "./summarize";

export interface OutputHit {
  role: "user" | "assistant";
  /** The matching line, control-stripped and clamped to a window around the hit. */
  snippet: string;
}

export interface TranscriptSearchResult {
  /** Up to `maxHits` snippets, in transcript order. */
  hits: OutputHit[];
  /** Total matching lines across the transcript (may exceed hits.length when capped). */
  total: number;
}

/** Max chars of a returned snippet; a long line is windowed around the match. */
const SNIPPET_MAX = 200;
/** Chars of leading context kept before the match when a line is windowed. */
const SNIPPET_LEAD = 48;

// Strip ANSI CSI sequences and C0 control chars (DEL too), collapsing each to a
// space, then squeeze runs — so a transcript line with raw escape bytes renders
// as clean, single-spaced text and can't smuggle an escape sequence into the UI.
// Escaped (no raw control bytes in source), mirroring summarize's sanitizer.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[\x20-\x2f]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function cleanForDisplay(line: string): string {
  return line
    .replace(ANSI_CSI, " ")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Window an ALREADY-cleaned line around the match at `matchIdx` so the hit is
 * visible even on a very long line, with ellipses on the truncated side(s). */
function windowSnippet(clean: string, matchIdx: number): string {
  if (clean.length <= SNIPPET_MAX) return clean;
  let start = Math.max(0, matchIdx - SNIPPET_LEAD);
  // Pull the window back if it would overrun the end, so it's always SNIPPET_MAX wide.
  start = Math.min(start, Math.max(0, clean.length - SNIPPET_MAX));
  let end = Math.min(clean.length, start + SNIPPET_MAX);
  // Don't slice through a surrogate pair (a lone half renders as �): if `start`
  // lands on a trailing half, step past it; if `end` cuts after a leading half,
  // step back before it.
  if (start > 0 && isLowSurrogate(clean.charCodeAt(start))) start += 1;
  if (end < clean.length && isHighSurrogate(clean.charCodeAt(end - 1)))
    end -= 1;
  let snip = clean.slice(start, end);
  if (start > 0) snip = `…${snip}`;
  if (end < clean.length) snip = `${snip}…`;
  return snip;
}

/**
 * Search one session's transcript for `query`. Returns up to `opts.maxHits`
 * role-labelled snippets (in transcript order) plus the TOTAL number of matching
 * lines (so the UI can show "12 matches" while listing only the first few). A
 * blank/whitespace query matches nothing. Pure → unit-tested.
 *
 * Both the query and each line are run through cleanForDisplay BEFORE matching,
 * so "what's matched" == "what's shown": a query typed with single spaces still
 * finds a transcript line that had double spaces / tabs / an ANSI run between the
 * words, and a query of nothing but control/ANSI bytes (which would be stripped
 * to empty) matches nothing rather than inflating `total` past the rendered hits.
 */
export function searchTranscript(
  jsonl: string,
  query: string,
  opts: { maxHits: number }
): TranscriptSearchResult {
  const q = cleanForDisplay(query).toLowerCase();
  const hits: OutputHit[] = [];
  let total = 0;
  if (!q) return { hits, total };

  for (const entry of extractTranscriptEntries(jsonl)) {
    for (const rawLine of entry.text.split("\n")) {
      const clean = cleanForDisplay(rawLine);
      const idx = clean.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      total++;
      if (hits.length < opts.maxHits) {
        hits.push({ role: entry.role, snippet: windowSnippet(clean, idx) });
      }
    }
  }
  return { hits, total };
}

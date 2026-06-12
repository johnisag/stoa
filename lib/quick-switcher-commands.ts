/**
 * Command lane for the ⌘/Ctrl-K QuickSwitcher.
 *
 * Beyond attaching to a session or opening a file, the palette can surface a
 * small set of *commands* — open Dispatch / Workflows / Verdict Inbox / Fleet
 * Board / Insight, start a new session, jump to the next session needing
 * attention — so the keyboard can reach views and actions that were otherwise
 * mouse-only.
 *
 * This module is pure (no React/DOM/IO) so the matching logic is unit-testable.
 * It reuses the same fuzzy matcher as the session lane (`fuzzyScore`) so a query
 * ranks commands consistently with sessions.
 */

import { fuzzyScore } from "./session-search";

/** A palette command: a label, search keywords, and a side-effecting action. */
export interface QuickCommand {
  /** Stable identity (used as the React key and in tests). */
  id: string;
  /** Human-readable label shown in the palette. */
  label: string;
  /** Extra terms (synonyms/abbreviations) the query can match besides the label. */
  keywords: string[];
  /** Fires when the command is chosen; the palette closes afterwards. */
  run: () => void;
}

/**
 * Best fuzzy score for a command across its label + keywords, or null if none
 * match. An empty query matches every command (score 0), so the palette shows
 * the full command list before the user types.
 */
export function scoreCommand(
  query: string,
  command: QuickCommand
): number | null {
  const q = query.trim();
  if (!q) return 0;
  let best: number | null = null;
  for (const field of [command.label, ...command.keywords]) {
    const s = fuzzyScore(q, field);
    if (s != null && (best == null || s > best)) best = s;
  }
  return best;
}

/**
 * Filter + rank commands for a query. Empty query returns the input order
 * unchanged (the palette's default command list); otherwise matches sorted by
 * score desc, breaking ties by the original order (stable). Never mutates input.
 */
export function filterCommands(
  commands: QuickCommand[],
  query: string
): QuickCommand[] {
  const q = query.trim();
  if (!q) return [...commands];

  const scored: { command: QuickCommand; score: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const score = scoreCommand(q, command);
    if (score != null) scored.push({ command, score, index });
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((x) => x.command);
}

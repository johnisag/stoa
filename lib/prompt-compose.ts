/**
 * Pure helpers for the full-screen prompt composer (send-now mode). Kept free of
 * React/DOM/server imports so they're safe to use from a client component and
 * easy to unit-test. The composer sends straight to the active terminal, so it
 * trims surrounding whitespace and normalizes line endings to LF — a stray CR
 * from a paste would otherwise submit the prompt mid-stream.
 */

/** Trim surrounding whitespace and normalize CRLF/CR line endings to LF. */
export function normalizeForSend(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Whether `text` has any content worth sending (after normalization). */
export function isSendable(text: string): boolean {
  return normalizeForSend(text).length > 0;
}

/**
 * The segments of a session's initial prompt, in CACHE-FRIENDLY order (#12). The
 * stable parts lead; anything VOLATILE per session trails.
 */
export interface LaunchPromptParts {
  /** A stable, PATH-FREE lead instruction (e.g. the worktree/workspace boundary
   *  RULE). Placed first so it's byte-identical across sibling sessions. */
  leadInstruction?: string | null;
  /** Auto-recalled pinned KNOWLEDGE for the project (#13) — stable per project. */
  pinnedKnowledge?: string | null;
  /** A selected PLAYBOOK recipe's body (#13) — stable when siblings share a recipe. */
  playbook?: string | null;
  /** The project-level prompt — stable for every session in a project. */
  projectPrompt?: string | null;
  /** The per-session task the user typed. */
  sessionPrompt?: string | null;
  /** Repo-level lessons/pitfalls (stable per repo). */
  lessons?: string | null;
  /** VOLATILE per-session context (a worktree absolute path / branch). Placed LAST
   *  so it never sits at the front and poison the cacheable prefix. */
  volatileSuffix?: string | null;
}

/**
 * Assemble a session's initial prompt so the cacheable PREFIX is byte-identical
 * across sibling sessions that share the stable parts, letting Anthropic's prompt
 * cache reuse it (a cached read is ~0.1× a fresh input read). The volatile
 * per-session context (a worktree path/branch) is appended LAST rather than
 * prepended — the old layout put the unique worktree path at byte 0, so no two
 * sessions ever shared a prefix. Empty/whitespace segments drop out; returns
 * undefined when nothing remains. Pure → unit-tested.
 */
export function composeLaunchPrompt(
  parts: LaunchPromptParts
): string | undefined {
  const ordered = [
    parts.leadInstruction,
    parts.pinnedKnowledge,
    parts.playbook,
    parts.projectPrompt,
    parts.sessionPrompt,
    parts.lessons,
    parts.volatileSuffix,
  ]
    .map((s) => (s == null ? "" : s.trim()))
    .filter(Boolean);
  return ordered.length ? ordered.join("\n\n") : undefined;
}

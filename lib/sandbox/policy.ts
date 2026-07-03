/**
 * Sandbox writable-root policy (#27) — PURE. Computes the set of directories a
 * confined agent must be able to WRITE: its worktree(s), the git internals a
 * linked worktree needs (index/refs/objects live in the main repo's git-common
 * dir), and Stoa's own state dir (~/.stoa — the DB, snapshot refs, worktrees).
 *
 * The git-common-dir (async `git rev-parse --git-common-dir`) is resolved by the
 * caller and passed in, so this stays a pure, deterministic transform. The result
 * is de-duplicated and stable-ordered.
 */

export interface RwRootsInput {
  /** The session's worktree path(s) — one, or several for a multi-repo session. */
  worktreePaths: string[];
  /** The main repo's git-common dir (its `.git`), so index/refs/objects writes
   *  succeed inside the sandbox. Null when it can't be resolved. */
  gitCommonDir?: string | null;
  /** Stoa's state dir (~/.stoa) — the DB + snapshot refs + worktrees base. */
  stoaHome: string;
}

export function computeRwRoots(input: RwRootsInput): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | null | undefined) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    roots.push(p);
  };
  for (const p of input.worktreePaths) add(p);
  add(input.gitCommonDir);
  add(input.stoaHome);
  return roots;
}

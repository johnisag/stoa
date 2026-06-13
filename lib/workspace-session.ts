/**
 * Multi-repo "workspace" session helpers — CLIENT-SAFE (no fs/git/db; pure string
 * work over the `sessions.worktree_paths` JSON column). Kept separate from
 * lib/multi-repo-worktree.ts (which pulls in fs/git for the server) so the Git
 * panel can derive its repo list without dragging server-only modules into the
 * browser bundle.
 */

import { baseName } from "./path-display";
import type { ProjectRepository } from "./db/types";

/**
 * Safe parse of a session's `worktree_paths` JSON column → the child worktree
 * paths. Returns [] for null/blank/malformed input or a non-array (never throws).
 */
export function parseWorktreePaths(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Map a workspace session's worktree paths to the `ProjectRepository` shape the
 * multi-repo Git panel renders, so a workspace session shows ITS worktrees' status
 * (where its edits live) rather than the project's original checkouts. The path is
 * a stable unique id; the first is primary (for the panel's PR/commit target).
 */
export function worktreePathsToRepositories(
  paths: string[],
  projectId: string
): ProjectRepository[] {
  return paths.map((p, i) => ({
    id: p,
    project_id: projectId,
    name: baseName(p),
    path: p,
    is_primary: i === 0,
    sort_order: i,
  }));
}

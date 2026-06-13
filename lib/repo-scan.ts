/**
 * Multi-repo discovery — find the git repos nested under a directory.
 *
 * For the "a project root holds many sibling git repos" case (e.g.
 * `C:\my-projects\pocs` containing etl-engine/, gridops-cop/, …): scan up to
 * `maxDepth` levels for directories that ARE git checkouts (they hold a `.git`
 * entry — a dir for a normal clone, a file for a linked worktree). A directory
 * that IS a repo is returned and NOT descended into (its own subdirs aren't
 * separate repos for our purposes). Filesystem-only — no git binary is spawned —
 * so a scan over a dev folder stays fast. Cross-platform (path.join, expandHome).
 */

import * as fs from "fs/promises";
import * as path from "path";
import { expandHome } from "./platform";

export interface ScannedRepo {
  /** Absolute path to the repo. */
  path: string;
  /** Directory name (the leaf), used to label the worktree subfolder. */
  name: string;
  /** Depth below the scanned root (root's immediate children = 1). */
  depth: number;
}

// Heavy / noise directories we never descend into (and never treat as repos).
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  "out",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
]);

/** True if `dir` contains a `.git` entry (a clone dir or a linked-worktree file). */
async function isGitCheckout(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Find git repos under `root`, up to `maxDepth` levels deep (root's immediate
 * children are depth 1). The root itself is NOT returned even if it's a repo —
 * the caller asked about what's UNDER it. Repos are not descended into. Bounded by
 * `maxResults` so a huge tree can't produce an unbounded list. Sorted by path.
 * Unreadable directories are skipped, never thrown.
 */
export async function findGitReposUnder(
  root: string,
  maxDepth = 2,
  opts: { maxResults?: number } = {}
): Promise<ScannedRepo[]> {
  const maxResults = opts.maxResults ?? 200;
  const rootAbs = expandHome(root);
  const out: ScannedRepo[] = [];
  const seen = new Set<string>();
  // Breadth-first so shallower repos are found before the cap bites.
  const queue: { dir: string; depth: number }[] = [{ dir: rootAbs, depth: 0 }];

  while (queue.length > 0) {
    if (out.length >= maxResults) break;
    const { dir, depth } = queue.shift()!;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip
    }
    const subdirs = entries
      .filter(
        (e) =>
          e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)
      )
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    for (const name of subdirs) {
      if (out.length >= maxResults) break;
      const childDepth = depth + 1;
      if (childDepth > maxDepth) continue;
      const childPath = path.join(dir, name);
      if (seen.has(childPath)) continue;
      seen.add(childPath);
      if (await isGitCheckout(childPath)) {
        out.push({ path: childPath, name, depth: childDepth });
        // A repo is a leaf — do NOT descend into it.
      } else if (childDepth < maxDepth) {
        queue.push({ dir: childPath, depth: childDepth });
      }
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

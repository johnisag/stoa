/**
 * Dispatch — local git-repo discovery.
 *
 * Scans a set of root directories one level deep for immediate subdirectories
 * that are git checkouts (they contain a `.git` entry — a directory for a normal
 * clone, a file for a linked worktree). Filesystem-only: no git binary is
 * spawned, so a scan over a dev folder is fast. Slug/branch resolution for a
 * picked repo goes through the existing /api/dispatch/resolve route.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { expandHome } from "../platform";

export interface DiscoveredRepo {
  path: string;
  name: string;
}

/**
 * Scan each root (one level deep) for subdirectories containing `.git`.
 * Missing/unreadable roots are skipped. De-duped by absolute path, sorted by
 * name, and capped per root so a huge folder can't produce an unbounded list.
 */
export async function discoverGitRepos(
  roots: string[],
  opts: { maxPerRoot?: number } = {}
): Promise<DiscoveredRepo[]> {
  const maxPerRoot = opts.maxPerRoot ?? 100;
  const seen = new Set<string>();
  const out: DiscoveredRepo[] = [];

  for (const rawRoot of roots) {
    const root = expandHome(rawRoot);
    let names: string[];
    try {
      const dirents = await fs.readdir(root, { withFileTypes: true });
      names = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
      names.sort((a, b) => a.localeCompare(b)); // cap takes the first alphabetically
    } catch {
      continue; // missing / unreadable root
    }
    let count = 0;
    for (const name of names) {
      if (count >= maxPerRoot) break;
      const repoPath = path.join(root, name);
      if (seen.has(repoPath)) continue;
      try {
        // `.git` is a directory for a normal clone, a file for a worktree.
        await fs.stat(path.join(repoPath, ".git"));
      } catch {
        continue; // not a git checkout
      }
      seen.add(repoPath);
      out.push({ path: repoPath, name });
      count++;
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Default scan roots: the parent directory of each existing Stoa project (so we
 * surface repos sitting next to ones Stoa already knows), plus any explicit
 * `STOA_SCAN_ROOTS` (a `,`/`;`-separated list). De-duplicated. The Uncategorized
 * default (`~` / blank) is ignored.
 */
export function defaultScanRoots(projectDirs: string[]): string[] {
  const home = expandHome("~");
  const roots = new Set<string>();
  for (const dir of projectDirs) {
    // Test the raw value: expandHome("~") returns the home dir, so the "~" guard
    // must run BEFORE expansion or the Uncategorized project would scan ~'s parent.
    const raw = (dir ?? "").trim();
    if (!raw || raw === "~") continue;
    const expanded = expandHome(raw);
    // Never derive a root from the home dir itself (e.g. "~/") or a filesystem
    // root — scanning dirname(home) or "/" enumerates the whole machine.
    if (expanded === home) continue;
    const parent = path.dirname(expanded);
    if (parent === path.dirname(parent)) continue; // parent is a filesystem root
    roots.add(parent);
  }
  const env = process.env.STOA_SCAN_ROOTS;
  if (env) {
    for (const r of env
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      roots.add(expandHome(r));
    }
  }
  return [...roots];
}

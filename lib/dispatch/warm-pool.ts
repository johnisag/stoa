/**
 * Warm worktree pool: pre-creates one worktree per enabled dispatch repo so that
 * dispatchOne() can skip the slow git+npm setup on the critical path.
 *
 * Lifecycle:
 *   replenish(repo) → create worktree with placeholder branch "warm/<id>" →
 *   setupWorktree → mark ready in DB.
 *
 *   dispatchOne() calls claimWarm(repoId, repoPath, realBranchName) → gets
 *   worktreePath or null (fall back to on-demand creation).
 *
 *   evictStale() runs once at startup to delete 'warming' rows left by a crash.
 */

import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getDb, queries } from "../db";
import {
  addWorktreeWithBranch,
  deleteWorktree,
  getWorktreesDir,
} from "../worktrees";
import { setupWorktree } from "../env-setup";
import { branchExists, runGit } from "../git";
import { expandHome } from "../platform";
import type { DispatchRepo } from "./types";

// Target pool size per repo. Keep at 1 to avoid pre-consuming too much disk.
const POOL_SIZE = 1;

/**
 * Ensure the pool has at least POOL_SIZE ready entries for `repo`. Skips if
 * already at capacity. Called fire-and-forget after each successful dispatch.
 */
export async function replenish(repo: DispatchRepo): Promise<void> {
  const db = getDb();
  const { n } = queries.countWarmWorktrees(db).get(repo.id) as { n: number };
  if (n >= POOL_SIZE) return;

  const id = randomUUID();
  const branchName = `warm/${id.slice(0, 8)}`;
  const projectPath = expandHome(repo.repo_path);

  // Pre-check: if the placeholder branch name already exists (collision is
  // astronomically unlikely with UUIDs, but guard it), skip silently.
  try {
    if (await branchExists(projectPath, branchName)) return;
  } catch {
    return;
  }

  // Need worktrees dir to exist — addWorktreeWithBranch takes a full path, so
  // build it under ~/.stoa/worktrees the same way createWorktree does.
  const worktreeBase = getWorktreesDir();
  await fs.promises.mkdir(worktreeBase, { recursive: true });

  // Unique dir name using the warm id to avoid collisions with live worktrees.
  const repoSlug = repo.repo_slug.replace(/\//g, "-");
  const worktreePath = path.join(
    worktreeBase,
    `${repoSlug}-warm-${id.slice(0, 8)}`
  );

  try {
    queries.insertWarmWorktree(db).run(id, repo.id, worktreePath, branchName);

    await addWorktreeWithBranch(
      projectPath,
      worktreePath,
      branchName,
      repo.base_branch
    );

    try {
      await setupWorktree({ worktreePath, sourcePath: projectPath });
    } catch (err) {
      console.warn(
        `warm-pool: setupWorktree failed for ${repo.repo_slug}:`,
        err
      );
      // Non-fatal: mark ready anyway; the agent may handle its own install.
    }

    queries.markWarmWorktreeReady(db).run(id);
  } catch (err) {
    console.warn(`warm-pool: replenish failed for ${repo.repo_slug}:`, err);
    queries.deleteWarmWorktree(db).run(id);
    try {
      if (fs.existsSync(worktreePath)) {
        await deleteWorktree(worktreePath, projectPath, true);
      }
    } catch {
      // best-effort
    }
  }
}

/**
 * Atomically claim a ready warm worktree, rename its placeholder branch to the
 * real branch name, and return the worktree path.
 *
 * Returns null when:
 *   - no ready warm worktree is available (fall back to on-demand creation), OR
 *   - the desired branch name already exists in the repo (rare re-dispatch case).
 */
export async function claimWarm(
  repoId: string,
  projectPath: string,
  realBranchName: string
): Promise<{ worktreePath: string; branchName: string } | null> {
  const db = getDb();

  // Guard: if the real branch already exists a rename would fail — let on-demand
  // createWorktree() handle the collision (it has its own uniqueness logic).
  try {
    if (await branchExists(projectPath, realBranchName)) return null;
  } catch {
    return null;
  }

  const row = queries.claimWarmWorktree(db).get(repoId) as
    | { id: string; worktree_path: string; branch_name: string }
    | undefined;
  if (!row) return null;

  try {
    // Rename placeholder branch → real branch. Run from the main repo so we're
    // not relying on the worktree's own git context (more robust).
    await runGit(
      projectPath,
      ["branch", "-m", row.branch_name, realBranchName],
      10000
    );
    return { worktreePath: row.worktree_path, branchName: realBranchName };
  } catch (err) {
    console.warn(
      `warm-pool: branch rename failed (${row.branch_name} → ${realBranchName}):`,
      err
    );
    // The worktree is now in an inconsistent state — clean it up and tell the
    // caller to fall back to on-demand creation.
    try {
      await deleteWorktree(row.worktree_path, projectPath, true);
    } catch {
      // best-effort
    }
    return null;
  }
}

/**
 * At server startup: evict any 'warming' rows left by a crash. Their worktrees
 * are partially set up (npm install may be half-done) and cannot be trusted.
 */
export async function evictStale(): Promise<void> {
  const db = getDb();
  const stale = queries.listWarmingWorktrees(db).all() as Array<{
    id: string;
    worktree_path: string;
  }>;

  for (const row of stale) {
    queries.deleteWarmWorktree(db).run(row.id);
    try {
      if (fs.existsSync(row.worktree_path)) {
        // We don't know the repo path (no FK join here), so use the worktree
        // path itself as the project path — git will find the common dir.
        await deleteWorktree(row.worktree_path, row.worktree_path, true);
      }
    } catch {
      // best-effort; leftover dirs are harmless (git prune cleans refs)
    }
  }
}

/**
 * Delete all warm worktrees for a repo (called when a repo is un-enrolled or
 * removed and the CASCADE hasn't run yet, e.g. from the ticker). The DB rows are
 * already gone via CASCADE; this just cleans up the filesystem.
 */
export async function cleanupPool(
  repoId: string,
  projectPath: string
): Promise<void> {
  const db = getDb();
  const rows = queries.listReadyWarmWorktreesForRepo(db).all(repoId) as Array<{
    id: string;
    worktree_path: string;
  }>;
  for (const row of rows) {
    queries.deleteWarmWorktree(db).run(row.id);
    try {
      if (fs.existsSync(row.worktree_path)) {
        await deleteWorktree(row.worktree_path, projectPath, true);
      }
    } catch {
      // best-effort
    }
  }
}

/** Fire-and-forget replenish — safe to call on the critical dispatch path. */
export function scheduleReplenish(repo: DispatchRepo): void {
  replenish(repo).catch((err) =>
    console.warn(
      `warm-pool: background replenish failed for ${repo.repo_slug}:`,
      err
    )
  );
}

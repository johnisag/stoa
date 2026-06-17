/**
 * Git Worktree management for isolated feature development
 */

import * as path from "path";
import * as fs from "fs";
import {
  isGitRepo,
  branchExists,
  getRepoName,
  slugify,
  generateBranchName,
  runGit,
} from "./git";
import { homeDir, expandHome } from "./platform";

// Base directory for all worktrees
const WORKTREES_DIR = path.join(homeDir(), ".stoa", "worktrees");

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  projectPath: string;
  projectName: string;
}

export interface CreateWorktreeOptions {
  projectPath: string;
  featureName: string;
  baseBranch?: string;
}

/**
 * Ensure the worktrees directory exists
 */
async function ensureWorktreesDir(): Promise<void> {
  await fs.promises.mkdir(WORKTREES_DIR, { recursive: true });
}

/**
 * Resolve a path, expanding a leading ~ to the home directory. Delegates to the
 * cross-platform helper so `~\x` (Windows) is handled, not just `~/x`.
 */
function resolvePath(p: string): string {
  return expandHome(p);
}

/**
 * Generate a unique worktree directory name
 */
function generateWorktreeDirName(
  projectName: string,
  featureName: string
): string {
  const featureSlug = slugify(featureName);
  return `${projectName}-${featureSlug}`;
}

/**
 * Create a new worktree for a feature branch
 */
export async function createWorktree(
  options: CreateWorktreeOptions
): Promise<WorktreeInfo> {
  const { projectPath, featureName, baseBranch = "main" } = options;

  const resolvedProjectPath = resolvePath(projectPath);

  // Validate project is a git repo
  if (!(await isGitRepo(resolvedProjectPath))) {
    throw new Error(`Not a git repository: ${projectPath}`);
  }

  // Generate branch name
  const branchName = generateBranchName(featureName);

  // Check if branch already exists
  if (await branchExists(resolvedProjectPath, branchName)) {
    throw new Error(`Branch already exists: ${branchName}`);
  }

  // Generate worktree path
  const projectName = getRepoName(resolvedProjectPath);
  const worktreeDirName = generateWorktreeDirName(projectName, featureName);
  const worktreePath = path.join(WORKTREES_DIR, worktreeDirName);

  // Check if worktree path already exists
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  // Ensure worktrees directory exists
  await ensureWorktreesDir();

  await addWorktreeWithBranch(
    resolvedProjectPath,
    worktreePath,
    branchName,
    baseBranch
  );

  return {
    worktreePath,
    branchName,
    baseBranch,
    projectPath: resolvedProjectPath,
    projectName,
  };
}

/**
 * `git worktree add -b <branch> <path> <ref>` at a CALLER-CHOSEN path, trying
 * remote→local→bare ref formats so an ambiguous/absent `origin/<base>` still
 * resolves. Lower-level than createWorktree (no repo/branch/path pre-checks and no
 * `~/.stoa/worktrees` path scheme) — used both by createWorktree and by the
 * multi-repo workspace builder, which places each repo's worktree as a named
 * subfolder of a shared workspace dir. Throws if every ref format fails.
 */
export async function addWorktreeWithBranch(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string
): Promise<void> {
  const refFormats = [
    `origin/${baseBranch}`, // remote first (most explicit)
    `refs/heads/${baseBranch}`, // then local branch
    baseBranch, // bare name as fallback
  ];
  let lastError: Error | null = null;
  for (const ref of refFormats) {
    try {
      await runGit(
        resolvePath(repoPath),
        ["worktree", "add", "-b", branchName, worktreePath, ref],
        30000
      );
      return; // success
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(
    `Failed to create worktree: ${lastError?.message ?? "unknown error"}`
  );
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `git worktree remove` (then a manual rm) can fail with EBUSY on Windows when a
// just-killed agent/pty hasn't released its handle on the dir yet. Retry a few
// times with backoff so the OS has a moment to let go (~2s total covers the
// typical handle-release lag without stalling a background cleanup for long).
// Delays sit BEFORE attempts 2 and 3 — the common (already-free) case removes on
// the first try, no wait.
const REMOVE_RETRY_BACKOFF_MS = [500, 1500];
const REMOVE_ATTEMPTS = REMOVE_RETRY_BACKOFF_MS.length + 1;

/** One removal attempt: `git worktree remove --force`, then a manual rm fallback.
 * Returns true once the directory is gone. Never throws (the caller retries). */
async function tryRemoveWorktreeOnce(
  repoPath: string,
  worktreePath: string
): Promise<boolean> {
  try {
    await runGit(
      repoPath,
      ["worktree", "remove", worktreePath, "--force"],
      30000
    );
    return true;
  } catch {
    // git refused (locked / not a registered worktree / not a repo) — fall back
    // to removing the directory ourselves.
  }
  try {
    if (fs.existsSync(worktreePath)) {
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
    }
    return !fs.existsSync(worktreePath);
  } catch {
    return false; // most likely EBUSY (Windows lock) — the caller retries
  }
}

/**
 * Delete a worktree (and optionally its branch), robustly. Retries the removal on
 * transient Windows locks, ALWAYS prunes stale registrations afterward (so the
 * attach picker never offers a dead worktree), and throws a clear error only if
 * the directory genuinely can't be removed — instead of letting a bare EBUSY
 * escape. Callers that clean up in the background swallow the throw; the reclaim
 * route surfaces it to the user.
 */
export async function deleteWorktree(
  worktreePath: string,
  projectPath: string,
  deleteBranch = false
): Promise<void> {
  const resolvedProjectPath = resolvePath(projectPath);
  const resolvedWorktreePath = resolvePath(worktreePath);

  // Get the branch name before removing (for optional deletion)
  let branchName: string | null = null;
  if (deleteBranch) {
    try {
      const { stdout } = await runGit(
        resolvedWorktreePath,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        5000
      );
      branchName = stdout.trim();
    } catch {
      // Ignore - worktree might already be gone
    }
  }

  // Remove the worktree, retrying on transient locks.
  let removed = false;
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(REMOVE_RETRY_BACKOFF_MS[attempt - 1]);
    removed = await tryRemoveWorktreeOnce(
      resolvedProjectPath,
      resolvedWorktreePath
    );
    if (removed) break;
  }

  // Always prune stale registrations — cheap, and it clears any worktree whose
  // directory was removed out-of-band so `git worktree list` stays honest.
  try {
    await runGit(resolvedProjectPath, ["worktree", "prune"], 10000);
  } catch {
    // Ignore prune errors (e.g. projectPath isn't a repo for a broken worktree).
  }

  // Optionally delete the branch — but ONLY a branch Stoa created. `branch -D`
  // force-deletes (discards unmerged commits), so restrict it to the
  // `feature/` prefix from generateBranchName(). A worktree manually repointed
  // to a real branch (develop / trunk / a non-`main` default) is left alone.
  if (
    deleteBranch &&
    branchName &&
    (branchName.startsWith("feature/") || branchName.startsWith("warm/"))
  ) {
    try {
      await runGit(resolvedProjectPath, ["branch", "-D", branchName], 10000);
    } catch {
      // Ignore branch deletion errors (might be merged or checked out elsewhere)
    }
  }

  // Surface a clear failure only if the directory is genuinely still there after
  // every retry (a process is holding it) — never a raw EBUSY.
  if (!removed && fs.existsSync(resolvedWorktreePath)) {
    throw new Error(
      `Could not remove worktree (still locked after ${REMOVE_ATTEMPTS} attempts): ${resolvedWorktreePath}`
    );
  }
}

/**
 * Resolve the MAIN repo path that owns a (possibly linked) worktree, via the
 * git common dir. Returns null when it can't be determined. Uses execFile (no
 * shell) and path-aware `.git` stripping so it works on Windows too — the old
 * `… 2>/dev/null || echo ""` + `/\/.git$/` approach silently no-op'd on cmd.exe,
 * orphaning worktrees.
 */
export async function getMainRepoPath(
  worktreePath: string
): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      resolvePath(worktreePath),
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      5000
    );
    const commonDir = stdout.trim();
    if (!commonDir) return null;
    return path.basename(commonDir) === ".git"
      ? path.dirname(commonDir)
      : commonDir;
  } catch {
    return null;
  }
}

/**
 * List all worktrees for a project
 */
export async function listWorktrees(projectPath: string): Promise<
  Array<{
    path: string;
    branch: string;
    head: string;
  }>
> {
  const resolvedProjectPath = resolvePath(projectPath);

  try {
    const { stdout } = await runGit(
      resolvedProjectPath,
      ["worktree", "list", "--porcelain"],
      10000
    );

    const worktrees: Array<{ path: string; branch: string; head: string }> = [];
    const entries = stdout.split("\n\n").filter(Boolean);

    for (const entry of entries) {
      const lines = entry.split("\n");
      let worktreePath = "";
      let branch = "";
      let head = "";
      let prunable = false;

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          worktreePath = line.slice(9);
        } else if (line.startsWith("branch ")) {
          branch = line.slice(7).replace("refs/heads/", "");
        } else if (line.startsWith("HEAD ")) {
          head = line.slice(5);
        } else if (line.startsWith("prunable")) {
          // git flags a registration whose directory is gone as `prunable …`.
          prunable = true;
        }
      }

      // Skip stale registrations: offering a worktree whose dir no longer exists
      // to the attach picker is the "attach sees stale worktrees" bug. Drop both
      // git-flagged `prunable` entries AND any whose directory is already gone
      // (git only flags prunable lazily, so a just-removed dir can slip through).
      if (worktreePath && !prunable && fs.existsSync(worktreePath)) {
        worktrees.push({ path: worktreePath, branch, head });
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Check if a path is inside an Stoa worktree. Normalizes both sides first —
 * git emits forward-slash paths even on Windows, while WORKTREES_DIR uses
 * path.join backslashes, so a raw startsWith would never match on Windows
 * (silently hiding every worktree from the attach picker + delete gate).
 */
export function isStoaWorktree(worktreePath: string): boolean {
  const base = normalizeWorktreePath(WORKTREES_DIR);
  const p = normalizeWorktreePath(worktreePath);
  // Require a SEPARATOR boundary, not a bare prefix: a plain startsWith(base)
  // would let a same-named sibling (…/worktrees-evil) pass and reach the
  // destructive delete path. Must be strictly inside the dir (and not the dir
  // itself, which is never a worktree).
  return p !== base && p.startsWith(base + path.sep);
}

export interface AnnotatedWorktree {
  path: string;
  branch: string;
  head: string;
  /** Lives under Stoa's worktrees dir (created/managed by Stoa). */
  isStoa: boolean;
  /** A live session already points here (so it's NOT an orphan to attach to). */
  attached: boolean;
}

/** Normalize a path for comparison (expand ~, resolve, case-fold on Windows). */
export function normalizeWorktreePath(p: string): string {
  const resolved = path.resolve(resolvePath(p));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Annotate raw worktree entries with `isStoa` and whether a live session already
 * owns each (`attached`) — given the set of session working directories. Pure
 * (no git/db), so the join logic is unit-testable. Drives the New Session
 * "attach to existing worktree" picker (offer the orphaned Stoa worktrees).
 */
export function annotateWorktrees(
  worktrees: Array<{ path: string; branch: string; head: string }>,
  sessionWorkingDirs: Iterable<string>
): AnnotatedWorktree[] {
  const attachedDirs = new Set<string>();
  for (const dir of sessionWorkingDirs)
    attachedDirs.add(normalizeWorktreePath(dir));
  return worktrees.map((w) => ({
    ...w,
    isStoa: isStoaWorktree(w.path),
    attached: attachedDirs.has(normalizeWorktreePath(w.path)),
  }));
}

/**
 * Get the worktrees base directory
 */
export function getWorktreesDir(): string {
  return WORKTREES_DIR;
}

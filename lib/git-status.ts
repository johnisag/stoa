import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "child_process";
import { unlinkSync } from "fs";
import { join } from "path";
import { devNull } from "os";
import { expandHome, isWindows } from "./platform";

/**
 * Expand ~ to home directory in paths
 */
export function expandPath(path: string): string {
  return expandHome(path);
}

/**
 * Run a git command via execFileSync (no shell) with an argument array.
 * Avoids shell quoting/redirection so it behaves identically across platforms.
 */
function git(
  args: string[],
  cwd: string,
  opts: { stdio?: "pipe"; maxBuffer?: number } = {}
): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf-8",
    // Windows: don't let each short-lived git child allocate a visible console
    // (a flashing conhost.exe). No-op on POSIX.
    windowsHide: isWindows,
  };
  if (opts.stdio) options.stdio = opts.stdio;
  if (opts.maxBuffer) options.maxBuffer = opts.maxBuffer;
  return execFileSync("git", args, options);
}

/**
 * Extract captured stdout from an execFileSync error. `git diff [--no-index]`
 * exits non-zero when the inputs differ while still printing the diff to
 * stdout; this recovers it as a string.
 */
function readStdout(error: unknown): string {
  const stdout = (error as { stdout?: Buffer | string } | null)?.stdout;
  if (typeof stdout === "string") return stdout;
  if (stdout) return stdout.toString("utf-8");
  return "";
}

export type FileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "unmerged";

export interface GitFile {
  path: string;
  status: FileStatus;
  staged: boolean;
  oldPath?: string; // For renamed files
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: GitFile[];
  /**
   * When this directory is a LINKED git worktree, uncommitted changes that live
   * in the base/main worktree instead (or null). Lets the UI warn when an agent
   * edited the base checkout rather than the worktree it was given.
   */
  baseWorktree?: { path: string; branch: string | null; count: number } | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  bare: boolean;
}

/**
 * Parse `git worktree list --porcelain`. Entries are blank-line separated; the
 * first entry is the main worktree. Pure (no I/O) so it's unit-testable.
 */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const entries: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  const flush = () => {
    if (cur) entries.push(cur);
    cur = null;
  };
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      flush();
    } else if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length), branch: null, bare: false };
    } else if (!cur) {
      continue;
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line === "detached") {
      cur.branch = null;
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return entries;
}

/** Normalize a path for comparison (forward slashes, no trailing sep, folded on Windows). */
function normalizePathForCompare(p: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWindows ? n.toLowerCase() : n;
}

/**
 * Given a parsed worktree list and the current directory, return the BASE/main
 * worktree iff `workingDir` is a *different*, linked worktree — else null (no
 * linked worktrees, or `workingDir` already IS the main). Pure (no I/O), so the
 * path-comparison + main-detection logic is unit-testable.
 */
export function findBaseWorktree(
  list: WorktreeInfo[],
  workingDir: string
): WorktreeInfo | null {
  if (list.length < 2) return null; // only the main worktree exists
  const main = list.find((w) => !w.bare); // `git worktree list` puts main first
  if (!main) return null;
  if (
    normalizePathForCompare(main.path) === normalizePathForCompare(workingDir)
  ) {
    return null; // the current dir IS the main worktree — nothing to flag
  }
  return main;
}

/**
 * If `workingDir` is a LINKED worktree, return the base/main worktree's path,
 * branch, and uncommitted-change count; null otherwise (incl. when it IS the
 * main worktree). Used to flag changes that landed in the base checkout.
 */
export function getWorktreeBaseChanges(
  workingDir: string
): { path: string; branch: string | null; count: number } | null {
  let list: WorktreeInfo[];
  try {
    list = parseWorktreeList(
      git(["worktree", "list", "--porcelain"], workingDir, { stdio: "pipe" })
    );
  } catch {
    return null;
  }
  const main = findBaseWorktree(list, workingDir);
  if (!main) return null;
  try {
    const st = getGitStatus(main.path);
    const count = st.staged.length + st.unstaged.length + st.untracked.length;
    return { path: main.path, branch: main.branch, count };
  } catch {
    return null;
  }
}

/**
 * Parse git status --porcelain=v2 output
 */
export function getGitStatus(workingDir: string): GitStatus {
  try {
    // Get branch info
    const branchOutput = git(["branch", "--show-current"], workingDir).trim();

    // Get ahead/behind counts
    let ahead = 0;
    let behind = 0;
    try {
      const trackingOutput = git(
        ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        workingDir,
        { stdio: "pipe" }
      ).trim();
      const [b, a] = trackingOutput.split(/\s+/).map(Number);
      ahead = a || 0;
      behind = b || 0;
    } catch {
      // No upstream configured — leaves ahead/behind at 0 (matching the old
      // `|| echo '0 0'` shell fallback)
    }

    // Get status
    const statusOutput = git(["status", "--porcelain=v1"], workingDir);

    const staged: GitFile[] = [];
    const unstaged: GitFile[] = [];
    const untracked: GitFile[] = [];

    for (const line of statusOutput.split("\n")) {
      if (!line) continue;

      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.slice(3);

      // Handle renames (format: "R  old -> new")
      let path = filePath;
      let oldPath: string | undefined;
      if (filePath.includes(" -> ")) {
        const parts = filePath.split(" -> ");
        oldPath = parts[0];
        path = parts[1];
      }

      // Untracked files
      if (indexStatus === "?" && workTreeStatus === "?") {
        untracked.push({ path, status: "untracked", staged: false });
        continue;
      }

      // Staged changes (index status)
      if (indexStatus !== " " && indexStatus !== "?") {
        staged.push({
          path,
          oldPath,
          status: parseStatus(indexStatus),
          staged: true,
        });
      }

      // Unstaged changes (work tree status)
      if (workTreeStatus !== " " && workTreeStatus !== "?") {
        unstaged.push({
          path,
          oldPath,
          status: parseStatus(workTreeStatus),
          staged: false,
        });
      }
    }

    return {
      branch: branchOutput || "HEAD",
      ahead,
      behind,
      staged,
      unstaged,
      untracked,
    };
  } catch (error) {
    throw new Error(
      `Failed to get git status: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

function parseStatus(char: string): FileStatus {
  switch (char) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "unmerged";
    default:
      return "modified";
  }
}

/**
 * Get diff for a specific file
 */
export function getFileDiff(
  workingDir: string,
  filePath: string,
  staged: boolean
): string {
  try {
    const args = ["diff", ...(staged ? ["--staged"] : []), "--", filePath];
    const output = git(args, workingDir, {
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return output;
  } catch {
    // Regular `git diff` exits 0 even with changes; a non-zero exit means a
    // real error (with empty stdout), so "" matches the old `|| true` result.
    return "";
  }
}

/**
 * Get diff for untracked file (show full content)
 */
export function getUntrackedFileDiff(
  workingDir: string,
  filePath: string
): string {
  try {
    const output = git(["diff", "--no-index", devNull, filePath], workingDir, {
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024,
    });
    return output;
  } catch (error) {
    // `git diff --no-index` exits 1 when the files differ; return its captured
    // stdout (matching the old `2>/dev/null || true` shell behavior).
    return readStdout(error);
  }
}

/**
 * Stage a file
 */
export function stageFile(workingDir: string, filePath: string): void {
  git(["add", "--", filePath], workingDir);
}

/**
 * Stage all files
 */
export function stageAll(workingDir: string): void {
  git(["add", "-A"], workingDir);
}

/**
 * Unstage a file
 */
export function unstageFile(workingDir: string, filePath: string): void {
  git(["reset", "HEAD", "--", filePath], workingDir);
}

/**
 * Unstage all files
 */
export function unstageAll(workingDir: string): void {
  git(["reset", "HEAD"], workingDir);
}

/**
 * Discard changes to a file (checkout for tracked, delete for untracked)
 */
export function discardChanges(workingDir: string, filePath: string): void {
  // Check if file is tracked by git
  try {
    git(["ls-files", "--error-unmatch", filePath], workingDir, {
      stdio: "pipe",
    });
    // File is tracked - use checkout
    git(["checkout", "--", filePath], workingDir);
  } catch {
    // File is untracked - delete it
    unlinkSync(join(workingDir, filePath));
  }
}

/**
 * Check if directory is a git repository
 */
export function isGitRepo(workingDir: string): boolean {
  try {
    git(["rev-parse", "--git-dir"], workingDir, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the root of the git repository
 */
export function getGitRoot(workingDir: string): string {
  try {
    return git(["rev-parse", "--show-toplevel"], workingDir).trim();
  } catch {
    return workingDir;
  }
}

/**
 * Check if on main/master branch
 */
export function isMainBranch(workingDir: string): boolean {
  try {
    const branch = git(["branch", "--show-current"], workingDir).trim();
    return branch === "main" || branch === "master";
  } catch {
    return false;
  }
}

/**
 * Create a new branch and switch to it
 */
export function createBranch(workingDir: string, branchName: string): void {
  git(["checkout", "-b", branchName], workingDir);
}

/**
 * Commit staged changes
 */
export function commit(workingDir: string, message: string): string {
  return git(["commit", "-m", message], workingDir);
}

/**
 * Push to remote
 */
export function push(workingDir: string, setUpstream = false): string {
  const branch = git(["branch", "--show-current"], workingDir).trim();

  const args = setUpstream ? ["push", "-u", "origin", branch] : ["push"];
  return git(args, workingDir);
}

/**
 * Check if branch has upstream
 */
export function hasUpstream(workingDir: string): boolean {
  try {
    git(["rev-parse", "--abbrev-ref", "@{upstream}"], workingDir, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get remote URL
 */
export function getRemoteUrl(workingDir: string): string | null {
  try {
    return git(["remote", "get-url", "origin"], workingDir).trim();
  } catch {
    return null;
  }
}

/**
 * Get the default branch name (main or master)
 */
export function getDefaultBranch(workingDir: string): string {
  try {
    // Try to get from remote
    const output = git(
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      workingDir,
      { stdio: "pipe" }
    ).trim();
    return output
      .replace("refs/remotes/origin/", "")
      .replace("refs/heads/", "");
  } catch {
    // No origin/HEAD configured — matches the old `|| echo 'refs/heads/main'`
    return "main";
  }
}

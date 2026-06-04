import { devNull } from "os";
import { runGit, isGitRepo } from "./git";
import { expandHome } from "./platform";

export interface SessionDiff {
  /** False when the session's cwd isn't a git repo (or doesn't exist). */
  supported: boolean;
  /** The ref the diff is computed against (base branch or "HEAD"). */
  baseRef: string | null;
  /** Combined unified diff: tracked changes vs baseRef + untracked files. */
  diff: string;
}

const DIFF_TIMEOUT = 15000;
// Big diffs shouldn't ENOBUFS at execFile's 1MB default.
const DIFF_MAX_BUFFER = 32 * 1024 * 1024;
// Cap the per-file --no-index work for untracked files.
const MAX_UNTRACKED = 100;

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(
      cwd,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      5000
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The cumulative diff of what an agent changed in a session: everything in the
 * working tree that differs from the base (committed since base + uncommitted),
 * plus any untracked files. For a worktree session the base is its base branch;
 * otherwise it's HEAD (so a non-worktree session still shows uncommitted work).
 * All git runs over the shared execFile seam — no shell, cross-platform.
 */
export async function getSessionDiff(opts: {
  cwd: string;
  baseBranch?: string | null;
}): Promise<SessionDiff> {
  const cwd = expandHome(opts.cwd);
  if (!(await isGitRepo(cwd))) {
    return { supported: false, baseRef: null, diff: "" };
  }

  // Prefer the session's base branch; fall back to HEAD if it's unset/missing.
  // baseRef stays the human label ("main"); diffTarget is what we actually diff.
  let baseRef = "HEAD";
  let diffTarget = "HEAD";
  const candidate = opts.baseBranch?.trim();
  if (candidate && candidate !== "HEAD" && (await refExists(cwd, candidate))) {
    baseRef = candidate;
    // Diff against the MERGE-BASE, not the base tip — otherwise commits landed
    // on the base after this session branched show up as spurious changes.
    diffTarget = candidate;
    try {
      const { stdout } = await runGit(
        cwd,
        ["merge-base", candidate, "HEAD"],
        5000
      );
      const sha = stdout.trim();
      if (sha) diffTarget = sha;
    } catch {
      // No common ancestor (unrelated histories) — diff against the base tip.
    }
  }

  // Tracked changes (committed-since-base + uncommitted) vs the working tree.
  let tracked = "";
  try {
    const { stdout } = await runGit(
      cwd,
      ["diff", diffTarget],
      DIFF_TIMEOUT,
      DIFF_MAX_BUFFER
    );
    tracked = stdout;
  } catch {
    // e.g. an unborn HEAD — fall back to a plain working-tree diff.
    try {
      const { stdout } = await runGit(
        cwd,
        ["diff"],
        DIFF_TIMEOUT,
        DIFF_MAX_BUFFER
      );
      tracked = stdout;
    } catch {
      tracked = "";
    }
  }

  // Untracked files don't appear in `git diff`; append each as a new-file diff.
  let untracked = "";
  try {
    const { stdout } = await runGit(
      cwd,
      ["ls-files", "--others", "--exclude-standard"],
      DIFF_TIMEOUT,
      DIFF_MAX_BUFFER
    );
    const files = stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .slice(0, MAX_UNTRACKED);
    for (const file of files) {
      try {
        const { stdout: d } = await runGit(
          cwd,
          ["diff", "--no-index", devNull, file],
          DIFF_TIMEOUT,
          DIFF_MAX_BUFFER
        );
        untracked += d;
      } catch (e) {
        // `git diff --no-index` exits 1 when the files differ — the normal case
        // for a new file; the diff is on the error's stdout.
        const out = (e as { stdout?: string }).stdout;
        if (out) untracked += out;
      }
    }
  } catch {
    // ls-files failed — skip untracked rather than fail the whole diff.
  }

  return { supported: true, baseRef, diff: tracked + untracked };
}

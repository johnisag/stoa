/**
 * Dispatch — merge a worker's PR via gh (user-initiated only).
 *
 * Plain `gh pr merge --<method>` merges NOW and fails if the PR isn't mergeable
 * (e.g. required checks red) — it deliberately does NOT use `--auto`, so Stoa
 * never enables GitHub auto-merge. Merging is always an explicit user action.
 * execFile with an argv array — no shell.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { resolveBinary } from "../platform";

const execFileAsync = promisify(execFile);
const gh = resolveBinary("gh") || "gh";

export type MergeMethod = "squash" | "merge" | "rebase";

/** Pure argv builder (testable). Note: no `--auto` — see file header. When
 * `matchHeadCommit` is set, gh REFUSES the merge if the PR head moved off that SHA
 * (the atomicity the session ceremony's auto-merge needs — never merge commits a
 * push slipped in after review). */
export function buildMergeArgs(
  prNumber: number,
  method: MergeMethod = "squash",
  matchHeadCommit?: string | null,
  repoSlug?: string | null
): string[] {
  const args = ["pr", "merge", String(prNumber), `--${method}`];
  if (matchHeadCommit) args.push("--match-head-commit", matchHeadCommit);
  // --repo decouples gh from the cwd's git remote, so the merge can run from the
  // stable main checkout instead of the per-task worktree (which may be reclaimed
  // — a gone worktree cwd otherwise makes Node throw a misleading "spawn gh ENOENT").
  if (repoSlug) args.push("--repo", repoSlug);
  return args;
}

/** Merge a PR by number from a checkout. Throws on failure (not mergeable, head
 * moved off matchHeadCommit, gh missing/unauth, etc.) so the caller surfaces it. */
export async function mergePR(opts: {
  cwd: string;
  prNumber: number;
  method?: MergeMethod;
  matchHeadCommit?: string | null;
  /** When set, gh runs against this repo via --repo (worktree-independent); the
   * cwd then only needs to be a real existing dir (the stable main checkout). */
  repoSlug?: string | null;
}): Promise<void> {
  await execFileAsync(
    gh,
    buildMergeArgs(
      opts.prNumber,
      opts.method,
      opts.matchHeadCommit,
      opts.repoSlug
    ),
    {
      cwd: opts.cwd,
      encoding: "utf-8",
      timeout: 60000,
      windowsHide: true,
    }
  );
}

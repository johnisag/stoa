/**
 * Pure helper for surfacing a workflow step's git worktree in the UI.
 *
 * Each step's worker is a Stoa session that, by its worktreePolicy, either OWNS
 * its own worktree ("new" — the default, one isolated checkout per step) or runs
 * inside the ONE shared workflow worktree ("shared" — only the first shared step
 * holds the path; the rest reuse it with a null worktree_path of their own).
 *
 * This maps the worker session's (worktree_path, branch_name) plus the step's
 * policy into a small descriptor the run board renders. It's framework-free and
 * unit-tested so the branching (own vs shared vs none) can't silently regress;
 * the React glue (RunDetail) just renders the descriptor.
 */

export type StepWorktreeInfo =
  | {
      /** This step owns an isolated worktree. */
      kind: "own";
      /** Feature branch checked out in the worktree (null if unknown/detached). */
      branch: string | null;
      /** Absolute worktree path (display/tooltip only — never a shell argv). */
      path: string;
    }
  | {
      /** This step runs inside the shared workflow worktree (owner holds the
       * path); we don't repeat the path on every shared row. */
      kind: "shared";
    };

/**
 * Describe a step's worktree from its worker session fields + policy. Returns
 * null when there's nothing to show yet — the step hasn't spawned a worker, or
 * its worktree creation fell back to the source dir (no own path) and it isn't a
 * shared-policy step.
 */
export function describeStepWorktree(opts: {
  worktreePath: string | null | undefined;
  branchName: string | null | undefined;
  worktreePolicy?: "new" | "shared";
}): StepWorktreeInfo | null {
  const path = opts.worktreePath?.trim();
  if (path) {
    return { kind: "own", branch: opts.branchName?.trim() || null, path };
  }
  // No own worktree path: a shared-policy step is running in the shared workflow
  // worktree (the owner row shows the actual path). Anything else has nothing to
  // surface.
  if (opts.worktreePolicy === "shared") return { kind: "shared" };
  return null;
}

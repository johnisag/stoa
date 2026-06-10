/**
 * Dispatch — CI auto-fix loop (opt-in per repo).
 *
 * When a repo arms `ci_autofix`, a worker's PR whose checks go RED gets a fixer
 * agent spawned in its worktree: read the failures (`gh pr checks`, run logs),
 * fix them, and push to the same branch — so CI re-runs and the PR self-heals
 * toward a green, mergeable state. This is the missing half of the autonomous
 * loop: the critic panel reviews the DIFF, but nothing otherwise addresses a red
 * pipeline. Capped by `ci_fix_rounds`; held off while any fixer is already live.
 *
 * Pure helpers (nextCiFixAction / buildCiFixPrompt) are unit-tested; the gh read,
 * spawn, and session lookups are I/O. Reuses getPrReadiness (checks) from
 * ./auto-merge and spawnInWorktree (spawn recipe) from ./reviewer.
 */

import { getDb, queries, type Session } from "../db";
import { getSessionBackend } from "../session-backend";
import { expandHome } from "../platform";
import { getPrReadiness, type CheckSummary } from "./auto-merge";
import { spawnInWorktree } from "./reviewer";
import type { DispatchRepo, IssueDispatch } from "./types";

/** Max CI-fix rounds before a red PR is left for a human (env-overridable;
 * `STOA_MAX_CI_FIX_ROUNDS=0` disables CI auto-fix even on an armed repo). */
export const MAX_CI_FIX_ROUNDS = (() => {
  const raw = process.env.STOA_MAX_CI_FIX_ROUNDS;
  if (raw == null) return 2;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 2;
})();

export type CiFixAction = "spawn_ci_fixer" | "wait" | "stuck" | "idle";

/**
 * Pure decision for one open PR this tick. Unit-tested.
 *   idle  — not a candidate (flag off / not a live PR / checks not red)
 *   wait  — checks red but a fixer (CI or review) is already working on it
 *   spawn_ci_fixer — checks red, no fixer live, under the round cap
 *   stuck — checks red, no fixer live, round cap hit (needs a human)
 * Only "failing" checks act — pending/passing/none are left alone (auto-merge
 * handles the green path; pending just needs to finish).
 */
export function nextCiFixAction(input: {
  ciAutofix: boolean;
  status: string;
  prNumber: number | null;
  checks: CheckSummary;
  ciFixerAlive: boolean;
  reviewFixerAlive: boolean;
  ciFixRounds: number;
  maxCiFixRounds: number;
}): CiFixAction {
  if (
    !input.ciAutofix ||
    input.status !== "pr_open" ||
    input.prNumber == null
  ) {
    return "idle";
  }
  if (input.checks !== "failing") return "idle";
  if (input.ciFixerAlive || input.reviewFixerAlive) return "wait";
  return input.ciFixRounds < input.maxCiFixRounds ? "spawn_ci_fixer" : "stuck";
}

/** The CI fixer's brief: diagnose the red checks and push a fix to the SAME
 * branch (updates the existing PR — no new PR). Pure (unit-tested). */
export function buildCiFixPrompt(repo: DispatchRepo, d: IssueDispatch): string {
  return (
    `[Stoa] CI is FAILING on pull request #${d.pr_number} in ${repo.repo_slug} ` +
    `(issue #${d.issue_number}: "${d.issue_title ?? ""}").\n\n` +
    `You are in the PR's worktree on branch "${d.branch_name ?? ""}".\n\n` +
    `1. See which checks failed and why:\n` +
    `   gh pr checks ${d.pr_number}\n` +
    `   (for a failed GitHub Actions run) gh run view <run-id> --log-failed\n` +
    `2. Fix the failures here in this worktree — reproduce locally first when you ` +
    `can (run the failing test/build/lint).\n` +
    `3. Commit and PUSH to the SAME branch (git push) — that updates PR ` +
    `#${d.pr_number} and re-runs CI. Do NOT open a new PR.\n\n` +
    `Keep the change minimal and focused on making CI green.`
  );
}

/** Spawn a CI fixer in the worker's worktree (records ci_fixer + bumps round). */
export async function spawnCiFixer(
  repo: DispatchRepo,
  d: IssueDispatch
): Promise<string | null> {
  if (d.pr_number == null) return null;
  return spawnInWorktree(
    repo,
    d,
    `ci-fix #${d.pr_number}`,
    buildCiFixPrompt(repo, d),
    (sid) => queries.startCiFixRound(getDb()).run(sid, d.id)
  );
}

/**
 * CI-fix pass: for every open PR whose repo armed `ci_autofix`, spawn a fixer
 * when its checks are red (and no fixer is already on it, under the round cap).
 * A no-op for non-armed repos (the common case). Runs regardless of review_gate.
 */
export async function ciFixPass(): Promise<void> {
  const db = getDb();
  const prOpen = queries.listPrOpen(db).all() as IssueDispatch[];
  if (prOpen.length === 0) return;

  let liveNames: Set<string>;
  try {
    liveNames = new Set(await getSessionBackend().list());
  } catch {
    liveNames = new Set();
  }
  const isAlive = (sessionId: string | null): boolean => {
    if (!sessionId) return false;
    const s = queries.getSession(db).get(sessionId) as Session | undefined;
    return !!s && liveNames.has(s.tmux_name);
  };

  for (const d of prOpen) {
    if (d.pr_number == null || !d.worktree_path) continue;
    const repo = queries.getDispatchRepo(db).get(d.repo_id) as
      | DispatchRepo
      | undefined;
    if (!repo || repo.ci_autofix !== 1) continue;

    // A fixer (CI / review / rebase) already working this worktree → skip entirely.
    // The rebase fixer force-pushes with lease, so a CI fixer spawned alongside it
    // would race the same git index and get its commit discarded by the next rebase.
    if (
      isAlive(d.ci_fixer_session_id) ||
      isAlive(d.fixer_session_id) ||
      isAlive(d.rebase_fixer_session_id)
    ) {
      continue;
    }

    const { checks } = await getPrReadiness(
      expandHome(d.worktree_path),
      d.pr_number
    );
    const action = nextCiFixAction({
      ciAutofix: true,
      status: d.status,
      prNumber: d.pr_number,
      checks,
      // Both false here: the isAlive guard above already `continue`d if either
      // fixer was live (the pure fn keeps the flags for standalone testing).
      ciFixerAlive: false,
      reviewFixerAlive: false,
      ciFixRounds: d.ci_fix_rounds,
      maxCiFixRounds: MAX_CI_FIX_ROUNDS,
    });

    if (action === "spawn_ci_fixer") await spawnCiFixer(repo, d);
    // wait / stuck / idle → nothing to do this tick
  }
}

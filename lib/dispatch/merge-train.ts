/**
 * Dispatch — the merge train (opt-in per repo).
 *
 * The auto-merge pass lands a PR that's approved + green + MERGEABLE. But when a
 * worker's PR is ready yet CONFLICTING — the base moved under it while it sat in
 * review — auto-merge can only wait, and a human is left to rebase it by hand. The
 * merge train closes that gap: it spawns the PR's author back into its worktree to
 * rebase onto the base, resolve the conflicts preserving BOTH intents, and
 * force-push-with-lease — so a ready PR self-heals back to mergeable and the
 * landing never costs human time. Nobody else closes this loop: `gh stack` /
 * Graphite auto-rebase but can't *repair* a conflicted one.
 *
 * Capped by `rebase_rounds` (bounding CONSECUTIVE failures — reset once the PR is
 * mergeable again); held off while any fixer (rebase / CI / review) is already on
 * the PR. On a GATED repo, a finished rebase re-reviews the rewritten head before
 * it can merge — a rebase resolution must never auto-merge under the pre-rebase
 * approval (the same rule the session ceremony pins by SHA). The train only keeps
 * PRs LANDABLE — the actual merge is still auto-merge (if armed) or a human (from
 * the Verdict Inbox / board). Pure helpers
 * (nextMergeTrainAction / buildRebaseFixPrompt) are unit-tested; the gh read,
 * spawn, and session lookups are I/O. Reuses getPrReadiness from ./auto-merge and
 * spawnInWorktree (the one spawn recipe) from ./reviewer.
 */

import { getDb, queries, type Session } from "../db";
import { getSessionBackend } from "../session-backend";
import { expandHome } from "../platform";
import { getPrReadiness, type CheckSummary } from "./auto-merge";
import { spawnInWorktree } from "./reviewer";
import type { DispatchRepo, IssueDispatch } from "./types";
import { taskRef } from "./task-label";

/** Max rebase-repair rounds before a CONFLICTING PR is left for a human
 * (env-overridable; `STOA_MAX_REBASE_ROUNDS=0` disables the train even when armed). */
export const MAX_REBASE_ROUNDS = (() => {
  const raw = process.env.STOA_MAX_REBASE_ROUNDS;
  if (raw == null) return 2;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 2;
})();

export type MergeTrainAction = "rebase" | "wait" | "stuck" | "idle";

/**
 * Pure decision for one open PR this tick. Unit-tested.
 *   idle   — not a candidate: train off / not a live PR / not CONFLICTING / red or
 *            pending checks / not yet critic-APPROVED on a gated repo
 *   wait   — CONFLICTING + otherwise landable, but a fixer is already on the PR
 *   rebase — CONFLICTING + otherwise landable, no fixer live, under the round cap
 *   stuck  — CONFLICTING + otherwise landable, no fixer live, round cap hit (human)
 *
 * The train acts only at LANDING time: a PR that's approved (if the repo is gated)
 * and green but CONFLICTING gets its author's rebase repaired. Red checks are the
 * CI-fixer's job; pending checks just need to finish (rebasing now would waste the
 * run); an unapproved PR isn't landing yet, so we don't churn its base.
 */
export function nextMergeTrainAction(input: {
  mergeTrain: boolean;
  status: string;
  prNumber: number | null;
  reviewGate: boolean;
  reviewDecision: string | null;
  mergeable: string | null;
  checks: CheckSummary;
  rebaseFixerAlive: boolean;
  otherFixerAlive: boolean;
  rebaseRounds: number;
  maxRebaseRounds: number;
}): MergeTrainAction {
  if (
    !input.mergeTrain ||
    input.status !== "pr_open" ||
    input.prNumber == null
  ) {
    return "idle";
  }
  // Only repair the rebase of a PR that's otherwise ready to land.
  if (input.reviewGate && input.reviewDecision !== "APPROVED") return "idle";
  if (input.checks === "failing" || input.checks === "pending") return "idle";
  // The trigger: GitHub says the branch needs a rebase onto its base.
  if (input.mergeable !== "CONFLICTING") return "idle";
  if (input.rebaseFixerAlive || input.otherFixerAlive) return "wait";
  return input.rebaseRounds < input.maxRebaseRounds ? "rebase" : "stuck";
}

/** The rebase fixer's brief: rebase the branch onto its base, resolve conflicts
 * preserving both intents, re-verify, and force-push-with-lease to the SAME branch
 * (updates the existing PR — no new PR). Pure (unit-tested). */
export function buildRebaseFixPrompt(
  repo: DispatchRepo,
  d: IssueDispatch
): string {
  const base = repo.base_branch || "main";
  return (
    `[Stoa] Pull request #${d.pr_number} in ${repo.repo_slug} (${taskRef(d)}) ` +
    `CONFLICTS with ${base} — the ` +
    `base moved under it and GitHub can't merge it until it's rebased.\n\n` +
    `You are in the PR's worktree on branch "${d.branch_name ?? ""}".\n\n` +
    `1. Fetch the latest base:\n` +
    `   git fetch origin ${base}\n` +
    `2. Rebase onto it and resolve EVERY conflict — preserve BOTH your change and ` +
    `what landed on ${base} (read both sides; never blindly take one):\n` +
    `   git rebase origin/${base}\n` +
    `   (resolve, \`git add <files>\`, \`git rebase --continue\` until it finishes)\n` +
    `3. Re-verify locally — run the build/tests you can — so the rebase didn't ` +
    `break anything.\n` +
    `4. Update the PR by force-pushing WITH LEASE to the SAME branch (never a ` +
    `plain --force, never a new PR):\n` +
    `   git push --force-with-lease\n` +
    `This makes PR #${d.pr_number} mergeable again. Keep the resolution faithful ` +
    `to both intents — do not drop either side's work.`
  );
}

/** Spawn a rebase fixer in the worker's worktree (records the fixer + bumps round). */
export async function spawnRebaseFixer(
  repo: DispatchRepo,
  d: IssueDispatch
): Promise<string | null> {
  if (d.pr_number == null) return null;
  return spawnInWorktree(
    repo,
    d,
    `rebase #${d.pr_number}`,
    buildRebaseFixPrompt(repo, d),
    (sid) => queries.startRebaseRound(getDb()).run(sid, d.id)
  );
}

/**
 * Merge-train pass: for every open PR whose repo armed `merge_train`, rebase-repair
 * it when it's approved + green but CONFLICTING (and no fixer is already on it,
 * under the round cap). A no-op for non-armed repos (the common case). Runs before
 * the auto-merge pass so a freshly-rebased PR can land the next tick once GitHub
 * recomputes mergeability.
 */
export async function mergeTrainPass(): Promise<void> {
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
      DispatchRepo | undefined;
    if (!repo || repo.merge_train !== 1) continue;

    // A rebase fixer that has FINISHED (id set, session gone): clear it so the
    // board stops showing "rebasing…", and on a gated repo re-review the REBASED
    // head — the resolution rewrote the diff, so it must never auto-merge under the
    // pre-rebase approval. Settle this tick; re-evaluate (re-panel / merge) next.
    if (d.rebase_fixer_session_id && !isAlive(d.rebase_fixer_session_id)) {
      if (repo.review_gate === 1) {
        queries.resetReviewAfterRebase(db).run(d.id);
      } else {
        queries.clearRebaseFixer(db).run(d.id);
      }
      continue;
    }

    // Any fixer (rebase / CI / review) already working → skip the gh call entirely.
    if (
      isAlive(d.rebase_fixer_session_id) ||
      isAlive(d.ci_fixer_session_id) ||
      isAlive(d.fixer_session_id)
    ) {
      continue;
    }

    const { mergeable, checks } = await getPrReadiness(
      expandHome(repo.repo_path),
      d.pr_number,
      repo.repo_slug
    );

    // The PR is mergeable again (base caught up / a prior rebase landed it): zero
    // the rebase counter so the cap bounds CONSECUTIVE failed repairs, not a busy
    // PR's lifetime of individually-fixed conflicts. nextMergeTrainAction returns
    // idle for a MERGEABLE PR anyway, so reset-and-continue loses nothing.
    if (mergeable === "MERGEABLE" && d.rebase_rounds > 0) {
      queries.resetRebaseRounds(db).run(d.id);
      continue;
    }

    const action = nextMergeTrainAction({
      mergeTrain: true,
      status: d.status,
      prNumber: d.pr_number,
      reviewGate: repo.review_gate === 1,
      reviewDecision: d.review_decision,
      mergeable,
      checks,
      // Both false here: the isAlive guard above already `continue`d if any fixer
      // was live (the pure fn keeps the flags for standalone testing).
      rebaseFixerAlive: false,
      otherFixerAlive: false,
      rebaseRounds: d.rebase_rounds,
      maxRebaseRounds: MAX_REBASE_ROUNDS,
    });

    if (action === "rebase") await spawnRebaseFixer(repo, d);
    // wait / stuck / idle → nothing to do this tick
  }
}

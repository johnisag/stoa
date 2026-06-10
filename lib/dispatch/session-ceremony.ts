/**
 * Session "go to auto" — drive enrolled sessions through the SAME ceremony the
 * dispatch engine runs on an issue's PR: a 3-critic panel reviews the session's
 * PR, a fixer addresses requested changes, a CI fixer heals red checks, then the
 * PR auto-merges. We REUSE the dispatch ceremony wholesale — its pure decisions
 * (nextReviewAction / nextCiFixAction / nextAutoMergeAction), its readers
 * (getPrReadiness / aggregatePanelVerdict), the spawn recipe (spawnWorktreeWorker),
 * the canonical verdict marker (reviewVerdictMarker), and mergePR — only the
 * prompt prose differs (a session has no GitHub issue).
 *
 * Runs once per reconcile tick (after autoMergePass); a no-op when no session is
 * enrolled (the common case). Detection/enrolment is the user's explicit opt-in
 * ("go to auto"); this pass is the autonomous WORK behind that tap.
 *
 * Safety, given the owner is an INTERACTIVE session (unlike a finished dispatch
 * worker):
 *  - collision guard: skip while the owner is running/waiting, so a fixer never
 *    writes the worktree under the owner's feet;
 *  - re-enrol scoping: the panel verdict is scoped to comments posted after this
 *    ceremony began (a re-enrol can't inherit a prior enrolment's stale APPROVE);
 *  - approval pinning: the approval is pinned to the PR head SHA, so an owner who
 *    pushes after approval gets re-reviewed instead of auto-merged unreviewed.
 */

import { getDb, queries, type Session } from "../db";
import { getSessionBackend } from "../session-backend";
import { statusDetector } from "../status-detector";
import { expandHome } from "../platform";
import {
  REVIEW_LENSES,
  nextReviewAction,
  aggregatePanelVerdict,
  reviewVerdictMarker,
  spawnWorktreeWorker,
  MAX_FIX_ROUNDS,
  type WorktreeSpawnTarget,
} from "./reviewer";
import { nextCiFixAction, MAX_CI_FIX_ROUNDS } from "./ci-fix";
import { getPrReadiness, nextAutoMergeAction } from "./auto-merge";
import { mergePR } from "./merge";
import type { SessionCeremony, SessionCeremonyStep } from "./types";

// ── session-flavored prompts (a session ceremony has a PR but no GH issue) ──

function buildSessionLensReviewPrompt(
  prNumber: number,
  round: number,
  lens: (typeof REVIEW_LENSES)[number]
): string {
  return (
    `[Stoa] You are ONE of three INDEPENDENT reviewers for pull request #${prNumber}.\n\n` +
    `YOUR LENS: ${lens.title}. Judge ONLY through this lens — ${lens.focus}.\n\n` +
    `Review ONLY — do NOT modify code, commit, or push anything.\n\n` +
    `1. Read the change:\n   gh pr diff ${prNumber}\n` +
    `2. Assess it through your lens. Be concrete and terse.\n` +
    `3. Post ONE PR comment on #${prNumber} (gh pr comment ${prNumber}) — a few ` +
    `lines of findings, then the LAST line EXACTLY this marker, verbatim, nothing ` +
    `after it:\n   ${reviewVerdictMarker(lens.key, round)}\n` +
    `Use verdict=REQUEST_CHANGES instead of APPROVE if your lens finds a blocking ` +
    `problem. If a multi-line --body is awkward in your shell, write it to a file ` +
    `and use \`gh pr comment ${prNumber} --body-file <file>\`. Do NOT post a GitHub ` +
    `review or open a new PR — only the one comment.`
  );
}

function buildSessionFixPrompt(prNumber: number): string {
  return (
    `[Stoa] A reviewer requested changes on pull request #${prNumber}.\n\n` +
    `You are in the PR's worktree.\n\n` +
    `1. Read the feedback and the diff:\n   gh pr view ${prNumber} --comments\n   gh pr diff ${prNumber}\n` +
    `2. Implement the requested changes, commit them, and PUSH to the SAME branch ` +
    `(git push). Do NOT open a new PR — pushing updates PR #${prNumber}.\n` +
    `3. Keep the changes scoped to the feedback.`
  );
}

function buildSessionCiFixPrompt(prNumber: number, branchName: string): string {
  return (
    `[Stoa] CI is FAILING on pull request #${prNumber}.\n\n` +
    `You are in the PR's worktree on branch "${branchName}".\n\n` +
    `1. See which checks failed and why:\n   gh pr checks ${prNumber}\n` +
    `   (for a failed GitHub Actions run) gh run view <run-id> --log-failed\n` +
    `2. Fix the failures here — reproduce locally first when you can (run the ` +
    `failing test/build/lint).\n` +
    `3. Commit and PUSH to the SAME branch (git push) — that updates PR ` +
    `#${prNumber} and re-runs CI. Do NOT open a new PR.\n\n` +
    `Keep the change minimal and focused on making CI green.`
  );
}

// ── the pass ──

/** A spawn target built from the session that owns the ceremony. */
function sessionTarget(session: Session): WorktreeSpawnTarget {
  return {
    agentType: session.agent_type,
    projectId: session.project_id,
    baseBranch: session.base_branch,
    worktreePath: session.worktree_path,
    branchName: session.branch_name,
    label: `session ${session.id.slice(0, 8)}`,
  };
}

/** SQLite `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC) → epoch ms (NaN-safe). */
function sqliteTimeToMs(t: string | null | undefined): number | undefined {
  if (!t) return undefined;
  const ms = Date.parse(t.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * One ceremony pass over every enrolled session. Mirrors the dispatch
 * review/CI-fix/auto-merge passes, fused per-session (a session has at most one
 * PR, so there's no headroom/quota to compute).
 */
export async function sessionCeremonyPass(): Promise<void> {
  const db = getDb();
  const ceremonies = queries
    .listActiveCeremonies(db)
    .all() as SessionCeremony[];
  if (ceremonies.length === 0) return;

  let liveNames: Set<string>;
  try {
    liveNames = new Set(await getSessionBackend().list());
  } catch {
    // Can't enumerate sessions → skip this tick rather than mis-read liveness
    // (a false "dead" fixer would clear an approval mid-fix, and an empty set
    // would bypass the collision guard). Mirrors the reconciler's worker sweep.
    return;
  }
  const isAlive = (sessionId: string | null): boolean => {
    if (!sessionId) return false;
    const s = queries.getSession(db).get(sessionId) as Session | undefined;
    return !!s && liveNames.has(s.tmux_name);
  };
  const setStep = (id: string, step: SessionCeremonyStep) =>
    queries.setCeremonyStep(db).run(step, id);

  for (const c of ceremonies) {
    const session = queries.getSession(db).get(c.session_id) as
      | Session
      | undefined;
    // The session was deleted, or never had a branch/worktree → can't proceed.
    if (!session || !session.worktree_path || !session.branch_name) {
      setStep(c.id, "stuck");
      continue;
    }

    // Collision guard: wait while the owner session is still actively working in
    // the worktree (incl. finishing a seed prompt). Only act once it's settled.
    if (liveNames.has(session.tmux_name)) {
      let ownerStatus = "idle";
      try {
        ownerStatus = (await statusDetector.getStatusDetail(session.tmux_name))
          .status;
      } catch {
        // capture failed — treat as settled rather than wedging the ceremony.
      }
      if (ownerStatus === "running" || ownerStatus === "waiting") continue;
    }

    const cwd = expandHome(session.worktree_path);

    // Resolve the PR (the API enrols only sessions that have one and caches it;
    // pick it up from the session row if the ceremony hasn't cached it yet).
    let prNumber = c.pr_number ?? session.pr_number;
    if (prNumber == null) continue; // no PR yet — nothing to review/merge
    if (c.pr_number == null) {
      queries.updateCeremonyPR(db).run(session.pr_url, prNumber, c.id);
    }

    // One readiness read per tick — head SHA + state + checks + mergeable.
    const readiness = await getPrReadiness(cwd, prNumber);
    // The owner (or anyone) merged/closed the PR out from under us → terminal.
    if (readiness.state === "MERGED") {
      setStep(c.id, "merged");
      continue;
    }
    if (readiness.state === "CLOSED") {
      setStep(c.id, "stuck");
      continue;
    }

    // ── 1. Review gate (always on for a session ceremony — it IS the gate) ──
    const fixerAlive = isAlive(c.fixer_session_id);
    let decision = c.review_decision;

    // Aggregate only while a panel is out with no fixer and no decision yet (a
    // finished fixer routes to "rereview" below, re-spawning a fresh panel). Scope
    // to comments posted after THIS ceremony began so a re-enrol can't inherit a
    // prior enrolment's APPROVE markers.
    if (c.reviewer_session_id && !c.fixer_session_id && !decision) {
      const verdict = await aggregatePanelVerdict(
        cwd,
        prNumber,
        c.fix_rounds,
        sqliteTimeToMs(c.created_at)
      );
      if (verdict.complete && verdict.decision) {
        queries.setCeremonyReviewDecision(db).run(verdict.decision, c.id);
        decision = verdict.decision;
      }
    }

    const reviewAction = nextReviewAction({
      reviewGate: true,
      status: "pr_open",
      prNumber,
      reviewerSessionId: c.reviewer_session_id,
      reviewDecision: decision,
      fixerSessionId: c.fixer_session_id,
      fixerAlive,
      fixRounds: c.fix_rounds,
      maxFixRounds: MAX_FIX_ROUNDS,
    });

    if (reviewAction === "spawn_critic") {
      setStep(c.id, "reviewing");
      let guardSet = false;
      for (const lens of REVIEW_LENSES) {
        await spawnWorktreeWorker(
          sessionTarget(session),
          `review #${prNumber} · ${lens.key}`,
          buildSessionLensReviewPrompt(prNumber, c.fix_rounds, lens),
          (id) => {
            if (!guardSet) {
              queries.setCeremonyReviewer(db).run(id, c.id);
              guardSet = true;
            }
          }
        );
      }
      continue;
    }
    if (reviewAction === "spawn_fixer") {
      setStep(c.id, "fixing");
      await spawnWorktreeWorker(
        sessionTarget(session),
        `fix #${prNumber}`,
        buildSessionFixPrompt(prNumber),
        (id) => queries.startCeremonyFixRound(db).run(id, c.id)
      );
      continue;
    }
    if (reviewAction === "rereview") {
      queries.resetCeremonyForReReview(db).run(c.id);
      setStep(c.id, "reviewing");
      continue;
    }
    if (reviewAction === "stuck") {
      setStep(c.id, "stuck");
      continue;
    }
    if (reviewAction !== "approved") {
      // "wait" (a fixer is working) / "idle" (panel still out) → next tick.
      if (reviewAction === "wait") setStep(c.id, "fixing");
      continue;
    }

    // ── 2. Approval pinning: pin to the head SHA at approval; re-review if moved ──
    let approvedSha = c.approved_sha;
    if (approvedSha == null && readiness.headRefOid) {
      approvedSha = readiness.headRefOid;
      queries.setCeremonyApprovedSha(db).run(approvedSha, c.id);
    }
    if (
      approvedSha &&
      readiness.headRefOid &&
      approvedSha !== readiness.headRefOid
    ) {
      // The owner pushed new commits after the panel approved — re-review them.
      queries.resetCeremonyForReReview(db).run(c.id);
      setStep(c.id, "reviewing");
      continue;
    }

    // ── 3. CI auto-fix (approved diff, but heal red checks first) ──
    if (isAlive(c.ci_fixer_session_id)) {
      setStep(c.id, "ci_fixing");
      continue;
    }
    const ciAction = nextCiFixAction({
      ciAutofix: true,
      status: "pr_open",
      prNumber,
      checks: readiness.checks,
      ciFixerAlive: false,
      reviewFixerAlive: false,
      ciFixRounds: c.ci_fix_rounds,
      maxCiFixRounds: MAX_CI_FIX_ROUNDS,
    });
    if (ciAction === "spawn_ci_fixer") {
      setStep(c.id, "ci_fixing");
      await spawnWorktreeWorker(
        sessionTarget(session),
        `ci-fix #${prNumber}`,
        buildSessionCiFixPrompt(prNumber, session.branch_name),
        (id) => queries.startCeremonyCiFixRound(db).run(id, c.id)
      );
      continue;
    }
    if (ciAction === "stuck") {
      setStep(c.id, "stuck");
      continue;
    }

    // ── 4. Auto-merge (approved + mergeable + green) ──
    const mergeAction = nextAutoMergeAction({
      autoMerge: true,
      status: "pr_open",
      prNumber,
      reviewGate: true,
      reviewDecision: decision,
      mergeable: readiness.mergeable,
      checks: readiness.checks,
    });
    if (mergeAction === "merge") {
      setStep(c.id, "merging");
      try {
        await mergePR({ cwd, prNumber });
        setStep(c.id, "merged");
        // Flip the session's own PR badge to 'merged' so a hands-off completion
        // shows on the card (not just inside the dialog). Don't reclaim the
        // worktree — the session owns it; the session-delete path does that.
        queries
          .updateSessionPR(db)
          .run(session.pr_url ?? c.pr_url, prNumber, "merged", session.id);
        console.log(`session ceremony: auto-merged PR #${prNumber}`);
      } catch (err) {
        console.error(
          `session ceremony: auto-merge of PR #${prNumber} deferred:`,
          err instanceof Error ? err.message : err
        );
      }
    } else {
      // Approved, but not mergeable/green yet → waiting on CI or a rebase.
      setStep(c.id, "ready");
    }
  }
}

/**
 * Session "go to auto" — drive enrolled sessions through the SAME ceremony the
 * dispatch engine runs on an issue's PR: a 3-critic panel reviews the session's
 * PR, a fixer addresses requested changes, a CI fixer heals red checks, then —
 * if the user opted in — the PR auto-merges (otherwise it stops at
 * 'awaiting_merge' and the human does the one-tap merge). We REUSE the dispatch
 * ceremony's pure decisions (nextReviewAction / nextCiFixAction /
 * nextAutoMergeAction), readers (getPrReadiness), the spawn recipe
 * (spawnWorktreeWorker), and mergePR; the review verdict uses a SHA-bound marker
 * (aggregateSessionVerdict) rather than the dispatch round marker.
 *
 * Runs once per reconcile tick (after autoMergePass); a no-op when no session is
 * enrolled. Enrolment is the user's explicit opt-in; this is the autonomous WORK.
 *
 * Safety, given the owner is an INTERACTIVE session (it can push at any time):
 *  - collision guard: skip while the owner is running/waiting;
 *  - SHA-bound review: the panel is pinned to the head SHA at SPAWN (fail-closed —
 *    no SHA, no panel), each panelist stamps the SHA it reviewed, and only markers
 *    matching the pinned SHA count — so a stale panel (re-enrol / cancel race / a
 *    push) can never approve commits it didn't see, no round/time bookkeeping;
 *  - the merge is `gh --match-head-commit`-pinned to that SHA, and a moved head is
 *    re-reviewed — never merged unreviewed;
 *  - auto-merge is OPT-IN; the default stops at 'awaiting_merge' for the human.
 */

import { getDb, queries, type Session } from "../db";
import { getSessionBackend } from "../session-backend";
import { statusDetector } from "../status-detector";
import { expandHome } from "../platform";
import {
  REVIEW_LENSES,
  nextReviewAction,
  aggregateSessionVerdict,
  sessionReviewMarker,
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
  lens: (typeof REVIEW_LENSES)[number]
): string {
  return (
    `[Stoa] You are ONE of three INDEPENDENT reviewers for pull request #${prNumber}.\n\n` +
    `YOUR LENS: ${lens.title}. Judge ONLY through this lens — ${lens.focus}.\n\n` +
    `Review ONLY — do NOT modify code, commit, or push anything.\n\n` +
    `1. Get the EXACT commit you are reviewing, then read the diff:\n` +
    `   gh pr view ${prNumber} --json headRefOid   (note the full headRefOid SHA)\n` +
    `   gh pr diff ${prNumber}\n` +
    `2. Assess it through your lens. Be concrete and terse.\n` +
    `3. Post ONE PR comment on #${prNumber} (gh pr comment ${prNumber}) — a few ` +
    `lines of findings, then the LAST line EXACTLY this marker with <HEAD_SHA> ` +
    `replaced by the full headRefOid SHA from step 1, verbatim, nothing after it:\n` +
    `   ${sessionReviewMarker("<HEAD_SHA>", lens.key)}\n` +
    `Use verdict=REQUEST_CHANGES instead of APPROVE if your lens finds a blocking ` +
    `problem. The SHA MUST be the one you actually reviewed (this binds your ` +
    `verdict to that exact commit). If a multi-line --body is awkward, write it to ` +
    `a file and use \`gh pr comment ${prNumber} --body-file <file>\`. Do NOT post a ` +
    `GitHub review or open a new PR — only the one comment.`
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
    // (a false "dead" fixer would clear a review mid-fix, and an empty set would
    // bypass the collision guard). Mirrors the reconciler's worker sweep.
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

    // If the head moved while a panel is still out (no decision yet), the panel is
    // reviewing stale commits and its markers (stamped with the new head) will
    // never match the old pin → it would wedge at 'reviewing' forever. Reset and
    // re-pin to the new head.
    if (
      c.reviewer_session_id &&
      !decision &&
      !c.fixer_session_id &&
      c.review_sha &&
      readiness.headRefOid &&
      c.review_sha !== readiness.headRefOid
    ) {
      queries.resetCeremonyForReReview(db).run(c.id);
      setStep(c.id, "reviewing");
      continue;
    }

    // Aggregate only while a panel is out with no fixer and no decision yet. The
    // verdict is keyed on review_sha (the exact commit the panel was pinned to at
    // spawn): a panelist's marker counts ONLY if it stamped that same SHA, so a
    // stale panel (re-enrol / cancel race / a push) can never approve other code.
    if (
      c.reviewer_session_id &&
      c.review_sha &&
      !c.fixer_session_id &&
      !decision
    ) {
      const verdict = await aggregateSessionVerdict(
        cwd,
        prNumber,
        c.review_sha
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
      // FAIL-CLOSED: never spawn a panel whose reviewed SHA we can't pin (a gh
      // read failure leaves headRefOid null) — retry next tick. The pinned SHA is
      // what the panel's markers must match AND what the merge requires
      // (gh --match-head-commit), so it must be known before we start.
      if (!readiness.headRefOid) continue;
      const reviewSha = readiness.headRefOid;
      setStep(c.id, "reviewing");
      let guardSet = false;
      for (const lens of REVIEW_LENSES) {
        await spawnWorktreeWorker(
          sessionTarget(session),
          `review #${prNumber} · ${lens.key}`,
          buildSessionLensReviewPrompt(prNumber, lens),
          (id) => {
            if (!guardSet) {
              queries.setCeremonyReview(db).run(id, reviewSha, c.id);
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

    // ── 2. Approval pinning: the panel approved review_sha; if the live head
    //       moved off it (owner pushed after approval) → re-review the new commits.
    if (
      c.review_sha &&
      readiness.headRefOid &&
      c.review_sha !== readiness.headRefOid
    ) {
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

    // ── 4. Ready: approved + green + mergeable? Auto-merge (opt-in) or hand to the
    //       human. The merge is pinned to the reviewed SHA (gh --match-head-commit).
    const ready =
      nextAutoMergeAction({
        autoMerge: true,
        status: "pr_open",
        prNumber,
        reviewGate: true,
        reviewDecision: decision,
        reviewSha: c.review_sha,
        mergeable: readiness.mergeable,
        checks: readiness.checks,
        // The verify harness is dispatch-only (a ceremony has no per-repo
        // verify_command); inert here — never adds a gate.
        verifyGate: false,
        verifyStatus: null,
      }) === "merge";

    if (!ready) {
      setStep(c.id, "ready"); // approved, waiting on CI / mergeability
      continue;
    }
    // FAIL-CLOSED: 'ready' requires the pinned reviewed SHA (spawn guarantees it;
    // defend against any path that lost it — never merge without a pin).
    if (!c.review_sha) {
      queries.resetCeremonyForReReview(db).run(c.id);
      setStep(c.id, "reviewing");
      continue;
    }
    if (c.auto_merge !== 1) {
      setStep(c.id, "awaiting_merge"); // the human does the final merge
      continue;
    }
    // Opt-in auto-merge, pinned to the reviewed SHA (gh refuses if the head moved).
    setStep(c.id, "merging");
    try {
      await mergePR({ cwd, prNumber, matchHeadCommit: c.review_sha });
      setStep(c.id, "merged");
      queries
        .updateSessionPR(db)
        .run(session.pr_url ?? c.pr_url, prNumber, "merged", session.id);
      console.log(`session ceremony: auto-merged PR #${prNumber}`);
    } catch (err) {
      // Not mergeable yet / head moved off the pin — leave it; the next tick
      // re-checks (the head-moved guard above re-reviews if the owner pushed).
      console.error(
        `session ceremony: auto-merge of PR #${prNumber} deferred:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

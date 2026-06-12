/**
 * Dispatch — auto-merge a worker's PR once it's ready (opt-in per issue).
 *
 * A row with auto_merge=1 and status 'pr_open' is merged by the reconciler when:
 *   - there are no merge conflicts (gh mergeable === "MERGEABLE"),
 *   - its checks are green (or there are none), and
 *   - if the repo armed review_gate, the critic panel's verdict is APPROVED.
 * The HARD gate is `gh pr merge` itself (it refuses an unmergeable PR); the
 * readiness check just avoids spamming doomed merge attempts every tick.
 *
 * Pure helpers (summarizePrChecks / nextAutoMergeAction) are unit-tested; the gh
 * read + merge are I/O. execFile with an argv array — no shell.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { getDb, queries } from "../db";
import { resolveBinary, expandHome } from "../platform";
import { runInBackground } from "../async-operations";
import { deleteWorktree } from "../worktrees";
import { mergePR } from "./merge";
import type { DispatchRepo, IssueDispatch } from "./types";

const execFileAsync = promisify(execFile);
const gh = resolveBinary("gh") || "gh";

// CheckSummary + summarizePrChecks live in the pure, dependency-free lib/pr-badge
// (so the client PR badge can use them); imported for local use here and
// re-exported so the rest of the dispatch fleet keeps its existing import path.
import { summarizePrChecks, type CheckSummary } from "../pr-badge";
export { summarizePrChecks, type CheckSummary };

export type AutoMergeAction = "merge" | "wait" | "skip";

/**
 * Decide what to do with one row this tick. Pure + unit-tested.
 *   skip  — not an auto-merge candidate (flag off / not a live PR)
 *   wait  — a candidate, but not ready (unapproved, conflicts, red/pending checks)
 *   merge — ready: attempt the merge now
 */
export function nextAutoMergeAction(input: {
  autoMerge: boolean;
  status: string;
  prNumber: number | null;
  reviewGate: boolean;
  reviewDecision: string | null;
  mergeable: string | null;
  checks: CheckSummary;
  /** Verify harness armed for this repo. */
  verifyGate: boolean;
  /** Stoa's local verify verdict for the CURRENT head (null when not armed, not
   * yet run, or the cached verdict is for an older SHA — the caller SHA-pins it). */
  verifyStatus: string | null;
}): AutoMergeAction {
  if (
    !input.autoMerge ||
    input.status !== "pr_open" ||
    input.prNumber == null
  ) {
    return "skip";
  }
  // Review gate armed → require the critic's APPROVED before merging.
  if (input.reviewGate && input.reviewDecision !== "APPROVED") return "wait";
  // CONFLICTING (needs rebase) or UNKNOWN (GitHub still computing) → not now.
  if (input.mergeable !== "MERGEABLE") return "wait";
  if (input.checks === "failing" || input.checks === "pending") return "wait";
  // Verify gate armed → require a local PASS for THIS head. Placed LAST and
  // ADDITIVE: it can only add a wait (never loosens an existing gate), and resolves
  // when the verify pass records 'pass'. A misconfig yields 'error' → it sits
  // visibly in the inbox with the output tail, never a silent merge.
  if (input.verifyGate && input.verifyStatus !== "pass") return "wait";
  return "merge"; // approved, mergeable, checks green/none, verified (if armed)
}

export interface PrReadiness {
  mergeable: string | null;
  checks: CheckSummary;
  /** PR head commit SHA (for approval-pinning), null on failure. */
  headRefOid: string | null;
  /** PR state — "OPEN" | "MERGED" | "CLOSED", null on failure. */
  state: string | null;
}

/** Pure argv for reading a PR's state (testable). --repo makes the read
 * independent of the cwd's git remote, so it can run from the stable main checkout
 * rather than a per-task worktree that may have been reclaimed. */
export function buildPrViewArgs(
  prNumber: number,
  repoSlug?: string | null
): string[] {
  const args = [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "mergeable,statusCheckRollup,headRefOid,state",
  ];
  if (repoSlug) args.push("--repo", repoSlug);
  return args;
}

/** Read a PR's merge readiness via gh (conflicts + checks + head SHA + state; the
 * review verdict is Stoa's own cached panel decision, not GitHub's). On any
 * failure, returns a never-ready shape (mergeable null + checks "pending") so the
 * caller waits. headRefOid/state are additive (the dispatch passes ignore them). */
export async function getPrReadiness(
  cwd: string,
  prNumber: number,
  repoSlug?: string | null
): Promise<PrReadiness> {
  try {
    const { stdout } = await execFileAsync(
      gh,
      buildPrViewArgs(prNumber, repoSlug),
      { cwd, encoding: "utf-8", timeout: 15000, windowsHide: true }
    );
    const parsed = JSON.parse(stdout) as {
      mergeable?: unknown;
      statusCheckRollup?: unknown;
      headRefOid?: unknown;
      state?: unknown;
    };
    return {
      mergeable: typeof parsed.mergeable === "string" ? parsed.mergeable : null,
      checks: summarizePrChecks(parsed.statusCheckRollup),
      headRefOid:
        typeof parsed.headRefOid === "string" ? parsed.headRefOid : null,
      state: typeof parsed.state === "string" ? parsed.state : null,
    };
  } catch {
    return {
      mergeable: null,
      checks: "pending",
      headRefOid: null,
      state: null,
    };
  }
}

/**
 * Auto-merge pass: for each opted-in open-PR row, merge when ready. A merge that
 * fails (PR not actually mergeable yet per GitHub) is non-fatal — the next tick
 * re-checks. Reuses listPrOpen and filters in JS (the common case is zero rows).
 */
export async function autoMergePass(): Promise<void> {
  const db = getDb();
  const rows = (queries.listPrOpen(db).all() as IssueDispatch[]).filter(
    (d) => d.auto_merge === 1
  );
  if (rows.length === 0) return;

  for (const d of rows) {
    if (d.pr_number == null || !d.worktree_path) continue;
    const repo = queries.getDispatchRepo(db).get(d.repo_id) as
      | DispatchRepo
      | undefined;
    if (!repo) continue;

    // gh PR reads/merges run against the repo (--repo) from the STABLE main
    // checkout — never the per-task worktree cwd, which may have been reclaimed
    // (a gone worktree otherwise makes gh's spawn throw a misleading ENOENT).
    const repoCwd = expandHome(repo.repo_path);
    const cwd = expandHome(d.worktree_path);
    const readiness = await getPrReadiness(
      repoCwd,
      d.pr_number,
      repo.repo_slug
    );
    const action = nextAutoMergeAction({
      autoMerge: true,
      status: d.status,
      prNumber: d.pr_number,
      reviewGate: repo.review_gate === 1,
      // Stoa's OWN aggregated panel verdict (cached on the row by reviewGatePass),
      // NOT GitHub's reviewDecision — the panel posts comments, not GitHub reviews,
      // so GitHub's field stays null and would block a gated PR forever.
      reviewDecision: d.review_decision,
      mergeable: readiness.mergeable,
      checks: readiness.checks,
      // Armed == gate on AND a command set (else verifyPass never runs and the
      // gate would wait forever — match verifyPass's own skip condition).
      verifyGate: repo.verify_gate === 1 && !!repo.verify_command,
      // SHA-PIN: a verify pass only counts for the EXACT head it ran on. A stale
      // pass (head moved after) must never greenlight the newer, unverified push.
      verifyStatus:
        readiness.headRefOid && d.verify_sha === readiness.headRefOid
          ? d.verify_status
          : null,
    });
    if (action !== "merge") continue;

    try {
      await mergePR({
        cwd: repoCwd,
        prNumber: d.pr_number,
        repoSlug: repo.repo_slug,
      });
      queries.updateDispatchStatus(db).run("merged", d.id);
      console.log(
        `dispatch: auto-merged PR #${d.pr_number} (${repo.repo_slug})`
      );
      // The PR is merged and the worker is long done — reclaim its worktree so
      // an autonomous (no-human) loop doesn't leak a directory per merged issue.
      // Background + best-effort: a cleanup failure must not fail the tick.
      runInBackground(
        () => deleteWorktree(cwd, repoCwd, false),
        `automerge-cleanup-${d.id}`
      );
    } catch (err) {
      // Not mergeable yet per GitHub (a required check/review just flipped, the
      // base moved, …) — leave it; the next tick re-checks.
      console.error(
        `dispatch: auto-merge of PR #${d.pr_number} deferred:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

// Pure, dependency-free PR review-status → tint mapping. Lives apart from lib/pr.ts
// (which imports node builtins via ./platform) so client components — the
// GitDrawer "View PR" pill — can import it without pulling in server-only modules.

// gh's `reviewDecision`: "" when no review is required/given. We narrow it to the
// states GitHub actually returns so the badge can tint from it.
export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | "";

// One verdict for a PR's CI checks. Canonical home (pure + dependency-free);
// lib/dispatch/auto-merge re-exports it so the dispatch fleet shares one definition.
export type CheckSummary = "passing" | "pending" | "failing" | "none";

/**
 * Collapse gh's `statusCheckRollup` into one verdict. Pure + unit-tested.
 *   failing — any check concluded in a non-success terminal state
 *   pending — any check still running/queued (and none failing)
 *   passing — at least one check, all successful / neutral / skipped
 *   none    — no checks configured on the PR
 * A CheckRun carries `status` + `conclusion`; a StatusContext carries `state`.
 */
export function summarizePrChecks(rollup: unknown): CheckSummary {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const raw of rollup) {
    const c = (raw ?? {}) as {
      status?: unknown;
      conclusion?: unknown;
      state?: unknown;
    };
    // StatusContext (legacy commit statuses): carries `state`, no status/conclusion.
    if (typeof c.state === "string") {
      const state = c.state.toUpperCase();
      if (state === "SUCCESS") continue;
      if (state === "PENDING" || state === "EXPECTED") {
        pending = true;
        continue;
      }
      return "failing"; // FAILURE | ERROR
    }
    // CheckRun: status QUEUED|IN_PROGRESS|COMPLETED; conclusion SUCCESS|FAILURE|…
    if (
      typeof c.status === "string" &&
      c.status.toUpperCase() !== "COMPLETED"
    ) {
      pending = true; // still running/queued
      continue;
    }
    const concl = (
      typeof c.conclusion === "string" ? c.conclusion : ""
    ).toUpperCase();
    if (concl === "SUCCESS" || concl === "NEUTRAL" || concl === "SKIPPED") {
      continue;
    }
    if (!concl) {
      pending = true; // no terminal verdict yet (or an unrecognized shape) → wait
      continue;
    }
    return "failing"; // FAILURE | CANCELLED | TIMED_OUT | ACTION_REQUIRED | …
  }
  return pending ? "pending" : "passing";
}

/** A color tint key for the "View PR" pill. */
export type PrBadgeTone = "approved" | "changes" | "pending" | "draft";

/** Tint + a11y label for the "View PR" pill, keyed by tone. Shared by BOTH the
 * desktop git drawer and the mobile git panel so the badge looks identical on
 * every surface. Muted (draft/pending) keeps the neutral pill; green/amber call
 * out a settled verdict. */
export const PR_TONE_STYLES: Record<
  PrBadgeTone,
  { className: string; label: string }
> = {
  approved: {
    className:
      "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400",
    label: "approved",
  },
  changes: {
    className:
      "bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-400",
    label: "changes requested",
  },
  pending: {
    className: "bg-muted hover:bg-accent",
    label: "review pending",
  },
  draft: {
    className: "bg-muted text-muted-foreground hover:bg-accent",
    label: "draft",
  },
};

/**
 * Map a PR's review/draft/checks state to one tint key. Pure + unit-tested.
 *   draft    — the PR is still a draft (takes precedence; not ready for review)
 *   changes  — a reviewer requested changes, OR CI is failing
 *   approved — approved AND checks aren't failing
 *   pending  — anything else (review still required / running checks / no signal)
 */
export function prBadgeTone(input: {
  reviewDecision: ReviewDecision;
  isDraft: boolean;
  checks: CheckSummary;
}): PrBadgeTone {
  if (input.isDraft) return "draft";
  if (
    input.reviewDecision === "CHANGES_REQUESTED" ||
    input.checks === "failing"
  )
    return "changes";
  if (input.reviewDecision === "APPROVED") return "approved";
  return "pending";
}

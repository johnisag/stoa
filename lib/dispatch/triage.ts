/**
 * Dispatch — on-demand backlog triage.
 *
 * Named "triage" (not "backlog") to avoid colliding with the Backlog tab, which
 * is the pending-candidate review queue. This is the OTHER thing: browse a repo's
 * live open GitHub issues and dispatch a chosen one. Pure helpers only — the
 * route does the I/O and hands the gh issues + dispatch rows in.
 */

import type { DispatchStatus, EligibleIssue, IssueDispatch } from "./types";

/** A browsed open issue + whether Stoa already has a dispatch row for it. */
export interface TriageIssue extends EligibleIssue {
  /** Current dispatch status for this issue, or null if never dispatched. */
  dispatchStatus: DispatchStatus | null;
  /** The dispatch row id (for follow-up actions), or null if never dispatched. */
  dispatchId: string | null;
}

/**
 * Overlay open issues with their dispatch state, keyed by issue number. Pure and
 * order-preserving (gh's sort is kept). An issue with no dispatch row gets
 * `{ dispatchStatus: null, dispatchId: null }` — i.e. freely dispatchable. The
 * (repo, issue_number) unique index guarantees at most one row per number.
 */
export function annotateTriageIssues(
  issues: EligibleIssue[],
  existing: Pick<IssueDispatch, "issue_number" | "status" | "id">[]
): TriageIssue[] {
  const byNumber = new Map<number, { status: DispatchStatus; id: string }>();
  for (const d of existing) {
    byNumber.set(d.issue_number, { status: d.status, id: d.id });
  }
  return issues.map((issue) => {
    const hit = byNumber.get(issue.number);
    return {
      ...issue,
      dispatchStatus: hit ? hit.status : null,
      dispatchId: hit ? hit.id : null,
    };
  });
}

/**
 * Whether triaging an existing issue may spawn a worker now: only a fresh
 * 'pending' candidate. An already working / in-PR / merged / failed / cancelled
 * row is left as-is (the board owns retrying a failed one). Pure + unit-locked.
 */
export function canDispatchExisting(status: DispatchStatus): boolean {
  return status === "pending";
}

/**
 * Verdict Inbox — a fleet-wide read model over everything awaiting the operator's
 * review attention: dispatch workers' PRs AND session "go to auto" ceremonies,
 * unified into one list. The dominant 2026 sink is human review; this surfaces
 * every pending diff in one place (verdict + branch + PR + state) so the operator
 * reviews from Stoa instead of opening N GitHub tabs.
 *
 * Pure-ish: reads existing DB rows only (no gh) — the per-lens FINDINGS are read
 * live per-item on demand (see readReviewerFindings in lib/dispatch/reviewer.ts),
 * so this list stays cheap to poll. `listInboxItems` is unit-tested against a
 * mocked db.
 */

import { getDb, queries, type Session } from "./db";
import type {
  IssueDispatch,
  DispatchRepo,
  SessionCeremony,
} from "./dispatch/types";
import { isLocalTask } from "./dispatch/task-label";

// The pure "needs me" selectors live in a db-free module so client components can
// import them without pulling better-sqlite3 into the browser bundle; re-export
// them here so server callers + tests still get them from `lib/verdict-inbox`.
export { beingFixed, needsMe, countNeedsMe } from "./verdict-inbox-selectors";

export type InboxItemType = "dispatch" | "ceremony";

export interface InboxItem {
  type: InboxItemType;
  /** The dispatch row id or the ceremony row id (routes the actions). */
  id: string;
  /** The session id (ceremony items) — the action endpoints key on it. */
  sessionId: string | null;
  /** The dispatch repo id (dispatch items only) — lets a finding be remembered as
   * a per-repo lesson. null for ceremonies (no tracked dispatch repo). */
  repoId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** Headline: the issue title (#N) or the session's branch. */
  title: string;
  /** Source line: repo slug (dispatch) or session name (ceremony). */
  subtitle: string;
  branch: string | null;
  /** Stoa's cached aggregate verdict — APPROVED | CHANGES_REQUESTED | null (in review). */
  reviewDecision: string | null;
  /** Coarse lifecycle for the badge: dispatch.status or ceremony.step. */
  state: string;
  /** Whether a critic panel gates this item — false → no verdict will ever come
   * (ungated repo), so the UI badges it "no review" and allows a human merge. */
  reviewGate: boolean;
  /** Local verification verdict (dispatch verify harness): pass | fail | error |
   * running | null. null when the repo didn't arm verify (or for ceremonies). */
  verifyStatus: string | null;
  /** Bounded tail of the failing verify step's output (fail/error), else null. */
  verifyOutput: string | null;
  /** Whether the verify harness gates this item (armed dispatch repo). */
  verifyGate: boolean;
  fixRounds: number;
  autoMerge: boolean;
  updatedAt: string;
}

/**
 * Every item awaiting review attention, newest first: dispatch rows that reached
 * a PR (or failed) + active session ceremonies. Merged/cancelled rows drop off.
 */
export function listInboxItems(): InboxItem[] {
  const db = getDb();
  const items: InboxItem[] = [];

  // Dispatch workers that opened a PR (review / CI / merge phase) or failed.
  const dispatches = (
    queries.listDispatchesForBoard(db).all() as IssueDispatch[]
  ).filter((d) => d.status === "pr_open" || d.status === "failed");
  for (const d of dispatches) {
    const repo = queries.getDispatchRepo(db).get(d.repo_id) as
      | DispatchRepo
      | undefined;
    items.push({
      type: "dispatch",
      id: d.id,
      sessionId: null,
      repoId: d.repo_id,
      prNumber: d.pr_number,
      prUrl: d.pr_url,
      // Local tasks have no issue number — show the bare title, not "(#0)".
      title: isLocalTask(d)
        ? (d.issue_title ?? "(untitled task)")
        : d.issue_title
          ? `${d.issue_title} (#${d.issue_number})`
          : `Issue #${d.issue_number}`,
      subtitle: repo?.repo_slug ?? "—",
      branch: d.branch_name,
      reviewDecision: d.review_decision,
      state: d.status,
      reviewGate: repo?.review_gate === 1,
      verifyStatus: d.verify_status,
      verifyOutput: d.verify_output,
      // Armed == gate on AND a command set (matches verifyPass / autoMergePass), so
      // a gate-on-but-no-command repo doesn't hide the Merge button forever.
      verifyGate: repo?.verify_gate === 1 && !!repo?.verify_command,
      fixRounds: d.fix_rounds,
      autoMerge: d.auto_merge === 1,
      updatedAt: d.updated_at,
    });
  }

  // Session "go to auto" ceremonies awaiting attention (incl. 'stuck').
  const ceremonies = queries
    .listCeremoniesForReview(db)
    .all() as SessionCeremony[];
  for (const c of ceremonies) {
    const session = queries.getSession(db).get(c.session_id) as
      | Session
      | undefined;
    if (!session) continue;
    items.push({
      type: "ceremony",
      id: c.id,
      sessionId: session.id,
      repoId: null,
      prNumber: c.pr_number,
      prUrl: c.pr_url,
      title: session.branch_name ?? session.name,
      subtitle: session.name,
      branch: session.branch_name,
      reviewDecision: c.review_decision,
      state: c.step,
      // A ceremony always runs the critic panel — it's gated by definition.
      reviewGate: true,
      // The verify harness is dispatch-only in v1 (a ceremony has no per-repo
      // verify_command); ceremonies carry no verify evidence.
      verifyStatus: null,
      verifyOutput: null,
      verifyGate: false,
      fixRounds: c.fix_rounds,
      autoMerge: c.auto_merge === 1,
      updatedAt: c.updated_at,
    });
  }

  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return items;
}

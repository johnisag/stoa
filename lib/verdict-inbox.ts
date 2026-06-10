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
import { expandHome } from "./platform";
import type {
  IssueDispatch,
  DispatchRepo,
  SessionCeremony,
} from "./dispatch/types";

export type InboxItemType = "dispatch" | "ceremony";

export interface InboxItem {
  type: InboxItemType;
  /** The dispatch row id or the ceremony row id (routes the actions). */
  id: string;
  /** The session id (ceremony items) — the action endpoints key on it. */
  sessionId: string | null;
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
  /** Worktree path (expanded) for reading the PR's findings via gh, or null. */
  cwd: string | null;
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
      prNumber: d.pr_number,
      prUrl: d.pr_url,
      title: d.issue_title
        ? `${d.issue_title} (#${d.issue_number})`
        : `Issue #${d.issue_number}`,
      subtitle: repo?.repo_slug ?? "—",
      branch: d.branch_name,
      reviewDecision: d.review_decision,
      state: d.status,
      cwd: d.worktree_path ? expandHome(d.worktree_path) : null,
      fixRounds: d.fix_rounds,
      autoMerge: d.auto_merge === 1,
      updatedAt: d.updated_at,
    });
  }

  // Session "go to auto" ceremonies still in flight.
  const ceremonies = queries
    .listActiveCeremonies(db)
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
      prNumber: c.pr_number,
      prUrl: c.pr_url,
      title: session.branch_name ?? session.name,
      subtitle: session.name,
      branch: session.branch_name,
      reviewDecision: c.review_decision,
      state: c.step,
      cwd: session.worktree_path ? expandHome(session.worktree_path) : null,
      fixRounds: c.fix_rounds,
      autoMerge: c.auto_merge === 1,
      updatedAt: c.updated_at,
    });
  }

  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return items;
}

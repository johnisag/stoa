/**
 * Pure "needs me" selectors over the Verdict Inbox read model.
 *
 * These live in their OWN module — separate from `lib/verdict-inbox.ts`, which
 * imports the db (better-sqlite3) — so CLIENT components (the inbox view, the
 * always-on nav-badge count) can import them without dragging a server-only
 * native module into the browser bundle. `lib/verdict-inbox.ts` re-exports them
 * for server callers + tests, so there's one canonical name either way. The
 * `InboxItem` import is type-only (erased at build), so this file stays db-free.
 */
import type { InboxItem } from "./verdict-inbox";

/**
 * A row a fixer is actively working (ceremony fix/CI/merge steps) — the loop is
 * still iterating, so it's not on the human yet. Shared so the inbox view and the
 * always-on nav-badge count can't drift on what counts as "in flight".
 */
export function beingFixed(i: InboxItem): boolean {
  return (
    i.type === "ceremony" &&
    (i.state === "fixing" || i.state === "ci_fixing" || i.state === "merging")
  );
}

/**
 * Does this row need the human NOW? Changes requested, failed, stuck, or approved
 * and waiting on a human merge (ceremony awaiting_merge, or an approved non-auto
 * dispatch) — plus ungated dispatch PRs, which get no verdict and need a merge.
 *
 * The single source of truth for "needs me": the Verdict Inbox view's "Needs me"
 * tab AND the always-on nav-badge count both call this, so the ambient badge and
 * the open queue can never disagree.
 */
export function needsMe(i: InboxItem): boolean {
  if (beingFixed(i)) return false;
  return (
    i.reviewDecision === "CHANGES_REQUESTED" ||
    i.state === "failed" ||
    i.state === "stuck" ||
    i.state === "awaiting_merge" ||
    (i.type === "dispatch" &&
      i.reviewDecision === "APPROVED" &&
      !i.autoMerge) ||
    (i.type === "dispatch" && !i.reviewGate && i.state === "pr_open")
  );
}

/** How many inbox rows need the human — the count behind the nav "needs me" badge. */
export function countNeedsMe(items: InboxItem[]): number {
  return items.reduce((n, i) => (needsMe(i) ? n + 1 : n), 0);
}

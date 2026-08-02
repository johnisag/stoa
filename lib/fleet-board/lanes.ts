/**
 * Fleet board (#5) — pure lane assignment + composition. The board is a kanban of
 * the AUTONOMOUS fleet (dispatch rows + session ceremonies) across lifecycle lanes.
 * Composed CLIENT-SIDE from existing read models (the verdict inbox, dispatch
 * board, pending backlog, and durable Fleet runs); this module is the only new
 * LOGIC, kept pure so it's unit-tested. No plain interactive sessions (they have
 * no lifecycle to map and live in the sidebar already), no scheduled rows
 * (future-dated).
 */
import type { InboxItem } from "@/lib/verdict-inbox";
import { needsMe } from "@/lib/verdict-inbox-selectors";
import type { IssueDispatch } from "@/lib/dispatch/types";
import type { FleetRunDto } from "@/lib/fleet/types";

export type LaneId =
  "queued" | "working" | "in_review" | "verified" | "merged" | "failed";

export const LANES: { id: LaneId; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "working", label: "Working" },
  { id: "in_review", label: "In review" },
  // Label "Ready" (not "Verified") so it doesn't collide with the verify-harness
  // "verify failed" badge a card may carry. The lane = approved/ungated, awaiting merge.
  { id: "verified", label: "Ready" },
  { id: "merged", label: "Merged" },
  { id: "failed", label: "Failed" },
];

export interface FleetCard {
  /** `${type}:${id}` — react key + dedupe key. */
  key: string;
  lane: LaneId;
  /** 'inbox' → rich verdict card; 'dispatch' → light issue card; 'fleet' →
   * durable run card with a lazy task drilldown. */
  source: "inbox" | "dispatch" | "fleet";
  inbox?: InboxItem;
  dispatch?: IssueDispatch;
  fleetRun?: FleetRunDto;
}

/** Map Fleet Management's durable run state onto the shared delivery board. */
export function laneForFleetRun(run: FleetRunDto): LaneId {
  if (run.awaitingManualMerge) return "verified";
  switch (run.status) {
    case "draft":
    case "planned":
      return "queued";
    case "running":
    case "paused":
      return "working";
    case "reviewing":
      return "in_review";
    case "merging":
      return "working";
    case "completed":
      return "merged";
    case "failed":
    case "canceled":
      return "failed";
  }
}

/** Lane for a unified inbox item (a pr_open/failed dispatch row, or any non-merged
 * ceremony step). `state` is the dispatch status OR the ceremony step — keyed by type. */
export function laneForInboxItem(i: InboxItem): LaneId {
  if (i.type === "ceremony") {
    switch (i.state) {
      case "queued":
        return "queued";
      case "reviewing":
        return "in_review";
      case "fixing":
      case "ci_fixing":
      case "merging":
        return "working";
      case "ready":
      case "awaiting_merge":
        return "verified";
      case "merged":
        return "merged";
      case "stuck":
        return "failed";
      default:
        return "working";
    }
  }
  // A dispatch inbox item is only ever pr_open or failed.
  if (i.state === "failed") return "failed";
  // CHANGES_REQUESTED keeps it in review — the fix→re-review loop is still
  // iterating (and 'verified' would be a lie that contradicts the inbox's "needs
  // me"). Gated + no verdict yet is also In review. Otherwise it's ready to merge
  // (approved, or ungated so no verdict will ever come).
  if (i.reviewDecision === "CHANGES_REQUESTED") return "in_review";
  return i.reviewGate && !i.reviewDecision ? "in_review" : "verified";
}

/** Lane for a raw dispatch row (from the board/pending hooks). pr_open is the only
 * value that also appears in the inbox — the composer prefers the inbox version. */
export function laneForDispatch(d: IssueDispatch): LaneId {
  switch (d.status) {
    case "pending":
    case "scheduled":
      return "queued";
    case "dispatched":
      return "working";
    case "merged":
      return "merged";
    case "failed":
      return "failed";
    case "pr_open":
      return "in_review";
    default:
      return "working";
  }
}

/**
 * Compose the fleet card stream from the three sources, deduped by `${type}:${id}`
 * with the richer InboxItem PREFERRED over a raw dispatch row (a pr_open/failed
 * dispatch appears in both the board hook and the inbox). Pure → unit-tested.
 */
export function composeFleetCards(
  board: IssueDispatch[],
  pending: IssueDispatch[],
  inbox: InboxItem[],
  fleetRuns: FleetRunDto[] = []
): FleetCard[] {
  const map = new Map<string, FleetCard>();
  for (const d of board) {
    const key = `dispatch:${d.id}`;
    map.set(key, {
      key,
      lane: laneForDispatch(d),
      source: "dispatch",
      dispatch: d,
    });
  }
  for (const d of pending) {
    const key = `dispatch:${d.id}`;
    map.set(key, { key, lane: "queued", source: "dispatch", dispatch: d });
  }
  // Inbox last: its pr_open/failed rows overwrite the board's (same key), carrying
  // the normalized verdict/verify/gate fields the raw dispatch row lacks.
  for (const i of inbox) {
    const key = `${i.type}:${i.id}`;
    map.set(key, { key, lane: laneForInboxItem(i), source: "inbox", inbox: i });
  }
  for (const run of fleetRuns) {
    const key = `fleet:${run.id}`;
    map.set(key, {
      key,
      lane: laneForFleetRun(run),
      source: "fleet",
      fleetRun: run,
    });
  }
  return [...map.values()];
}

/**
 * Does this card need the human NOW? Verdict rows use their canonical predicate;
 * durable Fleet runs carry the server-computed run/task/worker attention summary.
 * Dispatch-only cards carry no verdict and therefore cannot request attention.
 */
export function cardNeedsMe(c: FleetCard): boolean {
  if (c.source === "fleet") {
    return (c.fleetRun?.attentionCount ?? 0) > 0;
  }
  return c.source === "inbox" && !!c.inbox && needsMe(c.inbox);
}

/** Bucket composed cards into the six lanes (always all keys present). */
export function bucketByLane(cards: FleetCard[]): Record<LaneId, FleetCard[]> {
  const out: Record<LaneId, FleetCard[]> = {
    queued: [],
    working: [],
    in_review: [],
    verified: [],
    merged: [],
    failed: [],
  };
  for (const c of cards) out[c.lane].push(c);
  return out;
}

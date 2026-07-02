import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { dispatchOne } from "@/lib/dispatch/dispatcher";
import {
  isActionAllowed,
  type BoardAction,
} from "@/lib/dispatch/board-actions";
import { reconcileOneStale } from "@/lib/dispatch/stale";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";
import { parseJsonBody, requireLocalhost } from "@/lib/api-security";

type RouteParams = { params: Promise<{ id: string }> };

const ACTIONS: BoardAction[] = [
  "approve",
  "cancel",
  "dismiss",
  "retry",
  "reconcile",
];

// POST /api/dispatch/dispatches/[id] — act on a dispatch row.
//   approve   → spawn the worker now (pending; bypasses caps by design).
//   cancel    → drop a not-yet-running candidate (pending/scheduled).
//   dismiss   → hide a failed row (→ cancelled; stays parked).
//   retry     → re-run a failed row (reset → dispatch fresh; bypasses caps).
//   reconcile → re-check an open-PR row against GitHub (merged/closed out of band
//               → merged/cancelled; still open → no-op).
export async function POST(request: NextRequest, { params }: RouteParams) {
  const auth = requireLocalhost(request);
  if (!auth.ok) return auth.response;

  try {
    const { id } = await params;
    const db = getDb();
    const dispatch = queries.getDispatch(db).get(id) as
      IssueDispatch | undefined;
    if (!dispatch) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const parsed = await parseJsonBody<{ action?: string }>(request);
    if (!parsed.ok) return parsed.response;

    const action = parsed.data.action as BoardAction;
    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    // A reconcile tap that lost the race — a tick / auto-merge already resolved this
    // row in the gap before the board refreshed — isn't an error: report the row's
    // settled state as the outcome so the UI shows a friendly "moved to Merged" /
    // "cleared from the board" instead of a 409 with wire jargon.
    if (action === "reconcile" && dispatch.status !== "pr_open") {
      const resolution =
        dispatch.status === "merged"
          ? { resolution: "merged", probe: "merged" }
          : dispatch.status === "cancelled"
            ? { resolution: "cancelled", probe: "closed" }
            : { resolution: "noop", probe: "open" };
      return NextResponse.json(resolution);
    }
    if (!isActionAllowed(action, dispatch.status)) {
      return NextResponse.json(
        { error: `Can't ${action} a '${dispatch.status}' dispatch` },
        { status: 409 }
      );
    }

    // cancel + dismiss both just hide the row (→ cancelled).
    if (action === "cancel" || action === "dismiss") {
      queries.updateDispatchStatus(db).run("cancelled", id);
      return NextResponse.json({ success: true });
    }

    // reconcile: probe the PR's real state on GitHub and resolve the row if it was
    // merged/closed out of band. Returns { resolution, probe } — 'noop' with probe
    // 'open' means still in flight; 'noop' with probe 'error' means gh was
    // unreachable (so the UI can tell "still open" from "couldn't check").
    if (action === "reconcile") {
      const outcome = await reconcileOneStale(db, dispatch);
      return NextResponse.json(outcome);
    }

    // approve + retry both spawn a worker now; retry first wipes the failed
    // row's worker/PR/review state so dispatchOne gets a clean 'pending' row.
    const repo = queries.getDispatchRepo(db).get(dispatch.repo_id) as
      DispatchRepo | undefined;
    if (!repo) {
      return NextResponse.json(
        { error: "Tracked repo is gone" },
        {
          status: 409,
        }
      );
    }
    if (action === "retry") {
      queries.resetDispatchForRetry(db).run(id);
    }
    const row = queries.getDispatch(db).get(id) as IssueDispatch;
    await dispatchOne(repo, row);
    return NextResponse.json({
      dispatch: queries.getDispatch(db).get(id) as IssueDispatch,
    });
  } catch (error) {
    console.error("dispatch action failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}

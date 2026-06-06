import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { dispatchOne } from "@/lib/dispatch/dispatcher";
import {
  isActionAllowed,
  type BoardAction,
} from "@/lib/dispatch/board-actions";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";

type RouteParams = { params: Promise<{ id: string }> };

const ACTIONS: BoardAction[] = ["approve", "cancel", "dismiss", "retry"];

// POST /api/dispatch/dispatches/[id] — act on a dispatch row.
//   approve → spawn the worker now (pending; bypasses caps by design).
//   cancel  → drop a not-yet-running candidate (pending/scheduled).
//   dismiss → hide a failed row (→ cancelled; stays parked).
//   retry   → re-run a failed row (reset → dispatch fresh; bypasses caps).
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const dispatch = queries.getDispatch(db).get(id) as
      | IssueDispatch
      | undefined;
    if (!dispatch) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const action = body?.action as BoardAction;
    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
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

    // approve + retry both spawn a worker now; retry first wipes the failed
    // row's worker/PR/review state so dispatchOne gets a clean 'pending' row.
    const repo = queries.getDispatchRepo(db).get(dispatch.repo_id) as
      | DispatchRepo
      | undefined;
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

import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { dispatchOne } from "@/lib/dispatch/dispatcher";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/dispatch/dispatches/[id] — act on a dispatch row.
//   { action: "approve" } → spawn the worker now (review-mode one-tap approve;
//     a manual approve bypasses the daily/concurrency caps by design).
//   { action: "cancel" }  → drop a pending candidate.
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
    const action = body?.action;

    if (action === "cancel") {
      if (dispatch.status !== "pending" && dispatch.status !== "scheduled") {
        return NextResponse.json(
          { error: "Only pending or scheduled candidates can be cancelled" },
          { status: 409 }
        );
      }
      queries.updateDispatchStatus(db).run("cancelled", id);
      return NextResponse.json({ success: true });
    }

    if (action === "approve") {
      if (dispatch.status !== "pending") {
        return NextResponse.json(
          { error: "Only pending candidates can be approved" },
          { status: 409 }
        );
      }
      const repo = queries.getDispatchRepo(db).get(dispatch.repo_id) as
        | DispatchRepo
        | undefined;
      if (!repo) {
        return NextResponse.json(
          { error: "Tracked repo is gone" },
          { status: 409 }
        );
      }
      await dispatchOne(repo, dispatch);
      return NextResponse.json({
        dispatch: queries.getDispatch(db).get(id) as IssueDispatch,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("dispatch action failed:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

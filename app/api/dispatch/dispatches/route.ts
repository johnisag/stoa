import { NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import type { IssueDispatch } from "@/lib/dispatch/types";

// GET /api/dispatch/dispatches — the in-flight board: dispatched / pr_open /
// merged / failed rows, newest dispatch first. The UI overlays live session
// status + cost on top of these rows.
export async function GET() {
  try {
    const dispatches = queries
      .listDispatchesForBoard(getDb())
      .all() as IssueDispatch[];
    return NextResponse.json({ dispatches });
  } catch (error) {
    console.error("dispatch board list failed:", error);
    return NextResponse.json({ error: "Failed to list" }, { status: 500 });
  }
}

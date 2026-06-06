import { NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import type { IssueDispatch } from "@/lib/dispatch/types";

/**
 * GET /api/dispatch/scheduled — rows parked for a future time ('scheduled'),
 * shown in the Backlog so the user can see/cancel them before they come due.
 */
export async function GET() {
  try {
    const scheduled = queries.listScheduled(getDb()).all() as IssueDispatch[];
    return NextResponse.json({ scheduled });
  } catch (error) {
    console.error("dispatch scheduled list failed:", error);
    return NextResponse.json(
      { error: "Failed to load scheduled" },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import type { IssueDispatch } from "@/lib/dispatch/types";

// GET /api/dispatch/issues — the backlog: pending candidates awaiting dispatch
// (in review mode, these are the approval queue). The reconciler ingests these
// from gh every 60s for enabled repos.
export async function GET() {
  try {
    const pending = queries.listAllPending(getDb()).all() as IssueDispatch[];
    return NextResponse.json({ pending });
  } catch (error) {
    console.error("dispatch backlog list failed:", error);
    return NextResponse.json({ error: "Failed to list" }, { status: 500 });
  }
}

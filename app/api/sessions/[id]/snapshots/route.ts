import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { listSnapshots } from "@/lib/snapshots";

// GET /api/sessions/[id]/snapshots — the session's turn snapshots (oldest→newest).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = queries.getSession(getDb()).get(id) as Session | undefined;
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const snapshots = await listSnapshots(session.working_directory, id);
    return NextResponse.json({ snapshots });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("snapshots list failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// NOTE: on-demand capture now goes through POST /api/sessions/[id]/checkpoints
// (durable, labeled — it captures a snapshot under the hood). This route is
// GET-only.

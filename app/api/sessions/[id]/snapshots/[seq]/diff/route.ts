import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getSnapshotDiff } from "@/lib/snapshots";

// GET /api/sessions/[id]/snapshots/[seq]/diff — the delta a snapshot introduced
// (vs the previous snapshot), as a unified diff.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; seq: string }> }
) {
  try {
    const { id, seq } = await params;
    const seqNum = parseInt(seq, 10);
    if (Number.isNaN(seqNum)) {
      return NextResponse.json({ error: "Bad snapshot id" }, { status: 400 });
    }
    const session = queries.getSession(getDb()).get(id) as Session | undefined;
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const diff = await getSnapshotDiff(session.working_directory, id, seqNum);
    return NextResponse.json({ diff });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("snapshot diff failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

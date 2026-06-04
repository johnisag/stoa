import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { restoreSnapshot } from "@/lib/snapshots";

// POST /api/sessions/[id]/snapshots/[seq]/restore — rewind the working tree to a
// snapshot (a safety snapshot of the current state is captured first).
export async function POST(
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
    // Don't rewind the working tree out from under a live agent — it may have
    // files open and would clobber/confuse its in-flight work.
    if (session.status === "running") {
      return NextResponse.json(
        { error: "Stop the agent before rewinding" },
        { status: 409 }
      );
    }
    const result = await restoreSnapshot(session.working_directory, id, seqNum);
    if (!result.restored) {
      return NextResponse.json(
        { error: "Snapshot not found or not a git repo" },
        { status: 409 }
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("snapshot restore failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { listSnapshots, captureSnapshot } from "@/lib/snapshots";

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

// POST /api/sessions/[id]/snapshots — capture a checkpoint of the working tree now.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = queries.getSession(getDb()).get(id) as Session | undefined;
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const snapshot = await captureSnapshot(
      session.working_directory,
      id,
      "checkpoint"
    );
    // null = not a git repo, or nothing changed since the last snapshot.
    return NextResponse.json({ snapshot });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("snapshot capture failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

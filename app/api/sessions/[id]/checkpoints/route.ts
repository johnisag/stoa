import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { parseJsonBody } from "@/lib/api-security";
import { createCheckpoint, listCheckpoints } from "@/lib/checkpoints";

// GET /api/sessions/[id]/checkpoints — durable, labeled checkpoints for a
// session, newest-first, each flagged `expired` when its snapshot was pruned.
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
    const checkpoints = await listCheckpoints(session);
    return NextResponse.json({ checkpoints });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("checkpoints list failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/sessions/[id]/checkpoints — pin the current working tree as a
// durable, labeled checkpoint. Body: { label?: string }.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = queries.getSession(getDb()).get(id) as Session | undefined;
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    let label: string | undefined;
    const parsed = await parseJsonBody<{ label?: string }>(request);
    if (parsed.ok && typeof parsed.data.label === "string") {
      // Cap the label; the snapshot subject is already truncated to 200.
      label = parsed.data.label.slice(0, 200);
    }

    const checkpoint = await createCheckpoint(session, { label });
    // null = not a git repo / nothing to pin — surface as a non-error signal.
    if (!checkpoint) {
      return NextResponse.json({ checkpoint: null, created: false });
    }
    return NextResponse.json({ checkpoint, created: true }, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("checkpoint create failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

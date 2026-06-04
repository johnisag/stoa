import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { enqueuePrompt, listQueue, clearQueue } from "@/lib/prompt-queue";

function requireSession(id: string): Session | null {
  return (queries.getSession(getDb()).get(id) as Session | undefined) ?? null;
}

// GET /api/sessions/[id]/queue — the session's pending queued prompts.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!requireSession(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return NextResponse.json({ queue: listQueue(id) });
}

// POST /api/sessions/[id]/queue — queue a prompt to dispatch when the agent next
// goes idle. Body: { text }.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!requireSession(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const { text } = await request.json().catch(() => ({}));
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "Empty prompt" }, { status: 400 });
  }
  if (text.length > 100_000) {
    return NextResponse.json({ error: "Prompt too long" }, { status: 413 });
  }
  return NextResponse.json({ queue: enqueuePrompt(id, text) });
}

// DELETE /api/sessions/[id]/queue — clear the session's queue.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!requireSession(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  clearQueue(id);
  return NextResponse.json({ queue: [] });
}

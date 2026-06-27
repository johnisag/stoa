import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import {
  enqueuePromptIdempotent,
  listQueue,
  clearQueue,
  removeAt,
  moveUp,
  moveDown,
} from "@/lib/prompt-queue";

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
// goes idle. Body: { text, clientId? }. `clientId` (the offline-queue action id, #12)
// makes the enqueue idempotent: a replayed POST carrying the same id enqueues once.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!requireSession(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const { text, clientId } = await request.json().catch(() => ({}));
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "Empty prompt" }, { status: 400 });
  }
  if (text.length > 100_000) {
    return NextResponse.json({ error: "Prompt too long" }, { status: 413 });
  }
  // A client id only needs to be a UUID; bound its length so a caller can't bloat
  // the in-memory seen-set with oversized keys. Over-long → ignore (no idempotency).
  const id_ =
    typeof clientId === "string" && clientId && clientId.length <= 200
      ? clientId
      : undefined;
  return NextResponse.json({ queue: enqueuePromptIdempotent(id, text, id_) });
}

// PATCH /api/sessions/[id]/queue — reorder or drop a single queued prompt.
// Body: { action: "remove" | "up" | "down", index, text? }. `text` is the item the
// client believed was at `index`; the op no-ops if the queue has since shifted (the
// ticker dispatched item 0), so a stale client never mutates the wrong prompt.
// Returns the updated queue.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!requireSession(id)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const { action, index, text } = await request.json().catch(() => ({}));
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "Invalid index" }, { status: 400 });
  }
  const expected = typeof text === "string" ? text : undefined;
  switch (action) {
    case "remove":
      return NextResponse.json({ queue: removeAt(id, index, expected) });
    case "up":
      return NextResponse.json({ queue: moveUp(id, index, expected) });
    case "down":
      return NextResponse.json({ queue: moveDown(id, index, expected) });
    default:
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
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

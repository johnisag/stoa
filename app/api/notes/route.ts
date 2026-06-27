import { NextRequest, NextResponse } from "next/server";
import { createNote, listNotes, NoteValidationError } from "@/lib/notes";

// Notes / shared knowledge base — the SAME endpoint the Notes dialog and the
// orchestration MCP server's notes_* tools call. Markdown docs for humans + agents.

// GET /api/notes → list (pinned first, then most-recently-updated)
export async function GET() {
  try {
    return NextResponse.json({ notes: listNotes() });
  } catch (error) {
    console.error("notes GET failed:", error);
    return NextResponse.json(
      { error: "Failed to list notes" },
      { status: 500 }
    );
  }
}

// POST /api/notes { title?, content?, pinned? } → create
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }
  try {
    const { title, content, pinned } = (body ?? {}) as {
      title?: unknown;
      content?: unknown;
      pinned?: unknown;
    };
    const note = createNote({ title, content, pinned });
    return NextResponse.json({ note }, { status: 201 });
  } catch (error) {
    if (error instanceof NoteValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("notes POST failed:", error);
    return NextResponse.json(
      { error: "Failed to create note" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  getNote,
  updateNote,
  deleteNote,
  NoteValidationError,
} from "@/lib/notes";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/notes/[id]
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const note = getNote(id);
    if (!note) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ note });
  } catch (error) {
    console.error("note GET failed:", error);
    return NextResponse.json({ error: "Failed to get note" }, { status: 500 });
  }
}

// PATCH /api/notes/[id] { title?, content?, pinned? } → partial update
export async function PATCH(request: NextRequest, { params }: RouteParams) {
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
    const { id } = await params;
    const { title, content, pinned } = (body ?? {}) as {
      title?: unknown;
      content?: unknown;
      pinned?: unknown;
    };
    const note = updateNote(id, { title, content, pinned });
    if (!note) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ note });
  } catch (error) {
    if (error instanceof NoteValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("note PATCH failed:", error);
    return NextResponse.json(
      { error: "Failed to update note" },
      { status: 500 }
    );
  }
}

// DELETE /api/notes/[id]
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    return NextResponse.json({ removed: deleteNote(id) });
  } catch (error) {
    console.error("note DELETE failed:", error);
    return NextResponse.json(
      { error: "Failed to delete note" },
      { status: 500 }
    );
  }
}

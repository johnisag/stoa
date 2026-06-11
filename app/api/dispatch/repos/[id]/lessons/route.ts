import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";

type RouteParams = { params: Promise<{ id: string }> };

interface LessonRow {
  id: string;
  lens: string | null;
  text: string;
  created_at: string;
}

// GET /api/dispatch/repos/[id]/lessons — the repo's fleet-memory ledger (what the
// critic has flagged, newest first). Read-only visibility into what gets injected
// into new workers' prompts.
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const lessons = queries.listLessonsForRepo(getDb()).all(id) as LessonRow[];
    return NextResponse.json({ lessons });
  } catch (error) {
    console.error("list lessons failed:", error);
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}

// DELETE /api/dispatch/repos/[id]/lessons — forget the repo's lessons. With
// ?lesson=<id>, forget just that one (a stale/wrong finding); otherwise clear all.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const lessonId = request.nextUrl.searchParams.get("lesson");
    const db = getDb();
    if (lessonId !== null) {
      // ?lesson present → delete exactly that one. An EMPTY value is a malformed
      // request, NOT an instruction to wipe the whole repo (fail closed).
      if (!lessonId) {
        return NextResponse.json({ error: "empty lesson id" }, { status: 400 });
      }
      queries.deleteLesson(db).run(lessonId, id);
    } else {
      queries.clearLessonsForRepo(db).run(id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("clear lessons failed:", error);
    return NextResponse.json({ error: "Failed to clear" }, { status: 500 });
  }
}

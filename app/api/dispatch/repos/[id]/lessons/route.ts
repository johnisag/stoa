import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import { MAX_LESSON_LEN } from "@/lib/dispatch/lessons";

type RouteParams = { params: Promise<{ id: string }> };

interface LessonRow {
  id: string;
  lens: string | null;
  text: string;
  source: string;
  created_at: string;
}

// GET /api/dispatch/repos/[id]/lessons — the repo's fleet-memory ledger
// (operator-curated rules first, then the newest critic findings). Read-only
// visibility into what gets injected into new workers' (and interactive) prompts.
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

// POST /api/dispatch/repos/[id]/lessons — add an operator-curated MANUAL rule,
// or promote a matching existing finding to manual (so it survives "forget
// findings"). Body: { text, lens? }. This is the "remember this" curation surface.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();
    const text =
      typeof body?.text === "string"
        ? body.text.trim().slice(0, MAX_LESSON_LEN)
        : "";
    const lens =
      typeof body?.lens === "string" && body.lens.trim()
        ? body.lens.trim().slice(0, 32)
        : null;
    if (!text) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }
    const db = getDb();
    if (!queries.getDispatchRepo(db).get(id)) {
      return NextResponse.json({ error: "Unknown repo" }, { status: 404 });
    }
    // Promote a matching lesson to manual (endorse an existing finding); then
    // insert if brand-new. Both are idempotent (the insert is NOT-EXISTS-guarded),
    // so concurrent "remember" of the same text can't duplicate.
    queries.markLessonManual(db).run(id, text);
    queries.insertManualLesson(db).run(randomUUID(), id, lens, text, id, text);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("add lesson failed:", error);
    return NextResponse.json({ error: "Failed to add" }, { status: 500 });
  }
}

// DELETE /api/dispatch/repos/[id]/lessons — forget lessons. With ?lesson=<id>,
// forget just that one (any source). Otherwise clear the auto-captured FINDINGS
// (operator-curated manual rules survive — remove those individually).
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

import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import {
  rowToPlaybook,
  validatePlaybookInput,
  type PlaybookRow,
} from "@/lib/playbooks";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// PATCH /api/playbooks/[id] — update { name?, body?, pinned? }, merged over the
// existing row (so a partial edit keeps the rest). Pin only applies to a
// project-scoped playbook. (#13)
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const existing = queries.getPlaybook(db).get(id) as PlaybookRow | undefined;
    if (!existing) {
      return NextResponse.json(
        { error: "Playbook not found" },
        { status: 404 }
      );
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const v = validatePlaybookInput({
      name: typeof body.name === "string" ? body.name : existing.name,
      body: typeof body.body === "string" ? body.body : existing.body,
    });
    if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 400 });

    // A global recipe (no project) can never be pinned.
    const pinned =
      existing.project_id === null
        ? 0
        : typeof body.pinned === "boolean"
          ? body.pinned
            ? 1
            : 0
          : existing.pinned;

    queries.updatePlaybook(db).run(v.value.name, v.value.body, pinned, id);
    const row = queries.getPlaybook(db).get(id) as PlaybookRow;
    return NextResponse.json({ playbook: rowToPlaybook(row) });
  } catch (error) {
    console.error("playbook update failed:", error);
    return NextResponse.json(
      { error: "Failed to update playbook" },
      { status: 500 }
    );
  }
}

// DELETE /api/playbooks/[id]. (#13)
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const info = queries.deletePlaybook(db).run(id);
    if (info.changes === 0) {
      return NextResponse.json(
        { error: "Playbook not found" },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("playbook delete failed:", error);
    return NextResponse.json(
      { error: "Failed to delete playbook" },
      { status: 500 }
    );
  }
}

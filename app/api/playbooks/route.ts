import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import {
  rowToPlaybook,
  validatePlaybookInput,
  type PlaybookRow,
} from "@/lib/playbooks";

// GET /api/playbooks?projectId=... — the project's playbooks + the global recipes.
// Without projectId, only the global recipes (project_id IS NULL). (#13)
export async function GET(request: NextRequest) {
  try {
    const projectId = new URL(request.url).searchParams.get("projectId");
    const db = getDb();
    const rows = (
      projectId
        ? queries.listPlaybooksForProject(db).all(projectId)
        : queries.listGlobalPlaybooks(db).all()
    ) as PlaybookRow[];
    return NextResponse.json({ playbooks: rows.map(rowToPlaybook) });
  } catch (error) {
    console.error("playbooks list failed:", error);
    return NextResponse.json(
      { error: "Failed to list playbooks" },
      { status: 500 }
    );
  }
}

// POST /api/playbooks — create { name, body, projectId?, pinned? }. Only a
// project-scoped playbook can be pinned (a global recipe can't auto-recall). (#13)
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const v = validatePlaybookInput(body);
    if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 400 });

    const db = getDb();
    const projectId =
      typeof body.projectId === "string" && body.projectId.trim()
        ? body.projectId.trim()
        : null;
    if (projectId && !queries.getProject(db).get(projectId)) {
      return NextResponse.json({ error: "Project not found" }, { status: 400 });
    }
    const pinned = projectId && body.pinned === true ? 1 : 0;

    const id = randomUUID();
    queries
      .createPlaybook(db)
      .run(id, v.value.name, v.value.body, projectId, pinned);
    const row = queries.getPlaybook(db).get(id) as PlaybookRow;
    return NextResponse.json({ playbook: rowToPlaybook(row) }, { status: 201 });
  } catch (error) {
    console.error("playbook create failed:", error);
    return NextResponse.json(
      { error: "Failed to create playbook" },
      { status: 500 }
    );
  }
}

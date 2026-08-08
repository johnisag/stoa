import { NextRequest, NextResponse } from "next/server";
import { listNotesForProject } from "@/lib/notes";

// GET /api/projects/[id]/notes → notes visible to this project
// (its own notes + fleet-wide pinned notes).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return NextResponse.json({ notes: listNotesForProject(id) });
  } catch (error) {
    console.error("project notes GET failed:", error);
    return NextResponse.json(
      { error: "Failed to list project notes" },
      { status: 500 }
    );
  }
}

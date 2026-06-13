import { NextRequest, NextResponse } from "next/server";
import {
  deleteSavedWorkflow,
  getSavedWorkflow,
  updateSavedWorkflow,
} from "@/lib/saved-workflows";
import { parseBuilderDoc } from "@/lib/pipeline/builder-model";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/saved-workflows/[id]
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const workflow = getSavedWorkflow(id);
    if (!workflow) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    return NextResponse.json({ workflow });
  } catch (error) {
    console.error("Error getting saved workflow:", error);
    return NextResponse.json(
      { error: "Failed to get saved workflow" },
      { status: 500 }
    );
  }
}

// PATCH /api/saved-workflows/[id] - overwrite name + doc
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
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
    const { name, doc } = (body ?? {}) as { name?: unknown; doc?: unknown };
    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const parsedDoc = parseBuilderDoc(JSON.stringify(doc ?? null));
    if (!parsedDoc) {
      return NextResponse.json(
        { error: "doc is malformed" },
        { status: 400 }
      );
    }
    const workflow = updateSavedWorkflow(id, { name, doc: parsedDoc });
    if (!workflow) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    return NextResponse.json({ workflow });
  } catch (error) {
    console.error("Error updating saved workflow:", error);
    return NextResponse.json(
      { error: "Failed to update saved workflow" },
      { status: 500 }
    );
  }
}

// DELETE /api/saved-workflows/[id]
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    if (!deleteSavedWorkflow(id)) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting saved workflow:", error);
    return NextResponse.json(
      { error: "Failed to delete saved workflow" },
      { status: 500 }
    );
  }
}

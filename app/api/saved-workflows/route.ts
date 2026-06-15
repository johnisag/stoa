import { NextRequest, NextResponse } from "next/server";
import { createSavedWorkflow, listSavedWorkflows } from "@/lib/saved-workflows";
import { parseBuilderDoc } from "@/lib/pipeline/builder-model";

// GET /api/saved-workflows - list all saved workflows (newest first)
export async function GET() {
  try {
    return NextResponse.json({ workflows: listSavedWorkflows() });
  } catch (error) {
    console.error("Error listing saved workflows:", error);
    return NextResponse.json(
      { error: "Failed to list saved workflows" },
      { status: 500 }
    );
  }
}

// POST /api/saved-workflows - create a saved workflow
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
    const { name, doc } = (body ?? {}) as { name?: unknown; doc?: unknown };
    // Reject a missing OR whitespace-only name (a truthy "   " would otherwise
    // pass and persist as a blank-looking workflow).
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (!trimmedName) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    // Validate + sanitize the doc at the boundary — never trust the client's shape.
    const parsedDoc = parseBuilderDoc(JSON.stringify(doc ?? null));
    if (!parsedDoc) {
      return NextResponse.json({ error: "doc is malformed" }, { status: 400 });
    }
    const workflow = createSavedWorkflow({ name: trimmedName, doc: parsedDoc });
    return NextResponse.json({ workflow }, { status: 201 });
  } catch (error) {
    console.error("Error creating saved workflow:", error);
    return NextResponse.json(
      { error: "Failed to create saved workflow" },
      { status: 500 }
    );
  }
}

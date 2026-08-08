import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import {
  getTokenProjects,
  addTokenProject,
  removeTokenProject,
} from "@/lib/tokens";

// GET /api/tokens/[id]/projects → list project ids for a token
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    return NextResponse.json({ projectIds: getTokenProjects(id) });
  } catch (error) {
    console.error("token projects GET failed:", error);
    return NextResponse.json(
      { error: "Failed to list token projects" },
      { status: 500 }
    );
  }
}

// POST /api/tokens/[id]/projects { projectId } → add a project scope
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
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
    const { projectId } = (body ?? {}) as { projectId?: unknown };
    if (typeof projectId !== "string" || !projectId.trim()) {
      return NextResponse.json(
        { error: "projectId is required" },
        { status: 400 }
      );
    }
    addTokenProject(id, projectId);
    return NextResponse.json(
      { projectIds: getTokenProjects(id) },
      { status: 201 }
    );
  } catch (error) {
    console.error("token project POST failed:", error);
    return NextResponse.json(
      { error: "Failed to add project scope" },
      { status: 500 }
    );
  }
}

// DELETE /api/tokens/[id]/projects?projectId=xxx → remove a project scope
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const projectId = request.nextUrl.searchParams.get("projectId");
    if (!projectId) {
      return NextResponse.json(
        { error: "projectId query parameter is required" },
        { status: 400 }
      );
    }
    removeTokenProject(id, projectId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("token project DELETE failed:", error);
    return NextResponse.json(
      { error: "Failed to remove project scope" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { getDb, queries } from "@/lib/db";
import {
  getTokenProjects,
  addTokenProject,
  removeTokenProject,
} from "@/lib/tokens";

/** Validate the token id exists and is non-revoked. Returns an error response or null. */
function validateToken(tokenId: string): NextResponse | null {
  const token = queries
    .listAuthTokens(getDb())
    .all()
    .find((t: { id: string }) => t.id === tokenId);
  if (!token) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }
  return null;
}

/** Validate the project id exists. Returns an error response or null. */
function validateProject(projectId: string): NextResponse | null {
  const project = queries.getProject(getDb()).get(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return null;
}

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
    if (
      typeof projectId !== "string" ||
      !projectId.trim() ||
      projectId.length > 128
    ) {
      return NextResponse.json(
        { error: "projectId is required (max 128 chars)" },
        { status: 400 }
      );
    }
    const trimmedProjectId = projectId.trim();
    // Validate the token and project both exist.
    const tokenError = validateToken(id);
    if (tokenError) return tokenError;
    const projectError = validateProject(trimmedProjectId);
    if (projectError) return projectError;
    addTokenProject(id, trimmedProjectId);
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
    if (!projectId || !projectId.trim()) {
      return NextResponse.json(
        { error: "projectId query parameter is required" },
        { status: 400 }
      );
    }
    removeTokenProject(id, projectId.trim());
    return NextResponse.json({ projectIds: getTokenProjects(id) });
  } catch (error) {
    console.error("token project DELETE failed:", error);
    return NextResponse.json(
      { error: "Failed to remove project scope" },
      { status: 500 }
    );
  }
}

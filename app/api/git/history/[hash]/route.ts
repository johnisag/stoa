import { NextRequest, NextResponse } from "next/server";
import { getCommitDetail } from "@/lib/git-history";
import {
  getAllowedPathRoots,
  requireAdmin,
  resolveRealSandboxedPath,
} from "@/lib/api-security";

interface RouteParams {
  params: Promise<{ hash: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { hash } = await params;
    const searchParams = request.nextUrl.searchParams;
    const rawPath = searchParams.get("path");

    if (!rawPath) {
      return NextResponse.json(
        { error: "Missing path parameter" },
        { status: 400 }
      );
    }

    const roots = getAllowedPathRoots();
    const { allowed, resolved } = await resolveRealSandboxedPath(
      rawPath,
      roots
    );
    if (!allowed) {
      return NextResponse.json(
        { error: "Path is outside the allowed workspace" },
        { status: 403 }
      );
    }

    const commit = getCommitDetail(resolved, hash);
    if (!commit) {
      return NextResponse.json({ error: "Commit not found" }, { status: 404 });
    }

    return NextResponse.json({ commit });
  } catch (error) {
    console.error("Error getting commit detail:", error);
    return NextResponse.json(
      { error: "Failed to get commit detail" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getCommitFileDiff } from "@/lib/git-history";
import { getAllowedPathRoots, resolveSandboxedPath } from "@/lib/api-security";

interface RouteParams {
  params: Promise<{ hash: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { hash } = await params;
    const searchParams = request.nextUrl.searchParams;
    const rawPath = searchParams.get("path");
    const file = searchParams.get("file");

    if (!rawPath) {
      return NextResponse.json(
        { error: "Missing path parameter" },
        { status: 400 }
      );
    }

    if (!file) {
      return NextResponse.json(
        { error: "Missing file parameter" },
        { status: 400 }
      );
    }

    const roots = getAllowedPathRoots();
    const { allowed, resolved } = resolveSandboxedPath(rawPath, roots);
    if (!allowed) {
      return NextResponse.json(
        { error: "Path is outside the allowed workspace" },
        { status: 403 }
      );
    }

    const diff = getCommitFileDiff(resolved, hash, file);
    return NextResponse.json({ diff });
  } catch (error) {
    console.error("Error getting commit file diff:", error);
    return NextResponse.json(
      { error: "Failed to get commit file diff" },
      { status: 500 }
    );
  }
}

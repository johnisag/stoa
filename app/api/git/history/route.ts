import { NextRequest, NextResponse } from "next/server";
import { getCommitHistory } from "@/lib/git-history";
import {
  getAllowedPathRoots,
  resolveSandboxedPath,
  parseBoundedInt,
} from "@/lib/api-security";

const MAX_HISTORY_LIMIT = 200;

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const rawPath = searchParams.get("path");
    const limit = parseBoundedInt(
      searchParams.get("limit"),
      1,
      MAX_HISTORY_LIMIT,
      30
    );

    if (!rawPath) {
      return NextResponse.json(
        { error: "Missing path parameter" },
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

    const commits = getCommitHistory(resolved, limit);
    return NextResponse.json({ commits });
  } catch (error) {
    console.error("Error getting commit history:", error);
    return NextResponse.json(
      { error: "Failed to get commit history" },
      { status: 500 }
    );
  }
}

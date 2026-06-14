import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";
import { expandPath } from "@/lib/git-status";
import { getAllowedPathRoots, resolveSandboxedPath } from "@/lib/api-security";

/**
 * GET /api/git/file-content?path=...&file=...
 * Get file content from git HEAD (original version before changes)
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const rawPath = searchParams.get("path");
    const file = searchParams.get("file");

    if (!rawPath) {
      return NextResponse.json(
        { error: "Path parameter is required" },
        { status: 400 }
      );
    }

    if (!file) {
      return NextResponse.json(
        { error: "File parameter is required" },
        { status: 400 }
      );
    }

    const expandedPath = expandPath(rawPath);
    const roots = getAllowedPathRoots();
    const { allowed } = resolveSandboxedPath(expandedPath, roots);
    if (!allowed) {
      return NextResponse.json(
        { error: "Path is outside the allowed workspace" },
        { status: 403 }
      );
    }

    try {
      // Get file content from HEAD
      const content = execFileSync("git", ["show", `HEAD:${file}`], {
        cwd: expandedPath,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024, // 10MB
        windowsHide: true,
      });

      return NextResponse.json({ content });
    } catch (gitError: unknown) {
      // File might be new (not in HEAD)
      const errorMessage =
        gitError instanceof Error ? gitError.message : String(gitError);

      if (
        errorMessage.includes("does not exist") ||
        errorMessage.includes("fatal:")
      ) {
        return NextResponse.json({ content: "", isNew: true });
      }

      throw gitError;
    }
  } catch (error) {
    console.error("Error getting file content from git:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get file content",
      },
      { status: 500 }
    );
  }
}

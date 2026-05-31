import { NextRequest, NextResponse } from "next/server";
import nodePath from "path";
import { listDirectory } from "@/lib/files";
import { expandHome } from "@/lib/platform";

/**
 * GET /api/files?path=...&recursive=true
 * List directory contents
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const inputPath = searchParams.get("path");
    const recursive = searchParams.get("recursive") === "true";

    if (!inputPath) {
      return NextResponse.json(
        { error: "Path parameter is required" },
        { status: 400 }
      );
    }

    // Expand ~ to home, then resolve to an ABSOLUTE path so drive-relative
    // inputs like "\my-projects" become "C:\my-projects" (and children inherit
    // the drive). Without this, Windows paths lose their drive letter in the UI.
    const expandedPath = nodePath.resolve(expandHome(inputPath));

    const files = listDirectory(expandedPath, {
      recursive,
      maxDepth: recursive ? 2 : 1,
    });

    return NextResponse.json({ files, path: expandedPath });
  } catch (error) {
    console.error("Error listing directory:", error);
    return NextResponse.json(
      { error: "Failed to list directory" },
      { status: 500 }
    );
  }
}

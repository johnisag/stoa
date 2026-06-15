import { NextRequest, NextResponse } from "next/server";
import { listDirectory } from "@/lib/files";
import { getAllowedPathRoots, resolveSandboxedPath } from "@/lib/api-security";

/**
 * GET /api/files?path=...&recursive=true
 * List directory contents
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const inputPath = searchParams.get("path");
    const recursive = searchParams.get("recursive") === "true";
    // Optional recursion depth (recursive only), clamped so a caller can't ask
    // the server to walk an unbounded tree. Defaults to the historical 2.
    const depthParam = Number(searchParams.get("depth"));
    const depth =
      Number.isFinite(depthParam) && depthParam >= 1
        ? Math.min(Math.floor(depthParam), 8)
        : 2;

    if (!inputPath) {
      return NextResponse.json(
        { error: "Path parameter is required" },
        { status: 400 }
      );
    }

    const roots = getAllowedPathRoots();
    const { allowed, resolved } = resolveSandboxedPath(inputPath, roots);
    if (!allowed) {
      return NextResponse.json(
        { error: "Path is outside the allowed workspace" },
        { status: 403 }
      );
    }

    const files = listDirectory(resolved, {
      recursive,
      maxDepth: recursive ? depth : 1,
    });

    return NextResponse.json({ files, path: resolved });
  } catch (error) {
    console.error("Error listing directory:", error);
    return NextResponse.json(
      { error: "Failed to list directory" },
      { status: 500 }
    );
  }
}

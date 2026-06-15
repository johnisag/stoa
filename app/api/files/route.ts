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
    // The folder PICKER's listing mode (see the sandbox note below). Forced shallow:
    // a crafted browse+recursive call must not deep-enumerate the host.
    const browse = searchParams.get("browse") === "1";
    const recursive = searchParams.get("recursive") === "true" && !browse;
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
    // Browse mode (the folder picker) intentionally LISTS directories outside the
    // registered workspace roots, so a user can navigate the filesystem to pick a new
    // project directory. It is name-only — it never reads file contents (that's
    // /api/files/content, which stays strict) — and rides the same server auth as
    // every route; it only relaxes the workspace-root check for listing.
    if (!allowed && !browse) {
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

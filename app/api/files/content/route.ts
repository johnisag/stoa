import { NextRequest, NextResponse } from "next/server";
import { readFileContent, writeFileContent } from "@/lib/files";
import {
  getAllowedPathRoots,
  resolveSandboxedPath,
  parseJsonBody,
} from "@/lib/api-security";

/**
 * GET /api/files/content?path=...
 * Read file contents
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const path = searchParams.get("path");

    if (!path) {
      return NextResponse.json(
        { error: "Path parameter is required" },
        { status: 400 }
      );
    }

    const roots = getAllowedPathRoots();
    const { allowed, resolved } = resolveSandboxedPath(path, roots);
    if (!allowed) {
      return NextResponse.json(
        { error: "Path is outside the allowed workspace" },
        { status: 403 }
      );
    }

    const result = readFileContent(resolved);

    return NextResponse.json({
      ...result,
      path: resolved,
    });
  } catch (error) {
    console.error("Error reading file:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read file" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/files/content
 * Write file contents
 */
export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<{ path?: string; content?: string }>(
    request
  );
  if (!parsed.ok) return parsed.response;

  const { path, content } = parsed.data;

  if (!path) {
    return NextResponse.json({ error: "Path is required" }, { status: 400 });
  }

  if (content === undefined) {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  const roots = getAllowedPathRoots();
  const { allowed, resolved } = resolveSandboxedPath(path, roots);
  if (!allowed) {
    return NextResponse.json(
      { error: "Path is outside the allowed workspace" },
      { status: 403 }
    );
  }

  try {
    const result = writeFileContent(resolved, content);

    return NextResponse.json({
      ...result,
      path: resolved,
    });
  } catch (error) {
    console.error("Error writing file:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to write file",
      },
      { status: 500 }
    );
  }
}

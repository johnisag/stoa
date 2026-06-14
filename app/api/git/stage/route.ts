import { NextRequest, NextResponse } from "next/server";
import { stageFile, stageAll, isGitRepo, expandPath } from "@/lib/git-status";
import {
  parseJsonBody,
  getAllowedPathRoots,
  resolveSandboxedPath,
} from "@/lib/api-security";

export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<{
    path?: string;
    files?: string[];
  }>(request);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const { path: rawPath, files } = body;

  if (!rawPath) {
    return NextResponse.json({ error: "Path is required" }, { status: 400 });
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

  if (!isGitRepo(expandedPath)) {
    return NextResponse.json(
      { error: "Not a git repository" },
      { status: 400 }
    );
  }

  try {
    // Stage specific files or all
    if (files && files.length > 0) {
      for (const file of files) {
        stageFile(expandedPath, file);
      }
    } else {
      stageAll(expandedPath);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to stage files",
      },
      { status: 500 }
    );
  }
}

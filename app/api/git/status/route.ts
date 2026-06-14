import { NextRequest, NextResponse } from "next/server";
import {
  getGitStatus,
  isGitRepo,
  getFileDiff,
  getUntrackedFileDiff,
  getWorktreeBaseChanges,
  expandPath,
} from "@/lib/git-status";
import { getAllowedPathRoots, resolveSandboxedPath } from "@/lib/api-security";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const rawPath = searchParams.get("path");
  const filePath = searchParams.get("file");
  const staged = searchParams.get("staged") === "true";

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
    // If file is specified, return diff for that file
    if (filePath) {
      const isUntracked = searchParams.get("untracked") === "true";
      const diff = isUntracked
        ? getUntrackedFileDiff(expandedPath, filePath)
        : getFileDiff(expandedPath, filePath, staged);
      return NextResponse.json({ diff });
    }

    // Otherwise return full status, plus any changes stranded in the base
    // checkout when this path is a linked worktree (surfaced as a warning).
    const status = getGitStatus(expandedPath);
    status.baseWorktree = getWorktreeBaseChanges(expandedPath);
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get git status",
      },
      { status: 500 }
    );
  }
}

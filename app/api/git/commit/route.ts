import { NextRequest, NextResponse } from "next/server";
import {
  commit,
  isGitRepo,
  isMainBranch,
  createBranch,
  isValidBranchName,
  getGitStatus,
  expandPath,
} from "@/lib/git-status";
import {
  parseJsonBody,
  getAllowedPathRoots,
  resolveSandboxedPath,
} from "@/lib/api-security";

export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<{
    path?: string;
    message?: string;
    branchName?: string;
  }>(request);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const { path: rawPath, message, branchName } = body;

  if (!rawPath) {
    return NextResponse.json({ error: "Path is required" }, { status: 400 });
  }

  if (!message) {
    return NextResponse.json(
      { error: "Commit message is required" },
      { status: 400 }
    );
  }

  if (branchName !== undefined && !isValidBranchName(branchName)) {
    return NextResponse.json({ error: "Invalid branch name" }, { status: 400 });
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
    // Check if there are staged changes
    const status = getGitStatus(expandedPath);
    if (status.staged.length === 0) {
      return NextResponse.json(
        { error: "No staged changes to commit" },
        { status: 400 }
      );
    }

    // Create new branch if on main/master and branch name provided
    let newBranch = false;
    if (branchName && isMainBranch(expandedPath)) {
      createBranch(expandedPath, branchName);
      newBranch = true;
    }

    // Commit
    const output = commit(expandedPath, message);

    return NextResponse.json({
      success: true,
      output,
      newBranch,
      branchName: newBranch ? branchName : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to commit" },
      { status: 500 }
    );
  }
}

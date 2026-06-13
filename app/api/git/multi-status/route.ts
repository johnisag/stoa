import { NextRequest, NextResponse } from "next/server";
import { getProjectRepositories, getProject } from "@/lib/projects";
import { getMultiRepoGitStatus } from "@/lib/multi-repo-git";
import { expandPath } from "@/lib/git-status";
import {
  parseWorktreePaths,
  worktreePathsToRepositories,
} from "@/lib/workspace-session";

// GET /api/git/multi-status - aggregated git status across repositories. The repo
// set comes from an explicit `paths` list (a multi-repo workspace session's
// worktrees), else a project's configured repositories, else a single fallbackPath.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");
    const fallbackPath = searchParams.get("fallbackPath");
    const pathsParam = searchParams.get("paths");

    if (!projectId && !fallbackPath && !pathsParam) {
      return NextResponse.json(
        { error: "One of paths, projectId, or fallbackPath is required" },
        { status: 400 }
      );
    }

    let repositories: ReturnType<typeof getProjectRepositories> = [];

    if (pathsParam) {
      // A multi-repo workspace session: synthesize a repo per worktree path so the
      // panel reflects the SESSION's worktrees (its edits), not the project's repos.
      // Reuse the SAME client-safe helpers the panel uses so the repo names match.
      repositories = worktreePathsToRepositories(
        parseWorktreePaths(pathsParam),
        ""
      );
    } else if (projectId) {
      const project = getProject(projectId);
      if (!project) {
        return NextResponse.json(
          { error: "Project not found" },
          { status: 404 }
        );
      }
      repositories = getProjectRepositories(projectId);
    }

    // Get aggregated status
    const expandedFallback = fallbackPath
      ? expandPath(fallbackPath)
      : undefined;
    const status = getMultiRepoGitStatus(repositories, expandedFallback);

    return NextResponse.json(status);
  } catch (error) {
    console.error("Error fetching multi-repo git status:", error);
    return NextResponse.json(
      { error: "Failed to fetch git status" },
      { status: 500 }
    );
  }
}

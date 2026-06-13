import { NextRequest, NextResponse } from "next/server";
import {
  isGitRepo,
  getBranches,
  getDefaultBranch,
  getCurrentBranch,
} from "@/lib/git";
import {
  listWorktrees,
  annotateWorktrees,
  type AnnotatedWorktree,
} from "@/lib/worktrees";
import { findGitReposUnder } from "@/lib/repo-scan";
import { getDb, queries, type Session } from "@/lib/db";

/**
 * POST /api/git/check
 * Check if a path is a git repository and return branch info
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: dirPath } = body;

    if (!dirPath) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    // Check if it's a git repo
    const isRepo = await isGitRepo(dirPath);

    if (!isRepo) {
      // Not a git repo itself — but it may be a ROOT holding several sibling
      // repos (≤2 deep), e.g. ~/my-projects/pocs. Surface them so the New Session
      // dialog can offer a multi-repo "workspace" (one worktree per picked repo).
      const subRepos = await findGitReposUnder(dirPath, 2);
      return NextResponse.json({
        isGitRepo: false,
        branches: [],
        defaultBranch: null,
        currentBranch: null,
        subRepos: subRepos.map((r) => ({
          path: r.path,
          name: r.name,
          depth: r.depth,
        })),
      });
    }

    // Get branch info + existing worktrees
    const [branches, defaultBranch, currentBranch, rawWorktrees] =
      await Promise.all([
        getBranches(dirPath),
        getDefaultBranch(dirPath),
        getCurrentBranch(dirPath),
        listWorktrees(dirPath),
      ]);

    // Annotate Stoa-managed worktrees with whether a live session already owns
    // each — orphans (isStoa && !attached) are the "attach to recover" targets.
    let worktrees: AnnotatedWorktree[] = [];
    try {
      const db = getDb();
      const sessions = queries.getAllSessions(db).all() as Session[];
      worktrees = annotateWorktrees(
        rawWorktrees,
        sessions.map((s) => s.working_directory)
      ).filter((w) => w.isStoa);
    } catch {
      worktrees = [];
    }

    return NextResponse.json({
      isGitRepo: true,
      branches,
      defaultBranch,
      currentBranch,
      worktrees,
    });
  } catch (error) {
    console.error("Error checking git repo:", error);
    return NextResponse.json(
      { error: "Failed to check git repository" },
      { status: 500 }
    );
  }
}

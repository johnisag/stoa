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
  normalizeWorktreePath,
  type AnnotatedWorktree,
} from "@/lib/worktrees";
import { findGitReposUnder } from "@/lib/repo-scan";
import { getDb, queries, type Session } from "@/lib/db";
import {
  parseJsonBody,
  getAllowedPathRoots,
  resolveRealSandboxedPath,
  requireAdmin,
  requireLocalhost,
} from "@/lib/api-security";
import { homeDir } from "@/lib/platform";
import { isInteractiveSessionRole } from "@/lib/session-role";

/**
 * POST /api/git/check
 * Check if a path is a git repository and return branch info.
 *
 * Local callers may probe the home tree for the project-creation flow. Remote
 * admin callers are limited to registered project/repo roots so the mobile New
 * Session flow can discover branches without becoming a filesystem recon oracle.
 */
export async function POST(request: NextRequest) {
  const isLocal = requireLocalhost(request).ok;
  if (!isLocal) {
    const adminError = requireAdmin(request);
    if (adminError) return adminError;
  }

  const parsed = await parseJsonBody<unknown>(request);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("path" in body) ||
    typeof body.path !== "string" ||
    !body.path.trim()
  ) {
    return NextResponse.json({ error: "Path is required" }, { status: 400 });
  }
  const dirPath = body.path;

  // Only localhost gets the broader home-tree project discovery scope. Remote
  // callers have already passed the server's admin-only POST gate and remain
  // confined to registered project/repo/worktree roots.
  const roots = getAllowedPathRoots();
  const sandboxRoots = isLocal ? [...roots, homeDir()] : roots;
  const { allowed, resolved } = await resolveRealSandboxedPath(
    dirPath,
    sandboxRoots
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "Path is outside the allowed workspace" },
      { status: 403 }
    );
  }

  try {
    // Check if it's a git repo
    const isRepo = await isGitRepo(resolved);

    if (!isRepo) {
      // Not a git repo itself — but it may be a ROOT holding several sibling
      // repos (≤2 deep), e.g. ~/my-projects/pocs. Surface them so the New Session
      // dialog can offer a multi-repo "workspace" (one worktree per picked repo).
      const subRepos = await findGitReposUnder(resolved, 2);
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
        getBranches(resolved),
        getDefaultBranch(resolved),
        getCurrentBranch(resolved),
        listWorktrees(resolved),
      ]);

    // Annotate Stoa-managed worktrees with whether a live session already owns
    // each — orphans (isStoa && !attached) are the "attach to recover" targets.
    let worktrees: AnnotatedWorktree[] = [];
    try {
      const db = getDb();
      const allSessions = queries.getAllSessions(db).all() as Session[];
      const sessions = allSessions.filter(isInteractiveSessionRole);
      const internalDirs = new Set(
        allSessions
          .filter((session) => !isInteractiveSessionRole(session))
          .flatMap((session) => [
            session.working_directory,
            session.worktree_path,
          ])
          .filter((dir): dir is string => !!dir)
          .map(normalizeWorktreePath)
      );
      worktrees = annotateWorktrees(
        rawWorktrees.filter(
          (worktree) => !internalDirs.has(normalizeWorktreePath(worktree.path))
        ),
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

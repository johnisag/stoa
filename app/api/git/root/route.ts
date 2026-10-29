import { NextRequest, NextResponse } from "next/server";
import { getRepoRoot } from "@/lib/git";
import {
  getAllowedPathRoots,
  requireAdmin,
  resolveRealSandboxedPath,
} from "@/lib/api-security";
import { expandHome } from "@/lib/platform";

/**
 * GET /api/git/root?path=... — resolve the repository ROOT containing a path.
 *
 * A single rev-parse, sandbox-checked like every git route. This exists so the
 * Git surfaces can anchor porcelain paths and per-file pathspecs on the repo
 * root (git emits those relative to the ROOT regardless of the cwd it ran
 * from) without paying for the heavier /api/git/check payload (branch
 * enumeration + worktree annotation + a sub-repo scan when not a repo).
 */
export async function GET(request: NextRequest) {
  const adminError = requireAdmin(request);
  if (adminError) return adminError;

  const inputPath = request.nextUrl.searchParams.get("path");
  if (!inputPath) {
    return NextResponse.json({ error: "Path is required" }, { status: 400 });
  }

  try {
    const roots = getAllowedPathRoots();
    const { allowed, resolved } = await resolveRealSandboxedPath(
      expandHome(inputPath),
      roots
    );
    if (!allowed) {
      return NextResponse.json(
        { error: "Path is outside the allowed workspace" },
        { status: 403 }
      );
    }

    // The root can sit OUTSIDE the workspace (a session registered at a
    // monorepo subfolder whose repo root is not itself allowed). Every git
    // route would 403 it, so report null: the git surfaces stay on the
    // stored working directory.
    const repoRoot = await getRepoRoot(resolved);
    const rootAllowed =
      repoRoot !== null &&
      (await resolveRealSandboxedPath(repoRoot, roots)).allowed;
    return NextResponse.json({ repoRoot: rootAllowed ? repoRoot : null });
  } catch (error) {
    console.error("Error resolving repo root:", error);
    return NextResponse.json(
      { error: "Failed to resolve repo root" },
      { status: 500 }
    );
  }
}

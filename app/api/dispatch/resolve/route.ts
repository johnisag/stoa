import { NextRequest, NextResponse } from "next/server";
import { isAbsolute } from "path";
import { isGitRepo, getRepoSlug, getDefaultBranch } from "@/lib/git";
import { expandHome } from "@/lib/platform";

/**
 * GET /api/dispatch/resolve?path=<local checkout path>
 *
 * Resolves a local path into the fields the add-repo form needs: whether it's a
 * git repo, its GitHub `owner/name` slug (from the origin remote), and its
 * default branch. Read-only — used to auto-fill the form when the user picks a
 * source (a Stoa project / a scanned repo / a GitHub clone) instead of typing.
 */
export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path")?.trim();
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  // Only resolve absolute checkout paths (a project's working_directory or `~`).
  // Rejecting relative input avoids cwd-relative probing of the server's tree.
  if (!isAbsolute(expandHome(path))) {
    return NextResponse.json(
      { error: "path must be absolute" },
      { status: 400 }
    );
  }
  try {
    const gitRepo = await isGitRepo(path);
    if (!gitRepo) {
      return NextResponse.json({
        isGitRepo: false,
        slug: null,
        defaultBranch: null,
      });
    }
    // slug + branch are independent reads; run them together. Either can come
    // back null (no GitHub origin / no resolvable default) without failing.
    const [slug, defaultBranch] = await Promise.all([
      getRepoSlug(path),
      getDefaultBranch(path).catch(() => null),
    ]);
    return NextResponse.json({ isGitRepo: true, slug, defaultBranch });
  } catch (error) {
    console.error("dispatch resolve failed:", error);
    return NextResponse.json({ error: "Failed to resolve" }, { status: 500 });
  }
}

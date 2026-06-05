import { NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { listGitHubRepos, defaultCloneRoot } from "@/lib/dispatch/github";

/**
 * GET /api/dispatch/github-repos
 *
 * Lists the authenticated user's GitHub repos (via gh) plus where a clone would
 * land (`cloneRoot`), so the add-repo form can offer a "github" source: pick a
 * repo and Stoa clones it locally if needed, then fills the form.
 */
export async function GET() {
  try {
    const projects = queries.getAllProjects(getDb()).all() as {
      working_directory: string;
    }[];
    const repos = await listGitHubRepos();
    const cloneRoot = defaultCloneRoot(
      projects.map((p) => p.working_directory)
    );
    return NextResponse.json({ repos, cloneRoot });
  } catch (error) {
    console.error("dispatch github-repos failed:", error);
    return NextResponse.json(
      { error: "Failed to list GitHub repos" },
      { status: 500 }
    );
  }
}

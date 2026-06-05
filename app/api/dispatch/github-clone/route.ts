import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { prepareGitHubRepo, defaultCloneRoot } from "@/lib/dispatch/github";

/**
 * POST /api/dispatch/github-clone  { slug }
 *
 * Ensures `owner/name` is available locally (clones it under the clone root if
 * it isn't), returning the local path + default branch so the form can fill in.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
    // owner/name shape only — each part must start with a word char so a
    // dot-only name (".", "..") can't traverse out of the clone root.
    if (!/^[\w][\w.-]*\/[\w][\w.-]*$/.test(slug)) {
      return NextResponse.json(
        { error: "a valid owner/name slug is required" },
        { status: 400 }
      );
    }
    const projects = queries.getAllProjects(getDb()).all() as {
      working_directory: string;
    }[];
    const root = defaultCloneRoot(projects.map((p) => p.working_directory));
    if (!root) {
      return NextResponse.json(
        { error: "No clone location — set STOA_CLONE_ROOT or add a project" },
        { status: 400 }
      );
    }
    const prepared = await prepareGitHubRepo(slug, root);
    return NextResponse.json(prepared);
  } catch (error) {
    console.error("dispatch github-clone failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Clone failed" },
      { status: 500 }
    );
  }
}

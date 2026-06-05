import { NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { discoverGitRepos, defaultScanRoots } from "@/lib/dispatch/discover";

/**
 * GET /api/dispatch/discover
 *
 * Scans the parent folders of the user's Stoa projects (plus STOA_SCAN_ROOTS)
 * for local git checkouts, so the add-repo form can offer a "scan" source the
 * user picks from instead of typing a path. Read-only; filesystem-only.
 */
export async function GET() {
  try {
    const projects = queries.getAllProjects(getDb()).all() as {
      working_directory: string;
    }[];
    const roots = defaultScanRoots(projects.map((p) => p.working_directory));
    const repos = await discoverGitRepos(roots);
    return NextResponse.json({ repos });
  } catch (error) {
    console.error("dispatch discover failed:", error);
    return NextResponse.json({ error: "Failed to scan" }, { status: 500 });
  }
}

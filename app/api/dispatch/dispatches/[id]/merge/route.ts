import { NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { mergePR } from "@/lib/dispatch/merge";
import { expandHome } from "@/lib/platform";
import type { IssueDispatch } from "@/lib/dispatch/types";

/**
 * POST /api/dispatch/dispatches/[id]/merge
 *
 * Merge the worker's PR (squash) — a deliberate user action from the cockpit.
 * Plain merge (no GitHub auto-merge); fails loudly if the PR isn't mergeable.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const db = getDb();
    const d = queries.getDispatch(db).get(id) as IssueDispatch | undefined;
    if (!d) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (d.pr_number == null) {
      return NextResponse.json(
        { error: "This dispatch has no PR yet" },
        { status: 409 }
      );
    }
    if (d.status !== "pr_open") {
      return NextResponse.json(
        { error: `Can't merge a dispatch in '${d.status}'` },
        { status: 409 }
      );
    }
    // Merge repo-explicitly (--repo) from the stable main checkout; the worker's
    // worktree is only a fallback when the repo row is gone (a reclaimed worktree
    // cwd otherwise makes gh's spawn throw a misleading ENOENT).
    const repo = queries.getDispatchRepo(db).get(d.repo_id) as
      | { repo_path: string; repo_slug: string }
      | undefined;
    const cwd = expandHome(repo?.repo_path || d.worktree_path || "");
    if (!cwd) {
      return NextResponse.json(
        { error: "No checkout to merge from" },
        { status: 409 }
      );
    }
    await mergePR({ cwd, prNumber: d.pr_number, repoSlug: repo?.repo_slug });
    queries.updateDispatchStatus(db).run("merged", id);
    return NextResponse.json({
      dispatch: queries.getDispatch(db).get(id) as IssueDispatch,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Merge failed";
    // gh exits non-zero if the PR was already merged (a sweep or a 2nd tap got
    // there first) — reconcile the row to 'merged' rather than erroring.
    if (/already merged/i.test(msg)) {
      try {
        queries.updateDispatchStatus(getDb()).run("merged", id);
      } catch {
        // best-effort reconcile
      }
      return NextResponse.json({ reconciled: true });
    }
    console.error("dispatch merge failed:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

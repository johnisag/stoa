import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import { createIssue } from "@/lib/dispatch/create";
import { dispatchOne } from "@/lib/dispatch/dispatcher";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";

/**
 * POST /api/dispatch/issues/create
 *   { repoId, title, body?, labels?, disposition: "now" | "backlog" }
 *
 * Creates a REAL GitHub issue on the tracked repo via gh, records it as a
 * dispatch candidate, then either spawns a worker immediately ("now") or leaves
 * it pending in the backlog ("backlog"). The 60s reconciler dedupes on
 * (repo, issue#) so it won't re-ingest the issue we just recorded.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const repoId = typeof body?.repoId === "string" ? body.repoId : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const issueBody = typeof body?.body === "string" ? body.body : "";
    const labels = Array.isArray(body?.labels)
      ? (body.labels as unknown[]).filter(
          (l): l is string => typeof l === "string"
        )
      : [];
    const disposition = body?.disposition === "now" ? "now" : "backlog";

    if (!repoId || !title) {
      return NextResponse.json(
        { error: "repoId and a non-empty title are required" },
        { status: 400 }
      );
    }

    const db = getDb();
    const repo = queries.getDispatchRepo(db).get(repoId) as
      | DispatchRepo
      | undefined;
    if (!repo) {
      return NextResponse.json({ error: "Unknown repo" }, { status: 404 });
    }

    // 1. Create the real GitHub issue.
    const created = await createIssue({
      repoSlug: repo.repo_slug,
      repoPath: repo.repo_path,
      title,
      body: issueBody,
      labels,
    });

    // 2. Record it as a candidate (pending). datetime('now') for issue_created_at
    // so the backlog shows "raised just now".
    const id = randomUUID();
    queries
      .upsertDispatchCandidate(db)
      .run(
        id,
        repo.id,
        created.number,
        title,
        created.url,
        new Date().toISOString()
      );
    const row = queries.getDispatch(db).get(id) as IssueDispatch | undefined;
    if (!row) {
      // Can't happen for a fresh issue number (no INSERT OR IGNORE conflict), but
      // never silently downgrade a "now" to backlog — surface it instead.
      return NextResponse.json(
        { error: "Issue created but could not be recorded" },
        { status: 500 }
      );
    }

    // 3. Disposition. "now" spawns a worker immediately (bypasses the caps, like
    // a manual approve); "backlog" leaves it pending for the normal flow.
    if (disposition === "now") {
      await dispatchOne(repo, row);
    }

    // Re-fetch to return the post-dispatch status ("dispatched" for "now").
    return NextResponse.json({
      issue: created,
      dispatch: queries.getDispatch(db).get(id) as IssueDispatch,
    });
  } catch (error) {
    console.error("dispatch issue create failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create issue",
      },
      { status: 500 }
    );
  }
}

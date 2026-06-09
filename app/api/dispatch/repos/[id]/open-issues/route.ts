import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import { listOpenIssues } from "@/lib/dispatch/issues";
import {
  annotateTriageIssues,
  canDispatchExisting,
} from "@/lib/dispatch/triage";
import { dispatchOne } from "@/lib/dispatch/dispatcher";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/dispatch/repos/[id]/open-issues?search=
 *
 * Browse a tracked repo's OPEN GitHub issues on demand (ignores the standing
 * label_filter so the whole backlog is triageable), each annotated with its
 * current dispatch status. The phone-side "triage your backlog" read. Label
 * narrowing is expressed through gh `search` (e.g. "label:bug").
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const repo = queries.getDispatchRepo(db).get(id) as
      | DispatchRepo
      | undefined;
    if (!repo) {
      return NextResponse.json({ error: "Unknown repo" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const issues = await listOpenIssues(repo, {
      search: searchParams.get("search"),
    });
    const existing = queries
      .listDispatchesForRepo(db)
      .all(id) as IssueDispatch[];
    return NextResponse.json({
      issues: annotateTriageIssues(issues, existing),
    });
  } catch (error) {
    console.error("dispatch open-issues browse failed:", error);
    return NextResponse.json(
      { error: "Failed to browse issues" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/dispatch/repos/[id]/open-issues
 *   { number, title?, url?, createdAt? }
 *
 * Triage an EXISTING open issue → dispatch a worker now. Records the issue as a
 * candidate (idempotent on (repo, number) — a concurrent reconciler ingest or a
 * double-tap reuses the row) and spawns immediately when it's a fresh candidate
 * (manual override — bypasses the daily/concurrency caps like issues/create
 * "now"). An already-working / merged / failed row is returned unchanged.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const repo = queries.getDispatchRepo(db).get(id) as
      | DispatchRepo
      | undefined;
    if (!repo) {
      return NextResponse.json({ error: "Unknown repo" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const number = Number(body?.number);
    if (!Number.isInteger(number) || number <= 0) {
      return NextResponse.json(
        { error: "a positive integer issue number is required" },
        { status: 400 }
      );
    }
    const title =
      typeof body?.title === "string" && body.title.trim()
        ? body.title.trim()
        : `issue-${number}`;
    const url = typeof body?.url === "string" ? body.url : null;
    // The issue already exists on GitHub; keep its real raised-time, or leave it
    // null rather than fabricating "now" (unlike issues/create, which just made it).
    const createdAt =
      typeof body?.createdAt === "string" ? body.createdAt : null;

    // Idempotent: reuse the existing row if this issue is already tracked, so a
    // double-tap (or a reconciler ingest that just ran) never inserts a dupe.
    let row = queries.getDispatchByRepoIssue(db).get(repo.id, number) as
      | IssueDispatch
      | undefined;
    if (!row) {
      queries
        .upsertDispatchCandidate(db)
        .run(randomUUID(), repo.id, number, title, url, createdAt);
      row = queries.getDispatchByRepoIssue(db).get(repo.id, number) as
        | IssueDispatch
        | undefined;
    }
    if (!row) {
      return NextResponse.json(
        { error: "Could not record the issue" },
        { status: 500 }
      );
    }

    // Spawn only a still-fresh candidate; never re-dispatch an issue already
    // working / in PR / merged (the board owns retrying a failed one).
    if (canDispatchExisting(row.status)) {
      await dispatchOne(repo, row);
    }
    return NextResponse.json({
      dispatch: queries.getDispatch(db).get(row.id) as IssueDispatch,
    });
  } catch (error) {
    console.error("dispatch open-issues triage failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to dispatch issue",
      },
      { status: 500 }
    );
  }
}

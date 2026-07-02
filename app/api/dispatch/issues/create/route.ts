import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import { createIssue } from "@/lib/dispatch/create";
import { dispatchOne } from "@/lib/dispatch/dispatcher";
import { normalizeRecurrence } from "@/lib/dispatch/recurrence";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";
import {
  parseJsonBody,
  validateGitHubLabels,
  ISSUE_TITLE_MAX_LENGTH,
  ISSUE_BODY_MAX_LENGTH,
} from "@/lib/api-security";

/**
 * POST /api/dispatch/issues/create
 *   { repoId, title, body?, labels?, disposition, source?: "github" | "local" }
 *
 * Records a dispatch candidate. source 'github' (default) creates a REAL GitHub
 * issue via gh first; source 'local' is a freeform task with no GitHub issue
 * (issue_number 0, body in task_body). Either way it then spawns a worker
 * immediately ("now"), schedules it, or leaves it pending in the backlog. The
 * 60s reconciler dedupes GitHub issues on (repo, issue#); local tasks never dedupe.
 */
export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<{
    repoId?: string;
    title?: string;
    body?: string;
    labels?: unknown[];
    disposition?: string;
    scheduledAt?: string;
    autoMerge?: boolean;
    source?: string;
    recurrence?: unknown;
  }>(request);
  if (!parsed.ok) return parsed.response;

  try {
    const body = parsed.data;
    const repoId = typeof body?.repoId === "string" ? body.repoId : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const issueBody = typeof body?.body === "string" ? body.body : "";
    const rawLabels = Array.isArray(body?.labels) ? body.labels : [];
    const disposition =
      body?.disposition === "now"
        ? "now"
        : body?.disposition === "scheduled"
          ? "scheduled"
          : "backlog";
    const scheduledAt =
      typeof body?.scheduledAt === "string" ? body.scheduledAt.trim() : "";
    const autoMerge = body?.autoMerge === true;
    // Intake source: 'local' is a GitHub-free task (no gh issue, freeform body);
    // anything else creates a real GitHub issue (the original behavior).
    const source = body?.source === "local" ? "local" : "github";

    if (!repoId || !title) {
      return NextResponse.json(
        { error: "repoId and a non-empty title are required" },
        { status: 400 }
      );
    }
    if (title.length > ISSUE_TITLE_MAX_LENGTH) {
      return NextResponse.json(
        { error: `title exceeds ${ISSUE_TITLE_MAX_LENGTH} characters` },
        { status: 400 }
      );
    }
    if (issueBody.length > ISSUE_BODY_MAX_LENGTH) {
      return NextResponse.json(
        { error: `body exceeds ${ISSUE_BODY_MAX_LENGTH} characters` },
        { status: 400 }
      );
    }
    const labelCheck = validateGitHubLabels(rawLabels);
    if (!labelCheck.ok) {
      return NextResponse.json({ error: labelCheck.reason }, { status: 400 });
    }
    const labels = labelCheck.labels;

    if (disposition === "scheduled" && Number.isNaN(Date.parse(scheduledAt))) {
      return NextResponse.json(
        { error: "a valid scheduledAt time is required" },
        { status: 400 }
      );
    }

    const db = getDb();
    const repo = queries.getDispatchRepo(db).get(repoId) as
      DispatchRepo | undefined;
    if (!repo) {
      return NextResponse.json({ error: "Unknown repo" }, { status: 404 });
    }

    // 1+2. Record a candidate. issue_created_at = now so the backlog shows
    // "raised just now". A "scheduled" disposition parks it as 'scheduled' until
    // its time; everything else lands as 'pending'. A LOCAL task skips GitHub
    // entirely (no gh issue) — its freeform body is stored in task_body.
    const id = randomUUID();
    const nowIso = new Date().toISOString();
    let created: { number: number; url: string } | null = null;
    if (source === "local") {
      const status = disposition === "scheduled" ? "scheduled" : "pending";
      const schedAt =
        disposition === "scheduled"
          ? new Date(scheduledAt).toISOString()
          : null;
      // Recurrence only applies to a SCHEDULED local task; 'once'/unknown → null.
      const recurrence =
        disposition === "scheduled"
          ? normalizeRecurrence(body?.recurrence)
          : null;
      queries
        .insertLocalTask(db)
        .run(
          id,
          repo.id,
          title,
          issueBody || null,
          nowIso,
          schedAt,
          recurrence,
          status
        );
    } else {
      created = await createIssue({
        repoSlug: repo.repo_slug,
        repoPath: repo.repo_path,
        title,
        body: issueBody,
        labels,
      });
      if (disposition === "scheduled") {
        queries
          .insertScheduledCandidate(db)
          .run(
            id,
            repo.id,
            created.number,
            title,
            created.url,
            nowIso,
            new Date(scheduledAt).toISOString()
          );
      } else {
        queries
          .upsertDispatchCandidate(db)
          .run(id, repo.id, created.number, title, created.url, nowIso);
      }
    }
    // Opt-in auto-merge: persist the flag so the reconciler merges this row's PR
    // once it's ready (no conflicts, checks green, critic-approved if gated).
    if (autoMerge) {
      queries.setDispatchAutoMerge(db).run(1, id);
    }
    const row = queries.getDispatch(db).get(id) as IssueDispatch | undefined;
    if (!row) {
      // Can't happen for a fresh row id (no INSERT conflict), but never silently
      // downgrade a "now" to backlog — surface it instead.
      return NextResponse.json(
        { error: "Task could not be recorded" },
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

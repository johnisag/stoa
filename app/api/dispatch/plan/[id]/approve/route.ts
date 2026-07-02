import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import { getPlanRun, cleanupPlanRun } from "@/lib/dispatch/planner";
import { createIssue } from "@/lib/dispatch/create";
import { serializeClaims, normalizeClaim } from "@/lib/dispatch/claims";
import type { DispatchRepo, PlanTask } from "@/lib/dispatch/types";

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/dispatch/plan/[id]/approve — file each (operator-reviewed) task as a
// real GitHub issue + a pending dispatch row carrying its file_claims, then reclaim
// the planner worktree. The rows flow through the IDENTICAL ceremony; overlapping
// claims serialize automatically (pickSchedulable).
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const run = getPlanRun(id);
    if (!run) {
      return NextResponse.json({ error: "Unknown plan" }, { status: 404 });
    }
    const body = await request.json();
    const tasks: PlanTask[] = Array.isArray(body?.tasks) ? body.tasks : [];
    if (tasks.length === 0) {
      return NextResponse.json({ error: "no tasks to file" }, { status: 400 });
    }
    const db = getDb();
    const repo = queries.getDispatchRepo(db).get(run.repoId) as
      DispatchRepo | undefined;
    if (!repo) {
      return NextResponse.json({ error: "Unknown repo" }, { status: 404 });
    }
    const autoMerge = !!body?.autoMerge;

    const created: { number: number; title: string }[] = [];
    for (const t of tasks) {
      const title = typeof t?.title === "string" ? t.title.trim() : "";
      const bodyMd = typeof t?.body === "string" ? t.body : "";
      const claims = Array.isArray(t?.claims)
        ? t.claims
            .map((c) => normalizeClaim(c))
            .filter((c): c is string => c !== null)
        : [];
      if (!title || claims.length === 0) continue; // skip malformed (UI validates)

      const issue = await createIssue({
        repoSlug: repo.repo_slug,
        repoPath: repo.repo_path,
        title,
        body: bodyMd,
        labels: [],
      });
      const rowId = randomUUID();
      queries
        .upsertDispatchCandidate(db)
        .run(
          rowId,
          repo.id,
          issue.number,
          title,
          issue.url,
          new Date().toISOString()
        );
      queries.setDispatchClaims(db).run(serializeClaims(claims), rowId);
      if (autoMerge) queries.setDispatchAutoMerge(db).run(1, rowId);
      created.push({ number: issue.number, title });
    }
    await cleanupPlanRun(id);
    return NextResponse.json({ created });
  } catch (error) {
    console.error("plan approve failed:", error);
    return NextResponse.json(
      { error: "Failed to file the tasks" },
      { status: 500 }
    );
  }
}

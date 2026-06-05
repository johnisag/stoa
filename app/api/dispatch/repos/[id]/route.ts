import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { isValidAgentType } from "@/lib/providers";
import type { DispatchRepo } from "@/lib/dispatch/types";

type RouteParams = { params: Promise<{ id: string }> };

// PATCH /api/dispatch/repos/[id] — edit a tracked repo's allocation config
// (agent, quota, concurrency, label filter, base branch, mode, enable/pause).
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const db = getDb();
    const repo = queries.getDispatchRepo(db).get(id) as
      | DispatchRepo
      | undefined;
    if (!repo) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = await request.json();
    const agentType =
      body?.agentType !== undefined && isValidAgentType(body.agentType)
        ? body.agentType
        : repo.agent_type;
    const dailyQuota = Number.isFinite(body?.dailyQuota)
      ? Math.max(0, body.dailyQuota)
      : repo.daily_quota;
    const maxConcurrency = Number.isFinite(body?.maxConcurrency)
      ? Math.max(1, body.maxConcurrency)
      : repo.max_concurrency;
    const labelFilter =
      body?.labelFilter !== undefined
        ? typeof body.labelFilter === "string" && body.labelFilter.trim()
          ? body.labelFilter.trim()
          : null
        : repo.label_filter;
    const baseBranch =
      typeof body?.baseBranch === "string" && body.baseBranch.trim()
        ? body.baseBranch.trim()
        : repo.base_branch;
    const mode =
      body?.mode === "auto" || body?.mode === "review" ? body.mode : repo.mode;
    const enabled =
      body?.enabled !== undefined ? (body.enabled ? 1 : 0) : repo.enabled;

    queries
      .updateDispatchRepo(db)
      .run(
        agentType,
        dailyQuota,
        maxConcurrency,
        labelFilter,
        baseBranch,
        mode,
        enabled,
        id
      );
    return NextResponse.json({
      repo: queries.getDispatchRepo(db).get(id) as DispatchRepo,
    });
  } catch (error) {
    console.error("dispatch repo update failed:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

// DELETE /api/dispatch/repos/[id] — stop tracking a repo (cascades its dispatch
// rows). In-flight worker sessions are NOT killed here — only the tracking.
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    queries.deleteDispatchRepo(getDb()).run(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("dispatch repo delete failed:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}

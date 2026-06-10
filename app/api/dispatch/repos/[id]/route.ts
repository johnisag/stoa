import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { isValidAgentType } from "@/lib/providers";
import { parseVerifySteps } from "@/lib/dispatch/verify";
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
    const reviewGate =
      body?.reviewGate !== undefined
        ? body.reviewGate
          ? 1
          : 0
        : repo.review_gate;
    const ciAutofix =
      body?.ciAutofix !== undefined
        ? body.ciAutofix
          ? 1
          : 0
        : repo.ci_autofix;
    const mergeTrain =
      body?.mergeTrain !== undefined
        ? body.mergeTrain
          ? 1
          : 0
        : repo.merge_train;
    const verifyGate =
      body?.verifyGate !== undefined
        ? body.verifyGate
          ? 1
          : 0
        : repo.verify_gate;
    let verifyCommand = repo.verify_command;
    if (body?.verifyCommand !== undefined) {
      const next =
        typeof body.verifyCommand === "string" && body.verifyCommand.trim()
          ? body.verifyCommand.trim()
          : null;
      // Validate at SAVE time with the same pure parser the runner uses, so a bad
      // command fails loudly here (the client toasts it) — not minutes later.
      if (next) {
        const parsed = parseVerifySteps(next);
        if (!("steps" in parsed)) {
          return NextResponse.json(
            { error: `verify command: ${parsed.error}` },
            { status: 400 }
          );
        }
      }
      verifyCommand = next;
    }

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
        reviewGate,
        ciAutofix,
        mergeTrain,
        verifyGate,
        verifyCommand,
        id
      );
    // The verify command changed → prior verdicts no longer reflect what would run;
    // clear this repo's open dispatches so the next tick re-verifies (recovers a PR
    // stuck on a now-fixed misconfiguration).
    if (verifyCommand !== repo.verify_command) {
      queries.clearVerifyForRepo(db).run(id);
    }
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

import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { spawnPlanner, DEFAULT_TASK_CAP } from "@/lib/dispatch/planner";
import { dispatchSupported } from "@/lib/dispatch/issue-source";
import type { DispatchRepo } from "@/lib/dispatch/types";
import { DISPATCH_SPEC_MAX_LENGTH } from "@/lib/api-security";

// POST /api/dispatch/plan — spawn a planner worker to decompose a spec into a
// partition of tasks (each owning disjoint files). Returns a planId the UI polls.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const repoId = typeof body?.repoId === "string" ? body.repoId : "";
    const spec = typeof body?.spec === "string" ? body.spec.trim() : "";
    if (!repoId || !spec) {
      return NextResponse.json(
        { error: "repoId and spec are required" },
        { status: 400 }
      );
    }
    if (spec.length > DISPATCH_SPEC_MAX_LENGTH) {
      return NextResponse.json(
        { error: "spec exceeds maximum length" },
        { status: 400 }
      );
    }
    const taskCap = Number.isFinite(body?.taskCap)
      ? Math.max(1, Math.min(20, Math.floor(body.taskCap)))
      : DEFAULT_TASK_CAP;
    const repo = queries.getDispatchRepo(getDb()).get(repoId) as
      DispatchRepo | undefined;
    if (!repo) {
      return NextResponse.json({ error: "Unknown repo" }, { status: 404 });
    }
    // #34: the planner decomposes a spec into GitHub ISSUES (approve → `gh issue
    // create`). That's gh-only, so refuse to even START a planner run for a
    // Linear/other repo — otherwise it burns a worktree worker and then 500s at
    // approve. Linear repos are intake/browse-only.
    if (!dispatchSupported(repo)) {
      return NextResponse.json(
        {
          error:
            "The planner files GitHub issues, which isn't supported for this repo — Linear repos are intake/browse-only. Use a GitHub repo.",
        },
        { status: 400 }
      );
    }
    const planId = await spawnPlanner(repo, spec, taskCap);
    return NextResponse.json({ planId }, { status: 201 });
  } catch (error) {
    console.error("plan spawn failed:", error);
    return NextResponse.json(
      { error: "Failed to start the planner" },
      { status: 500 }
    );
  }
}

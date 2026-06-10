import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import { isValidAgentType } from "@/lib/providers";
import type { DispatchRepo } from "@/lib/dispatch/types";

// GET /api/dispatch/repos — list every tracked repo (the allocation console).
export async function GET() {
  try {
    const repos = queries.getAllDispatchRepos(getDb()).all() as DispatchRepo[];
    return NextResponse.json({ repos });
  } catch (error) {
    console.error("dispatch repos list failed:", error);
    return NextResponse.json({ error: "Failed to list" }, { status: 500 });
  }
}

// POST /api/dispatch/repos — track a new repo. New repos default to the safe
// posture: mode='review', disabled — nothing auto-spawns until you opt in.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const repoPath =
      typeof body?.repoPath === "string" ? body.repoPath.trim() : "";
    const repoSlug =
      typeof body?.repoSlug === "string" ? body.repoSlug.trim() : "";
    if (!repoPath || !repoSlug) {
      return NextResponse.json(
        { error: "repoPath and repoSlug are required" },
        { status: 400 }
      );
    }
    const agentType = isValidAgentType(body?.agentType)
      ? body.agentType
      : "claude";
    const mode = body?.mode === "auto" ? "auto" : "review";
    const id = randomUUID();
    queries
      .createDispatchRepo(getDb())
      .run(
        id,
        repoPath,
        repoSlug,
        agentType,
        Number.isFinite(body?.dailyQuota) ? Math.max(0, body.dailyQuota) : 0,
        Number.isFinite(body?.maxConcurrency)
          ? Math.max(1, body.maxConcurrency)
          : 1,
        typeof body?.labelFilter === "string" && body.labelFilter.trim()
          ? body.labelFilter.trim()
          : null,
        typeof body?.baseBranch === "string" && body.baseBranch.trim()
          ? body.baseBranch.trim()
          : "main",
        mode,
        body?.enabled ? 1 : 0,
        body?.reviewGate ? 1 : 0,
        body?.ciAutofix ? 1 : 0,
        body?.mergeTrain ? 1 : 0,
        typeof body?.projectId === "string" ? body.projectId : null
      );
    const repo = queries.getDispatchRepo(getDb()).get(id) as DispatchRepo;
    return NextResponse.json({ repo }, { status: 201 });
  } catch (error) {
    console.error("dispatch repo create failed:", error);
    return NextResponse.json({ error: "Failed to create" }, { status: 500 });
  }
}

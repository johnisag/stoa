import { NextRequest, NextResponse } from "next/server";
import {
  readPlanRun,
  cleanupPlanRun,
  getPlanRun,
} from "@/lib/dispatch/planner";

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/dispatch/plan/[id] — poll a plan run: running | ready (+tasks) | failed.
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  if (!getPlanRun(id)) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 404 });
  }
  return NextResponse.json(await readPlanRun(id));
}

// DELETE /api/dispatch/plan/[id] — cancel: reclaim the worktree + kill the planner.
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  await cleanupPlanRun(id);
  return NextResponse.json({ ok: true });
}

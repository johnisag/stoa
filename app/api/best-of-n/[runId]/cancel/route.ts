import { NextRequest, NextResponse } from "next/server";
import { cancelBonRun } from "@/lib/best-of-n";

/**
 * POST /api/best-of-n/:runId/cancel — cancel a running Best-of-N run.
 *
 * Kills all candidate sessions and removes their worktrees.
 * Response: { ok: true }
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  if (!runId || runId.length > 40) {
    return NextResponse.json({ error: "runId is invalid" }, { status: 400 });
  }
  try {
    await cancelBonRun(runId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Failed to cancel run";
    const isNotFound = msg.includes("not found");
    return NextResponse.json({ error: msg }, { status: isNotFound ? 404 : 500 });
  }
}

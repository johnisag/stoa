import { NextRequest, NextResponse } from "next/server";
import { pickBonWinner } from "@/lib/best-of-n";

/**
 * POST /api/best-of-n/:runId/pick — pick the winning candidate.
 *
 * Body: { candidateId }
 * Response: { ok: true, run, candidates }
 *
 * Kills and removes worktrees of all other candidates, marks the run done.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;

  if (!runId || runId.length > 40) {
    return NextResponse.json({ error: "runId is invalid" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { candidateId } = body as { candidateId?: unknown };
  if (typeof candidateId !== "string" || candidateId.trim().length === 0) {
    return NextResponse.json(
      { error: "candidateId is required" },
      { status: 400 }
    );
  }
  // Reject suspiciously long ids (max UUID length is 36 chars; allow some slack).
  if (candidateId.trim().length > 40) {
    return NextResponse.json(
      { error: "candidateId is invalid" },
      { status: 400 }
    );
  }

  try {
    const result = await pickBonWinner(runId, candidateId.trim());
    const winnerSessionId = result.run.winner_session_id;
    return NextResponse.json({ ok: true, winnerSessionId, ...result });
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Failed to pick winner";
    const isNotFound =
      msg.includes("not found") || msg.includes("not found in run");
    return NextResponse.json({ error: msg }, { status: isNotFound ? 404 : 400 });
  }
}

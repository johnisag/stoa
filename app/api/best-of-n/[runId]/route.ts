import { NextRequest, NextResponse } from "next/server";
import { getBonRunStatus } from "@/lib/best-of-n";

/**
 * GET /api/best-of-n/:runId — return the current state of a Best-of-N run.
 *
 * Response: { run: BestOfNRun, candidates: BestOfNCandidateWithStatus[] }
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  if (!runId || runId.length > 40) {
    return NextResponse.json({ error: "runId is invalid" }, { status: 400 });
  }
  try {
    const result = getBonRunStatus(runId);
    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Not found";
    return NextResponse.json({ error: msg }, { status: 404 });
  }
}

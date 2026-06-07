import { NextResponse } from "next/server";
import { getRun } from "@/lib/pipeline/registry";

/**
 * GET /api/pipelines/[id] — poll one pipeline run's live state.
 *
 * Runs are held in memory, so an id that's well-formed but absent may mean the
 * run was lost on a server restart (not just a bad id) — the message says so to
 * help a polling conductor tell "re-plan" from "I mistyped the id".
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return NextResponse.json(
      {
        error:
          "Pipeline run not found — unknown id, or the run was lost on a server restart (runs are kept in memory).",
      },
      { status: 404 }
    );
  }
  return NextResponse.json({ run });
}

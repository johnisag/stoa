import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionDiff } from "@/lib/session-diff";

// GET /api/sessions/[id]/diff — the cumulative diff of what the agent changed in
// this session (committed-since-base + uncommitted + untracked). Read-only.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = queries.getSession(getDb()).get(id) as Session | undefined;
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const result = await getSessionDiff({
      cwd: session.working_directory,
      baseBranch: session.base_branch,
    });
    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("diff route failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionDiff } from "@/lib/session-diff";
import { requireAdmin } from "@/lib/api-security";
import {
  assertGenericSessionRouteAccess,
  genericSessionRouteFailure,
} from "@/lib/session-route-access";

// GET /api/sessions/[id]/diff — the cumulative diff of what the agent changed in
// this session (committed-since-base + uncommitted + untracked). Read-only.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const adminError = requireAdmin(request);
  if (adminError) return adminError;

  try {
    const { id } = await params;
    const session = queries.getSession(getDb()).get(id) as Session | undefined;
    const denied = genericSessionRouteFailure(session);
    if (denied) {
      return NextResponse.json(
        { error: denied.error },
        { status: denied.status }
      );
    }
    assertGenericSessionRouteAccess(session);

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

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { readCappedJsonBody } from "@/lib/fleet/http";
import { retryFleetTask } from "@/lib/fleet/operator-actions";
import { getFleetRunDetail } from "@/lib/fleet/service";

const OPERATOR_BODY_MAX = 8 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id, taskId } = await params;
  const parsed = await readCappedJsonBody(request, OPERATOR_BODY_MAX);
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status }
    );
  }
  const result = retryFleetTask(id, taskId, parsed.body, "fleet-api-admin");
  const run = getFleetRunDetail(id);
  return "error" in result
    ? NextResponse.json({ ...result, run }, { status: result.status })
    : NextResponse.json({ ...result, run }, { status: 202 });
}

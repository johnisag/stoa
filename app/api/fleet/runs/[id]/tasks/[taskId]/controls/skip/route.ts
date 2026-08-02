import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import {
  getFleetApprovalControlPreview,
  skipFleetTaskWithApproval,
} from "@/lib/fleet/approval-controls";
import {
  FLEET_APPROVAL_CONTROL_JSON_BODY_MAX,
  readCappedJsonBody,
} from "@/lib/fleet/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id, taskId } = await params;
  const parsed = await readCappedJsonBody(
    request,
    FLEET_APPROVAL_CONTROL_JSON_BODY_MAX
  );
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status }
    );
  }
  const result = skipFleetTaskWithApproval(
    id,
    taskId,
    parsed.body,
    "fleet-api-admin"
  );
  const preview = getFleetApprovalControlPreview(id);
  return "error" in result
    ? NextResponse.json({ ...result, preview }, { status: result.status })
    : NextResponse.json({ ...result, preview });
}

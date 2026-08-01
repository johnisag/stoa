import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import {
  getFleetApprovalControlPreview,
  updateFleetRunConcurrency,
} from "@/lib/fleet/approval-controls";
import {
  FLEET_APPROVAL_CONTROL_JSON_BODY_MAX,
  readCappedJsonBody,
} from "@/lib/fleet/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
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
  const result = updateFleetRunConcurrency(id, parsed.body, "fleet-api-admin");
  const preview = getFleetApprovalControlPreview(id);
  return "error" in result
    ? NextResponse.json({ ...result, preview }, { status: result.status })
    : NextResponse.json({ ...result, preview });
}

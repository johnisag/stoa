import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { getFleetApprovalControlPreview } from "@/lib/fleet/approval-controls";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const preview = getFleetApprovalControlPreview(id);
  return preview
    ? NextResponse.json(preview)
    : NextResponse.json({ error: "Fleet run not found" }, { status: 404 });
}

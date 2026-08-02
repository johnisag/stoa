import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { revokeStoredFleetCapability } from "@/lib/fleet/capability-runtime";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    const result = revokeStoredFleetCapability(id, "operator");
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json({ capability: result });
  } catch {
    return NextResponse.json(
      { error: "Failed to revoke Fleet capability" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import {
  FLEET_APPROVAL_JSON_BODY_MAX,
  readCappedJsonBody,
} from "@/lib/fleet/http";
import { archiveFleetRun } from "@/lib/fleet/lifecycle";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const body = await readCappedJsonBody(request, FLEET_APPROVAL_JSON_BODY_MAX);
  if ("error" in body) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  try {
    const result = archiveFleetRun(id, body.body);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("[fleet] archive failed:", error);
    return NextResponse.json(
      { error: "Failed to archive fleet run" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { readCappedJsonBody } from "@/lib/fleet/http";
import {
  appendFleetSupervisorRecommendation,
  FLEET_SUPERVISOR_JSON_BODY_MAX,
  getFleetSupervisorSnapshot,
} from "@/lib/fleet/supervisor";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const snapshot = getFleetSupervisorSnapshot(id);
    return snapshot
      ? NextResponse.json(snapshot)
      : NextResponse.json({ error: "Fleet run not found" }, { status: 404 });
  } catch (error) {
    console.error("[fleet] GET /api/fleet/runs/[id]/supervisor failed:", error);
    return NextResponse.json(
      { error: "Failed to load Fleet supervisor snapshot" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const parsed = await readCappedJsonBody(
    request,
    FLEET_SUPERVISOR_JSON_BODY_MAX
  );
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status }
    );
  }
  try {
    const result = appendFleetSupervisorRecommendation(id, parsed.body);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error(
      "[fleet] POST /api/fleet/runs/[id]/supervisor failed:",
      error
    );
    return NextResponse.json(
      { error: "Failed to append Fleet supervisor recommendation" },
      { status: 500 }
    );
  }
}

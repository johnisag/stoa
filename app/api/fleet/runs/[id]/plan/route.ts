import { NextRequest, NextResponse } from "next/server";
import { FLEET_PLAN_JSON_BODY_MAX, readCappedJsonBody } from "@/lib/fleet/http";
import { ingestFleetRunPlan } from "@/lib/fleet/service";
import { requireAdmin } from "@/lib/api-security";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const body = await readCappedJsonBody(request, FLEET_PLAN_JSON_BODY_MAX);
  if ("error" in body) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  try {
    const input =
      body.body && typeof body.body === "object"
        ? { ...(body.body as Record<string, unknown>), actor: "operator" }
        : { actor: "operator" };
    const result = ingestFleetRunPlan(id, input);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 400 }
      );
    }
    return NextResponse.json(result.run);
  } catch (error) {
    console.error("[fleet] POST /api/fleet/runs/[id]/plan failed:", error);
    return NextResponse.json(
      { error: "Failed to ingest fleet plan" },
      { status: 500 }
    );
  }
}

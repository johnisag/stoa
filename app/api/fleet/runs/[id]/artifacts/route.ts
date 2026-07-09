import { NextRequest, NextResponse } from "next/server";
import {
  FLEET_ARTIFACT_JSON_BODY_MAX,
  readCappedJsonBody,
} from "@/lib/fleet/http";
import { attachFleetPlanCriticArtifact } from "@/lib/fleet/service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await readCappedJsonBody(request, FLEET_ARTIFACT_JSON_BODY_MAX);
  if ("error" in body) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  try {
    const result = attachFleetPlanCriticArtifact(id, body.body);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 400 }
      );
    }
    return NextResponse.json(result.run);
  } catch (error) {
    console.error("[fleet] POST /api/fleet/runs/[id]/artifacts failed:", error);
    return NextResponse.json(
      { error: "Failed to attach fleet artifact" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { FLEET_RUN_JSON_BODY_MAX, readCappedJsonBody } from "@/lib/fleet/http";
import { createDraftFleetRun, listFleetRuns } from "@/lib/fleet/service";

export async function GET() {
  try {
    return NextResponse.json({ runs: listFleetRuns() });
  } catch (error) {
    console.error("[fleet] GET /api/fleet/runs failed:", error);
    return NextResponse.json(
      { error: "Failed to list fleet runs" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await readCappedJsonBody(request, FLEET_RUN_JSON_BODY_MAX);
  if ("error" in body) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const result = createDraftFleetRun(body.body);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result.run, { status: 201 });
}

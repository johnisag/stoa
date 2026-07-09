import { NextRequest, NextResponse } from "next/server";
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = createDraftFleetRun(body);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result.run, { status: 201 });
}

import { NextRequest, NextResponse } from "next/server";
import { pauseFleetRun } from "@/lib/fleet/scheduler";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await pauseFleetRun(id);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 400 }
      );
    }
    return NextResponse.json({ run: result.run });
  } catch (error) {
    console.error("[fleet] POST /api/fleet/runs/[id]/pause failed:", error);
    return NextResponse.json(
      { error: "Failed to pause fleet run" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { startFleetRun } from "@/lib/fleet/scheduler";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await startFleetRun(id, { awaitLaunches: false });
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 400 }
      );
    }
    return NextResponse.json({ run: result.run, summary: result.summary });
  } catch (error) {
    console.error("[fleet] POST /api/fleet/runs/[id]/start failed:", error);
    return NextResponse.json(
      { error: "Failed to start fleet run" },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { tickFleetRun } from "@/lib/fleet/service";
import { hasFleetSchedulerIdentity } from "@/lib/fleet/scheduler-auth";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (
    !hasFleetSchedulerIdentity(
      request.headers.get("x-stoa-fleet-scheduler-token")
    )
  ) {
    return NextResponse.json(
      { error: "scheduler service identity required" },
      { status: 403 }
    );
  }
  const { id } = await params;
  try {
    const result = await tickFleetRun(id);
    if ("error" in result)
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 400 }
      );
    return NextResponse.json({ ...result.run, launched: result.launched });
  } catch (error) {
    console.error("[fleet] tick failed:", error);
    return NextResponse.json(
      { error: "Failed to tick fleet run" },
      { status: 500 }
    );
  }
}

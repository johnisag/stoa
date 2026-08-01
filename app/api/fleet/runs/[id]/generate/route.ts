import { NextRequest, NextResponse } from "next/server";
import { FLEET_RUN_JSON_BODY_MAX, readCappedJsonBody } from "@/lib/fleet/http";
import { cancelFleetPlanner, startFleetPlanner } from "@/lib/fleet/planner";
import { getFleetRunDetail } from "@/lib/fleet/service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await readCappedJsonBody(request, FLEET_RUN_JSON_BODY_MAX);
  if ("error" in body) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  try {
    const input =
      body.body && typeof body.body === "object"
        ? (body.body as {
            taskCap?: unknown;
            provider?: unknown;
          })
        : {};
    const result = await startFleetPlanner(id, input);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 400 }
      );
    }
    return NextResponse.json(result.run, { status: 202 });
  } catch (error) {
    console.error("[fleet] planner launch failed:", error);
    return NextResponse.json(
      { error: "Failed to start fleet planner" },
      { status: 500 }
    );
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const detail = getFleetRunDetail(id);
  return detail
    ? NextResponse.json(detail)
    : NextResponse.json({ error: "Fleet run not found" }, { status: 404 });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await cancelFleetPlanner(id);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 400 }
      );
    }
    return NextResponse.json(result.run);
  } catch (error) {
    console.error("[fleet] planner cancellation failed:", error);
    return NextResponse.json(
      { error: "Failed to cancel fleet planner" },
      { status: 500 }
    );
  }
}

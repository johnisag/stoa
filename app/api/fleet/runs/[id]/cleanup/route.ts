import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import {
  FLEET_APPROVAL_JSON_BODY_MAX,
  readCappedJsonBody,
} from "@/lib/fleet/http";
import {
  previewFleetCleanup,
  requestFleetCleanup,
} from "@/lib/fleet/lifecycle";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    const result = await previewFleetCleanup(id);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("[fleet] cleanup preview failed:", error);
    return NextResponse.json(
      { error: "Failed to preview fleet cleanup" },
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
  const body = await readCappedJsonBody(request, FLEET_APPROVAL_JSON_BODY_MAX);
  if ("error" in body) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  try {
    const result = await requestFleetCleanup(id, body.body);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(result, {
      status: result.dryRun ? 200 : 202,
    });
  } catch (error) {
    console.error("[fleet] cleanup request failed:", error);
    return NextResponse.json(
      { error: "Failed to request fleet cleanup" },
      { status: 500 }
    );
  }
}

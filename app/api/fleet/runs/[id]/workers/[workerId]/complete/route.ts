import { NextRequest, NextResponse } from "next/server";
import { completeFleetWorker } from "@/lib/fleet/service";
import {
  FLEET_APPROVAL_JSON_BODY_MAX,
  readCappedJsonBody,
} from "@/lib/fleet/http";
import { requireAdmin } from "@/lib/api-security";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; workerId: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id, workerId } = await params;
  try {
    const body = await readCappedJsonBody(
      request,
      FLEET_APPROVAL_JSON_BODY_MAX
    );
    if ("error" in body) {
      return NextResponse.json({ error: body.error }, { status: body.status });
    }
    const input =
      body.body && typeof body.body === "object"
        ? { ...(body.body as Record<string, unknown>), actor: "operator" }
        : { actor: "operator" };
    const result = await completeFleetWorker(id, workerId, input);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 400 }
      );
    }
    return NextResponse.json(result.run);
  } catch (error) {
    console.error("[fleet] complete worker failed:", error);
    return NextResponse.json(
      { error: "Failed to complete fleet worker" },
      { status: 500 }
    );
  }
}

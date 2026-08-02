import { NextRequest, NextResponse } from "next/server";
import {
  FLEET_APPROVAL_JSON_BODY_MAX,
  readCappedJsonBody,
} from "@/lib/fleet/http";
import { cancelFleetRun } from "@/lib/fleet/service";
import { parseFleetCancelRequest } from "@/lib/fleet/interrupt-policy";
import { requireAdmin } from "@/lib/api-security";
import { previewFleetDestructiveAction } from "@/lib/fleet/lifecycle";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    const result = await previewFleetDestructiveAction(id);
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[fleet] destructive cancellation preview failed:", error);
    return NextResponse.json(
      { error: "Failed to preview destructive Fleet cancellation" },
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
  if ("error" in body)
    return NextResponse.json({ error: body.error }, { status: body.status });
  try {
    const input =
      body.body && typeof body.body === "object"
        ? { ...(body.body as Record<string, unknown>), actor: "operator" }
        : { actor: "operator" };
    const parsed = parseFleetCancelRequest(id, input);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const result = await cancelFleetRun(id, input);
    if ("error" in result)
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 400 }
      );
    return NextResponse.json(result.run);
  } catch (error) {
    console.error("[fleet] cancel failed:", error);
    return NextResponse.json(
      { error: "Failed to cancel fleet run" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import {
  FLEET_SOURCE_JSON_BODY_MAX,
  readCappedJsonBody,
} from "@/lib/fleet/http";
import { createFleetRunFromSource } from "@/lib/fleet/source-service";

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const body = await readCappedJsonBody(request, FLEET_SOURCE_JSON_BODY_MAX);
  if ("error" in body) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const result = createFleetRunFromSource(body.body, "operator");
  if ("error" in result) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status ?? 400 }
    );
  }
  return NextResponse.json(result.run, { status: 201 });
}

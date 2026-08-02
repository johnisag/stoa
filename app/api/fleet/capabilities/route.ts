import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import {
  FLEET_CAPABILITY_ISSUE_JSON_BODY_MAX,
  readCappedJsonBody,
} from "@/lib/fleet/http";
import { issueStoredFleetCapability } from "@/lib/fleet/capability-runtime";

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const body = await readCappedJsonBody(
    request,
    FLEET_CAPABILITY_ISSUE_JSON_BODY_MAX
  );
  if ("error" in body) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  try {
    const result = issueStoredFleetCapability(body.body, "operator");
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    // The token is returned once. The durable/public record deliberately has no
    // tokenHash field, which avoids teaching clients to log a credential digest.
    return NextResponse.json(result, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Failed to issue Fleet capability" },
      { status: 500 }
    );
  }
}

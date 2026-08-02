import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/api-security";
import {
  FLEET_CAPABILITY_ACTION_JSON_BODY_MAX,
  readCappedJsonBody,
} from "@/lib/fleet/http";
import { executeStoredFleetCapability } from "@/lib/fleet/capability-runtime";

/**
 * Capability-only mutation boundary. Do not add requireAdmin here: the exact,
 * expiring server capability is the authorization. The custom server exempts
 * only this path from broad HTTP auth so a delegated MCP worker can use it.
 */
export async function POST(request: NextRequest) {
  // This route deliberately bypasses broad HTTP auth because its capability is
  // the credential. Apply the established connection-IP limiter before reading
  // or parsing the body so malformed/oversized unauthenticated traffic cannot
  // drive unbounded hashing or SQLite work.
  const rateLimit = checkRateLimit(request);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfter ?? 60) },
      }
    );
  }
  const body = await readCappedJsonBody(
    request,
    FLEET_CAPABILITY_ACTION_JSON_BODY_MAX
  );
  if ("error" in body) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const input = body.body as {
    token?: unknown;
    scope?: unknown;
    payload?: unknown;
  };
  try {
    const result = await executeStoredFleetCapability({
      token: input?.token,
      scope: input?.scope,
      payload: input?.payload,
    });
    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Failed to execute Fleet capability" },
      { status: 500 }
    );
  }
}

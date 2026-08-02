import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-security";
import { readCappedJsonBody } from "@/lib/fleet/http";
import {
  cancelManagedFleetSupervisor,
  getManagedFleetSupervisorStatus,
  startManagedFleetSupervisor,
} from "@/lib/fleet/supervisor-runtime";

const MANAGED_SUPERVISOR_REQUEST_MAX_BYTES = 16 * 1024;

function response(
  result:
    | ReturnType<typeof getManagedFleetSupervisorStatus>
    | Awaited<ReturnType<typeof startManagedFleetSupervisor>>,
  successStatus = 200
) {
  return "error" in result
    ? NextResponse.json({ error: result.error }, { status: result.statusCode })
    : NextResponse.json(result.status, { status: successStatus });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    return response(getManagedFleetSupervisorStatus(id));
  } catch (error) {
    console.error(
      "[fleet] GET /api/fleet/runs/[id]/supervisor/session failed:",
      error
    );
    return NextResponse.json(
      { error: "Failed to load managed Fleet supervisor" },
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
  const parsed = await readCappedJsonBody(
    request,
    MANAGED_SUPERVISOR_REQUEST_MAX_BYTES
  );
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error },
      { status: parsed.status }
    );
  }
  try {
    return response(
      await startManagedFleetSupervisor(
        id,
        parsed.body as { provider?: unknown; model?: unknown }
      ),
      201
    );
  } catch (error) {
    console.error(
      "[fleet] POST /api/fleet/runs/[id]/supervisor/session failed:",
      error
    );
    return NextResponse.json(
      { error: "Failed to start managed Fleet supervisor" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  try {
    return response(await cancelManagedFleetSupervisor(id));
  } catch (error) {
    console.error(
      "[fleet] DELETE /api/fleet/runs/[id]/supervisor/session failed:",
      error
    );
    return NextResponse.json(
      { error: "Failed to cancel managed Fleet supervisor" },
      { status: 500 }
    );
  }
}

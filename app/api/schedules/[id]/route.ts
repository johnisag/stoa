import { NextRequest, NextResponse } from "next/server";
import {
  getSchedule,
  setScheduleEnabled,
  deleteSchedule,
  ScheduleValidationError,
} from "@/lib/scheduler";

// GET    /api/schedules/[id]            → one schedule (404 if missing)
// PATCH  /api/schedules/[id] { enabled } → pause/resume the schedule
// DELETE /api/schedules/[id]            → remove it

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const schedule = getSchedule(id);
    if (!schedule) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ schedule });
  } catch (error) {
    console.error("schedule GET failed:", error);
    return NextResponse.json(
      { error: "Failed to get schedule" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }
  try {
    const { id } = await params;
    const { enabled } = (body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 }
      );
    }
    const schedule = setScheduleEnabled(id, enabled);
    if (!schedule) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ schedule });
  } catch (error) {
    if (error instanceof ScheduleValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("schedules PATCH failed:", error);
    return NextResponse.json(
      { error: "Failed to update schedule" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return NextResponse.json({ removed: deleteSchedule(id) });
  } catch (error) {
    console.error("schedule DELETE failed:", error);
    return NextResponse.json(
      { error: "Failed to delete schedule" },
      { status: 500 }
    );
  }
}

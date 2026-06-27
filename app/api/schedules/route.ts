import { NextRequest, NextResponse } from "next/server";
import {
  createSchedule,
  listSchedules,
  ScheduleValidationError,
} from "@/lib/scheduler";

// General-purpose scheduler — the SAME endpoint the orchestration MCP server's
// schedule_* tools call (and the shared surface a human UI would use). A schedule
// fires a prompt into a session on a cadence; at the due time the server enqueues
// the prompt into the session's prompt queue (delivered by the existing safe
// turn-boundary path).

// GET  /api/schedules → list (enabled first, then soonest next-run)
export async function GET() {
  try {
    return NextResponse.json({ schedules: listSchedules() });
  } catch (error) {
    console.error("schedules GET failed:", error);
    return NextResponse.json(
      { error: "Failed to read schedules" },
      { status: 500 }
    );
  }
}

// POST /api/schedules { sessionId, prompt, recurrence?, runAt?, name? } → create
export async function POST(request: NextRequest) {
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
    const { sessionId, prompt, recurrence, runAt, name } = (body ?? {}) as {
      sessionId?: unknown;
      prompt?: unknown;
      recurrence?: unknown;
      runAt?: unknown;
      name?: unknown;
    };
    const schedule = createSchedule({
      sessionId,
      prompt,
      recurrence,
      runAt,
      name,
    });
    return NextResponse.json({ schedule }, { status: 201 });
  } catch (error) {
    if (error instanceof ScheduleValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("schedules POST failed:", error);
    return NextResponse.json(
      { error: "Failed to create schedule" },
      { status: 500 }
    );
  }
}

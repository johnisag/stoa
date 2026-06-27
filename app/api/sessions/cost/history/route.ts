import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getFleetCostHistory } from "@/lib/cost-history";
import { normalizeWindowDays, windowStartMs } from "@/lib/analytics/queries";
import { utcDay } from "@/lib/utc-day";

export type { FleetCostPoint } from "@/lib/cost-history";

// GET /api/sessions/cost/history?days=N — the PERSISTED fleet spend curve over the
// last N days (one point per UTC day, summed across sessions sampled that day).
// Unlike /api/sessions/cost (a live snapshot recomputed from transcripts), this is
// durable: it keeps a deleted session's last sample and survives transcript loss
// (#15). Bounded to the same window range as analytics; best-effort.
export async function GET(req: NextRequest) {
  try {
    const days = normalizeWindowDays(
      req.nextUrl.searchParams.get("days") ?? undefined
    );
    const sinceDay = utcDay(windowStartMs(Date.now(), days));
    const fleet = getFleetCostHistory(getDb(), sinceDay);
    const totalUsd = fleet.reduce((sum, p) => sum + p.costUsd, 0);
    return NextResponse.json({ days, sinceDay, fleet, totalUsd });
  } catch (error) {
    console.error("cost history route failed:", error);
    return NextResponse.json(
      { error: "Failed to read cost history" },
      { status: 500 }
    );
  }
}

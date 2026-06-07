import { NextResponse, type NextRequest } from "next/server";
import {
  getAnalyticsReport,
  normalizeWindowDays,
} from "@/lib/analytics/queries";

export type { AnalyticsReport } from "@/lib/analytics/types";

// GET /api/analytics?windowDays=14 — the Insight report (performance,
// behavioural, intelligence, trends, issues) computed over the audit ledger +
// session outcomes for the last N days. Best-effort + on-box; not on a hot poll
// path (the cockpit refetches on a slow interval while the view is open).
export async function GET(req: NextRequest) {
  try {
    const windowDays = normalizeWindowDays(
      req.nextUrl.searchParams.get("windowDays")
    );
    const report = await getAnalyticsReport(windowDays);
    return NextResponse.json(report);
  } catch (error) {
    console.error("analytics route failed:", error);
    return NextResponse.json(
      { error: "Failed to compute analytics" },
      { status: 500 }
    );
  }
}

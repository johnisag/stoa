import { NextResponse, type NextRequest } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { computeSessionCosts } from "@/lib/session-cost";
import { buildMonitorRows } from "@/lib/agent-monitor";
import { collectMonitorProcessInfo } from "@/lib/monitor-collect";
import { readRateLimitWindowRecord } from "@/lib/rate-limit-window-source";
import {
  buildTelemetrySnapshot,
  type TelemetrySnapshot,
} from "@/lib/monitor-snapshot";

export type { TelemetrySnapshot } from "@/lib/monitor-snapshot";

// GET /api/monitor?format=json — a normalized, abtop-aligned telemetry snapshot of the
// whole fleet (M5): per-agent status / model / context / tokens / cost + child-process &
// MCP fan-out (M3) + listening / orphan ports (M4) + the global rate-limit window (M2).
// For interop / scripting. On-demand (gathers costs + a process/port snapshot), NOT the
// hot status-poll path. `format=json` is the only supported format today; the snapshot
// is also the default when `format` is omitted.
export async function GET(req: NextRequest) {
  const format = req.nextUrl.searchParams.get("format");
  if (format != null && format !== "json") {
    return NextResponse.json(
      { error: `Unsupported format "${format}" (only "json" is supported)` },
      { status: 400 }
    );
  }
  try {
    const db = getDb();
    const sessions = queries.getAllSessions(db).all() as Session[];
    const costs = await computeSessionCosts(sessions);
    const rows = buildMonitorRows(sessions, costs);
    const processInfo = await collectMonitorProcessInfo();
    const rateLimit = readRateLimitWindowRecord();

    const snapshot: TelemetrySnapshot = buildTelemetrySnapshot({
      generatedAt: Date.now(),
      rateLimit,
      rows,
      processInfo,
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    console.error("monitor snapshot route failed:", error);
    return NextResponse.json(
      { error: "Failed to build telemetry snapshot" },
      { status: 500 }
    );
  }
}

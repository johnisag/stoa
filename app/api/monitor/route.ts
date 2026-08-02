import { NextResponse, type NextRequest } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { computeSessionCosts } from "@/lib/session-cost";
import { buildMonitorRows } from "@/lib/agent-monitor";
import { collectMonitorProcessInfo } from "@/lib/monitor-collect";
import { readRateLimitWindowRecord } from "@/lib/rate-limit-window-source";
import {
  collectAbtopTelemetry,
  mergeAbtopAgentSnapshots,
} from "@/lib/abtop-sensor";
import {
  buildTelemetrySnapshot,
  type TelemetrySnapshot,
} from "@/lib/monitor-snapshot";
import { isInteractiveSessionRole } from "@/lib/session-role";
import { backendKeyForSession } from "@/lib/providers/registry";

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
    const allSessions = queries.getAllSessions(db).all() as Session[];
    const sessions = allSessions.filter(isInteractiveSessionRole);
    const internalSessionKeys = new Set<string>();
    for (const session of allSessions) {
      if (isInteractiveSessionRole(session)) continue;
      // abtop may identify the same process by Stoa id, backend key, or native
      // provider transcript/thread id. Exclude every identifier accepted by its
      // merge matcher so an internal broker cannot reappear as an unmatched row.
      internalSessionKeys.add(session.id);
      internalSessionKeys.add(backendKeyForSession(session));
      if (session.claude_session_id) {
        internalSessionKeys.add(session.claude_session_id);
      }
    }
    const costs = await computeSessionCosts(sessions);
    const rows = buildMonitorRows(sessions, costs);
    const [processInfo, abtopAgents] = await Promise.all([
      collectMonitorProcessInfo(),
      collectAbtopTelemetry(),
    ]);
    const rateLimit = readRateLimitWindowRecord();

    const baseSnapshot: TelemetrySnapshot = buildTelemetrySnapshot({
      generatedAt: Date.now(),
      rateLimit,
      rows,
      processInfo,
    });
    const snapshot: TelemetrySnapshot = {
      ...baseSnapshot,
      agents: mergeAbtopAgentSnapshots(
        baseSnapshot.agents,
        sessions,
        abtopAgents.filter((agent) => !internalSessionKeys.has(agent.sessionId))
      ),
    };
    return NextResponse.json(snapshot);
  } catch (error) {
    console.error("monitor snapshot route failed:", error);
    return NextResponse.json(
      { error: "Failed to build telemetry snapshot" },
      { status: 500 }
    );
  }
}

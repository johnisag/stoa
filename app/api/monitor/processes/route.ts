import { NextResponse } from "next/server";
import { collectMonitorProcessInfo } from "@/lib/monitor-collect";

export type { SessionProcessInfo } from "@/lib/process-tree";

// GET /api/monitor/processes — per-session child-process / MCP-server fan-out (M3) PLUS
// the listening ports attributed to each session's process tree (M4), for the Agent
// Monitor. The gather (one host-wide process + port snapshot → per-live-session subtree
// walk + port attribution) lives in lib/monitor-collect.ts, shared with the telemetry
// snapshot export (M5). On-demand only (NOT the hot status-poll path). Best-effort +
// fail-closed: a session degrades to a zero fan-out, never a 500 (except a catastrophic
// failure). Only counts + MCP names + port NUMBERS cross to the client.
export async function GET() {
  try {
    return NextResponse.json({ fanouts: await collectMonitorProcessInfo() });
  } catch (error) {
    console.error("monitor processes route failed:", error);
    return NextResponse.json(
      { error: "Failed to inspect processes" },
      { status: 500 }
    );
  }
}

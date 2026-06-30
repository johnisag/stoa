import { NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";
import { backendKeyForSession } from "@/lib/providers/registry";
import {
  snapshotProcesses,
  fanoutFor,
  type ProcessFanout,
} from "@/lib/process-tree";

export type { ProcessFanout } from "@/lib/process-tree";

// GET /api/monitor/processes — per-session child-process / MCP-server fan-out (M3) for
// the Agent Monitor. For each LIVE session we resolve its root pid via the backend and
// walk a single host process snapshot down from it. On-demand only (the Monitor's
// process view), NOT on the hot status-poll path — the snapshot shells out to ps /
// PowerShell. Best-effort + fail-closed: an unresolved pid or an empty snapshot just
// yields a zero fan-out for that session, never a 500.
export async function GET() {
  try {
    const db = getDb();
    const sessions = queries.getAllSessions(db).all() as Session[];
    const backend = getSessionBackend();

    // Only inspect sessions the backend still has live (a dead row has no tree).
    let liveNames: Set<string>;
    try {
      liveNames = new Set(await backend.list());
    } catch {
      liveNames = new Set();
    }

    // ONE host-wide snapshot for the whole fleet, then a per-session subtree walk.
    const procs = await snapshotProcesses();

    const fanouts: Record<string, ProcessFanout> = {};
    for (const s of sessions) {
      const key = backendKeyForSession(s);
      if (!liveNames.has(key)) continue;
      let pid: number | null = null;
      try {
        pid = await backend.getPid(key);
      } catch {
        pid = null;
      }
      fanouts[s.id] = fanoutFor(procs, pid);
    }

    return NextResponse.json({ fanouts });
  } catch (error) {
    console.error("monitor processes route failed:", error);
    return NextResponse.json(
      { error: "Failed to inspect processes" },
      { status: 500 }
    );
  }
}

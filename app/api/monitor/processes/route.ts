import { NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";
import { backendKeyForSession } from "@/lib/providers/registry";
import {
  snapshotProcesses,
  fanoutFor,
  attributePorts,
  type SessionProcessInfo,
} from "@/lib/process-tree";
import { listListeningPorts } from "@/lib/listening-ports";

export type { SessionProcessInfo } from "@/lib/process-tree";

/** Stoa-managed dev-server ports grouped BY PROJECT (from the dev_servers table).
 *  Per-project, not account-global, so one session's tracked port can't mask another
 *  session's genuine orphan (Gate D). Fail-closed: a missing table / malformed `ports`
 *  JSON contributes nothing. */
function managedPortsByProject(
  db: ReturnType<typeof getDb>
): Map<string, Set<number>> {
  const byProject = new Map<string, Set<number>>();
  try {
    const devServers = queries.getAllDevServers(db).all() as Array<{
      project_id: string;
      ports: string | null;
    }>;
    for (const ds of devServers) {
      let arr: unknown;
      try {
        arr = JSON.parse(ds.ports || "[]");
      } catch {
        continue; // malformed ports column → skip this dev server
      }
      if (!Array.isArray(arr)) continue;
      let set = byProject.get(ds.project_id);
      if (!set) {
        set = new Set<number>();
        byProject.set(ds.project_id, set);
      }
      for (const p of arr) if (typeof p === "number" && p > 0) set.add(p);
    }
  } catch {
    /* dev_servers table absent/unreadable → no project-managed ports */
  }
  return byProject;
}

/** A session's KNOWN ports: its own assigned `dev_server_port` + its project's managed
 *  dev-server ports. A listening port under the session's tree that ISN'T here is an
 *  agent-spawned "orphan". Per-session (not account-global) so a sibling session's
 *  tracked port can't falsely mark this one's orphan as known. */
function managedPortsForSession(
  s: Session,
  byProject: Map<string, Set<number>>
): Set<number> {
  const managed = new Set<number>(byProject.get(s.project_id ?? "") ?? []);
  if (typeof s.dev_server_port === "number" && s.dev_server_port > 0) {
    managed.add(s.dev_server_port);
  }
  return managed;
}

// GET /api/monitor/processes — per-session child-process / MCP-server fan-out (M3) PLUS
// the listening ports attributed to each session's process tree (M4), for the Agent
// Monitor. For each LIVE session we resolve its root pid via the backend and walk a
// single host process + listening-port snapshot down from it. On-demand only (the
// Monitor's process view), NOT on the hot status-poll path — it shells out to ps /
// PowerShell + lsof / netstat. Best-effort + fail-closed: an unresolved pid or an empty
// snapshot just yields a zero fan-out for that session, never a 500. Only counts + MCP
// names + port NUMBERS cross to the client — never a raw command line.
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

    // ONE host-wide snapshot of processes + listening ports for the whole fleet, then a
    // per-session subtree walk + port attribution.
    const procs = await snapshotProcesses();
    const listening = await listListeningPorts();
    const byProject = managedPortsByProject(db);

    const fanouts: Record<string, SessionProcessInfo> = {};
    for (const s of sessions) {
      const key = backendKeyForSession(s);
      if (!liveNames.has(key)) continue;
      let pid: number | null = null;
      try {
        pid = await backend.getPid(key);
      } catch {
        pid = null;
      }
      fanouts[s.id] = {
        ...fanoutFor(procs, pid),
        ports: attributePorts(
          procs,
          pid,
          listening,
          managedPortsForSession(s, byProject)
        ),
      };
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

/**
 * Shared per-session process + listening-port gather for the Agent Monitor (M3 + M4).
 * One host-wide process + port snapshot, then a per-LIVE-session subtree walk + port
 * attribution. Server-only. Used by BOTH `/api/monitor/processes` and the telemetry
 * snapshot export (`/api/monitor?format=json`, M5), so the (heavy) snapshot logic lives
 * in one place. Best-effort + fail-closed throughout: a per-session backend/snapshot
 * failure degrades THAT session to a zero fan-out; a catastrophic gather failure (e.g. no
 * DB) propagates for the caller's route-level try/catch to turn into a 500.
 */

import { getDb, queries, type Session } from "./db";
import { getSessionBackend } from "./session-backend";
import { backendKeyForSession } from "./providers/registry";
import {
  snapshotProcesses,
  fanoutFor,
  attributePorts,
  type SessionProcessInfo,
} from "./process-tree";
import { listListeningPorts } from "./listening-ports";

/** Stoa-managed dev-server ports grouped BY PROJECT (from the dev_servers table).
 *  Per-project, not account-global, so one session's tracked port can't mask another
 *  session's genuine orphan. Fail-closed: a missing table / malformed `ports` JSON
 *  contributes nothing. */
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

/**
 * Per-session child-process/MCP fan-out (M3) + attributed listening ports (M4), keyed by
 * session id, for every LIVE session. ONE host-wide process + listening-port snapshot is
 * taken and walked per session. Only the backend's live sessions are inspected (a dead
 * row has no tree). Best-effort: an unresolved pid or empty snapshot yields a zero
 * fan-out for that session.
 */
export async function collectMonitorProcessInfo(): Promise<
  Record<string, SessionProcessInfo>
> {
  const db = getDb();
  const sessions = queries.getAllSessions(db).all() as Session[];
  const backend = getSessionBackend();

  let liveNames: Set<string>;
  try {
    liveNames = new Set(await backend.list());
  } catch {
    liveNames = new Set();
  }

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
  return fanouts;
}

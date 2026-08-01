import { getDb, queries, type Session } from "@/lib/db";
import { killWorker } from "@/lib/orchestration";
import { backendKeyForSession } from "@/lib/providers/registry";
import { getSessionBackend } from "@/lib/session-backend";

/** Best-effort stop with an explicit postcondition; false means operator attention. */
export async function stopFleetSession(
  sessionId: string,
  finalStatus: "completed" | "failed" = "failed"
): Promise<boolean> {
  const db = getDb();
  const session = queries.getSession(db).get(sessionId) as Session | undefined;
  if (!session) return true;
  const previousWorkerStatus = session.worker_status;
  try {
    await killWorker(sessionId, false, finalStatus);
  } catch (error) {
    queries.updateWorkerStatus(db).run(previousWorkerStatus, sessionId);
    throw error;
  }
  try {
    const stopped = !(await getSessionBackend().exists(
      backendKeyForSession(session)
    ));
    if (!stopped) {
      queries.updateWorkerStatus(db).run(previousWorkerStatus, sessionId);
    }
    return stopped;
  } catch {
    queries.updateWorkerStatus(db).run(previousWorkerStatus, sessionId);
    return false;
  }
}

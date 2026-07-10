import type Database from "better-sqlite3";
import { queries, type Session } from "@/lib/db";
import type { DispatchRepo } from "@/lib/dispatch/types";
import type { FleetWorkerRow } from "./types";
import { cleanupFleetWorkerSpawn } from "./spawn";

export async function retryFleetCleanupForRepo(
  db: Database.Database,
  repo: DispatchRepo
): Promise<number> {
  const workers = queries
    .listCleanupPendingFleetWorkersForRepo(db)
    .all(repo.id) as FleetWorkerRow[];
  let resolved = 0;

  for (const worker of workers) {
    if (!worker.session_id) {
      queries
        .markFleetWorkerFailed(db)
        .run("cleanup ownership missing; unpinned by recovery", worker.id);
      resolved++;
      continue;
    }

    const session = queries.getSession(db).get(worker.session_id) as
      Session | undefined;
    if (!session) {
      queries
        .markFleetWorkerFailed(db)
        .run("cleanup session missing; unpinned by recovery", worker.id);
      resolved++;
      continue;
    }

    await cleanupFleetWorkerSpawn({
      db,
      repo,
      result: {
        sessionId: worker.session_id,
        worktreePath: session.worktree_path ?? session.working_directory ?? "",
        branchName: session.branch_name ?? "",
      },
      reason: "cleanup retry",
    });

    const updated = queries.getFleetWorker(db).get(worker.id) as
      FleetWorkerRow | undefined;
    if (updated && updated.status !== "cleanup_pending") resolved++;
  }

  return resolved;
}

/**
 * Command Stoa — the in-process best_of_n executor.
 *
 * Resolves the project SERVER-SIDE (from projectId), then delegates to
 * createBonRun in lib/best-of-n.ts. Returns a result the execute route uses to
 * tell the client to open a Best-of-N compare view pane.
 */

import { createBonRun } from "@/lib/best-of-n";
import type { BestOfNParams } from "./actions";

export interface BestOfNResult {
  runId: string;
  n: number;
}

/**
 * Execute a best_of_n proposal. The project's working_directory is resolved
 * server-side and passed in; it must never come from the agent/client directly.
 */
export async function executeBestOfN(
  params: BestOfNParams,
  project: { id: string; working_directory: string }
): Promise<BestOfNResult> {
  const result = await createBonRun({
    task: params.task,
    n: params.n,
    projectId: project.id,
    conductorSessionId: params.conductorSessionId,
    workingDirectory: project.working_directory,
  });

  return { runId: result.run.id, n: result.run.n };
}

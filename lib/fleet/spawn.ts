import { spawnWorker, WorkerSpawnError } from "@/lib/orchestration";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/registry";
import type { FleetRunRow, FleetTaskRow } from "./types";
import { buildFleetWorkerPrompt } from "./prompt";

export interface FleetSpawnResult {
  sessionId: string;
  worktreePath: string | null;
}

export class FleetSpawnError extends Error {
  constructor(
    message: string,
    readonly sessionId: string | null = null,
    readonly worktreePath: string | null = null
  ) {
    super(message);
    this.name = "FleetSpawnError";
  }
}

export async function spawnFleetWorker(input: {
  run: FleetRunRow;
  task: FleetTaskRow;
  workingDirectory: string;
  claims: string[];
  dependencies: string[];
  attempt: number;
  spawnRequestId: string;
}): Promise<FleetSpawnResult> {
  const provider = input.task.agent_type ?? input.run.provider;
  if (!PROVIDER_IDS.includes(provider as ProviderId) || provider === "shell") {
    throw new Error(`Unsupported fleet provider: ${provider}`);
  }
  const writeTask =
    input.task.task_type !== "review" && input.task.task_type !== "explore";
  let session;
  try {
    session = await spawnWorker({
      conductorSessionId: input.run.conductor_session_id ?? null,
      task: buildFleetWorkerPrompt(input),
      workingDirectory: input.workingDirectory,
      branchName:
        input.task.branch_name ??
        `fleet-${input.run.id.slice(0, 8)}-${input.task.id.slice(0, 8)}-${input.attempt}`,
      baseBranch: input.task.base_branch ?? "main",
      useWorktree: writeTask,
      requireWorktree: writeTask,
      requireTaskDelivery: true,
      model: input.task.model ?? input.run.model ?? undefined,
      agentType: provider as ProviderId,
    });
  } catch (error) {
    if (error instanceof WorkerSpawnError) {
      throw new FleetSpawnError(
        error.message,
        error.sessionId,
        error.worktreePath
      );
    }
    throw error;
  }
  if (session.worker_status === "failed") {
    throw new FleetSpawnError(
      "Fleet worker session failed to start",
      session.id,
      session.worktree_path
    );
  }
  if (writeTask && !session.worktree_path) {
    throw new FleetSpawnError(
      "Fleet write task started without an isolated worktree",
      session.id,
      session.worktree_path
    );
  }
  return { sessionId: session.id, worktreePath: session.worktree_path };
}

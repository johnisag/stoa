import { spawnWorker, WorkerSpawnError } from "@/lib/orchestration";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/registry";
import type { FleetRunRow, FleetTaskRow } from "./types";
import { buildFleetWorkerPrompt } from "./prompt";
import type { FleetWorkerAttemptContract } from "./report-runtime";

export interface FleetSpawnResult {
  sessionId: string;
  worktreePath: string | null;
  branchName?: string | null;
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

export interface FleetSpawnInput {
  run: FleetRunRow;
  task: FleetTaskRow;
  workingDirectory: string;
  claims: string[];
  dependencies: string[];
  attempt: number;
  spawnRequestId: string;
  reportContract?: FleetWorkerAttemptContract & { workerId: string };
}

export async function spawnFleetWorker(
  input: FleetSpawnInput
): Promise<FleetSpawnResult> {
  const provider = input.task.agent_type ?? input.run.provider;
  if (!PROVIDER_IDS.includes(provider as ProviderId) || provider === "shell") {
    throw new Error(`Unsupported fleet provider: ${provider}`);
  }
  let session;
  try {
    const deliveryTask = buildFleetWorkerPrompt(input);
    const persistedTask = input.reportContract
      ? buildFleetWorkerPrompt({
          ...input,
          reportContract: {
            ...input.reportContract,
            nonce: "[redacted ephemeral nonce]",
          },
        })
      : deliveryTask;
    session = await spawnWorker({
      conductorSessionId: input.run.conductor_session_id ?? null,
      task: persistedTask,
      ...(input.reportContract ? { deliveryTask } : {}),
      workingDirectory: input.workingDirectory,
      branchName:
        input.task.branch_name ??
        `fleet-${input.run.id.slice(0, 8)}-${input.task.id.slice(0, 8)}-${input.attempt}`,
      baseBranch: input.task.base_branch ?? "main",
      useWorktree: true,
      requireWorktree: true,
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
  if (!session.worktree_path) {
    throw new FleetSpawnError(
      "Fleet task started without an isolated worktree",
      session.id,
      session.worktree_path
    );
  }
  return {
    sessionId: session.id,
    worktreePath: session.worktree_path,
    branchName: session.branch_name ?? null,
  };
}

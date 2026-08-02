import { spawnWorker, WorkerSpawnError } from "@/lib/orchestration";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/registry";
import type { FleetRunRow, FleetTaskRow } from "./types";
import { buildFleetWorkerPrompt } from "./prompt";
import type { FleetWorkerAttemptContract } from "./report-runtime";
import { parseFleetAutomationPolicy } from "./automation-policy";
import { fleetAgentApprovalMode } from "./confinement";
import { isFleetUnattendedProvider } from "./provider-eligibility";
import { resolveExactModelForAgent } from "@/lib/model-catalog";
import { generateBranchName } from "@/lib/git";
import { worktreePathForFeature } from "@/lib/worktrees";

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
  sessionOwnershipKey: string;
  reportContract?: FleetWorkerAttemptContract & { workerId: string };
}

type FleetWorkerLocationInput = Pick<
  FleetSpawnInput,
  "run" | "task" | "attempt" | "workingDirectory"
>;

export function fleetWorkerFeatureName(
  input: FleetWorkerLocationInput
): string {
  return (
    input.task.branch_name ??
    `fleet-${input.run.id.slice(0, 8)}-${input.task.id.slice(0, 8)}-${input.attempt}`
  );
}

export function expectedFleetWorkerBranch(
  input: FleetWorkerLocationInput
): string {
  return generateBranchName(fleetWorkerFeatureName(input));
}

export function expectedFleetWorkerWorktreePath(
  input: FleetWorkerLocationInput
): string {
  return worktreePathForFeature(
    input.workingDirectory,
    fleetWorkerFeatureName(input)
  );
}

export async function spawnFleetWorker(
  input: FleetSpawnInput
): Promise<FleetSpawnResult> {
  if (!input.task.agent_type) {
    throw new Error("Fleet task is missing its persisted launch provider");
  }
  const provider = input.task.agent_type;
  if (!PROVIDER_IDS.includes(provider as ProviderId) || provider === "shell") {
    throw new Error(`Unsupported fleet provider: ${provider}`);
  }
  if (!isFleetUnattendedProvider(provider)) {
    throw new Error(
      `Fleet provider cannot run unattended: ${provider}. Use an interactive Stoa session instead.`
    );
  }
  const persistedModel = input.task.model?.trim() || null;
  const exactModel = resolveExactModelForAgent(provider, input.task.model);
  if (!exactModel.ok) {
    throw new Error(`Invalid Fleet task model: ${exactModel.error}`);
  }
  if (exactModel.model !== persistedModel) {
    throw new Error("Fleet task is missing its exact persisted launch model");
  }
  const parsedPolicy = parseFleetAutomationPolicy(
    input.run.automation_policy_json
  );
  if (!parsedPolicy.valid) {
    throw new Error("Fleet automation policy is invalid at worker launch");
  }
  const approvalMode = fleetAgentApprovalMode(parsedPolicy.policy);
  if (approvalMode === "prompt") {
    throw new Error(
      "Fleet worker requires explicit unconfined-agent authorization until strong Fleet isolation is available"
    );
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
      branchName: fleetWorkerFeatureName(input),
      baseBranch: input.task.base_branch ?? "main",
      useWorktree: true,
      requireWorktree: true,
      requireTaskDelivery: true,
      fleetWritableRoots: input.reportContract
        ? [input.reportContract.attemptDirectory]
        : [],
      fleetArtifactPaths: input.reportContract
        ? [input.reportContract.reportPath]
        : [],
      requireStrongIsolation: true,
      fleetOwnershipKey: input.sessionOwnershipKey,
      approvalMode,
      model: input.task.model ?? undefined,
      requireExactModel: true,
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

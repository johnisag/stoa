/**
 * Agent pipelines — declarative multi-provider workflow types.
 *
 * A pipeline is a DAG of steps; each step runs a task on a chosen agent
 * (claude/codex/hermes) and may depend on other steps. The engine
 * (lib/pipeline/engine.ts) is PURE — it validates a spec and drives a run's
 * state machine over injected step outcomes, with NO I/O. The executor
 * (lib/pipeline/executor.ts) is the only part that touches spawnWorker.
 *
 * This mirrors the #134 Insight-layer architecture: a pure core that is
 * exhaustively unit-testable (build a spec/state, assert the decision) with a
 * thin side-effecting shell around it.
 */

import type { AgentType } from "../providers";

/** One node of the workflow DAG. */
export interface PipelineStep {
  /** Unique within the pipeline (referenced by other steps' dependsOn). */
  id: string;
  /** Optional human label; falls back to `id` for display. */
  name?: string;
  /** Which agent runs this step. */
  agent: AgentType;
  /** Optional agent-specific model; omit for the agent's own default. */
  model?: string;
  /** The task/prompt sent to the worker. */
  task: string;
  /**
   * Step ids that must SUCCEED before this step becomes ready. Empty/omitted =
   * a root step (runnable immediately). Steps with no path between them run in
   * parallel; a shared dependency fans out, a shared dependent fans in.
   */
  dependsOn?: string[];
  /**
   * Per-step working directory override (a git repo path). Omit to inherit the
   * pipeline-level workingDirectory.
   */
  workingDirectory?: string;
}

/** A full declarative pipeline spec (the YAML/JSON the user authors). */
export interface PipelineSpec {
  /** Human name for the pipeline run. */
  name: string;
  /** Default git repo path for steps that don't override workingDirectory. */
  workingDirectory: string;
  steps: PipelineStep[];
}

/** Status of a single step within a run. */
export type StepStatus =
  | "pending" // not started; deps not all satisfied yet (or just created)
  | "running" // a worker has been spawned and is in flight
  | "succeeded" // completed successfully
  | "failed" // the worker failed / errored
  | "skipped"; // a (transitive) dependency failed, so this can never run

/** Status of the run as a whole (derived from its steps). */
export type RunStatus =
  | "pending" // created, nothing started yet
  | "running" // at least one step running or still runnable
  | "succeeded" // every step succeeded
  | "failed" // finished with at least one failure and no successes salvageable
  | "partial"; // finished: some steps succeeded, some failed/skipped

/** Live state of one step inside a run. */
export interface StepState {
  id: string;
  status: StepStatus;
  /** Stoa session id of the spawned worker (null until launched). */
  sessionId: string | null;
  /** Epoch ms when the step began running (null until launched). */
  startedAt: number | null;
  /** Epoch ms when the step reached a terminal state (null until then). */
  endedAt: number | null;
  /** Optional human-readable note (e.g. failure reason, skip cause). */
  detail: string | null;
}

/** Live state of a pipeline run — the object the engine reduces over. */
export interface PipelineRun {
  id: string;
  spec: PipelineSpec;
  /** Step id → its live state. */
  steps: Record<string, StepState>;
  status: RunStatus;
  createdAt: number;
  /** Epoch ms when the run reached a terminal status (null until then). */
  endedAt: number | null;
}

/** A single validation problem found in a spec. */
export interface PipelineValidationError {
  /** Step id the problem concerns, or null for a pipeline-level problem. */
  stepId: string | null;
  message: string;
}

/** Result of validating a raw spec. */
export interface PipelineValidationResult {
  valid: boolean;
  errors: PipelineValidationError[];
}

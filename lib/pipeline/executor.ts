/**
 * Agent pipelines — thin executor.
 *
 * Drives a run to completion by asking the PURE engine what's ready, launching
 * those steps, polling their outcomes, and feeding results back. ALL side
 * effects are injected via ExecutorDeps so the orchestration loop itself is
 * unit-testable with zero real workers (fake spawn/checkOutcome/sleep, assert
 * the resulting run). The default deps (defaultExecutorDeps) wire the real
 * spawnWorker seam — the only place this module touches lib/orchestration.
 *
 * Concurrency model: every step the engine reports ready is launched in
 * parallel (the DAG's edges are the only ordering constraint). A step's worker
 * runs until checkOutcome reports a terminal result; a failure cascades skips
 * to dependents (handled in the engine).
 */

import type { PipelineSpec, PipelineStep, PipelineRun } from "./types";
import {
  initRun,
  readySteps,
  applyStepStarted,
  applyStepOutcome,
  applyStepFailedToStart,
  isRunComplete,
  validateSpec,
} from "./engine";

/** A terminal/poll result for a launched step. */
export type StepOutcome = "running" | "succeeded" | "failed";

export interface SpawnResult {
  sessionId: string;
}

/** Injected side effects — real impls in defaultExecutorDeps, fakes in tests. */
export interface ExecutorDeps {
  /** Launch a worker for `step`; resolve with its Stoa session id. */
  spawn: (step: PipelineStep, spec: PipelineSpec) => Promise<SpawnResult>;
  /** Poll a launched step's worker; return running until it's terminal. */
  checkOutcome: (sessionId: string, step: PipelineStep) => Promise<StepOutcome>;
  /** Clock for stamping timings (injected for determinism in tests). */
  now: () => number;
  /** Sleep between poll cycles (injected so tests don't actually wait). */
  sleep: (ms: number) => Promise<void>;
  /** Optional: called with a fresh run snapshot after every state change. */
  onUpdate?: (run: PipelineRun) => void;
}

export interface RunOptions {
  /** Poll interval between outcome checks (ms). Default 3000. */
  pollIntervalMs?: number;
  /** Hard cap on poll cycles to prevent an unbounded loop. Default 4000. */
  maxPollCycles?: number;
  /** Run id to use (so a caller can pre-register the run under a known id). */
  runId?: string;
  /**
   * Skip re-validation when the caller already validated the spec (startPipeline
   * does). Defaults to false — a direct caller still gets the safety check.
   */
  preValidated?: boolean;
  /**
   * Max steps running concurrently. Bounds the real fan-out (each step spawns an
   * agent process + a git worktree), so a wide DAG can't fork-bomb the host.
   * Default 4. Extra ready steps queue until a slot frees.
   */
  maxParallelism?: number;
}

/**
 * Execute a pipeline spec to completion. Validates first (throws on an invalid
 * spec — the caller should validateSpec() and surface errors before calling),
 * unless `preValidated` is set. Returns the final run.
 *
 * Crash-safety: any unexpected throw inside the loop is caught and the run is
 * driven to a terminal `failed` status before rethrowing, so the registry never
 * keeps a permanently-"running" zombie snapshot.
 */
export async function runPipeline(
  spec: PipelineSpec,
  deps: ExecutorDeps,
  options: RunOptions = {}
): Promise<PipelineRun> {
  if (!options.preValidated) {
    const validation = validateSpec(spec);
    if (!validation.valid) {
      throw new Error(formatValidationErrors(validation.errors));
    }
  }

  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const maxPollCycles = options.maxPollCycles ?? 4000;
  const maxParallelism = Math.max(1, options.maxParallelism ?? 4);
  const runId = options.runId ?? fallbackRunId();

  let run = initRun(spec, { id: runId, now: deps.now() });
  const emit = () => deps.onUpdate?.(run);
  emit();

  const stepById = new Map(spec.steps.map((s) => [s.id, s]));
  let cycles = 0;

  try {
    while (!isRunComplete(run)) {
      const inFlight = Object.values(run.steps).filter(
        (s) => s.status === "running"
      ).length;

      // 1. Launch ready steps up to the parallelism cap (extras wait for a slot).
      const slots = maxParallelism - inFlight;
      const ready = slots > 0 ? readySteps(run).slice(0, slots) : [];
      if (ready.length > 0) {
        const launches = await Promise.all(
          ready.map(async (step) => {
            try {
              const { sessionId } = await deps.spawn(step, spec);
              return { step, sessionId, error: null as string | null };
            } catch (e) {
              return {
                step,
                sessionId: null as string | null,
                error: e instanceof Error ? e.message : "spawn failed",
              };
            }
          })
        );
        for (const l of launches) {
          if (l.sessionId) {
            run = applyStepStarted(run, l.step.id, l.sessionId, deps.now());
          } else {
            // Spawn failed: fail the still-pending step directly (no fake
            // session id) so the engine cascades skips to its dependents.
            run = applyStepFailedToStart(
              run,
              l.step.id,
              deps.now(),
              l.error ?? "spawn failed"
            );
          }
        }
        emit();
        continue; // re-evaluate readiness/slots before polling
      }

      // 2. Nothing new to launch — poll the in-flight steps for outcomes.
      const running = Object.values(run.steps).filter(
        (s) => s.status === "running" && s.sessionId
      );
      if (running.length === 0) {
        // No ready steps and nothing in flight, yet the run isn't complete: a
        // stuck state. Force the remaining non-terminal steps to a terminal
        // status so the run can't hang (mirrors the maxPollCycles guard).
        run = forceTerminate(
          run,
          deps.now(),
          "stuck: no runnable or in-flight steps"
        );
        emit();
        break;
      }

      const outcomes = await Promise.all(
        running.map(async (state) => {
          const step = stepById.get(state.id)!;
          try {
            const outcome = await deps.checkOutcome(state.sessionId!, step);
            return { id: state.id, outcome, error: null as string | null };
          } catch (e) {
            return {
              id: state.id,
              outcome: "running" as StepOutcome,
              error: e instanceof Error ? e.message : "poll failed",
            };
          }
        })
      );
      let progressed = false;
      for (const o of outcomes) {
        if (o.outcome === "succeeded" || o.outcome === "failed") {
          run = applyStepOutcome(run, o.id, o.outcome, deps.now());
          progressed = true;
        }
      }
      if (progressed) {
        emit();
        continue;
      }

      // 3. Still waiting — sleep, with a hard cycle cap as a safety net.
      if (++cycles > maxPollCycles) {
        run = forceTerminate(
          run,
          deps.now(),
          "timed out waiting for completion"
        );
        emit();
        break;
      }
      await deps.sleep(pollIntervalMs);
    }
  } catch (err) {
    // Unexpected fault: drive the run to a terminal status so it never lingers
    // as a zombie "running" snapshot, emit it, then rethrow for the bg logger.
    const detail = `pipeline executor error: ${err instanceof Error ? err.message : String(err)}`;
    run = forceTerminate(run, deps.now(), detail);
    emit();
    throw err;
  }

  emit();
  return run;
}

/**
 * Drive every non-terminal step to a terminal status (used by the stuck,
 * timeout, and crash guards). Running steps are failed directly; lingering
 * pending steps are also failed so the run is GUARANTEED terminal afterwards
 * (doesn't rely on the cascade invariant holding).
 */
function forceTerminate(
  run: PipelineRun,
  now: number,
  detail: string
): PipelineRun {
  let next = run;
  for (const state of Object.values(run.steps)) {
    if (state.status === "running") {
      next = applyStepOutcome(next, state.id, "failed", now, detail);
    } else if (state.status === "pending") {
      next = applyStepFailedToStart(next, state.id, now, detail);
    }
  }
  return next;
}

export function formatValidationErrors(
  errors: { stepId: string | null; message: string }[]
): string {
  return `invalid pipeline spec: ${errors
    .map((e) => (e.stepId ? `[${e.stepId}] ${e.message}` : e.message))
    .join("; ")}`;
}

// Only used when a caller doesn't pass a runId; startPipeline always does.
function fallbackRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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
  interpolateTask,
} from "./engine";

/** A terminal/poll result for a launched step. */
export type StepOutcome = "running" | "succeeded" | "failed";

export interface SpawnResult {
  sessionId: string;
  /**
   * Absolute path to the step's git worktree (where its output file lives).
   * Null/undefined when the step ran without a worktree; then no output is read
   * for it and downstream references resolve to "". Populated by the real deps.
   */
  worktreePath?: string | null;
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
  /**
   * Optional: read a SUCCEEDED step's output file from its worktree so the
   * contents can be fed to downstream steps via `{{steps.<id>.output}}`. Called
   * once, right after the step's outcome resolves to `succeeded`. Must be
   * tolerant: a missing/unreadable file resolves to "" (never throws). Omitted
   * in pure-loop tests (then every output is "" and placeholders strip out).
   */
  readOutput?: (
    result: SpawnResult,
    step: PipelineStep
  ) => Promise<string> | string;
  /**
   * Optional: tear down a step's worker once the run is terminal. The pty +
   * agent process are pure leak after the run ends, so this is always called for
   * every launched step; `cleanupWorktree` is true only for steps that did NOT
   * succeed (a succeeded step's worktree holds the work product to inspect/merge).
   * Wired to killWorker in defaultExecutorDeps; omitted in pure-loop tests.
   */
  terminate?: (
    sessionId: string,
    opts: { cleanupWorktree: boolean; succeeded: boolean }
  ) => Promise<void>;
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
  // Step id → its spawn result (carries the worktree path needed to read the
  // output file once the step succeeds).
  const spawnResultById = new Map<string, SpawnResult>();
  // Step id → the contents of its output file, captured on success. A
  // downstream step's `{{steps.<id>.output}}` placeholders resolve against this
  // (a step with no entry / empty file contributes "").
  const outputsById: Record<string, string> = {};
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
            // Resolve `{{steps.<id>.output}}` placeholders against upstream
            // outputs captured so far, RIGHT before spawning. Pure substitution;
            // the resolved task takes the same direct-spawn path as any other
            // task (no shell), so an interpolated upstream output is not a
            // shell-injection vector. Validation already guarantees every ref is
            // an upstream dependency, so its output is present in outputsById.
            const resolvedTask = interpolateTask(step.task, outputsById);
            const launchStep =
              resolvedTask === step.task
                ? step
                : { ...step, task: resolvedTask };
            try {
              const result = await deps.spawn(launchStep, spec);
              return {
                step,
                result,
                sessionId: result.sessionId,
                error: null as string | null,
              };
            } catch (e) {
              return {
                step,
                result: null as SpawnResult | null,
                sessionId: null as string | null,
                error: e instanceof Error ? e.message : "spawn failed",
              };
            }
          })
        );
        for (const l of launches) {
          if (l.sessionId) {
            if (l.result) spawnResultById.set(l.step.id, l.result);
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
          if (o.outcome === "succeeded") {
            // Capture this step's output (its kept worktree's output file) so
            // downstream `{{steps.<id>.output}}` placeholders can resolve to it
            // on the next launch pass. Best-effort: readOutput never throws (a
            // missing/unreadable file → ""); if it's not wired or the worktree
            // is unknown, the output stays "".
            outputsById[o.id] = await readStepOutput(o.id, deps, {
              spawnResultById,
              stepById,
            });
          }
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
    // as a zombie "running" snapshot, emit it, reap workers, then rethrow.
    const detail = `pipeline executor error: ${err instanceof Error ? err.message : String(err)}`;
    run = forceTerminate(run, deps.now(), detail);
    emit();
    await reapWorkers(run, deps);
    throw err;
  }

  emit();
  // Run is terminal — tear down every launched worker (pty/process is pure leak
  // now; worktrees kept only for succeeded steps). Best-effort, never throws.
  await reapWorkers(run, deps);
  return run;
}

/**
 * Read a succeeded step's output via the injected readOutput dep, fully
 * isolated: a missing dep, an unknown spawn result, or any throw resolves to ""
 * so a flaky read can never break the run (the contract is "output is best
 * effort; absence reads as empty"). The downstream interpolation treats "" as a
 * normal value.
 */
async function readStepOutput(
  stepId: string,
  deps: ExecutorDeps,
  state: {
    spawnResultById: Map<string, SpawnResult>;
    stepById: Map<string, PipelineStep>;
  }
): Promise<string> {
  if (!deps.readOutput) return "";
  const result = state.spawnResultById.get(stepId);
  const step = state.stepById.get(stepId);
  if (!result || !step) return "";
  try {
    return (await deps.readOutput(result, step)) ?? "";
  } catch {
    // Swallow: a read fault must not fail the step or the run.
    return "";
  }
}

/**
 * Tear down the workers of a terminal run. Always kills the pty/agent process
 * for every step that launched (had a sessionId); removes the git worktree only
 * for steps that did NOT succeed — a succeeded step's worktree holds the work
 * product the caller will inspect/merge (policy: reap failures, keep successes).
 *
 * Best-effort and fully isolated: a terminate fault for one step is swallowed so
 * it can neither abort the reap of the others nor escape into the run result.
 * A no-op when deps.terminate is not wired (pure-loop tests).
 */
async function reapWorkers(
  run: PipelineRun,
  deps: ExecutorDeps
): Promise<void> {
  if (!deps.terminate) return;
  const terminate = deps.terminate;
  await Promise.all(
    Object.values(run.steps).map(async (state) => {
      if (!state.sessionId) return; // never launched (failed-to-start/skipped)
      const succeeded = state.status === "succeeded";
      try {
        await terminate(state.sessionId, {
          // Keep a succeeded step's worktree (holds the work product); reap the rest.
          cleanupWorktree: !succeeded,
          succeeded,
        });
      } catch {
        // Swallow: a failed teardown must not break the run result or the
        // reaping of sibling steps. (default-deps logs the underlying cause.)
      }
    })
  );
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

/**
 * Agent pipelines — PURE engine.
 *
 * Two responsibilities, both pure (no I/O, deterministic given inputs):
 *   1. validateSpec()  — reject a malformed DAG before anything spawns.
 *   2. the run reducer — initRun / readySteps / applyStepStarted /
 *      applyStepOutcome compute the next state of a run given step outcomes.
 *
 * The executor (lib/pipeline/executor.ts) owns all side effects (spawnWorker,
 * polling). It asks the engine "what's ready?", launches those, feeds outcomes
 * back in. Keeping every decision here makes the whole DAG exhaustively
 * unit-testable with zero mocks (build a spec/run, assert the transition).
 *
 * Mirrors lib/analytics/engine.ts: a pure core over an injected snapshot, with
 * `now` passed in so time-dependent fields stay deterministic in tests.
 */

import { PROVIDER_IDS } from "../providers/registry";
import type {
  PipelineSpec,
  PipelineStep,
  PipelineRun,
  StepState,
  StepStatus,
  RunStatus,
  PipelineValidationResult,
  PipelineValidationError,
} from "./types";

/** Agents that can run a pipeline step (a worker session). `shell` is not one. */
const SPAWNABLE_AGENTS = PROVIDER_IDS.filter((id) => id !== "shell");

/** Terminal step statuses — a step that will never change again. */
const TERMINAL_STEP: ReadonlySet<StepStatus> = new Set<StepStatus>([
  "succeeded",
  "failed",
  "skipped",
]);

export function isTerminalStep(status: StepStatus): boolean {
  return TERMINAL_STEP.has(status);
}

// Shell metacharacters that could break out of an interpolated command on the
// tmux/bash init-script path (the pty path uses argv and is unaffected). This
// is deliberately narrow: command separators, quotes, expansion, and redirects.
// Path-legal characters (\\ for Windows, ~ for home, spaces) are NOT blocked —
// workingDirectory is a path, not a command.
const SHELL_METACHARS = /[;&|`$(){}<>\n\r"']/;

/** True if a string contains a character unsafe to interpolate into a shell. */
export function hasShellMetachars(s: string): boolean {
  return SHELL_METACHARS.test(s);
}

/** A model id is safe if it's only letters, digits, and . _ - / : (provider/model). */
export function isSafeModel(model: string): boolean {
  return /^[A-Za-z0-9._/:-]+$/.test(model);
}

/**
 * Validate a pipeline spec. Returns every problem found (not just the first) so
 * an author can fix them in one pass. Checks: pipeline name + workingDirectory,
 * non-empty steps, unique non-empty ids, a spawnable agent, a non-empty task,
 * dependsOn references that resolve, no self-dependency, and no cycles.
 */
export function validateSpec(spec: PipelineSpec): PipelineValidationResult {
  const errors: PipelineValidationError[] = [];
  const err = (stepId: string | null, message: string) =>
    errors.push({ stepId, message });

  if (!spec || typeof spec !== "object") {
    return {
      valid: false,
      errors: [{ stepId: null, message: "spec is not an object" }],
    };
  }
  if (!spec.name || !spec.name.trim()) {
    err(null, "pipeline name is required");
  }
  if (!spec.workingDirectory || !spec.workingDirectory.trim()) {
    err(null, "pipeline workingDirectory is required");
  }
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    err(null, "pipeline must have at least one step");
    // Without steps the rest of the checks are meaningless.
    return { valid: errors.length === 0, errors };
  }

  // Unique, non-empty ids.
  const ids = new Set<string>();
  const dupes = new Set<string>();
  for (const step of spec.steps) {
    const id = step?.id?.trim();
    if (!id) {
      err(null, "every step must have a non-empty id");
      continue;
    }
    if (ids.has(id)) dupes.add(id);
    ids.add(id);
  }
  for (const id of Array.from(dupes)) err(id, `duplicate step id: ${id}`);

  // Per-step field checks.
  for (const step of spec.steps) {
    const id = step?.id?.trim();
    if (!id) continue; // already reported
    if (!step.task || !step.task.trim()) {
      err(id, `step "${id}" must have a non-empty task`);
    }
    if (
      !SPAWNABLE_AGENTS.includes(
        step.agent as (typeof SPAWNABLE_AGENTS)[number]
      )
    ) {
      err(
        id,
        `step "${id}" has invalid agent "${step.agent}" (expected one of: ${SPAWNABLE_AGENTS.join(", ")})`
      );
    }
    // Defense in depth: `model` and `workingDirectory` flow through spawnWorker
    // into the tmux backend's bash init script, where a free-text agent's model
    // is interpolated into a `-m <model>` shell command. A spec arriving over
    // HTTP/MCP is untrusted, so reject shell metacharacters here rather than
    // relying on every downstream consumer to quote. (The pty backend uses an
    // argv array and is already safe; this guards the POSIX/tmux path.)
    if (step.model != null && !isSafeModel(step.model)) {
      err(
        id,
        `step "${id}" has an invalid model "${step.model}" (allowed: letters, digits, and . _ - / :)`
      );
    }
    if (
      step.workingDirectory != null &&
      hasShellMetachars(step.workingDirectory)
    ) {
      err(
        id,
        `step "${id}" workingDirectory contains illegal shell characters`
      );
    }
    for (const dep of step.dependsOn ?? []) {
      if (dep === id) {
        err(id, `step "${id}" depends on itself`);
      } else if (!ids.has(dep)) {
        err(id, `step "${id}" depends on unknown step "${dep}"`);
      }
    }
  }

  // Pipeline-level workingDirectory flows to the same place — guard it too.
  if (spec.workingDirectory && hasShellMetachars(spec.workingDirectory)) {
    err(null, "pipeline workingDirectory contains illegal shell characters");
  }

  // Cycle detection (DFS colouring) — only when ids/deps are otherwise sane,
  // so we don't chase references that don't exist.
  if (errors.length === 0) {
    const cycle = findCycle(spec.steps);
    if (cycle) {
      err(cycle[0], `dependency cycle detected: ${cycle.join(" -> ")}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Return one cycle as an ordered id list (a -> b -> a), or null if the DAG is
 * acyclic. Standard white/grey/black DFS over the dependency edges.
 */
function findCycle(steps: PipelineStep[]): string[] | null {
  const deps = new Map<string, string[]>();
  for (const s of steps)
    deps.set(
      s.id,
      (s.dependsOn ?? []).filter((d) => d !== s.id)
    );

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const id of Array.from(deps.keys())) colour.set(id, WHITE);
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    colour.set(id, GREY);
    stack.push(id);
    for (const next of deps.get(id) ?? []) {
      if (!deps.has(next)) continue; // unknown dep — reported elsewhere
      const c = colour.get(next);
      if (c === GREY) {
        // Found a back-edge: slice the stack from `next` to here, close the loop.
        const from = stack.indexOf(next);
        return [...stack.slice(from), next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(id, BLACK);
    return null;
  };

  for (const id of Array.from(deps.keys())) {
    if (colour.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Create the initial run state for a (already-validated) spec. All steps start
 * `pending`; the run starts `pending`. `id` and `now` are injected so the
 * caller (and tests) control identity + time.
 */
export function initRun(
  spec: PipelineSpec,
  opts: { id: string; now: number }
): PipelineRun {
  const steps: Record<string, StepState> = {};
  for (const s of spec.steps) {
    steps[s.id] = {
      id: s.id,
      status: "pending",
      sessionId: null,
      startedAt: null,
      endedAt: null,
      detail: null,
    };
  }
  return {
    id: opts.id,
    spec,
    steps,
    status: "pending",
    createdAt: opts.now,
    endedAt: null,
  };
}

/**
 * Steps that are ready to launch NOW: status `pending` and every dependency
 * `succeeded`. Pure read — does not mutate the run.
 */
export function readySteps(run: PipelineRun): PipelineStep[] {
  const ready: PipelineStep[] = [];
  for (const step of run.spec.steps) {
    const state = run.steps[step.id];
    if (!state || state.status !== "pending") continue;
    const deps = step.dependsOn ?? [];
    const allDepsSucceeded = deps.every(
      (d) => run.steps[d]?.status === "succeeded"
    );
    if (allDepsSucceeded) ready.push(step);
  }
  return ready;
}

/**
 * Mark a step as launched (running) with its worker session id. Returns a new
 * run; the run status becomes `running`. No-op (returns input) if the step
 * isn't currently `pending`.
 */
export function applyStepStarted(
  run: PipelineRun,
  stepId: string,
  sessionId: string,
  now: number
): PipelineRun {
  const prev = run.steps[stepId];
  if (!prev || prev.status !== "pending") return run;
  const steps = {
    ...run.steps,
    [stepId]: {
      ...prev,
      status: "running" as StepStatus,
      sessionId,
      startedAt: now,
    },
  };
  return recompute({ ...run, steps }, now);
}

/**
 * Mark a `pending` step as failed because its worker could not be launched
 * (spawn threw). Unlike applyStepOutcome this accepts a step that never ran, so
 * sessionId stays null (no fake id leaks to the API); the cause goes in detail.
 * Cascades skips to dependents. No-op if the step isn't `pending`.
 */
export function applyStepFailedToStart(
  run: PipelineRun,
  stepId: string,
  now: number,
  detail: string
): PipelineRun {
  const prev = run.steps[stepId];
  if (!prev || prev.status !== "pending") return run;
  const steps: Record<string, StepState> = {
    ...run.steps,
    [stepId]: {
      ...prev,
      status: "failed",
      startedAt: now,
      endedAt: now,
      detail,
    },
  };
  cascadeSkip(run.spec, steps, now);
  return recompute({ ...run, steps }, now);
}

/**
 * Apply a terminal outcome for a running step (succeeded | failed). On failure,
 * transitively skip every dependent that can no longer run. Recomputes run
 * status. Returns a new run; no-op if the step isn't `running`.
 */
export function applyStepOutcome(
  run: PipelineRun,
  stepId: string,
  outcome: "succeeded" | "failed",
  now: number,
  detail?: string
): PipelineRun {
  const prev = run.steps[stepId];
  if (!prev || prev.status !== "running") return run;

  const steps: Record<string, StepState> = {
    ...run.steps,
    [stepId]: {
      ...prev,
      status: outcome,
      // Clamp so endedAt is never before startedAt even if `now` (wall clock)
      // steps backwards between the launch and this poll.
      endedAt: Math.max(now, prev.startedAt ?? now),
      detail: detail ?? prev.detail,
    },
  };

  if (outcome === "failed") {
    cascadeSkip(run.spec, steps, now);
  }

  return recompute({ ...run, steps }, now);
}

/**
 * Mutates `steps` in place: any non-terminal step with a failed-or-skipped
 * (transitive) dependency becomes `skipped` — it can never satisfy its deps.
 * Iterates to a fixpoint so a skip cascades down a chain.
 */
function cascadeSkip(
  spec: PipelineSpec,
  steps: Record<string, StepState>,
  now: number
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of spec.steps) {
      const state = steps[step.id];
      if (
        !state ||
        isTerminalStep(state.status) ||
        state.status === "running"
      ) {
        continue;
      }
      const blocked = (step.dependsOn ?? []).some((d) => {
        const ds = steps[d]?.status;
        return ds === "failed" || ds === "skipped";
      });
      if (blocked) {
        steps[step.id] = {
          ...state,
          status: "skipped",
          endedAt: now,
          detail: state.detail ?? "skipped: a dependency did not succeed",
        };
        changed = true;
      }
    }
  }
}

/** Derive run status from step states and stamp endedAt on first terminal. */
function recompute(run: PipelineRun, now: number): PipelineRun {
  const status = deriveRunStatus(run.steps);
  const terminal =
    status === "succeeded" || status === "failed" || status === "partial";
  return {
    ...run,
    status,
    endedAt: terminal ? (run.endedAt ?? now) : null,
  };
}

/**
 * Run status from the multiset of step statuses:
 *  - any pending/running         -> running (or pending if nothing started yet)
 *  - all succeeded               -> succeeded
 *  - all terminal, none succeeded-> failed
 *  - all terminal, mixed         -> partial
 */
export function deriveRunStatus(steps: Record<string, StepState>): RunStatus {
  const values = Object.values(steps);
  if (values.length === 0) return "pending";

  const anyRunning = values.some((s) => s.status === "running");
  const anyPending = values.some((s) => s.status === "pending");
  if (anyRunning || anyPending) {
    // Nothing has started at all -> still pending; otherwise actively running.
    const anyStarted = values.some(
      (s) => s.status !== "pending" || s.startedAt !== null
    );
    return anyStarted ? "running" : "pending";
  }

  // All terminal now.
  const succeeded = values.filter((s) => s.status === "succeeded").length;
  if (succeeded === values.length) return "succeeded";
  if (succeeded === 0) return "failed";
  return "partial";
}

/** True once the run can no longer change (every step terminal). */
export function isRunComplete(run: PipelineRun): boolean {
  return Object.values(run.steps).every((s) => isTerminalStep(s.status));
}

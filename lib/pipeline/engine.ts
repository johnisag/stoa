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
import { isSafeModel } from "../model-catalog";
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

/**
 * Default file a step writes to expose its OUTPUT to downstream steps (relative
 * to the step's worktree). A step overrides it via `step.outputFile`. After the
 * step succeeds the executor reads this file from the kept worktree and stores
 * its contents keyed by step id; a downstream step pulls it in via a
 * `{{steps.<id>.output}}` placeholder (see interpolateTask).
 */
export const STOA_DEFAULT_OUTPUT_FILE = "STOA_OUTPUT.md";

/**
 * Matches an output placeholder `{{steps.<id>.output}}` in a step's task.
 * Whitespace inside the braces is tolerated (`{{ steps.foo.output }}`). The id
 * is captured; it shares the id space of step ids / dependsOn — letters,
 * digits, and the separators an id may contain (`._-`). Global so a task can
 * reference several upstream outputs (and the same one repeatedly).
 */
const OUTPUT_REF = /\{\{\s*steps\.([A-Za-z0-9._-]+)\.output\s*\}\}/g;

/**
 * Extract the set of upstream step ids referenced by `{{steps.<id>.output}}`
 * placeholders in a task string. Pure; order-preserving with duplicates
 * removed. Used by validateSpec (to reject references outside the dependency
 * closure) and shares its matcher with interpolateTask.
 */
export function extractOutputRefs(task: string): string[] {
  // matchAll operates on a copy of the global regex (it doesn't carry lastIndex),
  // so OUTPUT_REF is safe to share; Set preserves first-seen order.
  const ids = [...task.matchAll(OUTPUT_REF)].map((m) => m[1]);
  return [...new Set(ids)];
}

/**
 * Resolve `{{steps.<id>.output}}` placeholders in `task` against a map of
 * upstream outputs. PURE — no I/O; the file read that produces `outputsById`
 * lives in the executor. A referenced id present in the map is replaced with
 * its (possibly empty) output; an id ABSENT from the map is replaced with the
 * empty string (an upstream step that produced no output reads as ""). A task
 * with no placeholders is returned unchanged.
 */
export function interpolateTask(
  task: string,
  outputsById: Record<string, string>
): string {
  return task.replace(OUTPUT_REF, (_full, id: string) => outputsById[id] ?? "");
}

/**
 * The set of step ids transitively reachable through `start`'s dependsOn edges
 * (its upstream closure), excluding `start` itself. These are the ONLY steps
 * whose output `start` may reference. Pure graph walk over the spec's edges;
 * unknown deps are ignored here (reported separately by validateSpec).
 */
function upstreamClosure(
  start: string,
  depsById: Map<string, string[]>
): Set<string> {
  const reachable = new Set<string>();
  const stack = [...(depsById.get(start) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const dep of depsById.get(id) ?? []) stack.push(dep);
  }
  return reachable;
}

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

/**
 * True if `outputFile` is a safe worktree-relative path: non-empty, not
 * absolute or drive-qualified (POSIX `/...`, Windows `C:\...` / `C:/...`, or the
 * drive-relative `C:foo`), and with no `..` traversal segment. The executor
 * joins it onto the worktree root and reads it, so an untrusted spec must not be
 * able to escape the worktree (e.g. `../../etc/passwd`). Forward and back slashes
 * are both treated as separators so the check holds on every OS.
 */
export function isSafeOutputFile(file: string): boolean {
  if (!file || !file.trim()) return false;
  // Reject anything starting with a Windows drive prefix (`C:` — incl. the
  // drive-relative `C:foo`) or a leading separator (`\` or `/`). A drive letter
  // is never legitimate in a worktree-relative file.
  if (/^([A-Za-z]:|[\\/])/.test(file)) return false;
  // No `..` segment in either separator style.
  const segments = file.split(/[\\/]/);
  return !segments.includes("..");
}

// `isSafeModel` now lives in lib/model-catalog.ts (the canonical model home, also
// used by the project write-boundary guard). Re-exported so this module's existing
// importers/tests keep their path.
export { isSafeModel };

/**
 * Parse + validate a hand-authored pipeline spec (the custom-spec editor). Returns
 * the spec ONLY when the JSON parses AND validateSpec passes; otherwise a list of
 * problems (a JSON syntax error, or each validation error). Pure — reused by the
 * editor for instant feedback and safe to import client-side (no I/O).
 */
export function parsePipelineSpec(text: string): {
  spec: PipelineSpec | null;
  errors: PipelineValidationError[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      spec: null,
      errors: [
        {
          stepId: null,
          message: `Invalid JSON: ${e instanceof Error ? e.message : "parse error"}`,
        },
      ],
    };
  }
  const result = validateSpec(parsed as PipelineSpec);
  return {
    spec: result.valid ? (parsed as PipelineSpec) : null,
    errors: result.errors,
  };
}

/**
 * Validate a pipeline spec. Returns every problem found (not just the first) so
 * an author can fix them in one pass. Checks: pipeline name + workingDirectory,
 * non-empty steps, unique non-empty ids, a spawnable agent, a non-empty task,
 * dependsOn references that resolve, no self-dependency, and no cycles.
 */
/**
 * `dependsOn` as a clean string[] regardless of a malformed (non-array, or array
 * with non-string entries) value — keeps validateSpec/findCycle TOTAL on hostile
 * input. validateSpec runs on arbitrary parsed JSON (the Custom editor, a stored
 * doc), so a non-array dependsOn must surface as an error, not throw `.map`/`for…of`.
 */
function safeDependsOn(step: { dependsOn?: unknown }): string[] {
  return Array.isArray(step?.dependsOn)
    ? step.dependsOn.filter((d): d is string => typeof d === "string")
    : [];
}

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
  // typeof guards keep validateSpec TOTAL on arbitrary parsed JSON (the Custom
  // editor / an imported file) — a non-string name/workingDirectory must surface
  // as an error, not throw `.trim()`.
  if (typeof spec.name !== "string" || !spec.name.trim()) {
    err(null, "pipeline name is required");
  }
  if (
    typeof spec.workingDirectory !== "string" ||
    !spec.workingDirectory.trim()
  ) {
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
    const rawId = step?.id;
    const id = rawId?.trim();
    if (!id) {
      err(null, "every step must have a non-empty id");
      continue;
    }
    // Leading/trailing whitespace in a raw id passes the empty check but breaks
    // dependsOn/output-ref lookup (those compare against the trimmed id).
    if (typeof rawId === "string" && rawId !== id) {
      err(
        id,
        `step id "${rawId}" must not have leading or trailing whitespace`
      );
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
    // outputFile is joined onto the worktree root and READ by the executor, so
    // an untrusted spec must not be able to escape the worktree. Reject absolute
    // paths and `..` traversal here (the read itself is also best-effort).
    if (step.outputFile != null && !isSafeOutputFile(step.outputFile)) {
      err(
        id,
        `step "${id}" has an invalid outputFile "${step.outputFile}" (must be a worktree-relative path with no ".." or absolute prefix)`
      );
    }
    // worktreePolicy is a small enum; exitCriteria is free prompt text (like
    // `task`, it reaches the worker via the direct-spawn argv path, so it gets no
    // shell-metachar guard — only `model`/`workingDirectory`, which hit the tmux
    // bash init script, need one).
    if (
      step.worktreePolicy != null &&
      step.worktreePolicy !== "new" &&
      step.worktreePolicy !== "shared"
    ) {
      err(
        id,
        `step "${id}" has an invalid worktreePolicy "${step.worktreePolicy}" (expected "new" or "shared")`
      );
    }
    if (
      (step as { dependsOn?: unknown }).dependsOn != null &&
      (!Array.isArray(step.dependsOn) ||
        step.dependsOn.some((d) => typeof d !== "string"))
    ) {
      err(
        id,
        `step "${id}" has an invalid dependsOn (expected an array of step ids)`
      );
    }
    for (const dep of safeDependsOn(step)) {
      if (dep === id) {
        err(id, `step "${id}" depends on itself`);
      } else if (!ids.has(dep)) {
        err(id, `step "${id}" depends on unknown step "${dep}"`);
      }
    }
  }

  // Output-reference checks: a `{{steps.<id>.output}}` placeholder in a step's
  // task may ONLY reference a step in that step's transitive dependency closure.
  // Referencing an unknown step, the step itself, or a non-dependency is a hard
  // error so a bad template fails at validation, not mid-run. The closure walk
  // is cycle-safe (visited set), so this is safe even before cycle detection.
  const depsById = new Map<string, string[]>();
  for (const step of spec.steps) {
    const id = step?.id?.trim();
    if (id)
      depsById.set(
        id,
        safeDependsOn(step).map((d) => d.trim())
      );
  }
  for (const step of spec.steps) {
    const id = step?.id?.trim();
    if (!id || !step.task) continue;
    const refs = extractOutputRefs(step.task);
    if (refs.length === 0) continue;
    const closure = upstreamClosure(id, depsById);
    for (const ref of refs) {
      if (ref === id) {
        err(
          id,
          `step "${id}" references its own output {{steps.${id}.output}}`
        );
      } else if (!ids.has(ref)) {
        err(
          id,
          `step "${id}" references output of unknown step "${ref}" ({{steps.${ref}.output}})`
        );
      } else if (!closure.has(ref)) {
        err(
          id,
          `step "${id}" references output of "${ref}" but does not depend on it (add "${ref}" to dependsOn, directly or transitively)`
        );
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
      safeDependsOn(s).filter((d) => d !== s.id)
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

/**
 * Command Stoa — sequential plan executor.
 *
 * Executes a confirmed plan step-by-step, collecting a StepResult for each.
 * Defense-in-depth: re-validates every step before executing (client is never
 * trusted). Stop-on-first-failure: if a step fails the executor halts and
 * returns the collected results so far (remaining steps are skipped). This
 * matches the confirmed-intent model — the user approved the plan as a unit,
 * not as a best-effort bag of independent operations; proceeding past a
 * failure would leave the system in a partial state that is harder to reason
 * about than a clean abort.
 *
 * Uses the same per-action executors as the single-action execute route
 * (executeCreateSession, executeDispatchIssue) — no new spawn paths.
 */

import { getProject } from "@/lib/projects";
import { getDb, queries } from "@/lib/db";
import { validatePlan } from "./actions";
import { executeCreateSession } from "./create-session";
import { executeDispatchIssue } from "./dispatch-issue";
import { auditCommand } from "./audit";
import type { PlanStep, CreateSessionParams, DispatchIssueParams, StepResult } from "./actions";
import type { DispatchRepo } from "@/lib/dispatch/types";

// Re-export so existing imports of StepResult from this module continue to work.
export type { StepResult } from "./actions";

/** Cap for error messages surfaced into StepResult.summary — prevents internal
 * stack traces or file paths from leaking into the UI when an unexpected
 * exception propagates from a deep DB call. */
const ERROR_SUMMARY_MAX = 200;

/**
 * Execute a validated array of plan steps sequentially, collecting one StepResult
 * per step. Stops on the first failure: remaining steps are skipped and the
 * collected results so far (including the failed step) are returned.
 *
 * The caller is responsible for re-validating the plan shape before calling this
 * (see executePlan below, which does the full re-validate).
 */
async function executeSteps(steps: PlanStep[]): Promise<StepResult[]> {
  const results: StepResult[] = [];

  for (const step of steps) {
    let result: StepResult;

    try {
      if (step.action === "create_session") {
        const params = step.params as CreateSessionParams;
        const project = getProject(params.projectId);
        if (!project) {
          result = {
            stepId: step.stepId,
            ok: false,
            summary: `project "${params.projectId}" not found`,
            error: "unknown project",
          };
          auditCommand("command_rejected", {
            stage: "execute_plan_step",
            stepId: step.stepId,
            reason: "unknown project",
          });
        } else {
          const created = executeCreateSession(params, {
            id: project.id,
            working_directory: project.working_directory,
            default_model: project.default_model,
          });
          auditCommand("command_executed", {
            action: "create_session",
            stepId: step.stepId,
            sessionId: created.id,
            project: { id: project.id, name: project.name },
          });
          result = {
            stepId: step.stepId,
            ok: true,
            summary: `Session "${created.name}" created in ${project.name}`,
            sessionId: created.id,
          };
          // Carry initialPrompt in result so the client can deliver it.
          if (created.initialPrompt) {
            (result as StepResult & { initialPrompt: string }).initialPrompt =
              created.initialPrompt;
          }
        }
      } else {
        // dispatch_issue
        const params = step.params as DispatchIssueParams;
        const db = getDb();
        const repo = queries.getDispatchRepo(db).get(params.repoId) as
          | DispatchRepo
          | undefined;
        if (!repo) {
          result = {
            stepId: step.stepId,
            ok: false,
            summary: `dispatch repo "${params.repoId}" not found`,
            error: "unknown dispatch repo",
          };
          auditCommand("command_rejected", {
            stage: "execute_plan_step",
            stepId: step.stepId,
            reason: "unknown dispatch repo",
          });
        } else {
          const created = executeDispatchIssue(params, {
            id: repo.id,
            repo_slug: repo.repo_slug,
          });
          auditCommand("command_executed", {
            action: "dispatch_issue",
            stepId: step.stepId,
            dispatchId: created.dispatchId,
            repoSlug: created.repoSlug,
          });
          result = {
            stepId: step.stepId,
            ok: true,
            summary: `Task "${created.title.slice(0, 60)}${created.title.length > 60 ? "..." : ""}" created in ${created.repoSlug}`,
            dispatchId: created.dispatchId,
          };
        }
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : "unknown error";
      // Cap the message to avoid leaking internal stack traces or file paths
      // into the UI (StepResult.summary is rendered in PlanCard).
      const message = raw.slice(0, ERROR_SUMMARY_MAX);
      auditCommand("command_failed", {
        stage: "execute_plan_step",
        stepId: step.stepId,
        action: step.action,
        error: message,
      });
      result = {
        stepId: step.stepId,
        ok: false,
        summary: `step failed: ${message}`,
        error: message,
      };
    }

    results.push(result);

    // Stop-on-first-failure: halt here so subsequent steps don't run against
    // a partial system state. The caller receives all results collected so far.
    if (!result.ok) break;
  }

  return results;
}

/**
 * Entry point: re-validates the raw plan body (defense-in-depth — the client is
 * never trusted), then executes the steps sequentially.
 *
 * Returns { ok: true, results } when execution completes (which may be partial
 * — stop-on-first-failure means some steps may be skipped if an earlier step
 * fails). Returns { ok: false, reason } only when the plan itself fails
 * validation (before any steps run).
 */
export async function executePlan(
  rawBody: unknown
): Promise<
  | { ok: true; results: StepResult[] }
  | { ok: false; reason: string }
> {
  // Extract the steps from the raw body sent by the client.
  const bodyObj =
    rawBody && typeof rawBody === "object"
      ? (rawBody as Record<string, unknown>)
      : {};

  // Re-validate the full plan object.
  const planObj = {
    kind: "plan",
    name: bodyObj.name,
    steps: bodyObj.steps,
  };
  const validation = validatePlan(planObj);
  if (!validation.ok) {
    auditCommand("command_rejected", {
      stage: "execute_plan",
      reason: validation.reason,
    });
    return { ok: false, reason: validation.reason };
  }

  const results = await executeSteps(validation.steps);
  return { ok: true, results };
}

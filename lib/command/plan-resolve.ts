/**
 * Command Stoa — plan step project/repo resolution.
 *
 * For each step in a validated plan, resolves the referenced project (for
 * create_session steps) or dispatch repo (for dispatch_issue steps) from the DB.
 * Extracted from the propose route so it can be unit-tested independently without
 * standing up a Next.js route handler.
 *
 * Never trusts agent-supplied paths — the working directory always comes from the
 * server-side DB lookup, never the params themselves.
 */

import { getProject } from "@/lib/projects";
import { getDb, queries } from "@/lib/db";
import type { PlanStep, CreateSessionParams, DispatchIssueParams } from "./actions";

export interface ResolvedPlanSteps {
  ok: true;
  steps: PlanStep[];
  /** Map of projectId → resolved project name (for display in the plan card). */
  projectNames: Record<string, string>;
}

export interface PlanResolutionError {
  ok: false;
  reason: string;
}

export type PlanResolution = ResolvedPlanSteps | PlanResolutionError;

/**
 * Resolve the project/repo references in each plan step. For create_session steps,
 * looks up the project by id; for dispatch_issue steps, looks up the repo by id.
 * Any unknown id → { ok: false, reason }.
 *
 * The steps array is returned unchanged (params pass through — the executor
 * re-validates everything at run time). We collect project names here so the client
 * plan card can display them without another round-trip.
 */
export function resolveStepProjects(steps: PlanStep[]): PlanResolution {
  const db = getDb();
  const projectNames: Record<string, string> = {};

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (step.action === "create_session") {
      const params = step.params as CreateSessionParams;
      const project = getProject(params.projectId);
      if (!project) {
        return {
          ok: false,
          reason: `step ${i + 1} (${step.stepId}) references an unknown project "${params.projectId}"`,
        };
      }
      projectNames[params.projectId] = project.name;
    } else if (step.action === "dispatch_issue") {
      const params = step.params as DispatchIssueParams;
      const repo = queries.getDispatchRepo(db).get(params.repoId) as
        | { id: string; repo_slug: string }
        | undefined;
      if (!repo) {
        return {
          ok: false,
          reason: `step ${i + 1} (${step.stepId}) references an unknown dispatch repo "${params.repoId}"`,
        };
      }
      // Store the slug under the repoId for plan card display.
      projectNames[params.repoId] = repo.repo_slug;
    }
  }

  return { ok: true, steps, projectNames };
}

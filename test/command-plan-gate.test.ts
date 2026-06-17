/**
 * Command Stoa plan-gate integration tests.
 *
 * Tests for resolveStepProjects and executePlan using a real in-memory SQLite DB
 * (same pattern as command-execute.test.ts). No backend is spawned, no LLM is
 * called. Verifies:
 *   - resolveStepProjects resolves create_session and dispatch_issue steps correctly
 *   - executePlan re-validates steps (defense-in-depth), runs steps sequentially
 *     with stop-on-first-failure semantics, and writes audit rows.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

// Hoist the in-memory DB state so the mock closure captures it.
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});

// projects.ts uses the module-level `db` singleton — redirect it too.
vi.mock("@/lib/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects")>();
  return {
    ...actual,
    getProject: (id: string) => {
      const db = state.db as InstanceType<typeof Database>;
      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) return undefined;
      return {
        id: row.id as string,
        name: row.name as string,
        working_directory: row.working_directory as string,
        default_model: row.default_model as string | null,
        agent_type: row.agent_type as string,
      };
    },
    getAllProjects: () => {
      const db = state.db as InstanceType<typeof Database>;
      return db.prepare("SELECT * FROM projects").all() as Array<
        Record<string, unknown>
      >;
    },
  };
});

import { queries } from "@/lib/db";
import type { Session, SessionEvent } from "@/lib/db/types";
import { resolveStepProjects } from "@/lib/command/plan-resolve";
import { executePlan } from "@/lib/command/execute-plan";
import { COMMAND_AUDIT_KEY } from "@/lib/command/audit";
import type { PlanStep } from "@/lib/command/actions";

function db() {
  return state.db as InstanceType<typeof Database>;
}

const PROJECT = {
  id: "proj_test",
  name: "the-grid",
  working_directory: "~/work/the-grid",
  default_model: "sonnet" as string | null,
};

const REPO = {
  id: "repo_test",
  repo_slug: "owner/test-repo",
  repo_path: "~/repos/test-repo",
};

beforeAll(() => {
  const memory = new Database(":memory:");
  createSchema(memory);
  runMigrations(memory);
  state.db = memory;
});

beforeEach(() => {
  db().exec(
    "DELETE FROM sessions; DELETE FROM session_events; DELETE FROM projects; DELETE FROM dispatch_repos; DELETE FROM issue_dispatches;"
  );
  queries
    .createProject(db())
    .run(
      PROJECT.id,
      PROJECT.name,
      PROJECT.working_directory,
      "claude",
      PROJECT.default_model,
      null,
      1
    );
  queries
    .createDispatchRepo(db())
    .run(
      REPO.id,
      REPO.repo_path,
      REPO.repo_slug,
      "claude",
      5,
      2,
      null,
      "main",
      "auto",
      1,
      0,
      0,
      0,
      0,
      null,
      null
    );
});

afterEach(() => {
  delete process.env.STOA_AUDIT;
});

// ─── resolveStepProjects ──────────────────────────────────────────────────────

describe("resolveStepProjects", () => {
  it("returns resolved project names for all create_session steps", () => {
    const steps: PlanStep[] = [
      {
        stepId: "step-1",
        description: "Research",
        action: "create_session",
        params: { projectId: PROJECT.id, agentType: "claude" },
      },
      {
        stepId: "step-2",
        description: "Implement",
        action: "create_session",
        params: { projectId: PROJECT.id, agentType: "codex" },
      },
    ];
    const res = resolveStepProjects(steps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projectNames[PROJECT.id]).toBe(PROJECT.name);
    expect(res.steps).toHaveLength(2);
  });

  it("returns error when a projectId is not in the DB", () => {
    const steps: PlanStep[] = [
      {
        stepId: "step-1",
        description: "Research",
        action: "create_session",
        params: { projectId: "nonexistent_project", agentType: "claude" },
      },
      {
        stepId: "step-2",
        description: "Implement",
        action: "create_session",
        params: { projectId: PROJECT.id, agentType: "claude" },
      },
    ];
    const res = resolveStepProjects(steps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/unknown project/i);
  });

  it("returns resolved repo slugs for dispatch_issue steps", () => {
    const steps: PlanStep[] = [
      {
        stepId: "step-1",
        description: "Research",
        action: "create_session",
        params: { projectId: PROJECT.id, agentType: "claude" },
      },
      {
        stepId: "step-2",
        description: "Create task",
        action: "dispatch_issue",
        params: { repoId: REPO.id, title: "Follow-up task" },
      },
    ];
    const res = resolveStepProjects(steps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projectNames[REPO.id]).toBe(REPO.repo_slug);
  });

  it("returns error when a repoId is not in the DB", () => {
    const steps: PlanStep[] = [
      {
        stepId: "step-1",
        description: "Research",
        action: "create_session",
        params: { projectId: PROJECT.id, agentType: "claude" },
      },
      {
        stepId: "step-2",
        description: "Dispatch",
        action: "dispatch_issue",
        params: { repoId: "nonexistent_repo", title: "Task" },
      },
    ];
    const res = resolveStepProjects(steps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/unknown dispatch repo/i);
  });

  it("handles mixed create_session + dispatch_issue steps", () => {
    const steps: PlanStep[] = [
      {
        stepId: "step-1",
        description: "Session step",
        action: "create_session",
        params: { projectId: PROJECT.id, agentType: "claude" },
      },
      {
        stepId: "step-2",
        description: "Dispatch step",
        action: "dispatch_issue",
        params: { repoId: REPO.id, title: "Task title" },
      },
    ];
    const res = resolveStepProjects(steps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projectNames[PROJECT.id]).toBe(PROJECT.name);
    expect(res.projectNames[REPO.id]).toBe(REPO.repo_slug);
  });
});

// ─── executePlan ──────────────────────────────────────────────────────────────

describe("executePlan", () => {
  function makePlanBody(overrides: Record<string, unknown> = {}) {
    return {
      kind: "plan",
      name: "Research and implement",
      steps: [
        {
          stepId: "step-1",
          description: "Research",
          action: "create_session",
          params: { projectId: PROJECT.id, agentType: "claude" },
        },
        {
          stepId: "step-2",
          description: "Implement",
          action: "create_session",
          params: { projectId: PROJECT.id, agentType: "codex" },
        },
      ],
      ...overrides,
    };
  }

  it("executes all steps and returns StepResult[] in order", async () => {
    const result = await executePlan(makePlanBody());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toHaveLength(2);
    expect(result.results[0].stepId).toBe("step-1");
    expect(result.results[1].stepId).toBe("step-2");
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(true);
  });

  it("stops after the first failed step (stop-on-first-failure)", async () => {
    const result = await executePlan(
      makePlanBody({
        steps: [
          {
            stepId: "step-1",
            description: "Bad project",
            action: "create_session",
            params: { projectId: "nonexistent_proj", agentType: "claude" },
          },
          {
            stepId: "step-2",
            description: "Good step (should be skipped)",
            action: "create_session",
            params: { projectId: PROJECT.id, agentType: "claude" },
          },
        ],
      })
    );
    // The outer plan execution returns ok:true (validation passed); the inner
    // step result carries the failure and subsequent steps are not run.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the failed step is in results — step-2 was skipped.
    expect(result.results).toHaveLength(1);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toMatch(/unknown project/i);
    // No session should have been created (step-2 never ran).
    const all = queries.getAllSessions(db()).all() as Session[];
    expect(all).toHaveLength(0);
  });

  it("re-validates each step before executing (rejects a tampered action)", async () => {
    const result = await executePlan(
      makePlanBody({
        steps: [
          {
            stepId: "step-1",
            description: "Looks innocent",
            action: "open_view", // not allowed in a plan
            params: { view: "analytics" },
          },
          {
            stepId: "step-2",
            description: "Normal step",
            action: "create_session",
            params: { projectId: PROJECT.id, agentType: "claude" },
          },
        ],
      })
    );
    // The tampered action causes the full plan to fail validation before any
    // steps run (defense-in-depth — validatePlan rejects the plan body).
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unsupported action/i);
  });

  it("returns sessionId on successful create_session steps", async () => {
    const result = await executePlan(makePlanBody());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const stepResult of result.results) {
      expect(stepResult.sessionId).toBeDefined();
      expect(stepResult.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    }
  });

  it("returns dispatchId on successful dispatch_issue steps", async () => {
    const result = await executePlan(
      makePlanBody({
        steps: [
          {
            stepId: "step-1",
            description: "Research",
            action: "create_session",
            params: { projectId: PROJECT.id, agentType: "claude" },
          },
          {
            stepId: "step-2",
            description: "Create task",
            action: "dispatch_issue",
            params: { repoId: REPO.id, title: "Follow-up task" },
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[1].ok).toBe(true);
    expect(result.results[1].dispatchId).toBeDefined();
    expect(result.results[1].dispatchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("does not set auto_approve on created sessions", async () => {
    const result = await executePlan(makePlanBody());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const stepResult of result.results) {
      if (stepResult.sessionId) {
        const row = queries.getSession(db()).get(stepResult.sessionId) as Session;
        expect(row.auto_approve).toBe(0);
      }
    }
  });

  it("writes an audit row per step (action='command_executed')", async () => {
    const result = await executePlan(makePlanBody());
    expect(result.ok).toBe(true);
    const events = queries
      .getSessionEvents(db())
      .all(COMMAND_AUDIT_KEY) as SessionEvent[];
    const executedEvents = events.filter(
      (e) => e.event_type === "command_executed"
    );
    // One event per successfully executed step.
    expect(executedEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("returns { ok: false } when the plan body itself fails validation", async () => {
    // Only 1 step — below the minimum of 2.
    const result = await executePlan(
      makePlanBody({
        steps: [
          {
            stepId: "step-1",
            description: "Only step",
            action: "create_session",
            params: { projectId: PROJECT.id, agentType: "claude" },
          },
        ],
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/at least 2/i);
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getDb: () => state.db,
    get db() {
      return state.db;
    },
  };
});

vi.mock("@/lib/git-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git-status")>();
  return {
    ...actual,
    getDefaultBranch: () => "main",
    isGitRepo: () => true,
  };
});

import { queries } from "@/lib/db";
import { createFleetRunFromSource } from "@/lib/fleet/source-service";

function db() {
  return state.db as InstanceType<typeof Database>;
}

beforeAll(() => {
  const memory = new Database(":memory:");
  createSchema(memory);
  runMigrations(memory);
  state.db = memory;
});

beforeEach(() => {
  db().exec(`
    DELETE FROM fleet_events;
    DELETE FROM fleet_artifacts;
    DELETE FROM fleet_workers;
    DELETE FROM fleet_tasks;
    DELETE FROM fleet_runs;
    DELETE FROM dispatch_repos;
    DELETE FROM projects WHERE id <> 'uncategorized';
  `);
  queries
    .createProject(db())
    .run(
      "proj-source",
      "Source project",
      "C:\\repo",
      "codex",
      "gpt-5.5",
      null,
      1
    );
  queries
    .createDispatchRepo(db())
    .run(
      "repo-source",
      "C:\\repo",
      "owner/repo",
      "codex",
      10,
      4,
      null,
      "main",
      "review",
      1,
      1,
      0,
      0,
      1,
      "npm test",
      "proj-source"
    );
});

describe("createFleetRunFromSource", () => {
  it("atomically creates a durable plan with its dependency graph", () => {
    const result = createFleetRunFromSource({
      source: {
        kind: "text",
        name: "Imported project spec",
        text: [
          "- Design API [files: lib/api.ts]",
          "  - Test API [files: test/api.test.ts]",
        ].join("\n"),
        claimMode: "write",
        repoId: "repo-source",
        sourceId: "epic-42",
        provider: "codex",
      },
      options: {
        reviewPolicy: "four_agent",
        automationPolicy: {
          automaticPlanning: true,
        },
      },
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.run.run).toMatchObject({
      name: "Imported project spec",
      repoId: "repo-source",
      approvalState: "needs_approval",
      desiredState: "planned",
      sourceKind: "text",
      sourceId: "epic-42",
      sourceName: "Imported project spec",
    });
    expect(result.run.tasks.map((task) => task.title)).toEqual([
      "Design API",
      "Test API",
    ]);
    expect(result.run.tasks[1].dependsOnTaskIds).toEqual([
      result.run.tasks[0].id,
    ]);
    expect(result.run.tasks[0]).toMatchObject({
      workingDirectory: "C:\\repo",
      baseBranch: "main",
      sourceRef: "text:1",
      sourceStepId: "design-api",
      sourceIssueId: null,
      sourceIssueNumber: null,
    });
    expect(
      result.run.events.some((event) => event.eventType === "source_imported")
    ).toBe(true);
  });

  it("rolls back the new draft when its repository target is invalid", () => {
    const result = createFleetRunFromSource({
      source: {
        kind: "text",
        text: "- Implement feature [files: lib/feature.ts]",
        claimMode: "write",
        repoId: "missing-repo",
      },
    });

    expect(result).toMatchObject({ error: "unknown repoId" });
    expect(
      (
        db().prepare("SELECT COUNT(*) AS n FROM fleet_runs").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
  });

  it("rejects an ambiguous repository/project target before creating rows", () => {
    const result = createFleetRunFromSource({
      source: {
        kind: "text",
        text: "- Inspect",
        claimMode: "read",
        repoId: "repo-source",
      },
      options: { projectId: "proj-source" },
    });

    expect(result).toMatchObject({
      error: "select either a repository or a project, not both",
    });
    expect(
      (
        db().prepare("SELECT COUNT(*) AS n FROM fleet_runs").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
  });

  it.each([
    [
      "Pipeline",
      {
        kind: "pipeline",
        spec: {
          name: "Unbound pipeline",
          workingDirectory: "C:\\repo",
          steps: [{ id: "build", agent: "codex", task: "Build it" }],
        },
      },
    ],
    [
      "Builder",
      {
        kind: "builder",
        workflow: {
          name: "Unbound builder",
          workingDirectory: "C:\\repo",
          projectId: null,
          worktreePath: null,
          nodes: [
            {
              step: { id: "build", agent: "codex", task: "Build it" },
              x: 0,
              y: 0,
            },
          ],
          notes: [],
        },
      },
    ],
    [
      "Dispatch",
      {
        kind: "dispatch_planner",
        tasks: [{ title: "Build it", body: "Implement", claims: ["lib/"] }],
      },
    ],
  ])(
    "rejects an executable %s import without a registered target",
    (_name, source) => {
      const result = createFleetRunFromSource({ source });

      expect(result).toMatchObject({
        error: "a registered repository or project target is required",
      });
      expect(
        (
          db().prepare("SELECT COUNT(*) AS n FROM fleet_runs").get() as {
            n: number;
          }
        ).n
      ).toBe(0);
    }
  );

  it("rejects an arbitrary source working directory for a registered repo", () => {
    const result = createFleetRunFromSource({
      source: {
        kind: "text",
        text: "- Implement feature [files: lib/feature.ts]",
        claimMode: "write",
        repoId: "repo-source",
        workingDirectory: "C:\\other-repo",
      },
    });

    expect(result).toMatchObject({
      error:
        "source workingDirectory does not match registered repository repo-source",
    });
    expect(
      (
        db().prepare("SELECT COUNT(*) AS n FROM fleet_runs").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
  });

  it.each([
    ["working directory", { workingDirectory: "C:\\other-repo" }],
    ["base branch", { baseBranch: "release" }],
  ])("rejects per-step Pipeline %s divergence", (_name, stepTarget) => {
    const result = createFleetRunFromSource({
      source: {
        kind: "pipeline",
        repoId: "repo-source",
        baseBranch: "main",
        spec: {
          name: "Divergent pipeline",
          workingDirectory: "C:\\repo",
          steps: [
            {
              id: "build",
              agent: "codex",
              task: "Build it",
              ...stepTarget,
            },
          ],
        },
      },
    });

    expect(result).toMatchObject({
      error: expect.stringContaining("does not match registered repository"),
    });
  });

  it("binds a Pipeline plan to the registered target path and base", () => {
    const result = createFleetRunFromSource({
      source: {
        kind: "pipeline",
        sourceId: "pipeline-release",
        repoId: "repo-source",
        baseBranch: "main",
        spec: {
          name: "Bound pipeline",
          workingDirectory: "C:\\repo",
          steps: [{ id: "build", agent: "codex", task: "Build it" }],
        },
      },
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.run.tasks[0]).toMatchObject({
      workingDirectory: "C:\\repo",
      baseBranch: "main",
      sourceRef: "pipeline:build",
      sourceStepId: "build",
    });
  });

  it("accepts Dispatch's repo/project association and persists issue lineage", () => {
    db()
      .prepare(
        `INSERT INTO issue_dispatches
       (id, repo_id, issue_number, issue_title, status)
       VALUES ('dispatch-10', 'repo-source', 10, 'Foundation', 'pending')`
      )
      .run();

    const result = createFleetRunFromSource({
      source: {
        kind: "dispatch_issue",
        sourceId: "dispatch-batch",
        issues: [
          {
            id: "dispatch-10",
            issue_number: 10,
            issue_title: "Foundation",
            file_claims: '["lib/base/"]',
          },
        ],
        repo: {
          id: "repo-source",
          repo_path: "C:\\repo",
          repo_slug: "owner/repo",
          base_branch: "main",
          project_id: "proj-source",
          agent_type: "codex",
        },
      },
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.run.run).toMatchObject({
      repoId: "repo-source",
      projectId: null,
      sourceKind: "dispatch_issue",
      sourceId: "dispatch-batch",
    });
    expect(result.run.tasks[0]).toMatchObject({
      sourceRef: "dispatch-issue:dispatch-10",
      sourceStepId: expect.any(String),
      sourceIssueId: "dispatch-10",
      sourceIssueNumber: 10,
    });
  });

  it("rejects stale or foreign Dispatch issue linkage", () => {
    db()
      .prepare(
        `INSERT INTO issue_dispatches
       (id, repo_id, issue_number, issue_title, status)
       VALUES ('dispatch-10', 'repo-source', 10, 'Foundation', 'pending')`
      )
      .run();

    const source = {
      kind: "dispatch_issue",
      issues: [
        {
          id: "dispatch-10",
          issue_number: 11,
          issue_title: "Foundation",
        },
      ],
      repo: { id: "repo-source" },
    };
    const stale = createFleetRunFromSource({ source });
    const missing = createFleetRunFromSource({
      source: {
        ...source,
        issues: [{ ...source.issues[0], id: "missing-dispatch" }],
      },
    });

    expect(stale).toMatchObject({
      error: "dispatch issue dispatch-10 no longer matches issue number 11",
    });
    expect(missing).toMatchObject({
      error: "unknown dispatch issue missing-dispatch",
    });
    expect(
      (
        db().prepare("SELECT COUNT(*) AS n FROM fleet_runs").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
  });
});

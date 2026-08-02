import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({
  db: null as unknown,
  defaultBranch: "main",
  baseSha: "a".repeat(40),
}));

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
    getDefaultBranch: () => state.defaultBranch,
    isGitRepo: () => true,
    resolveGitCommit: () => state.baseSha,
  };
});

vi.mock("@/lib/readiness-server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/readiness-server")>();
  return {
    ...actual,
    detectAgentBinaries: () => ({
      claude: false,
      codex: true,
      hermes: false,
      kilo: false,
      kimi: false,
      shell: true,
    }),
  };
});

import { queries } from "@/lib/db";
import { createFleetRunFromSource } from "@/lib/fleet/source-service";
import { approveFleetRunPlan } from "@/lib/fleet/service";

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
  state.defaultBranch = "main";
  state.baseSha = "a".repeat(40);
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
  it("rejects unsafe and unsupported imported models atomically", () => {
    const unsafe = createFleetRunFromSource({
      source: {
        kind: "text",
        text: "- Implement import [files: lib/import.ts]",
        claimMode: "write",
        repoId: "repo-source",
        provider: "hermes",
        model: "openrouter/x;whoami",
      },
    });
    expect(unsafe).toMatchObject({ status: 400 });
    expect("error" in unsafe && unsafe.error).toContain("model");

    const unsupported = createFleetRunFromSource({
      source: {
        kind: "text",
        text: "- Implement import [files: lib/import.ts]",
        claimMode: "write",
        repoId: "repo-source",
        provider: "codex",
        verifyCommand: "npm test",
      },
      options: { provider: "codex", model: "gpt-4-unsupported" },
    });
    expect(unsupported).toEqual({
      error: "codex allocation model is not supported by codex",
      status: 400,
    });
    expect(db().prepare("SELECT COUNT(*) AS n FROM fleet_runs").get()).toEqual({
      n: 0,
    });
  });

  it("redacts source lineage prose before durable import", () => {
    const canary = "sk-SOURCECANARY0123456789";
    const result = createFleetRunFromSource(
      {
        source: {
          kind: "text",
          name: `Imported ${canary}`,
          text: "- Implement safe import [files: lib/import.ts]",
          claimMode: "write",
          repoId: "repo-source",
          sourceId: "epic-safe",
          provider: "codex",
          verifyCommand: "npm test",
        },
      },
      `source actor password=${canary}`
    );
    if ("error" in result) throw new Error(result.error);

    const runId = result.run.run.id;
    const run = db()
      .prepare(
        `SELECT name, goal, source_id, source_name, settings_json
         FROM fleet_runs WHERE id = ?`
      )
      .get(runId);
    const lineage = db()
      .prepare(
        `SELECT source_ref, source_step_id, source_issue_id
         FROM fleet_tasks WHERE fleet_run_id = ?`
      )
      .all(runId);
    const events = db()
      .prepare(`SELECT payload FROM fleet_events WHERE fleet_run_id = ?`)
      .all(runId);
    expect(JSON.stringify({ run, lineage, events })).not.toContain(canary);
    expect(JSON.stringify(run)).toContain("[REDACTED]");
  });

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
        verifyCommand: "npm test",
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

  it.each([
    [
      "Markdown",
      {
        kind: "text",
        text: "- Implement import [files: lib/import.ts]",
        claimMode: "write",
        repoId: "repo-source",
        provider: "hermes",
        model: "kimi-k3",
        verifyCommand: "npm test",
      },
    ],
    [
      "Pipeline",
      {
        kind: "pipeline",
        repoId: "repo-source",
        baseBranch: "main",
        verifyCommand: "npm test",
        spec: {
          name: "Imported pipeline",
          workingDirectory: "C:\\repo",
          steps: [
            {
              id: "build",
              agent: "hermes",
              model: "kimi-k3",
              task: "Build it",
              outputFile: "lib/pipeline.ts",
            },
          ],
        },
      },
    ],
    [
      "Builder",
      {
        kind: "builder",
        repoId: "repo-source",
        verifyCommand: "npm test",
        workflow: {
          name: "Imported builder",
          workingDirectory: "C:\\repo",
          projectId: null,
          worktreePath: null,
          nodes: [
            {
              step: {
                id: "build",
                agent: "hermes",
                model: "kimi-k3",
                task: "Build it",
                outputFile: "lib/builder.ts",
              },
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
        repo: { id: "repo-source" },
        provider: "hermes",
        model: "kimi-k3",
        verifyCommand: "npm test",
        tasks: [
          {
            title: "Build it",
            body: "Implement the dispatch task",
            claims: ["lib/dispatch.ts"],
          },
        ],
      },
    ],
  ])(
    "allocates an imported %s graph only to installed providers",
    (_name, source) => {
      const result = createFleetRunFromSource({ source });
      if ("error" in result) throw new Error(result.error);

      expect(result.run.run).toMatchObject({
        provider: "codex",
        model: "gpt-5.5",
        approvalState: "needs_approval",
      });
      expect(result.run.tasks).not.toHaveLength(0);
      expect(
        result.run.tasks.map((task) => ({
          provider: task.agentType,
          model: task.model,
        }))
      ).toEqual(
        result.run.tasks.map(() => ({
          provider: "codex",
          model: "gpt-5.5",
        }))
      );
    }
  );

  it("rejects an import before persistence when no agent provider is installed", () => {
    const result = createFleetRunFromSource(
      {
        source: {
          kind: "text",
          text: "- Implement feature [files: lib/feature.ts]",
          claimMode: "write",
          repoId: "repo-source",
          provider: "claude",
          verifyCommand: "npm test",
        },
      },
      "operator",
      { detectInstalledProviders: () => [] }
    );

    expect(result).toEqual({
      error: "no installed agent provider is available",
      status: 409,
    });
    expect(db().prepare(`SELECT COUNT(*) AS n FROM fleet_runs`).get()).toEqual({
      n: 0,
    });
  });

  it("preserves a project's configured checkout branch through approval", () => {
    state.defaultBranch = "release/v2";
    const result = createFleetRunFromSource({
      source: {
        kind: "text",
        text: "- Implement release [files: lib/release.ts]",
        claimMode: "write",
        projectId: "proj-source",
        verifyCommand: "npm test",
      },
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.run.run).toMatchObject({
      provider: "codex",
      model: "gpt-5.5",
    });
    expect(result.run.tasks[0]).toMatchObject({
      agentType: "codex",
      model: "gpt-5.5",
      baseBranch: "release/v2",
    });

    const approved = approveFleetRunPlan(result.run.run.id, {
      expectedPlanHash: result.run.run.planHash,
    });
    if ("error" in approved) throw new Error(approved.error);
    expect(approved.run.run.approvalState).toBe("approved");
    expect(approved.run.tasks[0]).toMatchObject({
      baseBranch: "release/v2",
    });
  });

  it("rolls back the new draft when its repository target is invalid", () => {
    const result = createFleetRunFromSource({
      source: {
        kind: "text",
        text: "- Implement feature [files: lib/feature.ts]",
        claimMode: "write",
        repoId: "missing-repo",
        verifyCommand: "npm test",
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
        verifyCommand: "npm test",
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
        verifyCommand: "npm test",
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
        verifyCommand: "npm test",
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
        verifyCommand: "npm test",
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
        verifyCommand: "npm test",
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
        verifyCommand: "npm test",
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
        verifyCommand: "npm test",
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
      verifyCommand: "npm test",
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

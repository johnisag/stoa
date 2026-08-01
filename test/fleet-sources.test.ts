import { describe, expect, it } from "vitest";
import type { BuilderDoc, SavedWorkflow } from "@/lib/pipeline/builder-model";
import type { PipelineSpec } from "@/lib/pipeline/types";
import {
  FLEET_SOURCE_TASK_CAP,
  adaptFleetBuilderSource,
  adaptFleetDispatchIssueSource,
  adaptFleetDispatchPlannerSource,
  adaptFleetPipelineSource,
  adaptFleetSource,
  adaptFleetTextSource,
} from "@/lib/fleet/sources";
import { fleetSourceDraftToPlan } from "@/lib/fleet/source-plan";

function expectDraft(result: ReturnType<typeof adaptFleetSource>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors[0]?.message);
  return result.draft;
}

function expectErrorCode(
  result: ReturnType<typeof adaptFleetSource>,
  code: string
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected adapter error");
  expect(result.errors[0]?.code).toBe(code);
}

const pipeline: PipelineSpec = {
  name: "Release feature",
  workingDirectory: "C:\\projects\\repo",
  steps: [
    {
      id: "scan",
      name: "Inspect code",
      agent: "claude",
      model: "sonnet",
      task: "Map the implementation surface.",
      outputFile: "artifacts/scan.md",
    },
    {
      id: "implement",
      name: "Implement feature",
      agent: "codex",
      model: "gpt-5.5",
      task: "Use {{steps.scan.output}} and implement the feature.",
      dependsOn: ["scan"],
      exitCriteria: "Tests pass on Windows, macOS, and Linux.",
    },
  ],
};

describe("Fleet source adapters", () => {
  it("converts a validated source into an exact dependency-preserving Fleet plan", () => {
    const draft = expectDraft(
      adaptFleetTextSource({
        kind: "text",
        name: "Imported epic",
        text: [
          "- Inspect code [files: lib/fleet/]",
          "  - Implement it [files: lib/fleet/runtime.ts]",
        ].join("\n"),
        provider: "codex",
        claimMode: "write",
        verifyCommand: "npm test && npm run build",
        repoId: "repo-fleet",
      })
    );

    const executable = fleetSourceDraftToPlan(draft);

    expect(executable.tasks).toHaveLength(2);
    expect(executable.dependencies).toEqual([[], [0]]);
    expect(executable.tasks[1]).toMatchObject({
      title: "Implement it",
      agentType: "codex",
      fileClaims: ["lib/fleet/runtime.ts"],
      verifyCommand: "npm test && npm run build",
    });
    expect(executable.planText).toContain("Imported from text");
    expect(executable.planText).toContain("Depends on: inspect-code");
  });

  it("preserves source execution-target hints for service-level binding", () => {
    const draft = expectDraft(
      adaptFleetTextSource({
        kind: "text",
        text: "- Build it [files: lib/build.ts]",
        repoId: "repo-fleet",
        workingDirectory: "C:\\projects\\repo",
        baseBranch: "main",
      })
    );

    expect(fleetSourceDraftToPlan(draft).tasks[0]).toMatchObject({
      workingDirectory: "C:\\projects\\repo",
      baseBranch: "main",
    });
  });

  it("rejects shell syntax in a text source verification command", () => {
    expectErrorCode(
      adaptFleetTextSource({
        kind: "text",
        text: "- Implement [files: lib/feature.ts]",
        claimMode: "write",
        verifyCommand: "npm test | tee output.txt",
      }),
      "unsafe_verify_command"
    );
  });

  it("canonicalizes read-only imports so they cannot acquire write claims", () => {
    const draft = expectDraft(
      adaptFleetTextSource({
        kind: "text",
        text: "- Audit configuration [files: .github/workflows/]",
        claimMode: "read",
      })
    );

    const executable = fleetSourceDraftToPlan(draft);

    expect(executable.tasks[0]).toMatchObject({
      taskType: "explore",
      fileClaims: [],
    });
  });

  it("normalizes a Markdown/high-level spec into stable ordered tasks", () => {
    const input = {
      kind: "text",
      name: "  Audit release  ",
      text: [
        "- Inspect code [files: lib\\fleet\\sources.ts]",
        "  - Inspect code [files: test/fleet-sources.test.ts]",
      ].join("\n"),
      provider: " CoDeX ",
      model: " gpt-5.5 ",
      claimMode: "read",
      workingDirectory: "C:\\projects\\repo",
    };

    const first = expectDraft(adaptFleetTextSource(input));
    const second = expectDraft(adaptFleetTextSource(input));

    expect(first).toEqual(second);
    expect(first.name).toBe("Audit release");
    expect(first.tasks.map((task) => task.id)).toEqual([
      "inspect-code",
      "inspect-code-2",
    ]);
    expect(first.tasks[1].dependsOn).toEqual(["inspect-code"]);
    expect(first.tasks[0]).toMatchObject({
      order: 0,
      provider: "codex",
      model: "gpt-5.5",
      claimMode: "read",
      fileClaims: [{ path: "lib/fleet/sources.ts", access: "read" }],
    });
  });

  it("maps a PipelineSpec, its JSON form, and a BuilderDoc equivalently", () => {
    const fromObject = expectDraft(
      adaptFleetPipelineSource({ kind: "pipeline", spec: pipeline })
    );
    const fromJson = expectDraft(
      adaptFleetPipelineSource({
        kind: "pipeline",
        spec: JSON.stringify(pipeline),
      })
    );
    const doc: BuilderDoc = {
      name: pipeline.name,
      workingDirectory: pipeline.workingDirectory,
      projectId: null,
      worktreePath: null,
      nodes: pipeline.steps.map((step, index) => ({
        step,
        x: index * 100,
        y: 0,
      })),
      notes: [{ id: "note", text: "not executable", x: 0, y: 0 }],
    };
    const fromBuilder = expectDraft(
      adaptFleetBuilderSource({ kind: "builder", workflow: doc })
    );

    expect(fromJson).toEqual(fromObject);
    expect(
      fromBuilder.tasks.map(({ sourceRef: _sourceRef, ...task }) => task)
    ).toEqual(
      fromObject.tasks.map(({ sourceRef: _sourceRef, ...task }) => task)
    );
    expect(fromBuilder.repository).toEqual(fromObject.repository);
    expect(fromObject.tasks[0].fileClaims).toEqual([
      { path: "artifacts/scan.md", access: "write" },
    ]);
    expect(fromObject.tasks[1]).toMatchObject({
      dependsOn: ["scan"],
      provider: "codex",
      model: "gpt-5.5",
      acceptanceCriteria: "Tests pass on Windows, macOS, and Linux.",
    });
  });

  it("preserves saved-workflow provenance without importing history or notes", () => {
    const doc: BuilderDoc = {
      name: pipeline.name,
      workingDirectory: pipeline.workingDirectory,
      projectId: "project-1",
      worktreePath: null,
      nodes: pipeline.steps.map((step, index) => ({ step, x: index, y: 0 })),
      notes: [],
    };
    const workflow: SavedWorkflow = {
      id: "workflow-1",
      name: "Saved release",
      doc,
      history: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };

    const draft = expectDraft(
      adaptFleetBuilderSource({ kind: "builder", workflow })
    );

    expect(draft.provenance).toEqual({
      kind: "builder",
      sourceId: "workflow-1",
      sourceName: "Saved release",
    });
    expect(draft.repository.projectId).toBe("project-1");
    expect(draft.tasks).toHaveLength(2);
  });

  it("maps Dispatch planner claims and dependency indexes without changing Dispatch", () => {
    const sourceTasks = [
      { title: "Build API", body: "Implement it", claims: ["lib\\api\\"] },
      { title: "Test API", body: "Cover it", claims: ["test/api.test.ts"] },
    ];
    const snapshot = structuredClone(sourceTasks);
    const draft = expectDraft(
      adaptFleetDispatchPlannerSource({
        kind: "dispatch_planner",
        name: "Issue split",
        tasks: sourceTasks,
        dependencies: [[], [0]],
        repo: {
          id: "repo-1",
          repo_path: "C:\\projects\\repo",
          repo_slug: "owner/repo",
          base_branch: "main",
          agent_type: "codex",
          default_model: "gpt-5.5",
          project_id: "project-1",
        },
      })
    );

    expect(sourceTasks).toEqual(snapshot);
    expect(draft.tasks[1].dependsOn).toEqual(["build-api"]);
    expect(draft.tasks[0].fileClaims).toEqual([
      { path: "lib/api", access: "write" },
    ]);
    expect(draft.repository).toEqual({
      repoId: "repo-1",
      projectId: "project-1",
      repoSlug: "owner/repo",
      workingDirectory: "C:\\projects\\repo",
      baseBranch: "main",
    });
  });

  it("maps Dispatch issues explicitly, including legacy unknown write scope", () => {
    const draft = expectDraft(
      adaptFleetDispatchIssueSource({
        kind: "dispatch_issue",
        issues: [
          {
            id: "dispatch-a",
            issue_number: 10,
            issue_title: "Foundation",
            issue_url: "https://example.test/issues/10",
            file_claims: '["lib/base/"]',
            task_body: null,
          },
          {
            id: "dispatch-b",
            issue_number: 11,
            issue_title: "Dependent change",
            issue_url: "https://example.test/issues/11",
            file_claims: null,
            task_body: null,
          },
        ],
        dependencies: { "dispatch-b": ["dispatch-a"] },
        provider: "hermes",
        model: "moonshot/kimi-k3",
      })
    );

    expect(draft.tasks[1].dependsOn).toEqual([draft.tasks[0].id]);
    expect(draft.tasks[1]).toMatchObject({
      claimMode: "write",
      fileClaims: [],
      provider: "hermes",
      model: "moonshot/kimi-k3",
    });
    expect(draft.tasks[0].fileClaims).toEqual([
      { path: "lib/base", access: "write" },
    ]);
  });
});

describe("Fleet source adapter validation", () => {
  it("reuses Pipeline DAG validation and rejects cycles", () => {
    const cyclic: PipelineSpec = {
      ...pipeline,
      steps: [
        { id: "a", agent: "codex", task: "A", dependsOn: ["b"] },
        { id: "b", agent: "codex", task: "B", dependsOn: ["a"] },
      ],
    };

    expectErrorCode(
      adaptFleetPipelineSource({ kind: "pipeline", spec: cyclic }),
      "invalid_pipeline"
    );
  });

  it("rejects cyclic, unknown, duplicate, and out-of-range imported dependencies", () => {
    const tasks = [
      { title: "A", body: "A", claims: ["a.ts"] },
      { title: "B", body: "B", claims: ["b.ts"] },
    ];

    expectErrorCode(
      adaptFleetDispatchPlannerSource({
        kind: "dispatch_planner",
        tasks,
        dependencies: [[1], [0]],
      }),
      "dependency_cycle"
    );
    expectErrorCode(
      adaptFleetDispatchPlannerSource({
        kind: "dispatch_planner",
        tasks,
        dependencies: [[], [2]],
      }),
      "unknown_dependency"
    );
    expectErrorCode(
      adaptFleetDispatchPlannerSource({
        kind: "dispatch_planner",
        tasks,
        dependencies: [[], [0, 0]],
      }),
      "duplicate_dependency"
    );
    expectErrorCode(
      adaptFleetDispatchIssueSource({
        kind: "dispatch_issue",
        issues: [{ id: "a", issue_number: 1, issue_title: "A" }],
        dependencies: { a: ["missing"] },
      }),
      "unknown_dependency"
    );
  });

  it("enforces the hard 40-task cap instead of truncating source data", () => {
    const lines = Array.from(
      { length: FLEET_SOURCE_TASK_CAP + 1 },
      (_, index) => `- Task ${index}`
    ).join("\n");
    expectErrorCode(
      adaptFleetTextSource({ kind: "text", text: lines }),
      "task_cap_exceeded"
    );
    expectErrorCode(
      adaptFleetDispatchPlannerSource({
        kind: "dispatch_planner",
        tasks: Array.from(
          { length: FLEET_SOURCE_TASK_CAP + 1 },
          (_, index) => ({
            title: `Task ${index}`,
            body: "work",
            claims: [`file-${index}.ts`],
          })
        ),
      }),
      "task_cap_exceeded"
    );
  });

  it("fails closed on traversal, globs, oversize text, and unsafe models", () => {
    expectErrorCode(
      adaptFleetDispatchPlannerSource({
        kind: "dispatch_planner",
        tasks: [{ title: "Escape", body: "bad", claims: ["../outside"] }],
      }),
      "invalid_claim"
    );
    expectErrorCode(
      adaptFleetDispatchPlannerSource({
        kind: "dispatch_planner",
        tasks: [{ title: "Glob", body: "bad", claims: ["lib/**/*.ts"] }],
      }),
      "invalid_claim"
    );
    expectErrorCode(
      adaptFleetTextSource({
        kind: "text",
        text: "x".repeat(24_001),
      }),
      "too_large"
    );
    expectErrorCode(
      adaptFleetTextSource({
        kind: "text",
        text: "Do work",
        provider: "hermes",
        model: "good; rm -rf",
      }),
      "unsafe_model"
    );
  });

  it("returns a bounded error for hostile objects and never auto-selects a source", () => {
    const hostile = Object.defineProperty({}, "kind", {
      get() {
        throw new Error("getter should not escape");
      },
    });
    expectErrorCode(adaptFleetSource(hostile), "unsafe_input");
    expectErrorCode(adaptFleetSource({ kind: "migration" }), "unknown_source");
  });
});

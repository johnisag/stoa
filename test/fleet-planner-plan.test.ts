import { describe, expect, it } from "vitest";
import {
  buildFleetPlannerPrompt,
  fleetPlannerPlanText,
  normalizeFleetPlannerTaskCap,
  parseFleetPlannerOutput,
} from "@/lib/fleet/planner-plan";

const validPlan = `noise
STOA_FLEET_PLAN_BEGIN
{"tasks":[{"key":"api","title":"Build API","description":"Add the endpoint","taskType":"implementation","fileClaims":["app/api/"],"dependsOn":[],"acceptanceCriteria":"Tests pass","verifyCommand":"npm test","suggestedProvider":"codex"},{"key":"review","title":"Review API","description":"Inspect the result","taskType":"review","fileClaims":[],"dependsOn":["api"]}]}
STOA_FLEET_PLAN_END`;

describe("Fleet planner plan contract", () => {
  it("builds a bounded, no-authority planner prompt", () => {
    const prompt = buildFleetPlannerPrompt({
      goal: "Ship the API",
      baseBranch: "main",
      taskCap: 12,
      availableProviders: ["claude", "codex"],
    });
    expect(prompt).toContain("at most 12");
    expect(prompt).toContain("do not modify project files, commit, push");
    expect(prompt).toContain("STOA_FLEET_PLAN_BEGIN");
  });

  it("parses dependencies, claims, criteria, and provider suggestions", () => {
    const parsed = parseFleetPlannerOutput(validPlan, 8);
    expect(parsed).toEqual({
      ok: true,
      tasks: [
        {
          key: "api",
          title: "Build API",
          description: "Add the endpoint",
          taskType: "implementation",
          fileClaims: ["app/api"],
          dependsOn: [],
          acceptanceCriteria: "Tests pass",
          verifyCommand: "npm test",
          suggestedProvider: "codex",
        },
        {
          key: "review",
          title: "Review API",
          description: "Inspect the result",
          taskType: "review",
          fileClaims: [],
          dependsOn: ["api"],
          acceptanceCriteria: null,
          verifyCommand: null,
          suggestedProvider: null,
        },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(fleetPlannerPlanText(parsed.tasks)).toContain(
      "1. Build API -- Add the endpoint [files: app/api]"
    );
    expect(fleetPlannerPlanText(parsed.tasks)).toContain("Verify: npm test");
  });

  it("rejects glob claims and claim-count or claim-length abuse", () => {
    expect(
      parseFleetPlannerOutput(validPlan.replace("app/api/", "app/**/*.ts"), 8)
    ).toMatchObject({ ok: false, error: expect.stringContaining("unsafe") });
    const many = Array.from({ length: 31 }, (_, index) => `src/${index}.ts`);
    expect(
      parseFleetPlannerOutput(
        validPlan.replace('["app/api/"]', JSON.stringify(many)),
        8
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining("excessive") });
    expect(
      parseFleetPlannerOutput(
        validPlan.replace("app/api/", `src/${"a".repeat(241)}`),
        8
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining("excessive") });
  });

  it("rejects forward dependencies, missing write claims, and cap overflow", () => {
    expect(
      parseFleetPlannerOutput(
        validPlan.replace('"dependsOn":[]', '"dependsOn":["review"]'),
        8
      )
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("dependency"),
    });
    expect(
      parseFleetPlannerOutput(validPlan.replace('["app/api/"]', "[]"), 8)
    ).toMatchObject({ ok: false, error: expect.stringContaining("claims") });
    expect(parseFleetPlannerOutput(validPlan, 1)).toMatchObject({
      ok: false,
      error: expect.stringContaining("cap"),
    });
  });

  it("rejects missing or unsafe write-task verification commands", () => {
    expect(
      parseFleetPlannerOutput(
        validPlan.replace('"verifyCommand":"npm test",', ""),
        8
      )
    ).toEqual({
      ok: false,
      error: "write task api has no verification command",
    });
    expect(
      parseFleetPlannerOutput(
        validPlan.replace('"npm test"', '"npm test | tee result.txt"'),
        8
      )
    ).toEqual({
      ok: false,
      error: "planner task api has an unsafe verification command",
    });
  });

  it("clamps operator task caps to the hard safety ceiling", () => {
    expect(normalizeFleetPlannerTaskCap(undefined)).toBe(8);
    expect(normalizeFleetPlannerTaskCap(0)).toBe(1);
    expect(normalizeFleetPlannerTaskCap(999)).toBe(40);
  });
});

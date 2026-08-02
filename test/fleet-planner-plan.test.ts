import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import {
  buildFleetPlannerPrompt,
  fleetPlannerPlanText,
  normalizeFleetPlannerTaskCap,
  parseFleetPlannerOutput,
  parseFleetPlannerResult,
} from "@/lib/fleet/planner-plan";

const validPlan = `noise
STOA_FLEET_PLAN_BEGIN
{"tasks":[{"key":"api","title":"Build API","description":"Add the endpoint","taskType":"implementation","fileClaims":["app/api/"],"dependsOn":[],"acceptanceCriteria":"Tests pass","riskNotes":[{"severity":"medium","risk":"Callers may rely on the old response","mitigation":"Run compatibility tests"}],"verifyCommand":"npm test","suggestedProvider":"codex","suggestedModel":"gpt-5.5"},{"key":"review","title":"Review API","description":"Inspect the result","taskType":"review","fileClaims":[],"dependsOn":["api"],"riskNotes":[]}]}
STOA_FLEET_PLAN_END`;

const RESULT_NONCE = "planner-result-nonce";
const RESULT_IDENTITY = {
  runId: "run-one",
  requestId: "request-one",
  attempt: 1,
  baseSha: "a".repeat(40),
  nonceHash: createHash("sha256").update(RESULT_NONCE).digest("hex"),
};

describe("Fleet planner plan contract", () => {
  it("builds a bounded, no-authority planner prompt", () => {
    const prompt = buildFleetPlannerPrompt({
      goal: "Ship the API",
      baseBranch: "main",
      taskCap: 12,
      availableProviders: ["claude", "codex"],
      resultPath: "/stoa/fleet/run-one/planner/request-one/result.json",
      nonce: RESULT_NONCE,
      ...RESULT_IDENTITY,
    });
    expect(prompt).toContain("at most 12");
    expect(prompt).toContain("do not modify project files, commit, push");
    expect(prompt).toContain("external Fleet-owned path");
    expect(prompt).toContain(RESULT_NONCE);
    expect(prompt).toContain(RESULT_IDENTITY.baseSha);
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
          riskNotes: [
            {
              severity: "medium",
              risk: "Callers may rely on the old response",
              mitigation: "Run compatibility tests",
            },
          ],
          verifyCommand: "npm test",
          suggestedProvider: "codex",
          suggestedModel: "gpt-5.5",
        },
        {
          key: "review",
          title: "Review API",
          description: "Inspect the result",
          taskType: "review",
          fileClaims: [],
          dependsOn: ["api"],
          acceptanceCriteria: null,
          riskNotes: [],
          verifyCommand: null,
          suggestedProvider: null,
          suggestedModel: null,
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

  it("requires bounded acceptance criteria and structured risk notes for write tasks", () => {
    expect(
      parseFleetPlannerOutput(
        validPlan.replace('"acceptanceCriteria":"Tests pass",', ""),
        8
      )
    ).toEqual({
      ok: false,
      error: "write task api needs bounded acceptance criteria",
    });
    expect(
      parseFleetPlannerOutput(
        validPlan.replace(
          '"riskNotes":[{"severity":"medium","risk":"Callers may rely on the old response","mitigation":"Run compatibility tests"}]',
          '"riskNotes":[]'
        ),
        8
      )
    ).toEqual({
      ok: false,
      error: "planner task api needs bounded structured risk notes",
    });
    expect(
      parseFleetPlannerOutput(
        validPlan.replace('"severity":"medium"', '"severity":"critical"'),
        8
      )
    ).toEqual({
      ok: false,
      error: "planner task api has a malformed risk note",
    });
  });

  it("authenticates planner results to one request, attempt, nonce, and base", () => {
    const tasks = JSON.parse(
      validPlan.slice(validPlan.indexOf("{"), validPlan.lastIndexOf("}") + 1)
    ).tasks;
    const result = JSON.stringify({
      schemaVersion: 1,
      nonce: RESULT_NONCE,
      runId: RESULT_IDENTITY.runId,
      requestId: RESULT_IDENTITY.requestId,
      attempt: RESULT_IDENTITY.attempt,
      baseSha: RESULT_IDENTITY.baseSha,
      tasks,
    });
    expect(parseFleetPlannerResult(result, RESULT_IDENTITY, 8)).toMatchObject({
      ok: true,
    });
    expect(
      parseFleetPlannerResult(
        result.replace('"requestId":"request-one"', '"requestId":"stale"'),
        RESULT_IDENTITY,
        8
      )
    ).toEqual({
      ok: false,
      error: "planner result requestId does not match",
    });
    expect(
      parseFleetPlannerResult(
        result.replace(RESULT_NONCE, "wrong-nonce"),
        RESULT_IDENTITY,
        8
      )
    ).toEqual({
      ok: false,
      error: "planner result nonce does not match",
    });
    expect(
      parseFleetPlannerResult(
        result.replace(RESULT_NONCE, ` ${RESULT_NONCE} `),
        RESULT_IDENTITY,
        8
      )
    ).toEqual({
      ok: false,
      error: "planner result nonce does not match",
    });
  });

  it("rejects unsafe or unscoped model suggestions", () => {
    expect(
      parseFleetPlannerOutput(validPlan.replace('"gpt-5.5"', '"gpt-5.5;rm"'), 8)
    ).toEqual({
      ok: false,
      error: "planner task api has an unsafe model suggestion",
    });
    expect(
      parseFleetPlannerOutput(
        validPlan.replace('"suggestedProvider":"codex",', ""),
        8
      )
    ).toEqual({
      ok: false,
      error: "planner task api has an unsafe model suggestion",
    });
  });

  it("clamps operator task caps to the hard safety ceiling", () => {
    expect(normalizeFleetPlannerTaskCap(undefined)).toBe(8);
    expect(normalizeFleetPlannerTaskCap(0)).toBe(1);
    expect(normalizeFleetPlannerTaskCap(999)).toBe(40);
  });
});

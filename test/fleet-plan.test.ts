import { describe, expect, it } from "vitest";
import { hashFleetTaskRows, hashParsedFleetPlanTasks } from "@/lib/fleet/hash";
import {
  FLEET_PLAN_TASK_MAX,
  FLEET_PLAN_TEXT_MAX,
  parseFleetPlanText,
} from "@/lib/fleet/plan";
import type { FleetTaskRow } from "@/lib/fleet/types";

const now = "2026-07-08T00:00:00.000Z";

function taskRow(
  id: string,
  sortOrder: number,
  overrides: Partial<FleetTaskRow> = {}
): FleetTaskRow {
  return {
    id,
    fleet_run_id: "run-1",
    parent_task_id: null,
    title: `Task ${sortOrder}`,
    description: null,
    status: "draft",
    task_type: "task",
    sort_order: sortOrder,
    file_claims_json: "[]",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("parseFleetPlanText", () => {
  it("parses markdown tasks, nesting, descriptions, and file claims", () => {
    const parsed = parseFleetPlanText(`
## Foundation
- Build parser - Convert markdown into tasks [files: lib/fleet/plan.ts]
  - Add tests: cover \`test/fleet-plan.test.ts\`
- Wire approval: hash before approve
`);

    expect(parsed).toHaveProperty("tasks");
    if ("error" in parsed) return;
    expect(parsed.tasks).toEqual([
      expect.objectContaining({
        title: "Foundation",
        taskType: "milestone",
        parentIndex: null,
      }),
      expect.objectContaining({
        title: "Build parser",
        description: "Convert markdown into tasks",
        parentIndex: null,
        fileClaims: ["lib/fleet/plan.ts"],
      }),
      expect.objectContaining({
        title: "Add tests",
        description: "cover `test/fleet-plan.test.ts`",
        parentIndex: 1,
        fileClaims: ["test/fleet-plan.test.ts"],
      }),
      expect.objectContaining({
        title: "Wire approval",
        description: "hash before approve",
        parentIndex: null,
      }),
    ]);
  });

  it("turns free text into a reviewable task instead of dropping it", () => {
    const parsed = parseFleetPlanText(
      "Investigate the repo, implement the safest plan, and keep workers parked."
    );

    expect(parsed).toHaveProperty("tasks");
    if ("error" in parsed) return;
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].title).toContain("Investigate the repo");
  });

  it("bounds input size and task count", () => {
    const lines = Array.from(
      { length: FLEET_PLAN_TASK_MAX + 10 },
      (_, index) => `- Task ${index}`
    ).join("\n");
    const parsed = parseFleetPlanText(
      `${lines}\n${"x".repeat(FLEET_PLAN_TEXT_MAX)}`
    );

    expect(parsed).toHaveProperty("tasks");
    if ("error" in parsed) return;
    expect(parsed.planText).toHaveLength(FLEET_PLAN_TEXT_MAX);
    expect(parsed.tasks).toHaveLength(FLEET_PLAN_TASK_MAX);
  });

  it("rejects blank or malformed runtime payloads", () => {
    expect(parseFleetPlanText(" ")).toEqual({ error: "planText is required" });
    expect(parseFleetPlanText(null)).toEqual({ error: "planText is required" });
  });
});

describe("fleet plan hashes", () => {
  it("are stable for parsed task content", () => {
    const a = parseFleetPlanText("- Build parser\n- Approve graph");
    const b = parseFleetPlanText("- Build parser\n- Approve graph");
    expect(a).toHaveProperty("tasks");
    expect(b).toHaveProperty("tasks");
    if ("error" in a || "error" in b) return;

    expect(hashParsedFleetPlanTasks(a.tasks)).toBe(
      hashParsedFleetPlanTasks(b.tasks)
    );
  });

  it("change when the task graph changes but ignore generated row ids", () => {
    const hashA = hashFleetTaskRows([
      taskRow("random-a", 0, { title: "Build parser" }),
      taskRow("random-b", 1, { title: "Approve graph" }),
    ]);
    const hashB = hashFleetTaskRows([
      taskRow("other-a", 0, { title: "Build parser" }),
      taskRow("other-b", 1, { title: "Approve graph" }),
    ]);
    const hashC = hashFleetTaskRows([
      taskRow("other-a", 0, { title: "Build parser" }),
      taskRow("other-b", 1, { title: "Approve changed graph" }),
    ]);

    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashC);
  });
});

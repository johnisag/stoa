import { describe, expect, it, vi } from "vitest";

const spawnWorker = vi.hoisted(() => vi.fn());
vi.mock("@/lib/orchestration", () => ({
  spawnWorker,
  WorkerSpawnError: class WorkerSpawnError extends Error {},
}));

import { spawnFleetWorker } from "@/lib/fleet/spawn";
import type { FleetRunRow, FleetTaskRow } from "@/lib/fleet/types";

describe("fleet spawn wrapper", () => {
  it("uses stable distinct branch names and the resolved base branch", async () => {
    spawnWorker.mockImplementation(async (options) => ({
      id: `session-${options.branchName}`,
      worker_status: "running",
      worktree_path: `C:\\wt\\${options.branchName}`,
    }));
    const run = {
      id: "run-123456789",
      name: "Fleet",
      goal: "Ship",
      provider: "codex",
      model: null,
    } as FleetRunRow;
    const makeTask = (id: string) =>
      ({
        id,
        title: id,
        task_type: "task",
        base_branch: "develop",
      }) as FleetTaskRow;
    for (const task of [makeTask("task-aaaaaaaa"), makeTask("task-bbbbbbbb")]) {
      await spawnFleetWorker({
        run,
        task,
        workingDirectory: "C:\\repo",
        claims: ["lib"],
        dependencies: [],
        attempt: 1,
        spawnRequestId: `${run.id}:${task.id}:1`,
      });
    }
    const options = spawnWorker.mock.calls.map((call) => call[0]);
    expect(options[0].branchName).not.toBe(options[1].branchName);
    expect(options.map((value) => value.baseBranch)).toEqual([
      "develop",
      "develop",
    ]);
    expect(options.every((value) => value.requireTaskDelivery)).toBe(true);
  });
});

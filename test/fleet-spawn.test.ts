import { describe, expect, it, vi } from "vitest";

const spawnWorker = vi.hoisted(() => vi.fn());
vi.mock("@/lib/orchestration", () => ({
  spawnWorker,
  WorkerSpawnError: class WorkerSpawnError extends Error {},
}));

import { spawnFleetWorker } from "@/lib/fleet/spawn";
import {
  DEFAULT_FLEET_AUTOMATION_POLICY,
  fleetAutomationPolicyJson,
} from "@/lib/fleet/automation-policy";
import type { FleetRunRow, FleetTaskRow } from "@/lib/fleet/types";

const AUTHORIZED_AUTOMATION_POLICY = fleetAutomationPolicyJson({
  ...DEFAULT_FLEET_AUTOMATION_POLICY,
  allowUnconfinedAgents: true,
});

describe("fleet spawn wrapper", () => {
  it("rejects a persisted unsupported model instead of clamping at spawn", async () => {
    spawnWorker.mockClear();
    await expect(
      spawnFleetWorker({
        run: {
          id: "run-invalid-model",
          provider: "codex",
          model: "gpt-5.5",
          automation_policy_json: AUTHORIZED_AUTOMATION_POLICY,
        } as FleetRunRow,
        task: {
          id: "task-invalid-model",
          title: "Invalid model",
          task_type: "task",
          agent_type: "codex",
          model: "gpt-4-unsupported",
        } as FleetTaskRow,
        workingDirectory: "C:\\repo",
        claims: ["lib"],
        dependencies: [],
        attempt: 1,
        spawnRequestId: "run-invalid-model:task-invalid-model:1",
      })
    ).rejects.toThrow("model is not supported by codex");
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("fails closed before launching a stale Kilo Fleet task", async () => {
    spawnWorker.mockClear();
    await expect(
      spawnFleetWorker({
        run: {
          id: "run-kilo",
          name: "Fleet",
          goal: "Ship",
          provider: "kilo",
          automation_policy_json: AUTHORIZED_AUTOMATION_POLICY,
        } as FleetRunRow,
        task: {
          id: "task-kilo",
          title: "Stale Kilo task",
          task_type: "task",
          agent_type: "kilo",
        } as FleetTaskRow,
        workingDirectory: "C:\\repo",
        claims: ["lib"],
        dependencies: [],
        attempt: 1,
        spawnRequestId: "run-kilo:task-kilo:1",
      })
    ).rejects.toThrow("Fleet provider cannot run unattended: kilo");
    expect(spawnWorker).not.toHaveBeenCalled();
  });

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
      automation_policy_json: AUTHORIZED_AUTOMATION_POLICY,
    } as FleetRunRow;
    const makeTask = (id: string) =>
      ({
        id,
        title: id,
        task_type: "task",
        agent_type: "codex",
        model: "gpt-5.5",
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
    expect(options.every((value) => value.useWorktree)).toBe(true);
    expect(options.every((value) => value.requireWorktree)).toBe(true);
    expect(options.every((value) => value.requireExactModel)).toBe(true);
    expect(options.every((value) => value.model === "gpt-5.5")).toBe(true);
  });

  it("isolates review tasks instead of using the source checkout", async () => {
    spawnWorker.mockResolvedValue({
      id: "review-session",
      worker_status: "running",
      worktree_path: "C:\\wt\\review",
    });
    await spawnFleetWorker({
      run: {
        id: "run-1",
        provider: "codex",
        automation_policy_json: AUTHORIZED_AUTOMATION_POLICY,
      } as FleetRunRow,
      task: {
        id: "review-1",
        title: "Review",
        task_type: "review",
        agent_type: "codex",
        model: "gpt-5.5",
      } as FleetTaskRow,
      workingDirectory: "C:\\repo",
      claims: [],
      dependencies: [],
      attempt: 1,
      spawnRequestId: "request-1",
    });
    expect(spawnWorker).toHaveBeenLastCalledWith(
      expect.objectContaining({ useWorktree: true, requireWorktree: true })
    );
  });

  it("delivers the report nonce ephemerally without persisting it in the task", async () => {
    spawnWorker.mockResolvedValue({
      id: "runtime-session",
      worker_status: "running",
      worktree_path: "C:\\wt\\runtime",
      branch_name: "feature/runtime",
    });
    const nonce = "secret-nonce-value-that-must-not-be-persisted";
    const result = await spawnFleetWorker({
      run: {
        id: "run-1",
        name: "Fleet",
        goal: "Ship",
        provider: "codex",
        automation_policy_json: AUTHORIZED_AUTOMATION_POLICY,
      } as FleetRunRow,
      task: {
        id: "task-1",
        title: "Runtime",
        task_type: "task",
        agent_type: "codex",
        model: "gpt-5.5",
        base_branch: "a".repeat(40),
      } as FleetTaskRow,
      workingDirectory: "C:\\repo",
      claims: ["lib"],
      dependencies: [],
      attempt: 1,
      spawnRequestId: "run-1:task-1:1",
      reportContract: {
        attemptDirectory: "C:\\fleet\\run-1\\task-1\\1",
        reportPath: "C:\\fleet\\run-1\\task-1\\1\\report.json",
        nonce,
        nonceHash: "f".repeat(64),
        baseSha: "a".repeat(40),
        workerId: "worker-1",
      },
    });

    const options = spawnWorker.mock.calls.at(-1)?.[0];
    expect(options.task).not.toContain(nonce);
    expect(options.task).toContain("[redacted ephemeral nonce]");
    expect(options.deliveryTask).toContain(nonce);
    expect(options.deliveryTask).toContain("Worker ID: worker-1");
    expect(options.fleetArtifactPaths).toEqual([
      "C:\\fleet\\run-1\\task-1\\1\\report.json",
    ]);
    expect(result.branchName).toBe("feature/runtime");
  });
});

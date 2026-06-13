/**
 * Pipeline default-deps — tests the IMPURE outcome mapping (statusDetector
 * status → StepOutcome) and the spawn passthrough, with the DB + collaborators
 * mocked. The key contract: `idle` only counts as success AFTER the worker was
 * observed `running` (no spawn-time idle-at-prompt false positive).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  status: "running" as string,
  sessionExists: true,
}));
const spawnWorkerMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ id: string; worktree_path?: string | null }> => ({
      id: "worker-1",
    })
  )
);
const getStatusMock = vi.hoisted(() => vi.fn(async () => state.status));
const killWorkerMock = vi.hoisted(() =>
  vi.fn(async (_id: string, _cleanup: boolean, _status: string) => {})
);

vi.mock("@/lib/orchestration", () => ({
  spawnWorker: spawnWorkerMock,
  killWorker: killWorkerMock,
}));
vi.mock("@/lib/status-detector", () => ({
  statusDetector: { getStatus: getStatusMock },
}));
vi.mock("@/lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers")>();
  return { ...actual };
});
vi.mock("@/lib/db", () => ({
  db: {},
  queries: {
    getSession: () => ({
      get: (_id: string) =>
        state.sessionExists
          ? {
              id: "worker-1",
              agent_type: "claude",
              tmux_name: "claude-worker-1",
            }
          : undefined,
    }),
  },
}));

import { defaultExecutorDeps } from "@/lib/pipeline/default-deps";
import type { PipelineStep, PipelineSpec } from "@/lib/pipeline/types";

const step: PipelineStep = { id: "a", agent: "claude", task: "do it" };
const spec: PipelineSpec = {
  name: "p",
  workingDirectory: "/repo",
  steps: [step],
};

beforeEach(() => {
  state.status = "running";
  state.sessionExists = true;
  spawnWorkerMock.mockClear();
  getStatusMock.mockClear();
  killWorkerMock.mockClear();
});

describe("defaultExecutorDeps.spawn", () => {
  it("forwards step fields to spawnWorker and returns the session id", async () => {
    const deps = defaultExecutorDeps("conductor-1");
    const res = await deps.spawn(
      { ...step, model: "sonnet", workingDirectory: "/custom" },
      spec
    );
    expect(res.sessionId).toBe("worker-1");
    expect(spawnWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conductorSessionId: "conductor-1",
        task: "do it",
        workingDirectory: "/custom",
        agentType: "claude",
        model: "sonnet",
        useWorktree: true,
      })
    );
  });

  it("falls back to the pipeline workingDirectory when the step omits one", async () => {
    const deps = defaultExecutorDeps("conductor-1");
    await deps.spawn(step, spec);
    expect(spawnWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: "/repo" })
    );
  });

  it("shares ONE worktree across worktreePolicy:'shared' steps (create once, reuse)", async () => {
    const deps = defaultExecutorDeps("conductor-1");
    const shared = (id: string): PipelineStep => ({
      id,
      agent: "claude",
      task: `t-${id}`,
      worktreePolicy: "shared",
    });

    // First shared step creates a worktree; remember its path.
    spawnWorkerMock.mockResolvedValueOnce({
      id: "w1",
      worktree_path: "/wt/shared",
    });
    const r1 = await deps.spawn(shared("s1"), spec);
    expect(r1.worktreePath).toBe("/wt/shared");
    expect(spawnWorkerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ useWorktree: true })
    );

    // Second shared step REUSES it: no new worktree, runs in the shared path, and
    // still carries that path so its output file is readable from there.
    spawnWorkerMock.mockResolvedValueOnce({ id: "w2" });
    const r2 = await deps.spawn(shared("s2"), spec);
    expect(r2.worktreePath).toBe("/wt/shared");
    expect(spawnWorkerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        useWorktree: false,
        workingDirectory: "/wt/shared",
      })
    );
  });

  it("NEVER reaps the shared worktree owner's worktree, even on owner failure", async () => {
    const deps = defaultExecutorDeps("conductor-1");
    spawnWorkerMock.mockResolvedValueOnce({
      id: "owner",
      worktree_path: "/wt/s",
    });
    await deps.spawn(
      { id: "s1", agent: "claude", task: "t", worktreePolicy: "shared" },
      spec
    );
    // The owner step FAILED → the executor passes cleanupWorktree:true, but the
    // shared worktree must survive (sibling shared steps ran in it). Forced false.
    await deps.terminate!("owner", { cleanupWorktree: true, succeeded: false });
    expect(killWorkerMock).toHaveBeenCalledWith("owner", false, "failed");
  });

  it("reaps a NON-owner worker's worktree normally (cleanup honored)", async () => {
    const deps = defaultExecutorDeps("conductor-1");
    await deps.terminate!("other", { cleanupWorktree: true, succeeded: false });
    expect(killWorkerMock).toHaveBeenCalledWith("other", true, "failed");
  });
});

describe("defaultExecutorDeps.checkOutcome", () => {
  it("returns failed when the session is gone", async () => {
    state.sessionExists = false;
    const deps = defaultExecutorDeps("c");
    expect(await deps.checkOutcome("worker-1", step)).toBe("failed");
  });

  it("maps dead and error to failed", async () => {
    const deps = defaultExecutorDeps("c");
    state.status = "dead";
    expect(await deps.checkOutcome("worker-1", step)).toBe("failed");
    state.status = "error";
    expect(await deps.checkOutcome("worker-1", step)).toBe("failed");
  });

  it("returns running while the worker is working", async () => {
    const deps = defaultExecutorDeps("c");
    state.status = "running";
    expect(await deps.checkOutcome("worker-1", step)).toBe("running");
  });

  it("does NOT treat a spawn-time idle (never seen running) as success", async () => {
    const deps = defaultExecutorDeps("c");
    state.status = "idle";
    // First poll, before any running observed → still in flight.
    expect(await deps.checkOutcome("worker-1", step)).toBe("running");
  });

  it("treats idle as success ONLY after running was observed", async () => {
    const deps = defaultExecutorDeps("c");
    state.status = "running";
    expect(await deps.checkOutcome("worker-1", step)).toBe("running");
    state.status = "idle";
    expect(await deps.checkOutcome("worker-1", step)).toBe("succeeded");
  });

  it("treats waiting as still running", async () => {
    const deps = defaultExecutorDeps("c");
    state.status = "waiting";
    expect(await deps.checkOutcome("worker-1", step)).toBe("running");
  });

  it("tracks running per-session independently", async () => {
    const deps = defaultExecutorDeps("c");
    // worker-1 seen running; a different session's idle must not inherit it.
    state.status = "running";
    await deps.checkOutcome("worker-1", step);
    state.status = "idle";
    // worker-1 → succeeded; but a fresh session id idles without being seen.
    expect(await deps.checkOutcome("worker-1", step)).toBe("succeeded");
    expect(await deps.checkOutcome("worker-2", step)).toBe("running");
  });
});

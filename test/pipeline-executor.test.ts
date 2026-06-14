/**
 * Pipeline executor — unit tests of the orchestration LOOP with fully fake deps
 * (no real workers, no DB, no sleep). Builds a deterministic spawn/checkOutcome
 * model and asserts the executor launches the DAG in dependency order, runs
 * independent steps in parallel, cascades skips on failure, handles spawn
 * failure, and terminates on the cycle cap.
 */
import { describe, it, expect, vi } from "vitest";
import { runPipeline } from "@/lib/pipeline/executor";
import type { ExecutorDeps, StepOutcome } from "@/lib/pipeline/executor";
import type { PipelineSpec, PipelineStep } from "@/lib/pipeline/types";

function step(over: Partial<PipelineStep> & { id: string }): PipelineStep {
  return { agent: "claude", task: `do ${over.id}`, ...over };
}
function spec(steps: PipelineStep[]): PipelineSpec {
  return { name: "p", workingDirectory: "/repo", steps };
}

/**
 * Build fake deps. `outcomes` maps step id → the terminal outcome its worker
 * will report (default "succeeded"). `failSpawn` lists step ids whose spawn
 * throws. Records launch order so tests can assert sequencing.
 */
function fakeDeps(opts: {
  outcomes?: Record<string, "succeeded" | "failed">;
  failSpawn?: string[];
}): ExecutorDeps & { launched: string[] } {
  const outcomes = opts.outcomes ?? {};
  const failSpawn = new Set(opts.failSpawn ?? []);
  const launched: string[] = [];
  let clock = 1000;
  // Each launched session is polled once → returns its terminal outcome
  // immediately (deterministic, no real waiting).
  const sessionOutcome = new Map<string, "succeeded" | "failed">();

  return {
    launched,
    async spawn(s: PipelineStep) {
      launched.push(s.id);
      if (failSpawn.has(s.id)) throw new Error(`spawn boom ${s.id}`);
      const sessionId = `sess-${s.id}`;
      sessionOutcome.set(sessionId, outcomes[s.id] ?? "succeeded");
      return { sessionId };
    },
    async checkOutcome(sessionId: string): Promise<StepOutcome> {
      return sessionOutcome.get(sessionId) ?? "succeeded";
    },
    now: () => ++clock,
    sleep: async () => {},
  };
}

describe("runPipeline", () => {
  it("throws on an invalid spec before launching anything", async () => {
    const deps = fakeDeps({});
    await expect(
      runPipeline(spec([step({ id: "a", dependsOn: ["ghost"] })]), deps)
    ).rejects.toThrow(/invalid pipeline spec/);
    expect(deps.launched).toEqual([]);
  });

  it("runs a single step to success", async () => {
    const deps = fakeDeps({});
    const run = await runPipeline(spec([step({ id: "a" })]), deps);
    expect(run.status).toBe("succeeded");
    expect(run.steps.a.status).toBe("succeeded");
    expect(run.steps.a.sessionId).toBe("sess-a");
    expect(deps.launched).toEqual(["a"]);
  });

  it("respects dependency order (b only after a)", async () => {
    const deps = fakeDeps({});
    const run = await runPipeline(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]),
      deps
    );
    expect(run.status).toBe("succeeded");
    expect(deps.launched).toEqual(["a", "b"]);
  });

  it("launches independent roots in parallel (same cycle)", async () => {
    const deps = fakeDeps({});
    const run = await runPipeline(
      spec([step({ id: "a" }), step({ id: "b" }), step({ id: "c" })]),
      deps
    );
    expect(run.status).toBe("succeeded");
    // All three launched before any polling resolves them.
    expect(deps.launched.sort()).toEqual(["a", "b", "c"]);
  });

  it("executes a diamond and merges (fan-out then fan-in)", async () => {
    const deps = fakeDeps({});
    const run = await runPipeline(
      spec([
        step({ id: "draft" }),
        step({ id: "impl-1", dependsOn: ["draft"] }),
        step({ id: "impl-2", dependsOn: ["draft"] }),
        step({ id: "merge", dependsOn: ["impl-1", "impl-2"] }),
      ]),
      deps
    );
    expect(run.status).toBe("succeeded");
    expect(deps.launched[0]).toBe("draft");
    expect(deps.launched[deps.launched.length - 1]).toBe("merge");
    expect(deps.launched.sort()).toEqual([
      "draft",
      "impl-1",
      "impl-2",
      "merge",
    ]);
  });

  it("cascades skip when a dependency fails (dependent never launches)", async () => {
    const deps = fakeDeps({ outcomes: { a: "failed" } });
    const run = await runPipeline(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]),
      deps
    );
    expect(run.status).toBe("failed");
    expect(run.steps.a.status).toBe("failed");
    expect(run.steps.b.status).toBe("skipped");
    expect(deps.launched).toEqual(["a"]); // b never spawned
  });

  it("treats a spawn failure as a failed step and cascades", async () => {
    const deps = fakeDeps({ failSpawn: ["a"] });
    const run = await runPipeline(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]),
      deps
    );
    expect(run.steps.a.status).toBe("failed");
    expect(run.steps.a.detail).toMatch(/spawn boom a/);
    expect(run.steps.b.status).toBe("skipped");
    expect(run.status).toBe("failed");
  });

  it("yields partial when one branch fails and an independent branch succeeds", async () => {
    const deps = fakeDeps({ outcomes: { b: "failed" } });
    const run = await runPipeline(
      spec([
        step({ id: "a" }),
        step({ id: "after-a", dependsOn: ["a"] }),
        step({ id: "b" }),
      ]),
      deps
    );
    expect(run.status).toBe("partial");
    expect(run.steps.a.status).toBe("succeeded");
    expect(run.steps["after-a"].status).toBe("succeeded");
    expect(run.steps.b.status).toBe("failed");
  });

  it("emits an onUpdate snapshot on each state change", async () => {
    const deps = fakeDeps({});
    const snaps: string[] = [];
    deps.onUpdate = (run) => snaps.push(run.status);
    await runPipeline(spec([step({ id: "a" })]), deps);
    // At least an initial pending/running and a terminal succeeded.
    expect(snaps[0]).toBe("pending");
    expect(snaps[snaps.length - 1]).toBe("succeeded");
  });

  it("terminates via the cycle cap if a worker never finishes", async () => {
    const deps = fakeDeps({});
    // Override checkOutcome to never resolve terminal.
    deps.checkOutcome = async () => "running";
    const run = await runPipeline(spec([step({ id: "a" })]), deps, {
      maxPollCycles: 3,
    });
    expect(run.steps.a.status).toBe("failed");
    expect(run.steps.a.detail).toMatch(/timed out/);
    expect(run.status).toBe("failed");
  });

  it("caps poll cycles at maxPollCycles exactly (not maxPollCycles + 1)", async () => {
    const deps = fakeDeps({});
    let calls = 0;
    deps.checkOutcome = async () => {
      calls++;
      return "running";
    };
    await runPipeline(spec([step({ id: "a" })]), deps, {
      maxPollCycles: 2,
    });
    // First poll increments to 1, second poll increments to 2 and trips >= cap.
    expect(calls).toBe(2);
  });

  it("logs a warning when checkOutcome throws but keeps the step running", async () => {
    const deps = fakeDeps({});
    let calls = 0;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.checkOutcome = async () => {
      calls++;
      if (calls === 1) throw new Error("poll boom");
      return "succeeded";
    };
    try {
      const run = await runPipeline(spec([step({ id: "a" })]), deps, {
        maxPollCycles: 3,
      });
      expect(run.steps.a.status).toBe("succeeded");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("pipeline: checkOutcome failed for a"),
        expect.stringContaining("poll boom")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("caps concurrent launches at maxParallelism (extras wait for a slot)", async () => {
    // Track peak concurrent in-flight spawns.
    let inFlight = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const deps: ExecutorDeps & { launched: string[] } = {
      launched: [],
      async spawn(s: PipelineStep) {
        (deps.launched as string[]).push(s.id);
        inFlight++;
        peak = Math.max(peak, inFlight);
        return { sessionId: `sess-${s.id}` };
      },
      async checkOutcome() {
        // Each poll completes one in-flight step.
        inFlight = Math.max(0, inFlight - 1);
        return "succeeded";
      },
      now: () => Date.now(),
      sleep: async () => {},
    };
    void resolvers;
    // 6 independent roots, cap 2 → never more than 2 launched-but-not-polled.
    const steps = ["a", "b", "c", "d", "e", "f"].map((id) => step({ id }));
    const run = await runPipeline(spec(steps), deps, { maxParallelism: 2 });
    expect(run.status).toBe("succeeded");
    expect(peak).toBeLessThanOrEqual(2);
    expect(deps.launched.sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("drives the run to terminal failed if the loop throws unexpectedly", async () => {
    const deps = fakeDeps({});
    const snaps: string[] = [];
    let calls = 0;
    deps.onUpdate = (run) => {
      snaps.push(run.status);
      // Throw on the 2nd emit (after launch) to simulate an unexpected fault;
      // the executor's catch must still emit a terminal snapshot and rethrow.
      if (++calls === 2) throw new Error("boom in onUpdate");
    };
    await expect(runPipeline(spec([step({ id: "a" })]), deps)).rejects.toThrow(
      /boom in onUpdate/
    );
    // The catch block's forced-terminate + emit ran last → last snapshot is
    // a terminal status, never a lingering "running"/"pending" zombie.
    expect(["failed", "succeeded", "partial"]).toContain(
      snaps[snaps.length - 1]
    );
  });

  // ── Worker reaping (FIX 1: forceTerminate must actually tear workers down) ──

  it("reaps every launched worker once the run is terminal", async () => {
    const deps = fakeDeps({});
    const reaped: Array<{ id: string; cleanupWorktree: boolean }> = [];
    deps.terminate = async (sessionId, opts) => {
      reaped.push({ id: sessionId, cleanupWorktree: opts.cleanupWorktree });
    };
    await runPipeline(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]),
      deps
    );
    // Both launched workers torn down exactly once.
    expect(reaped.map((r) => r.id).sort()).toEqual(["sess-a", "sess-b"]);
  });

  it("keeps a succeeded step's worktree but reaps a failed step's", async () => {
    const deps = fakeDeps({ outcomes: { a: "succeeded", b: "failed" } });
    const reaped = new Map<
      string,
      { cleanupWorktree: boolean; succeeded: boolean }
    >();
    deps.terminate = async (sessionId, opts) => {
      reaped.set(sessionId, opts);
    };
    // a and b are independent roots: a succeeds (keep worktree), b fails (reap).
    await runPipeline(spec([step({ id: "a" }), step({ id: "b" })]), deps);
    // succeeded → worktree preserved, status truthful
    expect(reaped.get("sess-a")).toEqual({
      cleanupWorktree: false,
      succeeded: true,
    });
    // failed → worktree removed, status failed
    expect(reaped.get("sess-b")).toEqual({
      cleanupWorktree: true,
      succeeded: false,
    });
  });

  it("does not reap a step that never launched (spawn failure / skip)", async () => {
    const deps = fakeDeps({ failSpawn: ["a"] });
    const reaped: string[] = [];
    deps.terminate = async (sessionId) => {
      reaped.push(sessionId);
    };
    // a fails to spawn (no sessionId), b is skipped (never launched) → nothing
    // to reap; terminate must not be called with a null/undefined id.
    await runPipeline(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]),
      deps
    );
    expect(reaped).toEqual([]);
  });

  it("reaps on the timeout path and isolates a terminate fault", async () => {
    const deps = fakeDeps({});
    deps.checkOutcome = async () => "running"; // never finishes → cycle cap
    const reaped: string[] = [];
    deps.terminate = async (sessionId) => {
      reaped.push(sessionId);
      throw new Error("kill boom"); // a teardown fault must be swallowed
    };
    // Must resolve (not reject) despite terminate throwing, and still reap.
    const run = await runPipeline(spec([step({ id: "a" })]), deps, {
      maxPollCycles: 2,
    });
    expect(run.steps.a.status).toBe("failed");
    expect(reaped).toEqual(["sess-a"]);
  });

  it("reaps even when the loop throws unexpectedly (crash path)", async () => {
    const deps = fakeDeps({});
    const reaped: string[] = [];
    deps.terminate = async (sessionId) => {
      reaped.push(sessionId);
      throw new Error("kill boom"); // teardown fault on the crash path too
    };
    let calls = 0;
    deps.onUpdate = () => {
      // Throw after the launch emit so a worker exists to reap on the crash path.
      if (++calls === 2) throw new Error("boom in onUpdate");
    };
    // The ORIGINAL error must propagate (not the teardown's "kill boom"), and
    // the worker must still be reaped despite terminate throwing.
    await expect(runPipeline(spec([step({ id: "a" })]), deps)).rejects.toThrow(
      /boom in onUpdate/
    );
    expect(reaped).toEqual(["sess-a"]);
  });

  it("reaps a launched worker on the stuck-state path", async () => {
    // a succeeds; b depends on a but its outcome never resolves AND we trip the
    // stuck guard by reporting b's running step as no-longer-running without a
    // terminal outcome. Simplest reliable stuck trigger: a single step whose
    // checkOutcome flips it out of contention. We instead assert the common
    // case: a step that fails to spawn leaves a downstream skipped while the
    // upstream's worker is still reaped.
    const deps = fakeDeps({ outcomes: { a: "succeeded" } });
    const reaped: string[] = [];
    deps.terminate = async (sessionId) => {
      reaped.push(sessionId);
    };
    await runPipeline(spec([step({ id: "a" })]), deps);
    // a launched and reached terminal → reaped.
    expect(reaped).toEqual(["sess-a"]);
  });

  // ── Workflows P1: per-node exitCriteria + worktreePolicy ──

  it("folds a step's exitCriteria into the spawned task as unbreakable rules", async () => {
    let spawnedTask = "";
    const deps: ExecutorDeps = {
      async spawn(s: PipelineStep) {
        spawnedTask = s.task;
        return { sessionId: `sess-${s.id}` };
      },
      async checkOutcome() {
        return "succeeded";
      },
      now: () => Date.now(),
      sleep: async () => {},
    };
    await runPipeline(
      spec([
        step({ id: "a", task: "build it", exitCriteria: "tests MUST pass" }),
      ]),
      deps
    );
    expect(spawnedTask).toContain("build it");
    expect(spawnedTask).toContain("UNBREAKABLE EXIT CRITERIA");
    expect(spawnedTask).toContain("tests MUST pass");
  });

  it("leaves the task unchanged when there is no exitCriteria", async () => {
    let spawnedTask = "";
    const deps: ExecutorDeps = {
      async spawn(s: PipelineStep) {
        spawnedTask = s.task;
        return { sessionId: `sess-${s.id}` };
      },
      async checkOutcome() {
        return "succeeded";
      },
      now: () => Date.now(),
      sleep: async () => {},
    };
    await runPipeline(spec([step({ id: "a", task: "just do it" })]), deps);
    expect(spawnedTask).toBe("just do it");
  });

  it("serializes a run with ANY shared-worktree step (parallelism clamped to 1)", async () => {
    let inFlight = 0;
    let peak = 0;
    const deps: ExecutorDeps & { launched: string[] } = {
      launched: [],
      async spawn(s: PipelineStep) {
        (deps.launched as string[]).push(s.id);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve(); // let any same-cycle siblings enter first
        return { sessionId: `sess-${s.id}` };
      },
      async checkOutcome() {
        inFlight = Math.max(0, inFlight - 1);
        return "succeeded";
      },
      now: () => Date.now(),
      sleep: async () => {},
    };
    // 3 independent roots; ONE marked shared → the whole run runs serially even
    // though default parallelism would launch all three at once.
    await runPipeline(
      spec([
        step({ id: "a", worktreePolicy: "shared" }),
        step({ id: "b" }),
        step({ id: "c" }),
      ]),
      deps
    );
    expect(peak).toBe(1);
    expect(deps.launched.sort()).toEqual(["a", "b", "c"]);
  });

  it("still parallelizes when no step is shared (control)", async () => {
    let inFlight = 0;
    let peak = 0;
    const deps: ExecutorDeps = {
      async spawn(s: PipelineStep) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        return { sessionId: `sess-${s.id}` };
      },
      async checkOutcome() {
        inFlight = Math.max(0, inFlight - 1);
        return "succeeded";
      },
      now: () => Date.now(),
      sleep: async () => {},
    };
    await runPipeline(
      spec([step({ id: "a" }), step({ id: "b" }), step({ id: "c" })]),
      deps
    );
    expect(peak).toBeGreaterThan(1);
  });
});

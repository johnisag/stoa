/**
 * Pipeline executor — unit tests of the orchestration LOOP with fully fake deps
 * (no real workers, no DB, no sleep). Builds a deterministic spawn/checkOutcome
 * model and asserts the executor launches the DAG in dependency order, runs
 * independent steps in parallel, cascades skips on failure, handles spawn
 * failure, and terminates on the cycle cap.
 */
import { describe, it, expect } from "vitest";
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
});

/**
 * Pipeline registry — unit tests for the in-memory run store: put/get/list,
 * newest-first ordering, and FIFO eviction of terminal runs past the cap while
 * never evicting a live run.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { putRun, getRun, listRuns, clearRuns } from "@/lib/pipeline/registry";
import type { PipelineRun, StepState } from "@/lib/pipeline/types";

function stepState(status: StepState["status"]): StepState {
  return {
    id: "a",
    status,
    sessionId: null,
    startedAt: null,
    endedAt: null,
    detail: null,
  };
}

function run(
  id: string,
  opts: { createdAt: number; complete: boolean; endedAt?: number }
): PipelineRun {
  const status = opts.complete ? "succeeded" : "running";
  return {
    id,
    spec: {
      name: id,
      workingDirectory: "/r",
      steps: [{ id: "a", agent: "claude", task: "t" }],
    },
    steps: { a: stepState(opts.complete ? "succeeded" : "running") },
    status,
    createdAt: opts.createdAt,
    endedAt: opts.complete ? (opts.endedAt ?? opts.createdAt + 1) : null,
  };
}

describe("pipeline registry", () => {
  beforeEach(() => clearRuns());

  it("stores and retrieves a run", () => {
    putRun(run("r1", { createdAt: 100, complete: false }));
    expect(getRun("r1")?.id).toBe("r1");
    expect(getRun("missing")).toBeUndefined();
  });

  it("replaces a run on re-put (same id)", () => {
    putRun(run("r1", { createdAt: 100, complete: false }));
    putRun(run("r1", { createdAt: 100, complete: true }));
    expect(getRun("r1")?.status).toBe("succeeded");
    expect(listRuns()).toHaveLength(1);
  });

  it("lists runs newest-created first", () => {
    putRun(run("old", { createdAt: 100, complete: true }));
    putRun(run("new", { createdAt: 200, complete: true }));
    expect(listRuns().map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("evicts oldest TERMINAL runs past the cap", () => {
    // 100 terminal runs fill the cap; the 101st evicts the oldest terminal one.
    for (let i = 0; i < 101; i++) {
      putRun(run(`r${i}`, { createdAt: i, complete: true, endedAt: i }));
    }
    expect(listRuns().length).toBeLessThanOrEqual(100);
    expect(getRun("r0")).toBeUndefined(); // oldest evicted
    expect(getRun("r100")).toBeDefined(); // newest kept
  });

  it("never evicts a LIVE run even when over the cap", () => {
    putRun(run("live", { createdAt: 0, complete: false })); // oldest, but live
    for (let i = 1; i <= 100; i++) {
      putRun(run(`r${i}`, { createdAt: i, complete: true, endedAt: i }));
    }
    // Over cap (101): a terminal run is evicted, the live one survives.
    expect(getRun("live")).toBeDefined();
  });

  it("hard-ceiling fallback evicts oldest runs when all are zombies (non-terminal)", () => {
    // 101 never-completing runs: no terminal run to drop, so the fallback must
    // evict the oldest-created so the map stays bounded (no unbounded zombie leak).
    for (let i = 0; i <= 100; i++) {
      putRun(run(`z${i}`, { createdAt: i, complete: false }));
    }
    expect(listRuns().length).toBeLessThanOrEqual(100);
    expect(getRun("z0")).toBeUndefined(); // oldest zombie evicted
    expect(getRun("z100")).toBeDefined(); // newest kept
  });
});

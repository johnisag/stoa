/**
 * Pipeline outputs — the data channel between steps.
 *
 * Covers (all without real agents/worktrees):
 *  - interpolateTask: PURE substitution of `{{steps.<id>.output}}` placeholders
 *    (single, multiple, repeated, none, unknown/empty-map semantics).
 *  - extractOutputRefs: which upstream ids a task references.
 *  - validateSpec: a `{{steps.X.output}}` ref outside the dependency closure
 *    (unknown / self / non-dependency) is a hard validation error; a ref to a
 *    transitive dependency is accepted.
 *  - isSafeOutputFile + the validateSpec outputFile guard (no traversal/absolute).
 *  - STOA_DEFAULT_OUTPUT_FILE constant.
 *  - The executor's read-and-store wiring, exercised through a tiny temp-file
 *    readOutput dep (no agent), asserting a downstream task receives an upstream
 *    output and that a missing file degrades to "".
 *  - The default-deps readOutput helper reading a real temp file.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "fs/promises";
import path from "path";
import os from "os";

// default-deps pulls in orchestration/db/status-detector at import time (better-
// sqlite3 + the session backend). The readOutput helper we test here only uses
// fs/path, so stub those heavy modules — mirrors pipeline-default-deps.test.ts —
// to keep this file hermetic on all three OSes.
vi.mock("@/lib/orchestration", () => ({
  spawnWorker: vi.fn(),
  killWorker: vi.fn(),
}));
vi.mock("@/lib/status-detector", () => ({
  statusDetector: { getStatus: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: {}, queries: { getSession: () => ({}) } }));

import {
  interpolateTask,
  extractOutputRefs,
  validateSpec,
  isSafeOutputFile,
  STOA_DEFAULT_OUTPUT_FILE,
} from "@/lib/pipeline/engine";
import { runPipeline } from "@/lib/pipeline/executor";
import type {
  ExecutorDeps,
  StepOutcome,
  SpawnResult,
} from "@/lib/pipeline/executor";
import type { PipelineSpec, PipelineStep } from "@/lib/pipeline/types";

function step(over: Partial<PipelineStep> & { id: string }): PipelineStep {
  return { agent: "claude", task: `do ${over.id}`, ...over };
}
function spec(steps: PipelineStep[]): PipelineSpec {
  return { name: "p", workingDirectory: "/repo", steps };
}

// ── interpolateTask (PURE) ──────────────────────────────────────────────────

describe("interpolateTask", () => {
  it("returns the task unchanged when there are no placeholders", () => {
    expect(interpolateTask("just a plain task", {})).toBe("just a plain task");
    expect(interpolateTask("a {{not.a.ref}} b", { a: "x" })).toBe(
      "a {{not.a.ref}} b"
    );
  });

  it("substitutes a single reference", () => {
    expect(
      interpolateTask("review this:\n{{steps.draft.output}}", {
        draft: "the design",
      })
    ).toBe("review this:\nthe design");
  });

  it("substitutes multiple distinct references", () => {
    const out = interpolateTask(
      "A={{steps.a.output}} B={{steps.b.output}}",
      { a: "alpha", b: "beta" }
    );
    expect(out).toBe("A=alpha B=beta");
  });

  it("substitutes a repeated reference everywhere it appears", () => {
    const out = interpolateTask(
      "{{steps.x.output}} and again {{steps.x.output}}",
      { x: "ONCE" }
    );
    expect(out).toBe("ONCE and again ONCE");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(interpolateTask("v={{ steps.a.output }}", { a: "1" })).toBe("v=1");
  });

  it("replaces an id ABSENT from the map with the empty string", () => {
    // An upstream step that produced nothing reads as "".
    expect(interpolateTask("x={{steps.ghost.output}}!", {})).toBe("x=!");
  });

  it("replaces an id mapped to an empty string with the empty string", () => {
    expect(interpolateTask("x={{steps.a.output}}!", { a: "" })).toBe("x=!");
  });

  it("does NOT treat an output value as a new placeholder (no re-expansion)", () => {
    // A literal placeholder inside an upstream output must survive verbatim — it
    // is not interpreted as a reference (String.replace does not re-scan output).
    expect(
      interpolateTask("{{steps.a.output}}", {
        a: "{{steps.b.output}}",
      })
    ).toBe("{{steps.b.output}}");
  });

  it("supports ids with . _ - separators", () => {
    expect(
      interpolateTask("{{steps.impl-1.output}} {{steps.a_b.output}}", {
        "impl-1": "one",
        a_b: "two",
      })
    ).toBe("one two");
  });
});

// ── extractOutputRefs ───────────────────────────────────────────────────────

describe("extractOutputRefs", () => {
  it("returns [] when there are no references", () => {
    expect(extractOutputRefs("nothing here")).toEqual([]);
  });

  it("collects distinct ids in order, de-duplicated", () => {
    expect(
      extractOutputRefs(
        "{{steps.a.output}} {{steps.b.output}} {{steps.a.output}}"
      )
    ).toEqual(["a", "b"]);
  });

  it("is stable across calls (global-regex lastIndex isn't leaked)", () => {
    const t = "{{steps.a.output}}";
    expect(extractOutputRefs(t)).toEqual(["a"]);
    expect(extractOutputRefs(t)).toEqual(["a"]); // second call still matches
  });
});

// ── STOA_DEFAULT_OUTPUT_FILE ────────────────────────────────────────────────

describe("STOA_DEFAULT_OUTPUT_FILE", () => {
  it("is a stable relative file name", () => {
    expect(STOA_DEFAULT_OUTPUT_FILE).toBe("STOA_OUTPUT.md");
    // A relative, traversal-free path so the default is itself safe to read.
    expect(isSafeOutputFile(STOA_DEFAULT_OUTPUT_FILE)).toBe(true);
  });
});

// ── validateSpec: output references ─────────────────────────────────────────

describe("validateSpec — output references", () => {
  it("accepts a reference to a direct dependency", () => {
    const r = validateSpec(
      spec([
        step({ id: "draft" }),
        step({
          id: "review",
          dependsOn: ["draft"],
          task: "review: {{steps.draft.output}}",
        }),
      ])
    );
    expect(r.valid).toBe(true);
  });

  it("accepts a reference to a TRANSITIVE dependency", () => {
    const r = validateSpec(
      spec([
        step({ id: "a" }),
        step({ id: "b", dependsOn: ["a"] }),
        step({
          id: "c",
          dependsOn: ["b"],
          task: "uses a: {{steps.a.output}}",
        }),
      ])
    );
    expect(r.valid).toBe(true);
  });

  it("rejects a reference to an UNKNOWN step", () => {
    const r = validateSpec(
      spec([step({ id: "a", task: "x {{steps.ghost.output}}" })])
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => /output of unknown step "ghost"/.test(e.message))
    ).toBe(true);
  });

  it("rejects a step referencing its OWN output", () => {
    const r = validateSpec(
      spec([step({ id: "a", task: "loop {{steps.a.output}}" })])
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /references its own output/.test(e.message))).toBe(
      true
    );
  });

  it("rejects a reference to a NON-dependency (known but not upstream)", () => {
    // b exists, but a does not depend on it → referencing it is invalid.
    const r = validateSpec(
      spec([
        step({ id: "a", task: "x {{steps.b.output}}" }),
        step({ id: "b" }),
      ])
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => /but does not depend on it/.test(e.message))
    ).toBe(true);
  });

  it("rejects referencing a SIBLING under a shared parent (not an ancestor)", () => {
    // impl-2 depends on draft but NOT on impl-1; referencing impl-1 is invalid.
    const r = validateSpec(
      spec([
        step({ id: "draft" }),
        step({ id: "impl-1", dependsOn: ["draft"] }),
        step({
          id: "impl-2",
          dependsOn: ["draft"],
          task: "{{steps.impl-1.output}}",
        }),
      ])
    );
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => /but does not depend on it/.test(e.message))
    ).toBe(true);
  });

  it("still accepts a spec with no output references (backward compatible)", () => {
    const r = validateSpec(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })])
    );
    expect(r.valid).toBe(true);
  });
});

// ── validateSpec + isSafeOutputFile: outputFile guard ───────────────────────

describe("isSafeOutputFile", () => {
  it("accepts plain relative file names and nested relative paths", () => {
    expect(isSafeOutputFile("STOA_OUTPUT.md")).toBe(true);
    expect(isSafeOutputFile("out/result.json")).toBe(true);
    expect(isSafeOutputFile("dir\\nested\\file.txt")).toBe(true);
  });

  it("rejects empty, absolute, and traversal paths", () => {
    expect(isSafeOutputFile("")).toBe(false);
    expect(isSafeOutputFile("   ")).toBe(false);
    expect(isSafeOutputFile("/etc/passwd")).toBe(false);
    expect(isSafeOutputFile("\\windows\\system32")).toBe(false);
    expect(isSafeOutputFile("C:\\secrets.txt")).toBe(false);
    expect(isSafeOutputFile("C:/secrets.txt")).toBe(false);
    expect(isSafeOutputFile("../../etc/passwd")).toBe(false);
    expect(isSafeOutputFile("ok/../../escape")).toBe(false);
  });
});

describe("validateSpec — outputFile", () => {
  it("accepts a relative outputFile override", () => {
    const r = validateSpec(spec([step({ id: "a", outputFile: "result.json" })]));
    expect(r.valid).toBe(true);
  });

  it("rejects a traversal outputFile", () => {
    const r = validateSpec(
      spec([step({ id: "a", outputFile: "../../etc/passwd" })])
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /invalid outputFile/.test(e.message))).toBe(
      true
    );
  });

  it("rejects an absolute outputFile", () => {
    const r = validateSpec(
      spec([step({ id: "a", outputFile: "/etc/passwd" })])
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /invalid outputFile/.test(e.message))).toBe(
      true
    );
  });
});

// ── Executor: read-and-store wiring (no real agent) ─────────────────────────

/**
 * Fake deps that report success for every step and serve each step's output
 * from an in-memory map keyed by the worktree path the fake spawn assigns.
 * Records the (interpolated) task each step was spawned with so a test can
 * assert the downstream task received the upstream output.
 */
function fakeDeps(outputs: Record<string, string>): ExecutorDeps & {
  spawnedTasks: Record<string, string>;
} {
  const spawnedTasks: Record<string, string> = {};
  let clock = 1000;
  const resultByWorktree = new Map<string, string>();
  return {
    spawnedTasks,
    async spawn(s: PipelineStep): Promise<SpawnResult> {
      spawnedTasks[s.id] = s.task;
      const worktreePath = `/wt/${s.id}`;
      // The step's "output" is whatever the test mapped to its id (or "").
      if (Object.prototype.hasOwnProperty.call(outputs, s.id)) {
        resultByWorktree.set(worktreePath, outputs[s.id]);
      }
      return { sessionId: `sess-${s.id}`, worktreePath };
    },
    async checkOutcome(): Promise<StepOutcome> {
      return "succeeded";
    },
    async readOutput(result: SpawnResult): Promise<string> {
      return resultByWorktree.get(result.worktreePath ?? "") ?? "";
    },
    now: () => ++clock,
    sleep: async () => {},
  };
}

describe("runPipeline — outputs flow downstream", () => {
  it("feeds an upstream step's output into a dependent's interpolated task", async () => {
    const deps = fakeDeps({ draft: "THE DESIGN DOC" });
    const run = await runPipeline(
      spec([
        step({ id: "draft" }),
        step({
          id: "review",
          dependsOn: ["draft"],
          task: "review:\n{{steps.draft.output}}",
        }),
      ]),
      deps,
      { preValidated: true }
    );
    expect(run.status).toBe("succeeded");
    // The draft ran with its literal task; review's placeholder was resolved.
    expect(deps.spawnedTasks.draft).toBe("do draft");
    expect(deps.spawnedTasks.review).toBe("review:\nTHE DESIGN DOC");
  });

  it("resolves a placeholder for an upstream with no output to empty string", async () => {
    // draft succeeds but produced no output entry → review sees "".
    const deps = fakeDeps({});
    const run = await runPipeline(
      spec([
        step({ id: "draft" }),
        step({
          id: "review",
          dependsOn: ["draft"],
          task: "x={{steps.draft.output}}!",
        }),
      ]),
      deps,
      { preValidated: true }
    );
    expect(run.status).toBe("succeeded");
    expect(deps.spawnedTasks.review).toBe("x=!");
  });

  it("merges multiple upstream outputs into a fan-in step", async () => {
    const deps = fakeDeps({ "impl-1": "ONE", "impl-2": "TWO" });
    const run = await runPipeline(
      spec([
        step({ id: "draft" }),
        step({ id: "impl-1", dependsOn: ["draft"] }),
        step({ id: "impl-2", dependsOn: ["draft"] }),
        step({
          id: "merge",
          dependsOn: ["impl-1", "impl-2"],
          task: "a={{steps.impl-1.output}} b={{steps.impl-2.output}}",
        }),
      ]),
      deps,
      { preValidated: true }
    );
    expect(run.status).toBe("succeeded");
    expect(deps.spawnedTasks.merge).toBe("a=ONE b=TWO");
  });

  it("leaves a task without placeholders untouched (no readOutput dependence)", async () => {
    // No readOutput dep wired at all → behaves exactly as before.
    const deps = fakeDeps({});
    delete (deps as { readOutput?: unknown }).readOutput;
    const run = await runPipeline(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]),
      deps,
      { preValidated: true }
    );
    expect(run.status).toBe("succeeded");
    expect(deps.spawnedTasks.b).toBe("do b");
  });
});

// ── default-deps readOutput against a REAL temp file (cross-platform) ────────

describe("defaultExecutorDeps.readOutput (real file, no agent)", () => {
  it("reads the default output file from a worktree and tolerates a missing one", async () => {
    // Import here so the module's other (DB-touching) deps aren't needed at top.
    const { defaultExecutorDeps } = await import("@/lib/pipeline/default-deps");
    const deps = defaultExecutorDeps("conductor-1");
    expect(deps.readOutput).toBeTypeOf("function");

    const dir = await mkdtemp(path.join(os.tmpdir(), "stoa-out-"));
    try {
      await writeFile(
        path.join(dir, STOA_DEFAULT_OUTPUT_FILE),
        "hello from worktree",
        "utf8"
      );
      const present = await deps.readOutput!(
        { sessionId: "s", worktreePath: dir },
        step({ id: "a" })
      );
      expect(present).toBe("hello from worktree");

      // A custom relative outputFile.
      await writeFile(path.join(dir, "result.txt"), "custom", "utf8");
      const custom = await deps.readOutput!(
        { sessionId: "s", worktreePath: dir },
        step({ id: "a", outputFile: "result.txt" })
      );
      expect(custom).toBe("custom");

      // Missing file → "".
      const missing = await deps.readOutput!(
        { sessionId: "s", worktreePath: dir },
        step({ id: "a", outputFile: "nope.md" })
      );
      expect(missing).toBe("");

      // No worktree path → "".
      const noWt = await deps.readOutput!(
        { sessionId: "s", worktreePath: null },
        step({ id: "a" })
      );
      expect(noWt).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

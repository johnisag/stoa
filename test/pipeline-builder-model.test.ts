/**
 * Visual builder document model — PURE unit tests. Locks seeding from a spec,
 * projection back to a spec, and every mutation (add/move/update/setDependsOn/
 * remove/rename) including the dependency cascades that keep the doc internally
 * consistent (no dangling or duplicate ids). No I/O.
 */
import { describe, it, expect } from "vitest";
import {
  docFromSpec,
  docToSpec,
  uniqueStepId,
  addStep,
  moveNode,
  updateStep,
  setDependsOn,
  removeStep,
  renameStep,
  CANVAS,
  type BuilderDoc,
} from "@/lib/pipeline/builder-model";
import type { PipelineSpec, PipelineStep } from "@/lib/pipeline/types";

function step(over: Partial<PipelineStep> & { id: string }): PipelineStep {
  return { agent: "claude", task: `do ${over.id}`, ...over };
}

function spec(steps: PipelineStep[]): PipelineSpec {
  return { name: "wf", workingDirectory: "/repo", steps };
}

function ids(doc: BuilderDoc) {
  return doc.nodes.map((n) => n.step.id);
}

describe("docFromSpec / docToSpec", () => {
  it("seeds positions from layout depth and row", () => {
    const doc = docFromSpec(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })])
    );
    const a = doc.nodes.find((n) => n.step.id === "a")!;
    const b = doc.nodes.find((n) => n.step.id === "b")!;
    expect(a.x).toBe(CANVAS.PAD); // level 0
    expect(b.x).toBe(CANVAS.PAD + CANVAS.COL_W); // level 1, downstream
    expect(a.y).toBe(CANVAS.PAD); // both row 0 in their column
    expect(b.y).toBe(CANVAS.PAD);
  });

  it("round-trips the spec structure (positions dropped)", () => {
    const original = spec([
      step({ id: "a", name: "Research" }),
      step({ id: "b", dependsOn: ["a"], exitCriteria: "tests pass" }),
    ]);
    expect(docToSpec(docFromSpec(original))).toEqual(original);
  });

  it("tolerates a missing name/workingDirectory", () => {
    const doc = docFromSpec({
      steps: [step({ id: "a" })],
    } as unknown as PipelineSpec);
    expect(doc.name).toBe("");
    expect(doc.workingDirectory).toBe("");
  });
});

describe("uniqueStepId", () => {
  it("returns the base when free, else suffixes -2, -3…", () => {
    const doc = docFromSpec(spec([step({ id: "step" }), step({ id: "step-2" })]));
    expect(uniqueStepId(doc)).toBe("step-3");
    expect(uniqueStepId(docFromSpec(spec([step({ id: "a" })])))).toBe("step");
  });
});

describe("addStep", () => {
  it("appends a unique-id step at the given position with the default agent", () => {
    const doc = addStep(docFromSpec(spec([step({ id: "step" })])), 300, 120);
    expect(ids(doc)).toEqual(["step", "step-2"]);
    const added = doc.nodes[1];
    expect(added).toMatchObject({ x: 300, y: 120 });
    expect(added.step).toMatchObject({ agent: "claude", task: "" });
  });

  it("honors an explicit agent", () => {
    const doc = addStep(docFromSpec(spec([])), 0, 0, "codex");
    expect(doc.nodes[0].step.agent).toBe("codex");
  });
});

describe("moveNode", () => {
  it("moves only the target node and clamps negatives to 0", () => {
    const doc = moveNode(
      docFromSpec(spec([step({ id: "a" }), step({ id: "b" })])),
      "a",
      -50,
      80
    );
    const a = doc.nodes.find((n) => n.step.id === "a")!;
    expect(a).toMatchObject({ x: 0, y: 80 });
    // b untouched
    expect(doc.nodes.find((n) => n.step.id === "b")!.x).toBe(CANVAS.PAD);
  });
});

describe("updateStep", () => {
  it("merges a field patch without touching others", () => {
    const doc = updateStep(
      docFromSpec(spec([step({ id: "a", name: "old" })])),
      "a",
      { name: "new", worktreePolicy: "shared" }
    );
    expect(doc.nodes[0].step).toMatchObject({
      id: "a",
      name: "new",
      worktreePolicy: "shared",
    });
  });
});

describe("setDependsOn", () => {
  it("dedupes and drops a self-dependency", () => {
    const doc = setDependsOn(
      docFromSpec(spec([step({ id: "a" }), step({ id: "b" })])),
      "b",
      ["a", "a", "b"]
    );
    expect(doc.nodes.find((n) => n.step.id === "b")!.step.dependsOn).toEqual([
      "a",
    ]);
  });

  it("clears dependsOn to undefined when empty", () => {
    const doc = setDependsOn(
      docFromSpec(spec([step({ id: "a", dependsOn: [] })])),
      "a",
      []
    );
    expect(doc.nodes[0].step.dependsOn).toBeUndefined();
  });
});

describe("removeStep", () => {
  it("removes the node and strips it from dependents", () => {
    const doc = removeStep(
      docFromSpec(
        spec([
          step({ id: "a" }),
          step({ id: "b", dependsOn: ["a", "x"] }),
        ])
      ),
      "a"
    );
    expect(ids(doc)).toEqual(["b"]);
    expect(doc.nodes[0].step.dependsOn).toEqual(["x"]);
  });

  it("drops a now-empty dependsOn to undefined", () => {
    const doc = removeStep(
      docFromSpec(spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })])),
      "a"
    );
    expect(doc.nodes[0].step.dependsOn).toBeUndefined();
  });
});

describe("renameStep", () => {
  it("renames and cascades into dependents' dependsOn", () => {
    const doc = renameStep(
      docFromSpec(
        spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })])
      ),
      "a",
      "research"
    );
    expect(ids(doc)).toEqual(["research", "b"]);
    expect(doc.nodes.find((n) => n.step.id === "b")!.step.dependsOn).toEqual([
      "research",
    ]);
  });

  it("is a no-op for an empty, unchanged, or colliding new id", () => {
    const base = docFromSpec(
      spec([step({ id: "a" }), step({ id: "b" })])
    );
    expect(renameStep(base, "a", "")).toBe(base);
    expect(renameStep(base, "a", "a")).toBe(base);
    expect(ids(renameStep(base, "a", "b"))).toEqual(["a", "b"]); // collision ignored
  });
});

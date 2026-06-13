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
  connect,
  disconnect,
  removeStep,
  renameStep,
  serializeBuilderDoc,
  parseBuilderDoc,
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

describe("connect / disconnect", () => {
  const base = () =>
    docFromSpec(spec([step({ id: "a" }), step({ id: "b" })]));

  it("connect adds from → to (to depends on from)", () => {
    const doc = connect(base(), "a", "b");
    expect(doc.nodes.find((n) => n.step.id === "b")!.step.dependsOn).toEqual([
      "a",
    ]);
  });

  it("connect is a no-op for self, unknown target, or duplicate edge", () => {
    const b = base();
    expect(connect(b, "a", "a")).toBe(b); // self
    expect(connect(b, "a", "ghost")).toBe(b); // unknown target
    const once = connect(b, "a", "b");
    expect(connect(once, "a", "b")).toBe(once); // duplicate
  });

  it("disconnect removes the edge and clears an emptied dependsOn", () => {
    const doc = disconnect(connect(base(), "a", "b"), "a", "b");
    expect(doc.nodes.find((n) => n.step.id === "b")!.step.dependsOn).toBeUndefined();
  });

  it("disconnect is a no-op for an absent edge", () => {
    const b = base();
    expect(disconnect(b, "a", "b")).toBe(b);
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

describe("serializeBuilderDoc / parseBuilderDoc", () => {
  it("round-trips a doc with positions", () => {
    const d = docFromSpec(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })])
    );
    expect(parseBuilderDoc(serializeBuilderDoc(d))).toEqual(d);
  });

  it("returns null on non-JSON or a non-doc shape", () => {
    expect(parseBuilderDoc("{ not json")).toBeNull();
    expect(parseBuilderDoc("42")).toBeNull();
    expect(parseBuilderDoc(JSON.stringify({ name: "x" }))).toBeNull(); // no nodes
    expect(
      parseBuilderDoc(JSON.stringify({ name: "x", workingDirectory: 1, nodes: [] }))
    ).toBeNull();
  });

  it("strips a malformed dependsOn but keeps the step (trust boundary)", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      nodes: [
        // dependsOn is a number → must not ride into the stored step (it would
        // later throw in validateSpec); the step itself is kept, deps dropped.
        { step: { id: "a", agent: "claude", task: "t", dependsOn: 42 }, x: 0, y: 0 },
        // array with a non-string entry → also dropped.
        {
          step: { id: "b", agent: "claude", task: "t", dependsOn: ["a", 7] },
          x: 1,
          y: 1,
        },
      ],
    });
    const parsed = parseBuilderDoc(raw);
    expect(parsed?.nodes.map((n) => n.step.id)).toEqual(["a", "b"]);
    expect(parsed?.nodes[0].step.dependsOn).toBeUndefined();
    expect(parsed?.nodes[1].step.dependsOn).toBeUndefined();
  });

  it("preserves the known optional step fields", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      nodes: [
        {
          step: {
            id: "a",
            agent: "claude",
            task: "t",
            name: "A",
            model: "opus",
            dependsOn: [],
            exitCriteria: "tests pass",
            worktreePolicy: "shared",
            outputFile: "out.md",
            junk: "DROP ME",
          },
          x: 0,
          y: 0,
        },
      ],
    });
    const step = parseBuilderDoc(raw)!.nodes[0].step as unknown as Record<
      string,
      unknown
    >;
    expect(step).toMatchObject({
      id: "a",
      name: "A",
      model: "opus",
      exitCriteria: "tests pass",
      worktreePolicy: "shared",
      outputFile: "out.md",
    });
    expect(step.junk).toBeUndefined(); // unknown field dropped
  });

  it("drops malformed nodes but keeps the well-formed ones", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      nodes: [
        { step: { id: "a", agent: "claude", task: "t" }, x: 1, y: 2 },
        { step: { id: "bad" }, x: 0, y: 0 }, // missing agent/task
        { x: 5, y: 5 }, // no step
        { step: { id: "c", agent: "claude", task: "t" }, x: "nope", y: 0 }, // bad coord
      ],
    });
    const parsed = parseBuilderDoc(raw);
    expect(parsed?.nodes.map((n) => n.step.id)).toEqual(["a"]);
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

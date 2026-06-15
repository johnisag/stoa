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
  uniqueNoteId,
  nextAutoPosition,
  dedupeStepIds,
  addStep,
  addPresetStep,
  addNote,
  moveNote,
  updateNote,
  removeNote,
  moveNode,
  updateStep,
  setDependsOn,
  connect,
  outputRefToken,
  insertOutputRef,
  disconnect,
  removeStep,
  renameStep,
  duplicateStep,
  duplicateNodes,
  deleteNodes,
  DUPLICATE_OFFSET,
  relayout,
  setProject,
  setWorktree,
  docFromImportedJson,
  serializeBuilderDoc,
  parseBuilderDoc,
  wrapNoteText,
  CANVAS,
  type BuilderDoc,
  type BuilderNote,
} from "@/lib/pipeline/builder-model";
import type { PipelineSpec, PipelineStep } from "@/lib/pipeline/types";
import { interpolateTask } from "@/lib/pipeline/engine";

function step(over: Partial<PipelineStep> & { id: string }): PipelineStep {
  return { agent: "claude", task: `do ${over.id}`, ...over };
}

function spec(steps: PipelineStep[]): PipelineSpec {
  return { name: "wf", workingDirectory: "/repo", steps };
}

function ids(doc: BuilderDoc) {
  return doc.nodes.map((n) => n.step.id);
}

function note(over: Partial<BuilderNote> & { id: string }): BuilderNote {
  return { text: `note ${over.id}`, x: 0, y: 0, ...over };
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

  it("does not alias the source spec's step objects (immutability)", () => {
    const original = spec([step({ id: "a", dependsOn: ["x"] })]);
    const doc = docFromSpec(original);
    // Mutating the doc's node must not reach back into the source spec.
    doc.nodes[0].step.id = "mutated";
    doc.nodes[0].step.dependsOn!.push("y");
    expect(original.steps[0].id).toBe("a");
    expect(original.steps[0].dependsOn).toEqual(["x"]);
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
    const doc = docFromSpec(
      spec([step({ id: "step" }), step({ id: "step-2" })])
    );
    expect(uniqueStepId(doc)).toBe("step-3");
    expect(uniqueStepId(docFromSpec(spec([step({ id: "a" })])))).toBe("step");
  });
});

describe("nextAutoPosition", () => {
  it("cascades every fourth node to a new row", () => {
    let doc = docFromSpec(spec([]));
    expect(nextAutoPosition(doc)).toMatchObject({
      x: CANVAS.PAD,
      y: CANVAS.PAD,
    });
    doc = addStep(doc, 0, 0);
    doc = addStep(doc, 0, 0);
    doc = addStep(doc, 0, 0);
    doc = addStep(doc, 0, 0);
    expect(nextAutoPosition(doc)).toMatchObject({
      x: CANVAS.PAD,
      y: CANVAS.PAD + CANVAS.NODE_H + 40,
    });
  });
});

describe("dedupeStepIds", () => {
  it("renames duplicate ids and rewrites dependsOn", () => {
    const doc = dedupeStepIds(
      docFromSpec(
        spec([
          step({ id: "a" }),
          step({ id: "a" }),
          step({ id: "b", dependsOn: ["a"] }),
        ])
      )
    );
    expect(ids(doc)).toEqual(["a", "a-2", "b"]);
    expect(doc.nodes.find((n) => n.step.id === "b")!.step.dependsOn).toEqual([
      "a",
    ]);
  });

  it("is a no-op when ids are already unique", () => {
    const doc = docFromSpec(spec([step({ id: "a" }), step({ id: "b" })]));
    expect(dedupeStepIds(doc)).toEqual(doc);
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

describe("addPresetStep", () => {
  it("appends a step from a preset at the next auto slot, copying agent/task/exitCriteria", () => {
    const doc = addPresetStep(docFromSpec(spec([])), {
      id: "review",
      agent: "hermes",
      task: "Review the change",
      exitCriteria: "No findings remain",
    });
    expect(ids(doc)).toEqual(["review"]);
    expect(doc.nodes[0]).toMatchObject(nextAutoPosition(docFromSpec(spec([]))));
    expect(doc.nodes[0].step).toMatchObject({
      id: "review",
      agent: "hermes",
      task: "Review the change",
      exitCriteria: "No findings remain",
    });
  });

  it("derives a unique id from the preset id on collision", () => {
    let doc = addPresetStep(docFromSpec(spec([])), {
      id: "research",
      agent: "claude",
      task: "t",
    });
    doc = addPresetStep(doc, { id: "research", agent: "claude", task: "t" });
    expect(ids(doc)).toEqual(["research", "research-2"]);
  });

  it("omits exitCriteria when the preset has none", () => {
    const doc = addPresetStep(docFromSpec(spec([])), {
      id: "implement",
      agent: "claude",
      task: "t",
    });
    expect(doc.nodes[0].step.exitCriteria).toBeUndefined();
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
  const base = () => docFromSpec(spec([step({ id: "a" }), step({ id: "b" })]));

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
    expect(
      doc.nodes.find((n) => n.step.id === "b")!.step.dependsOn
    ).toBeUndefined();
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
        spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a", "x"] })])
      ),
      "a"
    );
    expect(ids(doc)).toEqual(["b"]);
    expect(doc.nodes[0].step.dependsOn).toEqual(["x"]);
  });

  it("drops a now-empty dependsOn to undefined", () => {
    const doc = removeStep(
      docFromSpec(
        spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })])
      ),
      "a"
    );
    expect(doc.nodes[0].step.dependsOn).toBeUndefined();
  });
});

describe("relayout", () => {
  it("re-snaps hand-moved nodes back to the topological layout", () => {
    const base = docFromSpec(
      spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })])
    );
    const messy = moveNode(base, "b", 999, 999);
    const tidy = relayout(messy);
    const a = tidy.nodes.find((n) => n.step.id === "a")!;
    const b = tidy.nodes.find((n) => n.step.id === "b")!;
    expect(a).toMatchObject({ x: CANVAS.PAD, y: CANVAS.PAD });
    expect(b).toMatchObject({ x: CANVAS.PAD + CANVAS.COL_W, y: CANVAS.PAD });
    // steps + edges preserved
    expect(b.step.dependsOn).toEqual(["a"]);
  });
});

describe("docFromImportedJson", () => {
  it("imports a BuilderDoc JSON (positions preserved)", () => {
    const d = moveNode(docFromSpec(spec([step({ id: "a" })])), "a", 120, 80);
    expect(docFromImportedJson(serializeBuilderDoc(d))).toEqual(d);
  });

  it("imports a bare PipelineSpec JSON (positions seeded from layout)", () => {
    const s = spec([step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })]);
    const imported = docFromImportedJson(JSON.stringify(s));
    expect(imported?.nodes.map((n) => n.step.id)).toEqual(["a", "b"]);
    expect(imported?.nodes[1]).toMatchObject({ x: CANVAS.PAD + CANVAS.COL_W });
  });

  it("returns null for JSON that is neither a doc nor a spec", () => {
    expect(docFromImportedJson("not json")).toBeNull();
    expect(docFromImportedJson(JSON.stringify({ foo: 1 }))).toBeNull();
  });

  it("returns null (never throws) on a non-string name/workingDirectory", () => {
    // A near-valid spec/doc whose name isn't a string must not crash the import.
    expect(() => docFromImportedJson('{"name":1,"steps":[]}')).not.toThrow();
    expect(docFromImportedJson('{"name":1,"steps":[]}')).toBeNull();
    expect(
      docFromImportedJson('{"name":"x","workingDirectory":2,"steps":[]}')
    ).toBeNull();
  });

  it("dedupes duplicate step ids on import", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      nodes: [
        { step: { id: "a", agent: "claude", task: "t" }, x: 0, y: 0 },
        { step: { id: "a", agent: "claude", task: "t2" }, x: 10, y: 10 },
      ],
    });
    const imported = docFromImportedJson(raw)!;
    expect(imported.nodes.map((n) => n.step.id)).toEqual(["a", "a-2"]);
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
      parseBuilderDoc(
        JSON.stringify({ name: "x", workingDirectory: 1, nodes: [] })
      )
    ).toBeNull();
  });

  it("strips a malformed dependsOn but keeps the step (trust boundary)", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      nodes: [
        // dependsOn is a number → must not ride into the stored step (it would
        // later throw in validateSpec); the step itself is kept, deps dropped.
        {
          step: { id: "a", agent: "claude", task: "t", dependsOn: 42 },
          x: 0,
          y: 0,
        },
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

describe("duplicateStep", () => {
  it("clones a node with a unique id, offset position, and cleared dependsOn", () => {
    const base = docFromSpec(
      spec([
        step({ id: "a", name: "Research", exitCriteria: "tests pass" }),
        step({ id: "b", dependsOn: ["a"] }),
      ])
    );
    const doc = duplicateStep(base, "a");
    expect(doc.nodes.length).toBe(3);
    const copy = doc.nodes[2];
    expect(copy.step.id).toBe("a-2");
    expect(copy.step.name).toBe("Research");
    expect(copy.step.exitCriteria).toBe("tests pass");
    expect(copy.step.dependsOn).toBeUndefined();
    // Copy is placed down-right of the source and does not overlap it.
    expect(copy.x).toBeGreaterThan(base.nodes[0].x);
    expect(copy.y).toBeGreaterThan(base.nodes[0].y);
    expect(
      copy.x >= base.nodes[0].x + CANVAS.NODE_W ||
        copy.y >= base.nodes[0].y + CANVAS.NODE_H
    ).toBe(true);
    // Original and dependent untouched.
    expect(doc.nodes[0].step.id).toBe("a");
    expect(doc.nodes[1].step.dependsOn).toEqual(["a"]);
  });

  it("increments the suffix when the derived id is taken", () => {
    const base = docFromSpec(spec([step({ id: "a" }), step({ id: "a-2" })]));
    const doc = duplicateStep(base, "a");
    expect(doc.nodes[2].step.id).toBe("a-3");
  });

  it("does not stack repeated duplicates on top of each other", () => {
    const base = docFromSpec(spec([step({ id: "a" })]));
    const once = duplicateStep(base, "a");
    const twice = duplicateStep(once, "a");
    const first = once.nodes[1];
    const second = twice.nodes[2];
    const overlap =
      first.x < second.x + CANVAS.NODE_W &&
      first.x + CANVAS.NODE_W > second.x &&
      first.y < second.y + CANVAS.NODE_H &&
      first.y + CANVAS.NODE_H > second.y;
    expect(overlap).toBe(false);
  });

  it("is a no-op if the source id is not found", () => {
    const base = docFromSpec(spec([step({ id: "a" })]));
    expect(duplicateStep(base, "ghost")).toBe(base);
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
    const base = docFromSpec(spec([step({ id: "a" }), step({ id: "b" })]));
    expect(renameStep(base, "a", "")).toBe(base);
    expect(renameStep(base, "a", "a")).toBe(base);
    expect(ids(renameStep(base, "a", "b"))).toEqual(["a", "b"]); // collision ignored
  });

  it("rewrites {{steps.<oldId>.output}} placeholders in task and exitCriteria", () => {
    const doc = renameStep(
      docFromSpec(
        spec([
          step({ id: "a" }),
          step({
            id: "b",
            dependsOn: ["a"],
            task: "Read {{steps.a.output}} and summarize",
            exitCriteria: "Uses {{steps.a.output}}",
          }),
          step({ id: "c", task: "Also {{steps.a.output}}" }),
        ])
      ),
      "a",
      "research"
    );
    const b = doc.nodes.find((n) => n.step.id === "b")!.step;
    expect(b.task).toBe("Read {{steps.research.output}} and summarize");
    expect(b.exitCriteria).toBe("Uses {{steps.research.output}}");
    const c = doc.nodes.find((n) => n.step.id === "c")!.step;
    expect(c.task).toBe("Also {{steps.research.output}}");
  });

  it("treats dollar signs in the new id as literal text", () => {
    const doc = renameStep(
      docFromSpec(
        spec([
          step({ id: "a" }),
          step({ id: "b", task: "Use {{steps.a.output}}" }),
        ])
      ),
      "a",
      "$&"
    );
    const b = doc.nodes.find((n) => n.step.id === "b")!.step;
    expect(b.task).toBe("Use {{steps.$&.output}}");
  });
});

describe("project / worktree context", () => {
  it("docToSpec prefers worktreePath over workingDirectory", () => {
    const doc: BuilderDoc = {
      name: "wf",
      workingDirectory: "/repo",
      worktreePath: "/wt/feature-1",
      nodes: [],
      notes: [],
    };
    expect(docToSpec(doc).workingDirectory).toBe("/wt/feature-1");
  });

  it("docFromSpec seeds null projectId/worktreePath", () => {
    const doc = docFromSpec(spec([step({ id: "a" })]));
    expect(doc.projectId).toBeNull();
    expect(doc.worktreePath).toBeNull();
  });

  it("parseBuilderDoc preserves projectId and worktreePath", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      projectId: "proj-1",
      worktreePath: "/wt/feature-1",
      nodes: [{ step: { id: "a", agent: "claude", task: "t" }, x: 0, y: 0 }],
    });
    const parsed = parseBuilderDoc(raw)!;
    expect(parsed.projectId).toBe("proj-1");
    expect(parsed.worktreePath).toBe("/wt/feature-1");
  });

  it("setProject updates projectId, workingDirectory, and clears worktreePath", () => {
    const base = docFromSpec(spec([step({ id: "a" })]));
    const doc = setProject(base, "proj-1", "/projects/app");
    expect(doc.projectId).toBe("proj-1");
    expect(doc.workingDirectory).toBe("/projects/app");
    expect(doc.worktreePath).toBeNull();
  });

  it("setProject with null clears projectId and keeps workingDirectory", () => {
    const base = setProject(
      docFromSpec(spec([step({ id: "a" })])),
      "proj-1",
      "/projects/app"
    );
    const doc = setProject(base, null);
    expect(doc.projectId).toBeNull();
    expect(doc.workingDirectory).toBe("/projects/app");
  });

  it("setWorktree updates worktreePath and workingDirectory to the repo path", () => {
    const base = setProject(
      docFromSpec(spec([step({ id: "a" })])),
      "proj-1",
      "/projects/app"
    );
    const doc = setWorktree(base, "/wt/feature-1", "/projects/app");
    expect(doc.worktreePath).toBe("/wt/feature-1");
    expect(doc.workingDirectory).toBe("/projects/app");
  });

  it("setWorktree falls back to the worktree path when repo path is unknown", () => {
    const base = docFromSpec(spec([step({ id: "a" })]));
    const doc = setWorktree(base, "/wt/feature-1");
    expect(doc.worktreePath).toBe("/wt/feature-1");
    expect(doc.workingDirectory).toBe("/wt/feature-1");
  });

  it("setWorktree with null keeps project workingDirectory", () => {
    const base = setProject(
      docFromSpec(spec([step({ id: "a" })])),
      "proj-1",
      "/projects/app"
    );
    const withWt = setWorktree(base, "/wt/feature-1", "/projects/app");
    const doc = setWorktree(withWt, null, "/projects/app");
    expect(doc.worktreePath).toBeNull();
    expect(doc.workingDirectory).toBe("/projects/app");
  });
});

describe("uniqueNoteId", () => {
  it("returns the base when free, else suffixes -2, -3…", () => {
    const doc = {
      ...docFromSpec(spec([])),
      notes: [note({ id: "note" })],
    };
    expect(uniqueNoteId(doc)).toBe("note-2");
    expect(uniqueNoteId({ ...doc, notes: [] })).toBe("note");
  });

  it("avoids colliding with step ids", () => {
    const doc = docFromSpec(spec([step({ id: "note" })]));
    expect(uniqueNoteId(doc)).toBe("note-2");
  });

  it("avoids colliding with both step ids and existing note ids", () => {
    const doc = {
      ...docFromSpec(spec([step({ id: "note" }), step({ id: "note-2" })])),
      notes: [note({ id: "note-3" })],
    };
    expect(uniqueNoteId(doc)).toBe("note-4");
  });
});

describe("addNote", () => {
  it("appends a note with a unique id at the given position", () => {
    const doc = addNote(docFromSpec(spec([])), 120, 80, "hello");
    expect(doc.notes.length).toBe(1);
    expect(doc.notes[0]).toMatchObject({
      id: "note",
      x: 120,
      y: 80,
      text: "hello",
    });
  });

  it("derives a unique id when the base is taken", () => {
    let doc = addNote(docFromSpec(spec([])), 0, 0);
    doc = addNote(doc, 10, 10);
    expect(doc.notes.map((n) => n.id)).toEqual(["note", "note-2"]);
  });
});

describe("moveNote", () => {
  it("moves only the target note and clamps negatives to 0", () => {
    const doc = moveNote(
      {
        ...docFromSpec(spec([])),
        notes: [note({ id: "a", x: 10, y: 10 }), note({ id: "b" })],
      },
      "a",
      -50,
      80
    );
    const a = doc.notes.find((n) => n.id === "a")!;
    expect(a).toMatchObject({ x: 0, y: 80 });
    expect(doc.notes.find((n) => n.id === "b")!.x).toBe(0);
  });
});

describe("updateNote", () => {
  it("updates the note text without touching others", () => {
    const doc = updateNote(
      {
        ...docFromSpec(spec([])),
        notes: [note({ id: "a", text: "old" }), note({ id: "b" })],
      },
      "a",
      "new"
    );
    expect(doc.notes.find((n) => n.id === "a")!.text).toBe("new");
    expect(doc.notes.find((n) => n.id === "b")!.text).toBe("note b");
  });
});

describe("removeNote", () => {
  it("removes only the target note", () => {
    const doc = removeNote(
      {
        ...docFromSpec(spec([])),
        notes: [note({ id: "a" }), note({ id: "b" })],
      },
      "a"
    );
    expect(doc.notes.map((n) => n.id)).toEqual(["b"]);
  });
});

describe("deleteNodes", () => {
  it("removes multiple steps and notes in one call", () => {
    const doc = deleteNodes(
      {
        ...docFromSpec(
          spec([
            step({ id: "a" }),
            step({ id: "b", dependsOn: ["a"] }),
            step({ id: "c" }),
          ])
        ),
        notes: [note({ id: "n1" }), note({ id: "n2" })],
      },
      ["a", "c", "n1"]
    );
    expect(ids(doc)).toEqual(["b"]);
    expect(doc.nodes[0].step.dependsOn).toBeUndefined();
    expect(doc.notes.map((n) => n.id)).toEqual(["n2"]);
  });

  it("ignores unknown ids", () => {
    const base = docFromSpec(spec([step({ id: "a" })]));
    expect(deleteNodes(base, ["ghost"])).toEqual(base);
  });
});

describe("duplicateNodes", () => {
  it("duplicates every selected step", () => {
    const doc = duplicateNodes(
      docFromSpec(
        spec([
          step({ id: "a", name: "Research" }),
          step({ id: "b", dependsOn: ["a"] }),
          step({ id: "c" }),
        ])
      ),
      ["a", "c"]
    );
    expect(ids(doc)).toEqual(["a", "b", "c", "a-2", "c-2"]);
    const a2 = doc.nodes.find((n) => n.step.id === "a-2")!;
    expect(a2.step.name).toBe("Research");
    expect(a2.step.dependsOn).toBeUndefined();
  });

  it("does not duplicate notes", () => {
    const doc = duplicateNodes(
      {
        ...docFromSpec(spec([step({ id: "a" })])),
        notes: [note({ id: "n1" })],
      },
      ["a", "n1"]
    );
    expect(ids(doc)).toEqual(["a", "a-2"]);
    expect(doc.notes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("ignores unknown ids", () => {
    const base = docFromSpec(spec([step({ id: "a" })]));
    expect(duplicateNodes(base, ["ghost"])).toEqual(base);
  });
});

describe("parseBuilderDoc / serializeBuilderDoc notes", () => {
  it("round-trips notes", () => {
    const d = {
      ...docFromSpec(spec([step({ id: "a" })])),
      notes: [
        { id: "n1", text: "hello", x: 10, y: 20, color: "yellow" as const },
        { id: "n2", text: "world", x: 30, y: 40 },
      ],
    };
    expect(parseBuilderDoc(serializeBuilderDoc(d))).toEqual(d);
  });

  it("defaults missing notes to an empty array", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      nodes: [{ step: { id: "a", agent: "claude", task: "t" }, x: 0, y: 0 }],
    });
    expect(parseBuilderDoc(raw)!.notes).toEqual([]);
  });

  it("drops malformed notes but keeps well-formed ones", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      nodes: [],
      notes: [
        { id: "good", text: "ok", x: 1, y: 2 },
        { id: "bad", text: "missing coords" },
        { id: "also-bad", text: 123, x: 0, y: 0 },
        { text: "no id", x: 0, y: 0 },
      ],
    });
    const parsed = parseBuilderDoc(raw);
    expect(parsed!.notes.map((n) => n.id)).toEqual(["good"]);
  });

  it("preserves the yellow color only", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      nodes: [],
      notes: [
        { id: "a", text: "t", x: 0, y: 0, color: "yellow" },
        { id: "b", text: "t", x: 0, y: 0, color: "red" },
      ],
    });
    const parsed = parseBuilderDoc(raw)!;
    expect(parsed.notes[0].color).toBe("yellow");
    expect(parsed.notes[1].color).toBeUndefined();
  });
});

describe("docFromImportedJson notes", () => {
  it("defaults notes to an empty array when importing a BuilderDoc without notes", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      nodes: [{ step: { id: "a", agent: "claude", task: "t" }, x: 0, y: 0 }],
    });
    expect(docFromImportedJson(raw)!.notes).toEqual([]);
  });

  it("preserves notes when importing a BuilderDoc that has them", () => {
    const raw = JSON.stringify({
      name: "wf",
      workingDirectory: "/repo",
      nodes: [],
      notes: [{ id: "n1", text: "hello", x: 10, y: 20 }],
    });
    expect(docFromImportedJson(raw)!.notes).toEqual([
      { id: "n1", text: "hello", x: 10, y: 20 },
    ]);
  });
});

describe("step/note id isolation", () => {
  it("uniqueStepId avoids note ids", () => {
    const doc = {
      ...docFromSpec(spec([step({ id: "step" })])),
      notes: [note({ id: "step-2" })],
    };
    expect(uniqueStepId(doc)).toBe("step-3");
  });

  it("renameStep rejects a note id collision", () => {
    const base = {
      ...docFromSpec(spec([step({ id: "a" }), step({ id: "b" })])),
      notes: [note({ id: "b" })],
    };
    expect(ids(renameStep(base, "a", "b"))).toEqual(["a", "b"]);
  });

  it("duplicateStep nudges away from sticky notes", () => {
    const base = {
      ...docFromSpec(spec([step({ id: "a" })])),
      notes: [
        {
          id: "n1",
          text: "t",
          x: 16 + DUPLICATE_OFFSET,
          y: 16 + DUPLICATE_OFFSET,
        },
      ],
    };
    const dup = duplicateStep(base, "a");
    const copy = dup.nodes.find((n) => n.step.id !== "a")!;
    expect(copy.x).toBeGreaterThan(DUPLICATE_OFFSET);
    expect(copy.y).toBeGreaterThan(DUPLICATE_OFFSET);
  });

  it("nextAutoPosition counts notes as well as nodes", () => {
    const doc = {
      ...docFromSpec(spec([])),
      notes: [note({ id: "n1" })],
    };
    const pos = nextAutoPosition(doc);
    expect(pos.x).toBe(CANVAS.PAD + (CANVAS.NODE_W + 24));
    expect(pos.y).toBe(CANVAS.PAD);
  });
});

describe("dedupeStepIds note collision", () => {
  it("renames a step that collides with a note id", () => {
    const doc = {
      ...docFromSpec(spec([step({ id: "note-1" }), step({ id: "note-1" })])),
      notes: [note({ id: "note-1" })],
    };
    const fixed = dedupeStepIds(doc);
    expect(ids(fixed)).not.toContain("note-1");
    expect(ids(fixed).every((id) => id !== "note-1")).toBe(true);
    expect(fixed.notes[0].id).toBe("note-1");
  });
});

describe("uniqueNoteId", () => {
  it("avoids ids already taken by either a node step or a note", () => {
    const doc = {
      ...docFromSpec(spec([step({ id: "note" })])),
      notes: [note({ id: "note-2" })],
    };
    // "note" is taken by a step, "note-2" by a note → next free is "note-3".
    expect(uniqueNoteId(doc)).toBe("note-3");
  });

  it("delegates to the shared allocator (same result as uniqueStepId)", () => {
    const doc = {
      ...docFromSpec(spec([step({ id: "x" })])),
      notes: [note({ id: "x-2" })],
    };
    expect(uniqueNoteId(doc, "x")).toBe(uniqueStepId(doc, "x"));
  });
});

describe("wrapNoteText", () => {
  it("returns no lines for empty text", () => {
    expect(wrapNoteText("")).toEqual([]);
  });

  it("keeps short single-line text as one line", () => {
    expect(wrapNoteText("hello")).toEqual(["hello"]);
  });

  it("preserves explicit newlines as separate lines", () => {
    expect(wrapNoteText("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("soft-wraps on spaces to fit the line width", () => {
    const lines = wrapNoteText("one two three four five", 9, 10);
    expect(lines.every((l) => l.length <= 9)).toBe(true);
    expect(lines.join(" ")).toBe("one two three four five");
  });

  it("hard-breaks a word longer than a line", () => {
    const lines = wrapNoteText("supercalifragilistic", 6, 10);
    expect(lines[0]).toBe("superc");
    expect(lines.every((l) => l.length <= 6)).toBe(true);
  });

  it("caps the number of lines and ellipsizes the last visible one", () => {
    const lines = wrapNoteText("a\nb\nc\nd\ne\nf", 24, 4);
    expect(lines).toHaveLength(4);
    expect(lines[3].endsWith("…")).toBe(true);
  });
});

describe("outputRefToken", () => {
  it("produces the exact {{steps.<id>.output}} template", () => {
    expect(outputRefToken("research")).toBe("{{steps.research.output}}");
  });

  it("round-trips with the engine's interpolateTask resolver", () => {
    // The whole point of the builder's insert menu: the token it splices in is the
    // one the engine actually resolves at run time.
    expect(
      interpolateTask(outputRefToken("research"), { research: "FINDINGS" })
    ).toBe("FINDINGS");
  });

  it("works for ids with the allowed punctuation (dot/dash/underscore)", () => {
    const id = "step-1_a.b";
    expect(interpolateTask(outputRefToken(id), { [id]: "X" })).toBe("X");
  });
});

describe("insertOutputRef", () => {
  it("splices the token at the caret AND wires the dependency in one transform", () => {
    const doc = docFromSpec(
      spec([
        step({ id: "research" }),
        step({ id: "implement", task: "use  here" }),
      ])
    );
    // caret at index 4 ("use |") with no selection
    const next = insertOutputRef(doc, "implement", "research", 4, 4);
    const impl = next.nodes.find((n) => n.step.id === "implement")!;
    expect(impl.step.task).toBe(`use ${outputRefToken("research")} here`);
    expect(impl.step.dependsOn).toContain("research");
  });

  it("replaces a selected range and doesn't duplicate an existing dependency", () => {
    const doc = docFromSpec(
      spec([
        step({ id: "a" }),
        step({ id: "b", task: "XXXX", dependsOn: ["a"] }),
      ])
    );
    const next = insertOutputRef(doc, "b", "a", 0, 4); // select all of "XXXX"
    const b = next.nodes.find((n) => n.step.id === "b")!;
    expect(b.step.task).toBe(outputRefToken("a"));
    expect(b.step.dependsOn).toEqual(["a"]);
  });

  it("clamps an out-of-range caret to the task length", () => {
    const doc = docFromSpec(
      spec([step({ id: "a" }), step({ id: "b", task: "hi" })])
    );
    const next = insertOutputRef(doc, "b", "a", 999, 999);
    expect(next.nodes.find((n) => n.step.id === "b")!.step.task).toBe(
      `hi${outputRefToken("a")}`
    );
  });

  it("no-ops for a self-reference or an unknown target", () => {
    const doc = docFromSpec(spec([step({ id: "a", task: "hi" })]));
    expect(insertOutputRef(doc, "a", "a", 0, 0)).toBe(doc);
    expect(insertOutputRef(doc, "missing", "a", 0, 0)).toBe(doc);
  });
});

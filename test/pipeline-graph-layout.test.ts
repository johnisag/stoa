/**
 * Pipeline graph layout — PURE unit tests. Locks the longest-path column
 * assignment, stable row order, edge extraction, and the fan-out/fan-in and
 * diamond topologies the SVG render draws. No I/O.
 */
import { describe, it, expect } from "vitest";
import { layoutDag } from "@/lib/pipeline/graph-layout";
import type { PipelineSpec, PipelineStep } from "@/lib/pipeline/types";

function step(over: Partial<PipelineStep> & { id: string }): PipelineStep {
  return { agent: "claude", task: `do ${over.id}`, ...over };
}

function spec(steps: PipelineStep[]): PipelineSpec {
  return { name: "g", workingDirectory: "/repo", steps };
}

function nodeById(layout: ReturnType<typeof layoutDag>) {
  return new Map(layout.nodes.map((n) => [n.id, n]));
}

describe("layoutDag", () => {
  it("returns an empty layout for no steps", () => {
    const l = layoutDag(spec([]));
    expect(l.nodes).toEqual([]);
    expect(l.edges).toEqual([]);
    expect(l.levelCount).toBe(0);
    expect(l.rowCount).toBe(0);
  });

  it("places a single root at level 0, row 0", () => {
    const l = layoutDag(spec([step({ id: "a" })]));
    expect(l.nodes).toEqual([{ id: "a", label: "a", level: 0, row: 0 }]);
    expect(l.levelCount).toBe(1);
    expect(l.rowCount).toBe(1);
  });

  it("uses step.name as the label, falling back to id", () => {
    const l = layoutDag(spec([step({ id: "a", name: "Research" })]));
    expect(nodeById(l).get("a")?.label).toBe("Research");
  });

  it("coerces a non-string name to a string label (validateSpec doesn't type it)", () => {
    // A hand-authored JSON spec can carry `"name": 123`; the label must be a
    // string so the SVG render's .length/.slice never throws.
    const bad = { agent: "claude", task: "t", id: "a", name: 123 };
    const l = layoutDag(spec([bad as unknown as PipelineStep]));
    const label = nodeById(l).get("a")?.label;
    expect(label).toBe("123");
    expect(typeof label).toBe("string");
  });

  it("assigns columns by dependency depth (a → b → c)", () => {
    const l = layoutDag(
      spec([
        step({ id: "a" }),
        step({ id: "b", dependsOn: ["a"] }),
        step({ id: "c", dependsOn: ["b"] }),
      ])
    );
    const by = nodeById(l);
    expect(by.get("a")?.level).toBe(0);
    expect(by.get("b")?.level).toBe(1);
    expect(by.get("c")?.level).toBe(2);
    expect(l.levelCount).toBe(3);
  });

  it("fans out: two children of one root share a column, distinct rows", () => {
    const l = layoutDag(
      spec([
        step({ id: "root" }),
        step({ id: "x", dependsOn: ["root"] }),
        step({ id: "y", dependsOn: ["root"] }),
      ])
    );
    const by = nodeById(l);
    expect(by.get("x")?.level).toBe(1);
    expect(by.get("y")?.level).toBe(1);
    // Stable spec order → x in row 0, y in row 1.
    expect(by.get("x")?.row).toBe(0);
    expect(by.get("y")?.row).toBe(1);
    expect(l.rowCount).toBe(2);
  });

  it("longest-path wins on a diamond — the join sits one past its deepest parent", () => {
    // a → b → d, a → d. d's depth is max(b+1, a+1) = 2, not 1.
    const l = layoutDag(
      spec([
        step({ id: "a" }),
        step({ id: "b", dependsOn: ["a"] }),
        step({ id: "d", dependsOn: ["a", "b"] }),
      ])
    );
    expect(nodeById(l).get("d")?.level).toBe(2);
  });

  it("extracts an edge per dependency", () => {
    const l = layoutDag(
      spec([
        step({ id: "a" }),
        step({ id: "b", dependsOn: ["a"] }),
        step({ id: "d", dependsOn: ["a", "b"] }),
      ])
    );
    expect(l.edges).toEqual(
      expect.arrayContaining([
        { from: "a", to: "b" },
        { from: "a", to: "d" },
        { from: "b", to: "d" },
      ])
    );
    expect(l.edges).toHaveLength(3);
  });

  it("ignores edges to unknown dependency ids (validateSpec would reject them)", () => {
    const l = layoutDag(spec([step({ id: "a", dependsOn: ["ghost"] })]));
    expect(l.edges).toEqual([]);
    expect(nodeById(l).get("a")?.level).toBe(0); // unknown dep → treated as root
  });

  it("terminates and stays bounded on a malformed cycle (a ↔ b)", () => {
    const l = layoutDag(
      spec([
        step({ id: "a", dependsOn: ["b"] }),
        step({ id: "b", dependsOn: ["a"] }),
      ])
    );
    expect(l.nodes).toHaveLength(2);
    // The cycle guard caps levels — no infinite recursion, finite columns.
    expect(l.levelCount).toBeGreaterThanOrEqual(1);
    expect(l.nodes.every((n) => Number.isFinite(n.level))).toBe(true);
  });
});

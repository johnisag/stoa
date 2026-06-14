// @vitest-environment jsdom
/**
 * useBuilderHistory — React hook tests.
 *
 * Locks the undo/redo contract: committed edits push frames, transient edits
 * mutate the working copy without growing the stack, and commit finalizes a
 * transient frame. Reset clears the stack when loading a different workflow.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBuilderHistory } from "@/hooks/useBuilderHistory";
import { docFromSpec, type BuilderDoc } from "@/lib/pipeline/builder-model";
import type { PipelineSpec, PipelineStep } from "@/lib/pipeline/types";

function step(over: Partial<PipelineStep> & { id: string }): PipelineStep {
  return { agent: "claude", task: `do ${over.id}`, ...over };
}

function spec(steps: PipelineStep[]): PipelineSpec {
  return { name: "wf", workingDirectory: "/repo", steps };
}

const EMPTY: BuilderDoc = docFromSpec(spec([]));

function addNode(doc: BuilderDoc, id: string): BuilderDoc {
  return {
    ...doc,
    nodes: [
      ...doc.nodes,
      {
        step: { id, agent: "claude", task: `do ${id}` },
        x: 10,
        y: 10,
      },
    ],
  };
}

describe("useBuilderHistory", () => {
  it("starts with the initial doc and no undo/redo", () => {
    const { result } = renderHook(() => useBuilderHistory(EMPTY));
    expect(result.current.doc).toEqual(EMPTY);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("pushes a frame on committed edits", () => {
    const { result } = renderHook(() => useBuilderHistory(EMPTY));
    act(() => {
      result.current.setDoc((d) => addNode(d, "a"));
    });
    expect(result.current.doc.nodes).toHaveLength(1);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("does not push identical committed snapshots", () => {
    const { result } = renderHook(() => useBuilderHistory(EMPTY));
    act(() => {
      result.current.setDoc((d) => addNode(d, "a"));
    });
    act(() => {
      result.current.setDoc((d) => d);
    });
    act(() => {
      result.current.setDoc((d) => d);
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("mutates the working copy on transient edits without pushing", () => {
    const { result } = renderHook(() => useBuilderHistory(EMPTY));
    act(() => {
      result.current.setDoc((d) => addNode(d, "a"));
    });
    act(() => {
      result.current.setDoc(
        (d) => ({
          ...d,
          nodes: d.nodes.map((n) => (n.step.id === "a" ? { ...n, x: 99 } : n)),
        }),
        { transient: true }
      );
    });
    expect(result.current.doc.nodes[0].x).toBe(99);
    // No new frame pushed beyond the first one.
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("commits a transient edit when setDoc is called without transient", () => {
    const { result } = renderHook(() => useBuilderHistory(EMPTY));
    act(() => {
      result.current.setDoc((d) => addNode(d, "a"));
    });
    act(() => {
      result.current.setDoc(
        (d) => ({
          ...d,
          nodes: d.nodes.map((n) => (n.step.id === "a" ? { ...n, x: 99 } : n)),
        }),
        { transient: true }
      );
    });
    act(() => {
      result.current.setDoc((d) => d);
    });
    expect(result.current.doc.nodes[0].x).toBe(99);
    expect(result.current.canUndo).toBe(true);
    // Undo reverts to the pre-drag frame (the add is still there).
    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.nodes[0].x).toBe(10);
    expect(result.current.doc.nodes).toHaveLength(1);
  });

  it("undoes and redoes committed frames", () => {
    const { result } = renderHook(() => useBuilderHistory(EMPTY));
    act(() => {
      result.current.setDoc((d) => addNode(d, "a"));
    });
    act(() => {
      result.current.setDoc((d) => addNode(d, "b"));
    });
    expect(result.current.doc.nodes).toHaveLength(2);

    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.nodes).toHaveLength(1);
    expect(result.current.canRedo).toBe(true);

    act(() => {
      result.current.redo();
    });
    expect(result.current.doc.nodes).toHaveLength(2);
    expect(result.current.canRedo).toBe(false);
  });

  it("drops redo frames when a new edit branches off an older frame", () => {
    const { result } = renderHook(() => useBuilderHistory(EMPTY));
    act(() => {
      result.current.setDoc((d) => addNode(d, "a"));
    });
    act(() => {
      result.current.setDoc((d) => addNode(d, "b"));
    });
    act(() => {
      result.current.undo();
    });
    act(() => {
      result.current.setDoc((d) => addNode(d, "c"));
    });
    expect(result.current.doc.nodes.map((n) => n.step.id)).toEqual(["a", "c"]);
    expect(result.current.canRedo).toBe(false);
  });

  it("resets the stack to a single frame", () => {
    const { result } = renderHook(() => useBuilderHistory(EMPTY));
    act(() => {
      result.current.setDoc((d) => addNode(d, "a"));
    });
    const loaded = docFromSpec(spec([step({ id: "x" })]));
    act(() => {
      result.current.reset(loaded);
    });
    expect(result.current.doc).toEqual(loaded);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("caps the stack at maxDepth", () => {
    const { result } = renderHook(() => useBuilderHistory(EMPTY, 3));
    act(() => {
      result.current.setDoc((d) => addNode(d, "a"));
    });
    act(() => {
      result.current.setDoc((d) => addNode(d, "b"));
    });
    act(() => {
      result.current.setDoc((d) => addNode(d, "c"));
    });
    // Stack is now at capacity; one more push should drop the oldest frame.
    act(() => {
      result.current.setDoc((d) => addNode(d, "d"));
    });
    expect(result.current.doc.nodes).toHaveLength(4);
    // Undo back to the oldest remaining frame ([a, b], since EMPTY was dropped
    // after c and [a] was dropped after d).
    act(() => {
      result.current.undo();
    });
    act(() => {
      result.current.undo();
    });
    expect(result.current.doc.nodes.map((n) => n.step.id)).toEqual(["a", "b"]);
    expect(result.current.canUndo).toBe(false);
  });

  it("committedDoc tracks the last committed frame, not transient edits", () => {
    const { result } = renderHook(() => useBuilderHistory(EMPTY));
    act(() => {
      result.current.setDoc((d) => addNode(d, "a"));
    });
    const committedAfterAdd = result.current.committedDoc;
    expect(committedAfterAdd.nodes).toHaveLength(1);
    expect(committedAfterAdd.nodes[0].x).toBe(10);

    // A transient edit moves the working doc but must NOT touch committedDoc —
    // this is what lets the dirty check skip work during a drag.
    act(() => {
      result.current.setDoc(
        (d) => ({
          ...d,
          nodes: d.nodes.map((n) => (n.step.id === "a" ? { ...n, x: 99 } : n)),
        }),
        { transient: true }
      );
    });
    expect(result.current.doc.nodes[0].x).toBe(99);
    expect(result.current.committedDoc).toBe(committedAfterAdd); // same frame ref
    expect(result.current.committedDoc.nodes[0].x).toBe(10);
  });
});

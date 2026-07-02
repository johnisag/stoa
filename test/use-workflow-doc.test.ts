// @vitest-environment jsdom
/**
 * useWorkflowDoc — React hook tests.
 *
 * Locks the doc-mutation + selection coupling that was extracted verbatim from
 * WorkflowBuilder: adding a step/note selects it, duplicating selects the fresh
 * copies, deleting keeps the selection consistent, and undo/redo drop the
 * selection. Composes the real useCanvasSelection so the interaction is exercised
 * exactly as the builder wires it.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWorkflowDoc } from "@/hooks/useWorkflowDoc";
import { useCanvasSelection } from "@/hooks/useCanvasSelection";
import { docFromSpec, type BuilderDoc } from "@/lib/pipeline/builder-model";
import { WORKFLOW_SNIPPETS } from "@/lib/pipeline/snippets";
import type { PipelineSpec } from "@/lib/pipeline/types";

const EMPTY: BuilderDoc = docFromSpec({
  name: "wf",
  workingDirectory: "/repo",
  steps: [],
} as PipelineSpec);

function setup(initial: BuilderDoc = EMPTY) {
  return renderHook(() => {
    const selection = useCanvasSelection();
    const doc = useWorkflowDoc(initial, selection, WORKFLOW_SNIPPETS);
    return { selection, doc };
  });
}

describe("useWorkflowDoc", () => {
  it("handleAdd appends a step and selects it", () => {
    const { result } = setup();
    act(() => result.current.doc.handleAdd());
    const nodes = result.current.doc.doc.nodes;
    expect(nodes).toHaveLength(1);
    const id = nodes[0].step.id;
    expect([...result.current.selection.selectedIds]).toEqual([id]);
    expect(result.current.selection.primaryId).toBe(id);
    expect(result.current.doc.canUndo).toBe(true);
  });

  it("handleAddNote appends a note and selects it", () => {
    const { result } = setup();
    act(() => result.current.doc.handleAddNote());
    const notes = result.current.doc.doc.notes;
    expect(notes).toHaveLength(1);
    expect(result.current.selection.primaryId).toBe(notes[0].id);
  });

  it("handleDuplicate(id) copies a step and selects the copy", () => {
    const { result } = setup();
    act(() => result.current.doc.handleAdd());
    const firstId = result.current.doc.doc.nodes[0].step.id;
    act(() => result.current.doc.handleDuplicate(firstId));
    const nodes = result.current.doc.doc.nodes;
    expect(nodes).toHaveLength(2);
    const copyId = nodes[nodes.length - 1].step.id;
    expect(copyId).not.toBe(firstId);
    expect([...result.current.selection.selectedIds]).toEqual([copyId]);
    expect(result.current.selection.primaryId).toBe(copyId);
  });

  it("handleDuplicate() (no id) duplicates the current step selection", () => {
    const { result } = setup();
    act(() => result.current.doc.handleAdd());
    const firstId = result.current.doc.doc.nodes[0].step.id;
    // firstId is already selected by handleAdd.
    act(() => result.current.doc.handleDuplicate());
    const nodes = result.current.doc.doc.nodes;
    expect(nodes).toHaveLength(2);
    const newIds = nodes.map((n) => n.step.id).filter((id) => id !== firstId);
    expect([...result.current.selection.selectedIds].sort()).toEqual(
      newIds.sort()
    );
  });

  it("handleDuplicate() is a no-op when nothing duplicable is selected", () => {
    const { result } = setup();
    act(() => result.current.doc.handleAddNote()); // only a note selected
    const before = result.current.doc.doc;
    act(() => result.current.doc.handleDuplicate());
    expect(result.current.doc.doc).toBe(before); // unchanged reference
  });

  it("handleDeleteItem removes the item and clears its primary focus", () => {
    const { result } = setup();
    act(() => result.current.doc.handleAdd());
    const id = result.current.doc.doc.nodes[0].step.id;
    act(() => result.current.doc.handleDeleteItem(id));
    expect(result.current.doc.doc.nodes).toHaveLength(0);
    expect([...result.current.selection.selectedIds]).toEqual([]);
    expect(result.current.selection.primaryId).toBeNull();
  });

  it("handleDeleteItem re-homes the primary to a remaining selected id", () => {
    const { result } = setup();
    act(() => result.current.doc.handleAdd());
    const a = result.current.doc.doc.nodes[0].step.id;
    act(() => result.current.doc.handleAdd());
    const b = result.current.doc.doc.nodes[1].step.id;
    // Select both, with b as primary (handleAdd left b primary).
    act(() => result.current.selection.setSelectedIds(new Set([a, b])));
    act(() => result.current.selection.setPrimaryId(b));
    act(() => result.current.doc.handleDeleteItem(b));
    expect(result.current.selection.primaryId).toBe(a);
    expect([...result.current.selection.selectedIds]).toEqual([a]);
  });

  it("handleUndo/handleRedo revert doc frames and drop the selection", () => {
    const { result } = setup();
    act(() => result.current.doc.handleAdd());
    expect(result.current.doc.doc.nodes).toHaveLength(1);
    act(() => result.current.doc.handleUndo());
    expect(result.current.doc.doc.nodes).toHaveLength(0);
    expect(result.current.selection.primaryId).toBeNull();
    expect([...result.current.selection.selectedIds]).toEqual([]);
    act(() => result.current.doc.handleRedo());
    expect(result.current.doc.doc.nodes).toHaveLength(1);
    expect(result.current.selection.primaryId).toBeNull();
  });

  it("handleTidy is a no-op on an empty canvas", () => {
    const { result } = setup();
    const before = result.current.doc.doc;
    act(() => result.current.doc.handleTidy());
    expect(result.current.doc.doc).toBe(before);
    expect(result.current.doc.canUndo).toBe(false);
  });

  it("commitRename renames a step and re-selects the new id", () => {
    const { result } = setup();
    act(() => result.current.doc.handleAdd());
    const oldId = result.current.doc.doc.nodes[0].step.id;
    act(() => result.current.doc.commitRename(oldId, "renamed"));
    expect(result.current.doc.doc.nodes[0].step.id).toBe("renamed");
    expect(result.current.selection.primaryId).toBe("renamed");
    expect([...result.current.selection.selectedIds]).toEqual(["renamed"]);
  });
});

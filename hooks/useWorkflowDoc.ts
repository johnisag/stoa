"use client";

import { toast } from "sonner";
import {
  addNote,
  addPresetStep,
  addStep,
  deleteNodes,
  duplicateNodes,
  duplicateStep,
  moveNode,
  moveNote,
  nextAutoPosition,
  relayout,
  renameStep,
  updateNote,
  updateStep,
  type BuilderDoc,
} from "@/lib/pipeline/builder-model";
import type { WorkflowSnippet } from "@/lib/pipeline/snippets";
import {
  useBuilderHistory,
  type BuilderHistory,
} from "@/hooks/useBuilderHistory";
import type { CanvasSelection } from "@/hooks/useCanvasSelection";

export interface WorkflowDoc extends BuilderHistory {
  /** Undo, then drop the selection (an undone frame may not contain it). */
  handleUndo: () => void;
  /** Redo, then drop the selection. */
  handleRedo: () => void;
  /**
   * Duplicate a specific step (when `id` given) or the current step selection,
   * then select the fresh copies. No-op if nothing duplicable is selected.
   */
  handleDuplicate: (id?: string) => void;
  /** Apply a batch of node/note position updates (transient — no history frame). */
  handleMoveItems: (updates: { id: string; x: number; y: number }[]) => void;
  /** Commit the in-flight drag as one history frame. */
  handleMoveEnd: () => void;
  /** Delete one item and keep the selection consistent. */
  handleDeleteItem: (id: string) => void;
  /** Add a step at the next cascade position and select it. */
  handleAdd: () => void;
  /** Add a note near the next cascade position and select it. */
  handleAddNote: () => void;
  /** Live-edit a note's text (transient — coalesced into one frame on blur). */
  patchNote: (id: string, text: string) => void;
  /** Patch a step, committing a history frame. */
  patch: (id: string, p: Parameters<typeof updateStep>[2]) => void;
  /** Patch a step transiently (for typing); commit on blur. */
  patchTransient: (id: string, p: Parameters<typeof updateStep>[2]) => void;
  /** Commit the current working doc as a frame (used on input blur). */
  commit: () => void;
  /** Rename a step id, guarding against collisions; re-selects the new id. */
  commitRename: (oldId: string, raw: string) => void;
  /** Insert a snippet as a new step (auto-positioned) and select it. */
  handleSnippetSelect: (snippetId: string) => void;
  /** Insert a snippet as a new step at (x, y) and select it. */
  handleSnippetDrop: (snippetId: string, x: number, y: number) => void;
  /** Re-snap the layout to the topological columns. */
  handleTidy: () => void;
}

/**
 * The builder-doc state + all pure doc mutations for WorkflowBuilder.
 *
 * Wraps `useBuilderHistory` (the undo/redo doc reducer) and folds in the
 * doc-mutating handlers that were formerly inline in WorkflowBuilder. Handlers
 * that also change the canvas selection drive it through the injected
 * `CanvasSelection` API, so the two stores stay decoupled while behavior is
 * byte-identical. I/O-free apart from the same toasts the inline handlers fired
 * ("Tidied the layout", the id-collision error).
 *
 * View-orchestration handlers that need `confirm`, refs, or persistence (load,
 * import, delete-saved, insert-output-ref, fit-all) stay in the component —
 * they aren't pure doc mutations.
 */
export function useWorkflowDoc(
  initialDoc: BuilderDoc,
  selection: CanvasSelection,
  snippets: readonly WorkflowSnippet[]
): WorkflowDoc {
  const history = useBuilderHistory(initialDoc);
  const { doc, setDoc, undo, redo } = history;
  const { selectedIds, clearSelection, setSelectedIds, setPrimaryId } =
    selection;

  function handleUndo() {
    undo();
    clearSelection();
  }

  function handleRedo() {
    redo();
    clearSelection();
  }

  function handleDuplicate(id?: string) {
    if (id) {
      const next = duplicateStep(doc, id);
      if (next === doc) return;
      setDoc(next);
      const copy = next.nodes[next.nodes.length - 1];
      setSelectedIds(new Set([copy.step.id]));
      setPrimaryId(copy.step.id);
      return;
    }
    const stepIds = [...selectedIds].filter((sid) =>
      doc.nodes.some((n) => n.step.id === sid)
    );
    if (stepIds.length === 0) return;
    const beforeIds = new Set(doc.nodes.map((n) => n.step.id));
    const next = duplicateNodes(doc, stepIds);
    if (next === doc) return;
    setDoc(next);
    const newIds = next.nodes
      .filter((n) => !beforeIds.has(n.step.id))
      .map((n) => n.step.id);
    setSelectedIds(new Set(newIds));
    setPrimaryId(newIds[0] ?? null);
  }

  function handleMoveItems(updates: { id: string; x: number; y: number }[]) {
    setDoc(
      (d) =>
        updates.reduce((acc, { id, x, y }) => {
          if (acc.nodes.some((n) => n.step.id === id))
            return moveNode(acc, id, x, y);
          if (acc.notes.some((n) => n.id === id))
            return moveNote(acc, id, x, y);
          return acc;
        }, d),
      { transient: true }
    );
  }

  function handleMoveEnd() {
    setDoc((d) => d);
  }

  function handleDeleteItem(id: string) {
    const next = deleteNodes(doc, [id]);
    setDoc(next);
    const remaining = new Set(selectedIds);
    remaining.delete(id);
    setSelectedIds(remaining);
    if (selection.primaryId === id) {
      setPrimaryId(remaining.size > 0 ? [...remaining][0] : null);
    }
  }

  function handleAdd() {
    // Cascade new nodes so they don't stack on top of each other; the user drags
    // them where they want.
    const { x, y } = nextAutoPosition(doc);
    const next = addStep(doc, x, y);
    setDoc(next);
    const id = next.nodes[next.nodes.length - 1].step.id;
    setSelectedIds(new Set([id]));
    setPrimaryId(id);
  }

  function handleAddNote() {
    const { x, y } = nextAutoPosition(doc);
    const next = addNote(doc, x + 16, y + 16, "New note");
    setDoc(next);
    const id = next.notes[next.notes.length - 1].id;
    setSelectedIds(new Set([id]));
    setPrimaryId(id);
  }

  function patchNote(id: string, text: string) {
    setDoc((d) => updateNote(d, id, text), { transient: true });
  }

  function patch(id: string, p: Parameters<typeof updateStep>[2]) {
    setDoc((d) => updateStep(d, id, p));
  }

  function patchTransient(id: string, p: Parameters<typeof updateStep>[2]) {
    setDoc((d) => updateStep(d, id, p), { transient: true });
  }

  function commit() {
    setDoc((d) => d);
  }

  function commitRename(oldId: string, raw: string) {
    const newId = raw.trim();
    if (!newId || newId === oldId) return;
    const next = renameStep(doc, oldId, newId);
    if (next === doc) {
      toast.error(`Step id "${newId}" is already taken`);
      return;
    }
    setDoc(next);
    setSelectedIds(new Set([newId]));
    setPrimaryId(newId);
  }

  function handleSnippetSelect(snippetId: string) {
    const snippet = snippets.find((s) => s.id === snippetId);
    if (!snippet) return;
    const next = addPresetStep(doc, snippet);
    setDoc(next);
    const id = next.nodes[next.nodes.length - 1].step.id;
    setSelectedIds(new Set([id]));
    setPrimaryId(id);
  }

  function handleSnippetDrop(snippetId: string, x: number, y: number) {
    const snippet = snippets.find((s) => s.id === snippetId);
    if (!snippet) return;
    const next = addPresetStep(doc, snippet, x, y);
    setDoc(next);
    const id = next.nodes[next.nodes.length - 1].step.id;
    setSelectedIds(new Set([id]));
    setPrimaryId(id);
  }

  function handleTidy() {
    if (doc.nodes.length === 0) return;
    setDoc((d) => relayout(d));
    toast.success("Tidied the layout");
  }

  return {
    ...history,
    handleUndo,
    handleRedo,
    handleDuplicate,
    handleMoveItems,
    handleMoveEnd,
    handleDeleteItem,
    handleAdd,
    handleAddNote,
    patchNote,
    patch,
    patchTransient,
    commit,
    commitRename,
    handleSnippetSelect,
    handleSnippetDrop,
    handleTidy,
  };
}

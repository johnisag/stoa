"use client";

import { useState } from "react";

export interface SelectNodeOptions {
  shiftKey?: boolean;
  addToSelection?: boolean;
  keepSelection?: boolean;
}

export interface CanvasSelection {
  /** The set of currently-selected item ids (step ids and note ids). */
  selectedIds: Set<string>;
  /** The primary (last-focused) item id, whose edit panel is shown. */
  primaryId: string | null;
  /** Clear the whole selection. */
  clearSelection: () => void;
  /**
   * Select an item, mirroring the canvas' click semantics:
   * - `null` clears the selection,
   * - `keepSelection` just moves the primary focus (no set change),
   * - shift/add toggles membership, otherwise it's a single-select replace.
   */
  handleSelectNode: (id: string | null, opts?: SelectNodeOptions) => void;
  /** Low-level setters, used by the doc-mutation handlers that re-select after
   *  an add/duplicate/delete/rename. */
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setPrimaryId: React.Dispatch<React.SetStateAction<string | null>>;
}

/**
 * Node/note selection state for the visual workflow builder canvas.
 *
 * Extracted from WorkflowBuilder with NO behavior change — `handleSelectNode`
 * and `clearSelection` are the former inline handlers verbatim (recreated each
 * render, reading the live `selectedIds` closure). Doc mutations that also
 * change the selection (add/duplicate/delete/rename) live in useWorkflowDoc and
 * drive selection through the raw `setSelectedIds`/`setPrimaryId` setters,
 * keeping this selection store free of any BuilderDoc knowledge.
 */
export function useCanvasSelection(): CanvasSelection {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [primaryId, setPrimaryId] = useState<string | null>(null);

  function clearSelection() {
    setSelectedIds(new Set());
    setPrimaryId(null);
  }

  function handleSelectNode(id: string | null, opts?: SelectNodeOptions) {
    if (id === null) {
      clearSelection();
      return;
    }
    if (opts?.keepSelection) {
      setPrimaryId(id);
      return;
    }
    const shift = opts?.shiftKey ?? opts?.addToSelection ?? false;
    if (shift) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedIds(next);
      setPrimaryId(next.has(id) ? id : next.size > 0 ? [...next][0] : null);
    } else {
      setSelectedIds(new Set([id]));
      setPrimaryId(id);
    }
  }

  return {
    selectedIds,
    primaryId,
    clearSelection,
    handleSelectNode,
    setSelectedIds,
    setPrimaryId,
  };
}

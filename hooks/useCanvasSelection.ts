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
  /** Replace the selection with exactly `ids`, focusing `primary` (or the first). */
  selectOnly: (ids: string[], primary?: string | null) => void;
  /** Low-level setters, for the rare handler that needs raw control. */
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setPrimaryId: React.Dispatch<React.SetStateAction<string | null>>;
}

/**
 * Node/note selection state for the visual workflow builder canvas.
 *
 * Extracted from WorkflowBuilder with NO behavior change — `handleSelectNode`
 * and `clearSelection` are the former inline handlers verbatim (recreated each
 * render, reading the live `selectedIds` closure). Doc mutations that also
 * change the selection (add/duplicate/delete) live in the builder and drive
 * selection through `selectOnly` / the raw setters, keeping the selection store
 * free of any BuilderDoc knowledge.
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

  function selectOnly(ids: string[], primary?: string | null) {
    setSelectedIds(new Set(ids));
    setPrimaryId(primary !== undefined ? primary : (ids[0] ?? null));
  }

  return {
    selectedIds,
    primaryId,
    clearSelection,
    handleSelectNode,
    selectOnly,
    setSelectedIds,
    setPrimaryId,
  };
}

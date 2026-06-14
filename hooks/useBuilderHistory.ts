"use client";

import { useCallback, useState } from "react";
import {
  serializeBuilderDoc,
  type BuilderDoc,
} from "@/lib/pipeline/builder-model";

export interface SetDocOptions {
  /**
   * If true, the update applies to the working document without pushing a new
   * history frame. Use for transient visual changes like dragging a node in
   * progress; call `setDoc` again without `transient` (or with the same doc) to
   * commit the final state.
   */
  transient?: boolean;
}

export interface BuilderHistory {
  /** Current document (committed frame + any transient changes). */
  doc: BuilderDoc;
  /** Apply a new document or updater. Commits by default; pass `{ transient: true }` for drag previews. */
  setDoc: (
    updater: BuilderDoc | ((prev: BuilderDoc) => BuilderDoc),
    opts?: SetDocOptions
  ) => void;
  /** Replace the whole history with a single frame — use when loading a different workflow. */
  reset: (doc: BuilderDoc) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Undo/redo history for the visual workflow builder.
 *
 * The stack stores committed snapshots of BuilderDoc. A transient update (e.g.
 * a node drag in progress) mutates the working copy without growing the stack,
 * so the history doesn't record every pointer move. Calling `setDoc` without
 * `transient` commits the working copy as a new frame. The default max depth is
 * 20 frames to keep memory bounded.
 */
export function useBuilderHistory(
  initialDoc: BuilderDoc,
  maxDepth = 20
): BuilderHistory {
  const depth = Math.max(1, maxDepth);
  const [state, setState] = useState<{
    stack: BuilderDoc[];
    index: number;
    working: BuilderDoc;
  }>({
    stack: [initialDoc],
    index: 0,
    working: initialDoc,
  });

  const setDoc = useCallback(
    (
      updater: BuilderDoc | ((prev: BuilderDoc) => BuilderDoc),
      opts: SetDocOptions = {}
    ) => {
      setState((s) => {
        const next =
          typeof updater === "function"
            ? (updater as (prev: BuilderDoc) => BuilderDoc)(s.working)
            : updater;

        if (opts.transient) {
          return { ...s, working: next };
        }

        // Commit: ignore if nothing changed versus the current committed frame.
        if (next === s.stack[s.index]) return { ...s, working: next };
        if (
          serializeBuilderDoc(next) === serializeBuilderDoc(s.stack[s.index])
        ) {
          return { ...s, working: next };
        }

        const stack = s.stack.slice(0, s.index + 1);
        stack.push(next);
        const dropped = Math.max(0, stack.length - depth);
        if (dropped) stack.splice(0, dropped);
        const index = s.index + 1 - dropped;
        return { stack, index, working: next };
      });
    },
    [depth]
  );

  const undo = useCallback(() => {
    setState((s) => {
      if (s.index <= 0) return s;
      const index = s.index - 1;
      return { ...s, index, working: s.stack[index] };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      if (s.index >= s.stack.length - 1) return s;
      const index = s.index + 1;
      return { ...s, index, working: s.stack[index] };
    });
  }, []);

  const reset = useCallback((next: BuilderDoc) => {
    setState(() => ({ stack: [next], index: 0, working: next }));
  }, []);

  return {
    doc: state.working,
    setDoc,
    reset,
    undo,
    redo,
    canUndo: state.index > 0,
    canRedo: state.index < state.stack.length - 1,
  };
}

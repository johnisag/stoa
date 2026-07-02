"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  serializeBuilderDoc,
  type BuilderDoc,
  type SavedWorkflow,
} from "@/lib/pipeline/builder-model";
import {
  useSavedWorkflows,
  useCreateSavedWorkflow,
  useUpdateSavedWorkflow,
  useDeleteSavedWorkflow,
} from "@/data/saved-workflows/queries";
import type { useConfirm } from "@/components/ConfirmProvider";

type Confirm = ReturnType<typeof useConfirm>;

export interface WorkflowPersistence {
  /** The saved-store id of the loaded workflow (null = an unsaved draft). */
  savedId: string | null;
  /** The saved-workflows list query (rows + loading state for the menu). */
  savedList: ReturnType<typeof useSavedWorkflows>;
  /** The currently-loaded SavedWorkflow row (for its history list), or null. */
  currentSaved: SavedWorkflow | null;
  /** True when the last committed frame differs from the last save/load. */
  dirty: boolean;
  /** The save-workflow mutation (its `isPending` disables the menu item). */
  createWf: ReturnType<typeof useCreateSavedWorkflow>;
  /** The update-workflow mutation. */
  updateWf: ReturnType<typeof useUpdateSavedWorkflow>;
  /** Load a doc onto the canvas as the given saved id (or null draft). */
  loadDoc: (next: BuilderDoc, savedWorkflowId: string | null) => void;
  /** Save to the loaded row, or create a new one; sets the dirty baseline. */
  handleSave: () => Promise<void>;
  /** Fork the loaded workflow into a brand-new saved row. */
  handleSaveCopy: () => Promise<void>;
  /** Delete the loaded saved row (confirm-guarded). */
  handleDeleteSaved: () => Promise<void>;
}

/**
 * Saved-workflows persistence for WorkflowBuilder: the store CRUD mutations,
 * the loaded-row identity (`savedId`), the unsaved-changes signal (`dirty`), and
 * the save/save-copy/delete/load handlers — all extracted verbatim from the
 * component with NO behavior change.
 *
 * The builder still owns the doc (via useWorkflowDoc) and the selection; this
 * hook composes over them through the injected `doc`, `committedDoc`, `reset`,
 * and `clearSelection`. `dirty` keys off `committedDoc` (not the live doc) so an
 * in-flight drag doesn't re-serialize on every pointer frame.
 */
export function useWorkflowPersistence(opts: {
  doc: BuilderDoc;
  committedDoc: BuilderDoc;
  emptyDoc: BuilderDoc;
  reset: (doc: BuilderDoc) => void;
  clearSelection: () => void;
  confirm: Confirm;
}): WorkflowPersistence {
  const { doc, committedDoc, emptyDoc, reset, clearSelection, confirm } = opts;

  // The saved-store id of the workflow currently loaded (null = an unsaved draft).
  // Drives Save-overwrites-vs-creates and which row a Delete removes.
  const [savedId, setSavedId] = useState<string | null>(null);
  // Serialized doc at the last save/load/new — current doc differing from it means
  // there are unsaved changes (the trigger shows a dot). Baseline = the empty doc.
  const [savedSnapshot, setSavedSnapshot] = useState<string>(() =>
    serializeBuilderDoc(emptyDoc)
  );

  const savedList = useSavedWorkflows();
  const createWf = useCreateSavedWorkflow();
  const updateWf = useUpdateSavedWorkflow();
  const deleteWf = useDeleteSavedWorkflow();

  // Unsaved-changes signal: the last committed doc differs from the last
  // save/load. Keyed off the committed frame (not the live `doc`) so an
  // in-flight drag doesn't re-serialize the whole doc on every pointer frame.
  const dirty = useMemo(
    () => serializeBuilderDoc(committedDoc) !== savedSnapshot,
    [committedDoc, savedSnapshot]
  );
  const currentSaved = useMemo(
    () => savedList.data?.find((w) => w.id === savedId) ?? null,
    [savedList.data, savedId]
  );

  function loadDoc(next: BuilderDoc, savedWorkflowId: string | null) {
    reset(next);
    clearSelection();
    setSavedId(savedWorkflowId);
    setSavedSnapshot(serializeBuilderDoc(next)); // freshly loaded = no unsaved changes
  }

  // Returns false (after a toast) if the canvas isn't ready to save, so the menu
  // item can stay enabled and TEACH why — a disabled item gives a phone tap no
  // feedback at all.
  function saveGuard(): string | null {
    const name = doc.name.trim();
    if (doc.nodes.length === 0 && doc.notes.length === 0) {
      toast.error("Add a step or note first.");
      return null;
    }
    if (!name) {
      toast.error(
        `Give the workflow a name first (the “Workflow name” field).`
      );
      return null;
    }
    return name;
  }

  async function handleSave() {
    const name = saveGuard();
    if (!name) return;
    const snapshot = serializeBuilderDoc(doc);
    try {
      if (savedId) {
        await updateWf.mutateAsync({ id: savedId, name, doc });
      } else {
        const created = await createWf.mutateAsync({ name, doc });
        setSavedId(created.id);
      }
      setSavedSnapshot(snapshot); // now persisted = no unsaved changes
      toast.success(`Saved "${name}"`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    }
  }

  // Always creates a new row (forking a loaded workflow) — so renaming + Save
  // doesn't silently overwrite the original under its old id.
  async function handleSaveCopy() {
    const name = saveGuard();
    if (!name) return;
    const snapshot = serializeBuilderDoc(doc);
    try {
      const created = await createWf.mutateAsync({ name, doc });
      setSavedId(created.id);
      setSavedSnapshot(snapshot);
      toast.success(`Saved a copy as "${name}"`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    }
  }

  async function handleDeleteSaved() {
    if (!savedId) return;
    const target = savedList.data?.find((w) => w.id === savedId);
    if (
      !(await confirm({
        title: "Delete this saved workflow?",
        description: `"${target?.name ?? doc.name}" will be removed. This can't be undone.`,
      }))
    ) {
      return;
    }
    try {
      await deleteWf.mutateAsync(savedId);
      toast.success("Deleted saved workflow");
      setSavedId(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  return {
    savedId,
    savedList,
    currentSaved,
    dirty,
    createWf,
    updateWf,
    loadDoc,
    handleSave,
    handleSaveCopy,
    handleDeleteSaved,
  };
}

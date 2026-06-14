import { proxy } from "valtio";
import { updateSelection } from "@/lib/rangeSelectionUtils";

// Store state
export const selectionStore = proxy({
  selectedIds: new Set<string>(),
  lastSelectedId: null as string | null,
});

// Actions - can be called from anywhere
export const selectionActions = {
  toggle: (
    sessionId: string,
    shiftKey = false,
    allSessionIds: string[] = []
  ) => {
    const newSet = updateSelection(
      selectionStore.selectedIds,
      sessionId,
      shiftKey,
      selectionStore.lastSelectedId,
      allSessionIds
    );
    selectionStore.selectedIds = newSet;
    selectionStore.lastSelectedId = sessionId;
  },

  selectAll: (sessionIds: string[]) => {
    selectionStore.selectedIds = new Set(sessionIds);
  },

  clear: () => {
    selectionStore.selectedIds = new Set();
    selectionStore.lastSelectedId = null;
  },

  /**
   * Reads whether `sessionId` is selected. Because this reads directly from the
   * Valtio proxy, components should only call it inside `useSnapshot` (or another
   * subscription) if they need to re-render when the selection changes.
   */
  isSelected: (sessionId: string) => {
    return selectionStore.selectedIds.has(sessionId);
  },

  /**
   * Returns the number of selected sessions. Like `isSelected`, this reads the
   * live proxy; use it inside `useSnapshot` for reactive UI.
   */
  getCount: () => {
    return selectionStore.selectedIds.size;
  },

  /**
   * Returns the selected ids as an array. Like `isSelected`, this reads the live
   * proxy; use it inside `useSnapshot` for reactive UI.
   */
  getSelectedIds: () => {
    return Array.from(selectionStore.selectedIds);
  },
};

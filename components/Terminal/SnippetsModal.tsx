"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { X, Plus, Trash2 } from "lucide-react";
import {
  type Snippet,
  getStoredSnippets,
  addSnippet,
  removeSnippet,
  extractPlaceholders,
  SNIPPETS_CHANGED_EVENT,
} from "@/lib/snippets";
import { formatTerminalTextForAgent } from "@/lib/path-display";
import { createUndoableRunner, UNDO_DELAY_MS } from "@/lib/undoable-action";
import { SnippetFillInDialog } from "./SnippetFillInDialog";

// The shared snippet store lives in localStorage; read/write through it so both
// the mobile toolbar and the desktop tab bar surface the same list.
function browserStorage() {
  return window.localStorage;
}

// #37: module-scoped so a pending delete survives re-renders/unmounts (and is
// shared by every SnippetsModal instance — the store is one list). The storage
// write only happens when the undo window elapses.
const undoableSnippetDelete = createUndoableRunner({ delayMs: UNDO_DELAY_MS });

/**
 * Snippets as the user currently sees them: the stored list minus deletes
 * still inside their undo window (storage isn't written until the window
 * elapses, but the user already deleted them). Shared with the mobile chip
 * bar so every surface agrees with the modal's optimistic view.
 */
export function getVisibleSnippets(): Snippet[] {
  const pendingDeletes = new Set(undoableSnippetDelete.pending());
  return getStoredSnippets(browserStorage()).filter(
    (s) => !pendingDeletes.has(`snippet:${s.id}`)
  );
}

// Tell passive surfaces (the chip bar) the visible list changed. Same-tab
// only — the cross-tab `storage` event never fires in the mutating tab.
function emitSnippetsChanged() {
  window.dispatchEvent(new Event(SNIPPETS_CHANGED_EVENT));
}

// Snippets modal for saving/inserting common commands. Reused by both the mobile
// terminal toolbar and the desktop tab bar so a saved prompt is insertable on
// any surface — keep this the single owner of the snippets UI.
export function SnippetsModal({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (content: string) => void;
}) {
  const [snippets, setSnippets] = useState<Snippet[]>(() =>
    typeof window === "undefined" ? [] : getStoredSnippets(browserStorage())
  );
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  // Snippet whose {{placeholders}} are being filled in before insert (#33).
  const [fillIn, setFillIn] = useState<Snippet | null>(null);

  const handleAdd = () => {
    if (newName.trim() && newContent.trim()) {
      setSnippets(addSnippet(browserStorage(), snippets, newName, newContent));
      setNewName("");
      setNewContent("");
      setIsAdding(false);
      emitSnippetsChanged();
    }
  };

  const handleDelete = (snippet: Snippet) => {
    // Double-fire guard (see undoable-action.ts: a reschedule would flush the
    // first delete immediately and its twin would clobber storage again).
    if (undoableSnippetDelete.pending().includes(`snippet:${snippet.id}`))
      return;
    // #37: hide it from local state now; the storage write happens after the
    // undo window (re-reading storage at execute time so a snippet added on
    // another surface meanwhile isn't clobbered).
    setSnippets((prev) => prev.filter((s) => s.id !== snippet.id));
    undoableSnippetDelete.schedule(`snippet:${snippet.id}`, () => {
      const storage = browserStorage();
      removeSnippet(storage, getStoredSnippets(storage), snippet.id);
    });
    emitSnippetsChanged();
    toast(`Deleted "${snippet.name}"`, {
      duration: UNDO_DELAY_MS,
      action: {
        label: "Undo",
        onClick: () => {
          undoableSnippetDelete.cancel(`snippet:${snippet.id}`);
          // Re-sync through getVisibleSnippets (NOT raw storage): another
          // delete may still be inside its own undo window — storage isn't
          // written yet, so a raw read would resurrect it here while the
          // chip bar correctly keeps hiding it.
          setSnippets(getVisibleSnippets());
          emitSnippetsChanged();
        },
      },
    });
  };

  const handleInsert = (snippet: Snippet) => {
    // #33: a body with {{placeholders}} detours through the fill-in dialog,
    // which sanitizes the substituted result itself (same call, below).
    if (extractPlaceholders(snippet.content).length > 0) {
      setFillIn(snippet);
      return;
    }
    // Sanitize HERE — the single owner of the snippets UI — so EVERY surface
    // (desktop + mobile) injects control-char-safe text, not just the one that
    // remembered to. Strips C0+DEL, keeps tab/newline.
    onInsert(formatTerminalTextForAgent(snippet.content));
    onClose();
  };

  // Re-sync from localStorage on each open so a snippet added on another surface
  // (another pane / the mobile toolbar) appears here without a reload. Skip ids
  // whose delete is still inside its undo window — storage hasn't been written
  // yet, but the user already deleted them.
  useEffect(() => {
    if (!open) return;
    setSnippets(getVisibleSnippets());
    // A fill-in left behind by a close mid-fill must not reappear next open.
    setFillIn(null);
  }, [open]);

  // Escape closes (parity with the other modals). While the fill-in dialog is
  // on top it owns Escape — closing just the dialog, not the whole modal.
  useEffect(() => {
    if (!open || fillIn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, fillIn, onClose]);

  if (!open) return null;

  return (
    <>
      {fillIn && (
        <SnippetFillInDialog
          key={fillIn.id}
          body={fillIn.content}
          snippetName={fillIn.name}
          onInsert={(text) => {
            // Already sanitized by the dialog (formatTerminalTextForAgent).
            onInsert(text);
            setFillIn(null);
            onClose();
          }}
          onClose={() => setFillIn(null)}
        />
      )}
      <div
        // Bottom-sheet on mobile; centered, width-capped dialog on desktop.
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
        onClick={onClose}
      >
        <div
          className="bg-background flex max-h-[70vh] w-full flex-col rounded-t-xl sm:max-w-md sm:rounded-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="border-border flex items-center justify-between border-b px-4 py-3">
            <span className="text-sm font-medium">Snippets</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsAdding(!isAdding)}
                className="hover:bg-muted rounded-md p-1.5"
              >
                <Plus className="h-5 w-5" />
              </button>
              <button
                onClick={onClose}
                className="hover:bg-muted rounded-md p-1.5"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Add new snippet form */}
          {isAdding && (
            <div className="border-border bg-muted/50 border-b px-4 py-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Snippet name..."
                className="bg-background focus:ring-primary mb-2 w-full rounded-lg px-3 py-2 text-sm focus:ring-2 focus:outline-none"
              />
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="Command or text..."
                className="bg-background focus:ring-primary h-20 w-full resize-none rounded-lg px-3 py-2 font-mono text-sm focus:ring-2 focus:outline-none"
              />
              {/* #33: surface the template-variable feature where snippets
                  are written — it's invisible otherwise. */}
              <p className="text-muted-foreground mt-1 text-xs">
                Tip: <span className="font-mono">{"{{name}}"}</span>{" "}
                placeholders ask for values when inserted.
              </p>
              <button
                onClick={handleAdd}
                disabled={!newName.trim() || !newContent.trim()}
                className="bg-primary text-primary-foreground mt-2 w-full rounded-lg py-2 font-medium disabled:opacity-50"
              >
                Save Snippet
              </button>
            </div>
          )}

          {/* Snippets list */}
          <div className="flex-1 overflow-y-auto">
            {snippets.length === 0 ? (
              <div className="text-muted-foreground px-4 py-8 text-center text-sm">
                No snippets yet. Tap + to add one.
              </div>
            ) : (
              snippets.map((snippet) => (
                <div
                  key={snippet.id}
                  className="border-border active:bg-muted flex items-center gap-2 border-b px-4 py-3"
                >
                  <button
                    onClick={() => handleInsert(snippet)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-sm font-medium">
                      {snippet.name}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-xs">
                      {snippet.content}
                    </div>
                  </button>
                  <button
                    onClick={() => handleDelete(snippet)}
                    className="hover:bg-destructive/20 text-muted-foreground hover:text-destructive rounded-md p-2"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}

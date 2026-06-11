"use client";

import { useState, useEffect } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import {
  type Snippet,
  getStoredSnippets,
  addSnippet,
  removeSnippet,
} from "@/lib/snippets";
import { formatTerminalTextForAgent } from "@/lib/path-display";

// The shared snippet store lives in localStorage; read/write through it so both
// the mobile toolbar and the desktop tab bar surface the same list.
function browserStorage() {
  return window.localStorage;
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

  const handleAdd = () => {
    if (newName.trim() && newContent.trim()) {
      setSnippets(addSnippet(browserStorage(), snippets, newName, newContent));
      setNewName("");
      setNewContent("");
      setIsAdding(false);
    }
  };

  const handleDelete = (id: string) => {
    setSnippets(removeSnippet(browserStorage(), snippets, id));
  };

  const handleInsert = (content: string) => {
    // Sanitize HERE — the single owner of the snippets UI — so EVERY surface
    // (desktop + mobile) injects control-char-safe text, not just the one that
    // remembered to. Strips C0+DEL, keeps tab/newline.
    onInsert(formatTerminalTextForAgent(content));
    onClose();
  };

  // Re-sync from localStorage on each open so a snippet added on another surface
  // (another pane / the mobile toolbar) appears here without a reload.
  useEffect(() => {
    if (open) setSnippets(getStoredSnippets(browserStorage()));
  }, [open]);

  // Escape closes (parity with the other modals).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
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
                  onClick={() => handleInsert(snippet.content)}
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
                  onClick={() => handleDelete(snippet.id)}
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
  );
}

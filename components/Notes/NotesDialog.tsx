"use client";

import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Pin, PinOff, Plus, Trash2, Pencil, NotebookPen } from "lucide-react";
import { MarkdownRenderer } from "@/components/FileExplorer/MarkdownRenderer";
import {
  useNotes,
  useCreateNote,
  useUpdateNote,
  useDeleteNote,
  noteKeys,
  type Note,
} from "@/data/notes";
import { useViewport } from "@/hooks/useViewport";
import { createUndoableRunner, UNDO_DELAY_MS } from "@/lib/undoable-action";

// #37: module-scoped so a pending delete survives re-renders/unmounts. The real
// DELETE only fires when the undo window elapses.
const undoableNoteDelete = createUndoableRunner({ delayMs: UNDO_DELAY_MS });

interface NotesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Notes / shared knowledge base — a markdown read/write surface for humans, over
 * the SAME /api/notes the agents' notes_* MCP tools use. List on the left, a
 * rendered note (or its editor) on the right; pin, edit, delete, and create.
 */
export function NotesDialog({ open, onOpenChange }: NotesDialogProps) {
  const { isMobile } = useViewport();
  const queryClient = useQueryClient();
  const { data: notes = [], isLoading } = useNotes(open);
  const createNote = useCreateNote();
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");

  const selected = notes.find((n) => n.id === selectedId) ?? null;

  // Keep a valid selection: when the list (re)loads and the current selection is
  // gone (or none yet), fall back to the first note. Don't clobber an in-progress
  // edit.
  useEffect(() => {
    if (!open || editing) return;
    if (selectedId && notes.some((n) => n.id === selectedId)) return;
    setSelectedId(notes[0]?.id ?? null);
  }, [open, notes, selectedId, editing]);

  const startEdit = () => {
    if (!selected) return;
    setDraftTitle(selected.title);
    setDraftContent(selected.content);
    setEditing(true);
  };

  const startNew = async () => {
    const note = await createNote.mutateAsync({
      title: "Untitled",
      content: "",
    });
    setSelectedId(note.id);
    setDraftTitle(note.title);
    setDraftContent(note.content);
    setEditing(true);
  };

  const save = async () => {
    // Save by selectedId (not `selected`): a just-created note isn't in the
    // cached `notes` list until its refetch lands, so `selected` is momentarily
    // null while we're already editing it.
    if (!selectedId) return;
    await updateNote.mutateAsync({
      id: selectedId,
      title: draftTitle,
      content: draftContent,
    });
    setEditing(false);
  };

  const togglePin = async (n: Note) =>
    updateNote.mutateAsync({ id: n.id, pinned: !n.pinned });

  const remove = (n: Note) => {
    // Double-fire guard (see undoable-action.ts: a reschedule would flush the
    // first delete immediately and leave its twin to 404 later).
    if (undoableNoteDelete.pending().includes(`note:${n.id}`)) return;
    // #37: hide the note now, hold the real DELETE for the undo window. Undo
    // cancels the pending delete and refetches (the server never saw it).
    undoableNoteDelete.schedule(
      `note:${n.id}`,
      () => {
        deleteNote.mutateAsync(n.id).catch(() => {
          toast.error("Failed to delete note");
          queryClient.invalidateQueries({ queryKey: noteKeys.list() });
        });
      },
      () =>
        queryClient.setQueryData<Note[]>(noteKeys.list(), (old) =>
          old?.filter((note) => note.id !== n.id)
        )
    );
    if (selectedId === n.id) {
      setEditing(false);
      setSelectedId(null);
    }
    toast(`Deleted "${n.title || "(untitled)"}"`, {
      duration: UNDO_DELAY_MS,
      action: {
        label: "Undo",
        onClick: () => {
          undoableNoteDelete.cancel(`note:${n.id}`);
          queryClient.invalidateQueries({ queryKey: noteKeys.list() });
          // Land back on the restored note, not the first-note fallback.
          setSelectedId(n.id);
        },
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        sheet={isMobile}
        className="flex h-[80vh] max-w-3xl flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="border-border border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <NotebookPen className="h-4 w-4" />
            Notes
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* List */}
          <div className="border-border flex w-2/5 min-w-0 flex-col border-r sm:w-1/3">
            <div className="border-border border-b p-2">
              <Button
                size="sm"
                variant="outline"
                className="w-full gap-1.5"
                onClick={startNew}
                disabled={createNote.isPending}
              >
                <Plus className="h-3.5 w-3.5" /> New note
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {isLoading ? (
                <div className="text-muted-foreground p-4 text-center text-sm">
                  Loading…
                </div>
              ) : notes.length === 0 ? (
                <div className="text-muted-foreground p-4 text-center text-sm">
                  No notes yet
                </div>
              ) : (
                notes.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => {
                      setSelectedId(n.id);
                      setEditing(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm transition-colors",
                      n.id === selectedId ? "bg-accent" : "hover:bg-accent/50"
                    )}
                  >
                    {Boolean(n.pinned) && (
                      <Pin className="h-3 w-3 flex-shrink-0 text-amber-500" />
                    )}
                    <span className="truncate">{n.title || "(untitled)"}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Detail. Editor first: a freshly-created note may not be in the
              cached list yet, so render the editor off `editing` (drafts +
              selectedId), not off `selected`, to avoid an empty-state flash. */}
          <div className="flex min-w-0 flex-1 flex-col">
            {editing ? (
              <>
                <div className="border-border flex items-center gap-2 border-b p-2">
                  <Input
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    placeholder="Title"
                    className="h-8"
                  />
                  <Button
                    size="sm"
                    onClick={save}
                    disabled={updateNote.isPending}
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </Button>
                </div>
                <textarea
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  placeholder="Write markdown…"
                  className="bg-background flex-1 resize-none p-4 font-mono text-sm focus:outline-none"
                />
              </>
            ) : !selected ? (
              <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-center text-sm">
                Select a note, or create one.
              </div>
            ) : (
              <>
                <div className="border-border flex items-center gap-1 border-b p-2">
                  <span className="min-w-0 flex-1 truncate px-1 font-medium">
                    {selected.title || "(untitled)"}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={selected.pinned ? "Unpin note" : "Pin note"}
                    onClick={() => togglePin(selected)}
                  >
                    {selected.pinned ? (
                      <PinOff className="h-3.5 w-3.5" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Edit note"
                    onClick={startEdit}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Delete note"
                    onClick={() => remove(selected)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {selected.content.trim() ? (
                    <MarkdownRenderer content={selected.content} />
                  ) : (
                    <div className="text-muted-foreground p-6 text-sm italic">
                      (empty — click the pencil to write)
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

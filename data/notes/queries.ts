import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { noteKeys } from "./keys";

/** A note as the client sees it (mirrors lib/db NoteRow; `pinned` is a 0/1). */
export interface Note {
  id: string;
  title: string;
  content: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

async function fetchNotes(): Promise<Note[]> {
  const res = await fetch("/api/notes");
  if (!res.ok) throw new Error("Failed to fetch notes");
  return (await res.json()).notes ?? [];
}

export function useNotes(enabled = true) {
  return useQuery({
    queryKey: noteKeys.list(),
    queryFn: fetchNotes,
    enabled,
    staleTime: 15000,
  });
}

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { title?: string; content?: string }) => {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new Error((await res.json()).error || "Failed to create note");
      }
      return (await res.json()).note as Note;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: noteKeys.list() }),
  });
}

export function useUpdateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: {
      id: string;
      title?: string;
      content?: string;
      pinned?: boolean;
    }) => {
      const res = await fetch(`/api/notes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        throw new Error((await res.json()).error || "Failed to update note");
      }
      return (await res.json()).note as Note;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: noteKeys.list() }),
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error((await res.json()).error || "Failed to delete note");
      }
      return (await res.json()).removed as boolean;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: noteKeys.list() }),
  });
}

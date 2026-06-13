import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// Type-only — erased at build, so importing from the (server-touching) builder
// model doesn't drag node builtins into the client bundle.
import type { BuilderDoc, SavedWorkflow } from "@/lib/pipeline/builder-model";
import { savedWorkflowKeys } from "./keys";

async function fetchSavedWorkflows(): Promise<SavedWorkflow[]> {
  const res = await fetch("/api/saved-workflows");
  if (!res.ok) throw new Error("Failed to fetch saved workflows");
  return (await res.json()).workflows ?? [];
}

export function useSavedWorkflows(enabled = true) {
  return useQuery({
    queryKey: savedWorkflowKeys.list(),
    queryFn: fetchSavedWorkflows,
    enabled,
    staleTime: 30000,
  });
}

export function useCreateSavedWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; doc: BuilderDoc }) => {
      const res = await fetch("/api/saved-workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new Error((await res.json()).error || "Failed to save workflow");
      }
      return (await res.json()).workflow as SavedWorkflow;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: savedWorkflowKeys.list() }),
  });
}

export function useUpdateSavedWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...input
    }: {
      id: string;
      name: string;
      doc: BuilderDoc;
    }) => {
      const res = await fetch(`/api/saved-workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new Error((await res.json()).error || "Failed to update workflow");
      }
      return (await res.json()).workflow as SavedWorkflow;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: savedWorkflowKeys.list() }),
  });
}

export function useDeleteSavedWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/saved-workflows/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete workflow");
      return res.json();
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: savedWorkflowKeys.list() }),
  });
}

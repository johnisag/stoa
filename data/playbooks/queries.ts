import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
// Type-only import — lib/playbooks is pure/client-safe, but keep the boundary clean.
import type { Playbook } from "@/lib/playbooks";
import { playbookKeys } from "./keys";

async function fetchPlaybooks(projectId: string | null): Promise<Playbook[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const res = await fetch(`/api/playbooks${qs}`);
  if (!res.ok) throw new Error("Failed to load playbooks");
  return ((await res.json()).playbooks ?? []) as Playbook[];
}

/** The project's playbooks + global recipes (#13). */
export function usePlaybooksQuery(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: playbookKeys.list(projectId),
    queryFn: () => fetchPlaybooks(projectId),
    enabled,
    staleTime: 30_000,
  });
}

export interface CreatePlaybookInput {
  name: string;
  body: string;
  projectId?: string | null;
  pinned?: boolean;
}

export function useCreatePlaybook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePlaybookInput): Promise<Playbook> => {
      const res = await fetch("/api/playbooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(msg.error || "Failed to create playbook");
      }
      return (await res.json()).playbook as Playbook;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: playbookKeys.all }),
  });
}

export function useDeletePlaybook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await fetch(`/api/playbooks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete playbook");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: playbookKeys.all }),
  });
}

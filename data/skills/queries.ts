import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { skillKeys } from "./keys";

/** A provider that has a native custom-command directory wired. */
export interface SkillProvider {
  id: string;
  name: string;
}

/** A command as the list shows it (the body is fetched on demand for editing). */
export interface SkillSummary {
  name: string;
  description: string;
}

/** The providers whose native command convention Stoa can write. */
export function useSkillProviders() {
  return useQuery({
    queryKey: skillKeys.providers(),
    queryFn: async (): Promise<SkillProvider[]> => {
      const res = await fetch("/api/skills");
      if (!res.ok) throw new Error("Failed to load command providers");
      return (await res.json()).providers ?? [];
    },
    staleTime: Infinity,
  });
}

/** A provider's existing commands. */
export function useSkills(provider: string | undefined, enabled = true) {
  return useQuery({
    queryKey: skillKeys.list(provider ?? ""),
    enabled: enabled && !!provider,
    queryFn: async (): Promise<SkillSummary[]> => {
      const res = await fetch(
        `/api/skills?provider=${encodeURIComponent(provider!)}`
      );
      if (!res.ok) throw new Error("Failed to load commands");
      return (await res.json()).skills ?? [];
    },
    staleTime: 15000,
  });
}

/** Fetch one command's full body, on demand (for the editor). Null if it's gone. */
export async function fetchSkill(
  provider: string,
  name: string
): Promise<{ name: string; description: string; body: string } | null> {
  const res = await fetch(
    `/api/skills?provider=${encodeURIComponent(provider)}&name=${encodeURIComponent(name)}`
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to load command");
  return (await res.json()).skill;
}

export function useWriteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      provider: string;
      name: string;
      description?: string;
      body: string;
    }) => {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        throw new Error((await res.json()).error || "Failed to save command");
      }
      return (await res.json()).skill as SkillSummary;
    },
    onSuccess: (_d, v) =>
      qc.invalidateQueries({ queryKey: skillKeys.list(v.provider) }),
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { provider: string; name: string }) => {
      const res = await fetch(
        `/api/skills?provider=${encodeURIComponent(input.provider)}&name=${encodeURIComponent(input.name)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        throw new Error((await res.json()).error || "Failed to delete command");
      }
      return (await res.json()).removed as boolean;
    },
    onSuccess: (_d, v) =>
      qc.invalidateQueries({ queryKey: skillKeys.list(v.provider) }),
  });
}

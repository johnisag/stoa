import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionCeremony } from "@/lib/dispatch/types";
import { sessionKeys } from "./keys";

/** A ceremony still doing work — poll it; 'merged'/'stuck' are terminal. */
function isActive(c: SessionCeremony | null | undefined): boolean {
  return !!c && c.step !== "merged" && c.step !== "stuck";
}

/** The session's ceremony (or null). Polls every 5s while active, then stops. */
export function useCeremony(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: sessionKeys.ceremony(sessionId),
    queryFn: async (): Promise<SessionCeremony | null> => {
      const res = await fetch(`/api/sessions/${sessionId}/ceremony`);
      if (!res.ok) throw new Error("Failed to load auto-mode status");
      return (await res.json()).ceremony ?? null;
    },
    enabled,
    refetchInterval: (q) =>
      isActive(q.state.data as SessionCeremony | null) ? 5000 : false,
  });
}

/** Enrol the session in auto mode (optional seed prompt). */
export function useStartCeremony(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (seedPrompt?: string): Promise<SessionCeremony> => {
      const res = await fetch(`/api/sessions/${sessionId}/ceremony`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedPrompt: seedPrompt || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start auto mode");
      return data.ceremony as SessionCeremony;
    },
    onSuccess: (c) => qc.setQueryData(sessionKeys.ceremony(sessionId), c),
  });
}

/** Cancel auto mode (removes the ceremony; in-flight agents finish on their own). */
export function useCancelCeremony(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/ceremony`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to cancel auto mode");
    },
    onSuccess: () => qc.setQueryData(sessionKeys.ceremony(sessionId), null),
  });
}

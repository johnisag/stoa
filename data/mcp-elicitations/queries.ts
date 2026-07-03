"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
// Type-only — lib/mcp/elicit-schema is pure (no server-only deps), but keep it
// `import type` so nothing from the MCP layer bundles into the browser.
import type { ElicitField, ElicitValue } from "@/lib/mcp/elicit-schema";

export type { ElicitField, ElicitValue };

export interface PendingElicitation {
  id: string;
  conductorId: string;
  message: string;
  fields: ElicitField[];
  createdAt: number;
}

export const ELICITATIONS_KEY = ["mcp-elicitations"];

/** Shared fetcher so the inbox view and the ambient nav-badge count share ONE
 * cache entry (the count and the open queue can't disagree). */
export async function fetchElicitations(): Promise<PendingElicitation[]> {
  const res = await fetch("/api/mcp/elicit");
  if (!res.ok) throw new Error(`elicitations ${res.status}`);
  const data = await res.json();
  return data.elicitations ?? [];
}

/** Poll the operator's queue of pending agent input-requests. */
export function useElicitations(enabled: boolean) {
  return useQuery({
    queryKey: ELICITATIONS_KEY,
    enabled,
    queryFn: fetchElicitations,
    refetchInterval: 4000,
    staleTime: 2000,
    refetchOnWindowFocus: false,
  });
}

export type ElicitAction = "accept" | "decline" | "cancel";

/** Answer a pending request; refreshes the queue so the card drops. */
export function useAnswerElicitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: string;
      action: ElicitAction;
      values?: Record<string, ElicitValue>;
    }): Promise<void> => {
      const res = await fetch(`/api/mcp/elicit/${vars.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: vars.action, values: vars.values }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `answer ${res.status}`);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ELICITATIONS_KEY }),
  });
}

"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const key = (sessionId: string) => ["session-queue", sessionId];

/** A session's pending queued prompts. Polls so dispatched items disappear. */
export function useSessionQueue(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(sessionId),
    enabled,
    queryFn: async (): Promise<string[]> => {
      const res = await fetch(`/api/sessions/${sessionId}/queue`);
      if (!res.ok) throw new Error(`queue ${res.status}`);
      return (await res.json()).queue ?? [];
    },
    refetchInterval: enabled ? 4000 : false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useEnqueuePrompt(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string): Promise<string[]> => {
      const res = await fetch(`/api/sessions/${sessionId}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`enqueue ${res.status}`);
      return (await res.json()).queue ?? [];
    },
    onSuccess: (queue) => queryClient.setQueryData(key(sessionId), queue),
  });
}

/** Drop or reorder a single queued prompt by index (remove / move up / down). */
export function useQueueItemAction(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      action: "remove" | "up" | "down";
      index: number;
      // The text the client believes is at `index` — lets the server no-op if the
      // queue shifted under it (the ticker dispatched item 0), so it never mutates
      // the wrong prompt.
      text: string;
    }): Promise<string[]> => {
      const res = await fetch(`/api/sessions/${sessionId}/queue`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`queue-item ${res.status}`);
      return (await res.json()).queue ?? [];
    },
    onSuccess: (queue) => queryClient.setQueryData(key(sessionId), queue),
  });
}

export function useClearQueue(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<string[]> => {
      const res = await fetch(`/api/sessions/${sessionId}/queue`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`clear ${res.status}`);
      return [];
    },
    onSuccess: () => queryClient.setQueryData(key(sessionId), []),
  });
}

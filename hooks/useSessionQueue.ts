"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  newActionId,
  nextSeq,
  enqueueOfflineAction,
} from "@/hooks/useOfflineQueue";

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
      // Carry a client id so the request is idempotent: if it's queued offline and
      // the eventual replay is delivered twice, the server enqueues it once (#12).
      const clientId = newActionId();
      const url = `/api/sessions/${sessionId}/queue`;
      const body = JSON.stringify({ text, clientId });

      // Stash the action for replay + optimistically reflect it locally, so a send
      // in a dead spot (or a transient server failure) isn't lost — it's retried on
      // reconnect, tab refocus, or the periodic drain (useOfflineQueue). `offline`
      // distinguishes a real offline (navigator.onLine===false) from an online fetch
      // rejection so the toast doesn't give false "when you reconnect" confidence.
      const queueOffline = async (offline: boolean): Promise<string[]> => {
        await enqueueOfflineAction({
          id: clientId,
          url,
          method: "POST",
          body,
          label: text.replace(/\s+/g, " ").trim().slice(0, 60),
          createdAt: Date.now(),
          seq: nextSeq(),
          attempts: 0,
        });
        toast.message(
          offline
            ? "Offline — queued to send when you reconnect"
            : "Couldn't reach the server — queued, retrying shortly"
        );
        const current =
          (queryClient.getQueryData(key(sessionId)) as string[]) ?? [];
        return [...current, text];
      };

      // Known-offline: don't even attempt the network.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return queueOffline(true);
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch {
        // fetch() rejects on a NETWORK failure — offline, OR a transient
        // online failure (server restart / 502 / captive portal). Queue it either
        // way; the while-online drain triggers (useOfflineQueue) retry it.
        return queueOffline(
          typeof navigator !== "undefined" && navigator.onLine === false
        );
      }
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

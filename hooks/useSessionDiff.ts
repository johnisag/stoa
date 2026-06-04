"use client";

import { useQuery } from "@tanstack/react-query";
import type { SessionDiff } from "@/lib/session-diff";

// Shared shape (type-only import, erased at build — no server code reaches the
// client) so the response can't drift from what the route returns.
export type SessionDiffResponse = SessionDiff;

/**
 * The session's cumulative diff (what the agent changed). Heavier than the
 * status poll — only fetched when `enabled` (i.e. the review modal is open),
 * always fresh on open, and dropped from cache shortly after close.
 */
export function useSessionDiff(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["session-diff", sessionId],
    enabled,
    queryFn: async (): Promise<SessionDiffResponse> => {
      const res = await fetch(`/api/sessions/${sessionId}/diff`);
      if (!res.ok)
        throw new Error(`/api/sessions/${sessionId}/diff ${res.status}`);
      return res.json();
    },
    staleTime: 0, // re-fetch on every open — the agent may have changed things
    gcTime: 30000, // bound the (potentially large) cached diff's lifetime
    refetchOnWindowFocus: false,
  });
}

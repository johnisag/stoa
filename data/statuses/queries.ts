import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Session } from "@/lib/db";
import type { SessionStatus } from "@/components/views/types";
import { statusKeys } from "../sessions/keys";

interface StatusResponse {
  statuses: Record<string, SessionStatus>;
}

// Stable empty fallback: returning a fresh `{}` before the first fetch would give
// every consumer a new reference each render, defeating memoization (e.g. FleetBar).
// One shared frozen object keeps the identity stable until real data arrives.
const EMPTY_STATUSES: Record<string, SessionStatus> = Object.freeze({});

async function fetchStatuses(): Promise<StatusResponse> {
  const res = await fetch("/api/sessions/status");
  if (!res.ok) throw new Error("Failed to fetch statuses");
  return res.json();
}

interface UseSessionStatusesOptions {
  sessions: Session[];
  activeSessionId?: string | null;
  checkStateChanges: (
    states: Array<{
      id: string;
      name: string;
      status: SessionStatus["status"];
      hasPrompt?: boolean;
    }>,
    activeSessionId?: string | null
  ) => void;
}

export function useSessionStatusesQuery({
  sessions,
  activeSessionId,
  checkStateChanges,
}: UseSessionStatusesOptions) {
  const query = useQuery({
    queryKey: statusKeys.all,
    queryFn: fetchStatuses,
    staleTime: 2000,
    // Refetch on window focus (overrides the global default) so transitions
    // missed while the tab was hidden/throttled are caught the moment you
    // return — checkStateChanges then fires any pending notifications.
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const statuses = query.state.data?.statuses;
      if (!statuses) return 5000;

      // "running"/"waiting"/"error" are live or needs-attention states — poll
      // fast so transitions (and recovery) show quickly; otherwise back off.
      const hasActive = Object.values(statuses).some(
        (s) =>
          s.status === "running" ||
          s.status === "waiting" ||
          s.status === "error"
      );

      return hasActive ? 5000 : 30000;
    },
  });

  useEffect(() => {
    if (!query.data?.statuses) return;

    const statuses = query.data.statuses;

    const sessionStates = sessions.map((s) => ({
      id: s.id,
      name: s.name,
      status: (statuses[s.id]?.status || "dead") as SessionStatus["status"],
      hasPrompt: statuses[s.id]?.hasPrompt,
    }));
    checkStateChanges(sessionStates, activeSessionId);
    // Note: claude_session_id is now updated server-side in /api/sessions/status
  }, [query.data, sessions, activeSessionId, checkStateChanges]);

  return {
    sessionStatuses: query.data?.statuses ?? EMPTY_STATUSES,
    isLoading: query.isLoading,
  };
}

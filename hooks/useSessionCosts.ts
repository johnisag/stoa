"use client";

import { useQuery } from "@tanstack/react-query";
import type { SessionCost } from "@/app/api/sessions/cost/route";
import type { BudgetConfig, BudgetLevel } from "@/lib/budget";

export interface SessionCostsResponse {
  sessions: Record<string, SessionCost>;
  totalUsd: number;
  budget: BudgetConfig;
  levels: Record<string, BudgetLevel>;
}

/**
 * Estimated token cost per session + a fleet total. Reads each Claude session's
 * transcript, so it's heavier than the status poll — refetched slowly (every
 * 30s) and only as a cost-panel signal, not on the hot path.
 */
export function useSessionCosts() {
  return useQuery({
    queryKey: ["session-costs"],
    queryFn: async (): Promise<SessionCostsResponse> => {
      const res = await fetch("/api/sessions/cost");
      if (!res.ok) throw new Error(`/api/sessions/cost ${res.status}`);
      return res.json();
    },
    refetchInterval: 30000,
    refetchIntervalInBackground: false, // pause the poll when the tab is hidden
    staleTime: 20000,
  });
}

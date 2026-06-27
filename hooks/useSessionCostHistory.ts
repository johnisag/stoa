"use client";

import { useQuery } from "@tanstack/react-query";
import type { FleetCostPoint } from "@/lib/cost-history";

export interface SessionCostHistoryResponse {
  days: number;
  sinceDay: string;
  fleet: FleetCostPoint[];
  totalUsd: number;
}

/**
 * The PERSISTED fleet spend curve (one point per UTC day) — durable history that
 * survives session deletion / transcript loss, unlike the live cost snapshot.
 * Read lazily (only where a sparkline is shown) and refreshed slowly; the data
 * only changes when a sample is written (cost badge open, or the opt-in tick).
 */
export function useSessionCostHistory(days = 14) {
  return useQuery({
    queryKey: ["session-cost-history", days],
    queryFn: async (): Promise<SessionCostHistoryResponse> => {
      const res = await fetch(`/api/sessions/cost/history?days=${days}`);
      if (!res.ok) throw new Error(`/api/sessions/cost/history ${res.status}`);
      return res.json();
    },
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    staleTime: 45000,
  });
}

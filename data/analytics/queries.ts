import { useQuery } from "@tanstack/react-query";
// Type-only import — erased at build, so pulling the report type from the
// (server-touching) lib/analytics module doesn't drag node builtins into the
// client bundle (same trick data/dispatch/queries.ts uses for lib/db types).
import type { AnalyticsReport } from "@/lib/analytics/types";
import { analyticsKeys } from "./keys";

async function fetchReport(windowDays: number): Promise<AnalyticsReport> {
  const res = await fetch(`/api/analytics?windowDays=${windowDays}`);
  if (!res.ok) throw new Error("Failed to load analytics");
  return (await res.json()) as AnalyticsReport;
}

/**
 * The Insight report for a rolling window. `enabled` is true only while the
 * Analytics view is open so we never compute it in the background — it reads
 * transcripts + the ledger, which isn't free. Slow refetch: insight is a
 * reflective view, not a live monitor.
 */
export function useAnalyticsQuery(windowDays: number, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.report(windowDays),
    queryFn: () => fetchReport(windowDays),
    enabled,
    staleTime: 30000,
    refetchInterval: enabled ? 60000 : false,
  });
}

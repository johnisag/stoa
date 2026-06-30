"use client";

import { useQuery } from "@tanstack/react-query";
import type { SessionProcessInfo } from "@/app/api/monitor/processes/route";

export interface MonitorProcessesResponse {
  /** Per-session (by session id) child-process / MCP-server fan-out + listening ports. */
  fanouts: Record<string, SessionProcessInfo>;
}

/**
 * Per-session process fan-out (child-process + MCP-server counts) for the Agent
 * Monitor (M3). Heavier than the status poll — it shells out to ps / PowerShell — so
 * it's fetched slowly and ONLY while enabled (the Monitor view is open). `enabled`
 * gates it so the snapshot never runs when nothing is watching.
 */
export function useMonitorProcesses(enabled: boolean) {
  return useQuery({
    queryKey: ["monitor-processes"],
    queryFn: async (): Promise<MonitorProcessesResponse> => {
      const res = await fetch("/api/monitor/processes");
      if (!res.ok) throw new Error(`/api/monitor/processes ${res.status}`);
      return res.json();
    },
    enabled,
    refetchInterval: 15000,
    refetchIntervalInBackground: false, // pause when the tab is hidden
    staleTime: 10000,
  });
}

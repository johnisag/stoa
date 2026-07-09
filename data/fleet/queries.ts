import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  CreateFleetRunInput,
  FleetRunDetailDto,
  FleetRunDto,
} from "@/lib/fleet/types";
import { fleetKeys } from "./keys";

async function fetchFleetRuns(): Promise<FleetRunDto[]> {
  const res = await fetch("/api/fleet/runs");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load fleet runs");
  return data.runs ?? [];
}

async function fetchFleetRun(id: string): Promise<FleetRunDetailDto> {
  const res = await fetch(`/api/fleet/runs/${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load fleet run");
  return data as FleetRunDetailDto;
}

export function useFleetRunsQuery(enabled = true) {
  return useQuery({
    queryKey: fleetKeys.runs(),
    queryFn: fetchFleetRuns,
    enabled,
    staleTime: 5000,
    refetchInterval: enabled ? 15000 : false,
  });
}

export function useFleetRunQuery(id: string | null, enabled = true) {
  return useQuery({
    queryKey: fleetKeys.run(id ?? "__disabled__"),
    queryFn: enabled && id ? () => fetchFleetRun(id) : skipToken,
    staleTime: 5000,
  });
}

export function useCreateFleetRun() {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: CreateFleetRunInput) => {
      const res = await fetch("/api/fleet/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create fleet run");
      return data as FleetRunDetailDto;
    },
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      qc.setQueryData(fleetKeys.run(detail.run.id), detail);
    },
  });
}

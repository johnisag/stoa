import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ApproveFleetPlanInput,
  AttachFleetArtifactInput,
  CreateFleetRunInput,
  FleetRunDetailDto,
  FleetRunDto,
  FleetSchedulerSummary,
  IngestFleetPlanInput,
} from "@/lib/fleet/types";
import { fleetKeys } from "./keys";

export interface FleetRunActionResponse {
  run: FleetRunDetailDto;
  summary?: FleetSchedulerSummary;
}

export function fleetRunShouldPoll(detail: FleetRunDetailDto | undefined) {
  if (!detail) return false;
  if (detail.run.status === "canceled") return detail.pendingLaunches > 0;
  if (detail.workers.some((worker) => worker.status === "cleanup_pending")) {
    return true;
  }
  if (detail.run.status === "running") return true;
  if (detail.run.status === "paused") {
    return detail.workers.some((worker) =>
      ["leasing", "spawning", "running", "waiting_for_operator"].includes(
        worker.status
      )
    );
  }
  return false;
}

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
    refetchInterval: (query) => {
      const detail = query.state.data as FleetRunDetailDto | undefined;
      return fleetRunShouldPoll(detail) ? 5000 : false;
    },
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

function useFleetRunMutation<TInput>(
  mutationFn: (input: TInput) => Promise<FleetRunDetailDto>
) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn,
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      qc.setQueryData(fleetKeys.run(detail.run.id), detail);
    },
  });
}

export function useIngestFleetPlan(runId: string | null) {
  return useFleetRunMutation(async (input: IngestFleetPlanInput) => {
    if (!runId) throw new Error("No fleet run selected");
    const res = await fetch(
      `/api/fleet/runs/${encodeURIComponent(runId)}/plan`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to ingest fleet plan");
    return data as FleetRunDetailDto;
  });
}

export function useApproveFleetPlan(runId: string | null) {
  return useFleetRunMutation(async (input: ApproveFleetPlanInput) => {
    if (!runId) throw new Error("No fleet run selected");
    const res = await fetch(
      `/api/fleet/runs/${encodeURIComponent(runId)}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to approve fleet plan");
    return data as FleetRunDetailDto;
  });
}

export function useAttachFleetArtifact(runId: string | null) {
  return useFleetRunMutation(async (input: AttachFleetArtifactInput) => {
    if (!runId) throw new Error("No fleet run selected");
    const res = await fetch(
      `/api/fleet/runs/${encodeURIComponent(runId)}/artifacts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to attach finding");
    return data as FleetRunDetailDto;
  });
}

function useFleetRunAction(runId: string | null, action: string) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (): Promise<FleetRunActionResponse> => {
      if (!runId) throw new Error("No fleet run selected");
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(runId)}/${action}`,
        {
          method: "POST",
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.error || `Failed to ${action} fleet run`);
      return data as FleetRunActionResponse;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      qc.setQueryData(fleetKeys.run(result.run.run.id), result.run);
    },
  });
}

export function useStartFleetRun(runId: string | null) {
  return useFleetRunAction(runId, "start");
}

export function useTickFleetRun(runId: string | null) {
  return useFleetRunAction(runId, "tick");
}

export function usePauseFleetRun(runId: string | null) {
  return useFleetRunAction(runId, "pause");
}

export function useCancelFleetRun(runId: string | null) {
  return useFleetRunAction(runId, "cancel");
}

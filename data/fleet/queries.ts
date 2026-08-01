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
  IngestFleetPlanInput,
  PauseFleetRunInput,
  ResumeFleetRunInput,
  CancelFleetRunInput,
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
    refetchInterval: enabled && id ? 5000 : false,
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

function useFleetAction<TInput>(runId: string | null, action: string) {
  return useFleetRunMutation(async (input: TInput) => {
    if (!runId) throw new Error("No fleet run selected");
    const res = await fetch(
      `/api/fleet/runs/${encodeURIComponent(runId)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to ${action} fleet run`);
    return data as FleetRunDetailDto;
  });
}

export function useResumeFleetRun(runId: string | null) {
  return useFleetAction<ResumeFleetRunInput>(runId, "resume");
}

export function usePauseFleetRun(runId: string | null) {
  return useFleetAction<PauseFleetRunInput>(runId, "pause");
}

export function useCancelFleetRun(runId: string | null) {
  return useFleetAction<CancelFleetRunInput>(runId, "cancel");
}

export function useCompleteFleetWorker(runId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (workerId: string) => {
      if (!runId) throw new Error("No fleet run selected");
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(runId)}/workers/${encodeURIComponent(workerId)}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor: "operator" }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to mark worker complete");
      }
      return data as FleetRunDetailDto;
    },
    onSuccess: (detail) => {
      if (runId) qc.invalidateQueries({ queryKey: fleetKeys.run(runId) });
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      qc.setQueryData(fleetKeys.run(detail.run.id), detail);
    },
  });
}

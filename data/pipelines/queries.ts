import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
// Type-only imports are erased at build, so pulling the pipeline types from the
// (server-touching) lib/pipeline module does NOT drag node builtins into the
// client bundle — the same trick data/dispatch/queries.ts uses for lib/dispatch.
import type { PipelineRun, PipelineSpec } from "@/lib/pipeline/types";
import { pipelineKeys } from "./keys";

// ── reads ──

async function fetchRuns(): Promise<PipelineRun[]> {
  const res = await fetch("/api/pipelines");
  if (!res.ok) throw new Error("Failed to load pipeline runs");
  const data = await res.json();
  return data.runs ?? [];
}

async function fetchRun(id: string): Promise<PipelineRun> {
  const res = await fetch(`/api/pipelines/${id}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Pipeline run not found");
  return data.run;
}

/** A run still doing work — poll it fast; a terminal run never changes again. */
function isRunActive(run: PipelineRun | undefined): boolean {
  return run?.status === "pending" || run?.status === "running";
}

/** Recent runs, newest first. Polls only while the view is open (enabled). */
export function useListRuns(enabled = true) {
  return useQuery({
    queryKey: pipelineKeys.list(),
    queryFn: fetchRuns,
    enabled,
    staleTime: 4000,
    refetchInterval: enabled ? 6000 : false,
  });
}

/**
 * One run's live state. Polls every 2.5s WHILE the run is active and stops once
 * it reaches a terminal status (a kept run never changes), so an open-but-done
 * run isn't hammered. `id` null disables the query (nothing selected).
 */
export function usePollRun(id: string | null, enabled = true) {
  return useQuery({
    queryKey: pipelineKeys.detail(id ?? "__disabled__"),
    queryFn: enabled && id ? () => fetchRun(id) : skipToken,
    staleTime: 1500,
    refetchInterval: (query) =>
      isRunActive(query.state.data as PipelineRun | undefined) ? 2500 : false,
  });
}

// ── mutation ──

export interface StartRunInput {
  spec: PipelineSpec;
  conductorSessionId: string;
}

/**
 * Start a pipeline run. On success, seed the run-detail cache and invalidate the
 * list so the new run shows immediately, before the next poll tick.
 */
export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    // Never auto-retry: starting a run spawns workers, so a retried POST could
    // double-spawn (matches the explicit retry:0 on dispatch's mutations).
    retry: 0,
    mutationFn: async (input: StartRunInput): Promise<PipelineRun> => {
      const res = await fetch("/api/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.error || "Failed to start the pipeline");
      return data.run as PipelineRun;
    },
    onSuccess: (run) => {
      qc.setQueryData(pipelineKeys.detail(run.id), run);
      qc.invalidateQueries({ queryKey: pipelineKeys.list() });
    },
  });
}

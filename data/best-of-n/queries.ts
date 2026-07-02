import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { BestOfNRun, BestOfNCandidate } from "@/lib/db";

// ── types ──

export interface BestOfNCandidateWithStatus extends BestOfNCandidate {
  worker_status: string | null;
  session_status: string | null;
}

export interface BonRunWithCandidates {
  run: BestOfNRun;
  candidates: BestOfNCandidateWithStatus[];
}

// ── cache keys ──

export const bonKeys = {
  all: ["best-of-n"] as const,
  list: (projectId?: string) =>
    [...bonKeys.all, "list", projectId ?? "all"] as const,
  detail: (id: string) => [...bonKeys.all, "detail", id] as const,
};

// ── fetch helpers ──

async function fetchBonRuns(projectId?: string): Promise<BestOfNRun[]> {
  const url = projectId
    ? `/api/best-of-n?projectId=${encodeURIComponent(projectId)}`
    : "/api/best-of-n";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load Best-of-N runs");
  const data = await res.json();
  return data.runs ?? [];
}

async function fetchBonRun(id: string): Promise<BonRunWithCandidates> {
  const res = await fetch(`/api/best-of-n/${id}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Best-of-N run not found");
  return data as BonRunWithCandidates;
}

function isRunActive(run: BestOfNRun | undefined): boolean {
  return run?.status === "running";
}

// ── hooks ──

/** List recent Best-of-N runs. Polls every 6 s while open. */
export function useListBonRuns(projectId?: string, enabled = true) {
  return useQuery({
    queryKey: bonKeys.list(projectId),
    queryFn: enabled ? () => fetchBonRuns(projectId) : skipToken,
    staleTime: 4000,
    refetchInterval: enabled ? 6000 : false,
  });
}

/**
 * One run's live state. Polls every 2.5 s while the run is active; stops once
 * it reaches a terminal status (done / failed).
 */
export function usePollBonRun(id: string | null, enabled = true) {
  return useQuery({
    queryKey: bonKeys.detail(id ?? "__disabled__"),
    queryFn: enabled && id ? () => fetchBonRun(id) : skipToken,
    staleTime: 1500,
    refetchInterval: (query) => {
      const data = query.state.data as BonRunWithCandidates | undefined;
      return isRunActive(data?.run) ? 2500 : false;
    },
  });
}

// ── mutations ──

export interface CreateBonRunInput {
  task: string;
  n: 2 | 3;
  projectId: string;
  baseBranch?: string;
  conductorSessionId: string;
}

/** Start a Best-of-N run. retry:0 — spawns workers, so a retry would double-spawn. */
export function useCreateBonRun() {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (
      input: CreateBonRunInput
    ): Promise<BonRunWithCandidates> => {
      const res = await fetch("/api/best-of-n", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.error || "Failed to create Best-of-N run");
      return data as BonRunWithCandidates;
    },
    onSuccess: (result) => {
      qc.setQueryData(bonKeys.detail(result.run.id), result);
      qc.invalidateQueries({ queryKey: bonKeys.list() });
    },
  });
}

export interface PickWinnerInput {
  runId: string;
  candidateId: string;
}

/** Pick a winner for a Best-of-N run. retry:0 — kills other workers. */
export function usePickWinner() {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (
      input: PickWinnerInput
    ): Promise<
      { ok: boolean; winnerSessionId: string | null } & BonRunWithCandidates
    > => {
      const res = await fetch(`/api/best-of-n/${input.runId}/pick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: input.candidateId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to pick winner");
      return data;
    },
    onSuccess: (result) => {
      qc.setQueryData(bonKeys.detail(result.run.id), {
        run: result.run,
        candidates: result.candidates,
      });
      qc.invalidateQueries({ queryKey: bonKeys.list() });
    },
  });
}

/** Cancel a running Best-of-N run. */
export function useCancelBonRun() {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (runId: string): Promise<{ ok: boolean }> => {
      const res = await fetch(`/api/best-of-n/${runId}/cancel`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to cancel run");
      return data;
    },
    onSuccess: (_result, runId) => {
      qc.invalidateQueries({ queryKey: bonKeys.detail(runId) });
      qc.invalidateQueries({ queryKey: bonKeys.list() });
    },
  });
}

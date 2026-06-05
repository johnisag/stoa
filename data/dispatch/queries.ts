import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// Type-only imports are erased at build, so pulling the domain types from the
// (server-touching) lib/dispatch module does NOT drag node builtins into the
// client bundle — same trick data/sessions/queries.ts uses for lib/db types.
import type {
  DispatchRepo,
  DispatchMode,
  IssueDispatch,
} from "@/lib/dispatch/types";
import type { AgentType } from "@/lib/providers";
import { dispatchKeys } from "./keys";

// ── reads ──

async function fetchRepos(): Promise<DispatchRepo[]> {
  const res = await fetch("/api/dispatch/repos");
  if (!res.ok) throw new Error("Failed to load dispatch repos");
  const data = await res.json();
  return data.repos ?? [];
}

async function fetchPending(): Promise<IssueDispatch[]> {
  const res = await fetch("/api/dispatch/issues");
  if (!res.ok) throw new Error("Failed to load the dispatch backlog");
  const data = await res.json();
  return data.pending ?? [];
}

async function fetchBoard(): Promise<IssueDispatch[]> {
  const res = await fetch("/api/dispatch/dispatches");
  if (!res.ok) throw new Error("Failed to load the dispatch board");
  const data = await res.json();
  return data.dispatches ?? [];
}

/** The tracked repos + their allocation config. `enabled` is true only while the
 * Dispatch view is open so we don't poll the backlog/board in the background. */
export function useDispatchReposQuery(enabled = true) {
  return useQuery({
    queryKey: dispatchKeys.repos(),
    queryFn: fetchRepos,
    enabled,
    staleTime: 15000,
  });
}

export function usePendingQuery(enabled = true) {
  return useQuery({
    queryKey: dispatchKeys.pending(),
    queryFn: fetchPending,
    enabled,
    staleTime: 5000,
    refetchInterval: enabled ? 8000 : false,
  });
}

export function useBoardQuery(enabled = true) {
  return useQuery({
    queryKey: dispatchKeys.board(),
    queryFn: fetchBoard,
    enabled,
    staleTime: 5000,
    refetchInterval: enabled ? 5000 : false, // workers + PRs change while you watch
  });
}

// ── sources ── (auto-fill the add-repo form from a local path)

export interface ResolvedSource {
  isGitRepo: boolean;
  slug: string | null;
  defaultBranch: string | null;
}

async function resolveSource(path: string): Promise<ResolvedSource> {
  const res = await fetch(
    `/api/dispatch/resolve?path=${encodeURIComponent(path)}`
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to resolve repo");
  return data as ResolvedSource;
}

/** Resolve a local checkout path → { isGitRepo, slug, defaultBranch } so the
 * add-repo form can auto-fill owner/name + base branch when a source is picked. */
export function useResolveSource() {
  return useMutation({ mutationFn: resolveSource });
}

// ── writes ── (the route parses camelCase keys; see app/api/dispatch/repos)

export interface CreateRepoInput {
  repoPath: string;
  repoSlug: string;
  agentType: AgentType;
  dailyQuota: number;
  maxConcurrency: number;
  labelFilter: string | null;
  baseBranch: string;
  mode: DispatchMode;
  enabled: boolean;
}

export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateRepoInput) => {
      const res = await fetch("/api/dispatch/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to add repo");
      return data.repo as DispatchRepo;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: dispatchKeys.repos() }),
  });
}

/** Partial config patch (quota, concurrency, mode, enabled, agent, label, base). */
export type UpdateRepoPatch = Partial<{
  agentType: AgentType;
  dailyQuota: number;
  maxConcurrency: number;
  labelFilter: string | null;
  baseBranch: string;
  mode: DispatchMode;
  enabled: boolean;
}>;

export function useUpdateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: UpdateRepoPatch;
    }) => {
      const res = await fetch(`/api/dispatch/repos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to update repo");
      return data.repo as DispatchRepo;
    },
    // Optimistic: reflect the toggle/edit immediately, roll back on error.
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: dispatchKeys.repos() });
      const previous = qc.getQueryData<DispatchRepo[]>(dispatchKeys.repos());
      qc.setQueryData<DispatchRepo[]>(dispatchKeys.repos(), (old) =>
        (old ?? []).map((r) =>
          r.id === id
            ? {
                ...r,
                ...(patch.agentType !== undefined
                  ? { agent_type: patch.agentType }
                  : {}),
                ...(patch.dailyQuota !== undefined
                  ? { daily_quota: patch.dailyQuota }
                  : {}),
                ...(patch.maxConcurrency !== undefined
                  ? { max_concurrency: patch.maxConcurrency }
                  : {}),
                ...(patch.labelFilter !== undefined
                  ? { label_filter: patch.labelFilter }
                  : {}),
                ...(patch.baseBranch !== undefined
                  ? { base_branch: patch.baseBranch }
                  : {}),
                ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
                ...(patch.enabled !== undefined
                  ? { enabled: patch.enabled ? 1 : 0 }
                  : {}),
              }
            : r
        )
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(dispatchKeys.repos(), ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: dispatchKeys.repos() }),
  });
}

export function useDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/dispatch/repos/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove repo");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: dispatchKeys.all }),
  });
}

/** Approve (spawn now) or cancel a pending candidate. */
export function useDispatchAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: string;
      action: "approve" | "cancel";
    }) => {
      const res = await fetch(`/api/dispatch/dispatches/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed to ${action}`);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dispatchKeys.pending() });
      qc.invalidateQueries({ queryKey: dispatchKeys.board() });
    },
  });
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// Type-only imports are erased at build, so pulling the domain types from the
// (server-touching) lib/dispatch module does NOT drag node builtins into the
// client bundle — same trick data/sessions/queries.ts uses for lib/db types.
import type {
  DispatchRepo,
  DispatchMode,
  IssueDispatch,
  PlanTask,
} from "@/lib/dispatch/types";
import type { AgentType } from "@/lib/providers";
import type { DiscoveredRepo } from "@/lib/dispatch/discover";
import type { GitHubRepo, PreparedRepo } from "@/lib/dispatch/github";
import type { TriageIssue } from "@/lib/dispatch/triage";
import type { Recurrence } from "@/lib/dispatch/recurrence";
import { dispatchKeys } from "./keys";

export type { DiscoveredRepo, GitHubRepo, PreparedRepo, TriageIssue };

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

async function fetchScheduled(): Promise<IssueDispatch[]> {
  const res = await fetch("/api/dispatch/scheduled");
  if (!res.ok) throw new Error("Failed to load scheduled");
  const data = await res.json();
  return data.scheduled ?? [];
}

/** Future-dated rows ('scheduled'). Polls so a row disappears from the list as
 * it comes due and the reconciler promotes it. */
export function useScheduledQuery(enabled = true) {
  return useQuery({
    queryKey: dispatchKeys.scheduled(),
    queryFn: fetchScheduled,
    enabled,
    staleTime: 5000,
    refetchInterval: enabled ? 15000 : false,
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

async function fetchDiscovered(): Promise<DiscoveredRepo[]> {
  const res = await fetch("/api/dispatch/discover");
  if (!res.ok) throw new Error("Failed to scan for local repos");
  const data = await res.json();
  return data.repos ?? [];
}

/** Local git checkouts found by scanning the projects' parent folders (+
 * STOA_SCAN_ROOTS). Lazy: only runs while the "scan" source is selected. */
export function useDiscoverQuery(enabled = true) {
  return useQuery({
    queryKey: dispatchKeys.discover(),
    queryFn: fetchDiscovered,
    enabled,
    staleTime: 60000,
  });
}

export interface GitHubRepoList {
  repos: GitHubRepo[];
  cloneRoot: string | null;
}

async function fetchGitHubRepos(): Promise<GitHubRepoList> {
  const res = await fetch("/api/dispatch/github-repos");
  if (!res.ok) throw new Error("Failed to list GitHub repos");
  const data = await res.json();
  return { repos: data.repos ?? [], cloneRoot: data.cloneRoot ?? null };
}

/** The authenticated user's GitHub repos (via gh) + where a clone would land.
 * Lazy: only runs while the "github" source is selected. */
export function useGitHubReposQuery(enabled = true) {
  return useQuery({
    queryKey: dispatchKeys.github(),
    queryFn: fetchGitHubRepos,
    enabled,
    staleTime: 60000,
  });
}

async function prepareRepo(slug: string): Promise<PreparedRepo> {
  const res = await fetch("/api/dispatch/github-clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to prepare repo");
  return data as PreparedRepo;
}

/** Ensure a picked GitHub repo exists locally (clone-if-needed) → returns its
 * local path + default branch so the form can fill in. */
export function usePrepareRepo() {
  return useMutation({ mutationFn: prepareRepo });
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
  reviewGate: boolean;
  ciAutofix: boolean;
  mergeTrain: boolean;
  verifyGate: boolean;
  verifyCommand: string;
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

export interface CreateIssueInput {
  repoId: string;
  title: string;
  body: string;
  labels: string[];
  disposition: "now" | "backlog" | "scheduled";
  /** ISO time — required when disposition === "scheduled". */
  scheduledAt?: string;
  /** Opt-in: auto-merge the worker's PR once it's ready. */
  autoMerge?: boolean;
  /** 'local' = a GitHub-free task (no gh issue); default 'github'. */
  source?: "github" | "local";
  /** Recurrence for a scheduled local task ('once' = no repeat). */
  recurrence?: Recurrence;
}

/** Create a GitHub issue (source 'github') or a freeform local task (source
 * 'local') on a tracked repo and either dispatch it now, schedule it, or leave it
 * in the backlog. Refreshes the backlog + board. */
export function useCreateIssue() {
  const qc = useQueryClient();
  return useMutation({
    // Issue creation is non-idempotent (each POST opens a new GitHub issue) — do
    // NOT auto-retry, or a flaky network would create duplicates.
    retry: 0,
    mutationFn: async (input: CreateIssueInput) => {
      const res = await fetch("/api/dispatch/issues/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create issue");
      // `issue` is null for a local (GitHub-free) task.
      return data as { issue: { number: number; url: string } | null };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dispatchKeys.pending() });
      qc.invalidateQueries({ queryKey: dispatchKeys.board() });
      qc.invalidateQueries({ queryKey: dispatchKeys.scheduled() });
    },
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
  reviewGate: boolean;
  ciAutofix: boolean;
  mergeTrain: boolean;
  verifyGate: boolean;
  verifyCommand: string | null;
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
                ...(patch.reviewGate !== undefined
                  ? { review_gate: patch.reviewGate ? 1 : 0 }
                  : {}),
                ...(patch.ciAutofix !== undefined
                  ? { ci_autofix: patch.ciAutofix ? 1 : 0 }
                  : {}),
                ...(patch.mergeTrain !== undefined
                  ? { merge_train: patch.mergeTrain ? 1 : 0 }
                  : {}),
                ...(patch.verifyGate !== undefined
                  ? { verify_gate: patch.verifyGate ? 1 : 0 }
                  : {}),
                ...(patch.verifyCommand !== undefined
                  ? { verify_command: patch.verifyCommand }
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
      action: "approve" | "cancel" | "dismiss" | "retry";
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
      qc.invalidateQueries({ queryKey: dispatchKeys.scheduled() });
    },
  });
}

// ── on-demand triage ── (browse a repo's open issues, dispatch a chosen one)

async function fetchOpenIssues(
  repoId: string,
  search: string
): Promise<TriageIssue[]> {
  const qs = search.trim()
    ? `?search=${encodeURIComponent(search.trim())}`
    : "";
  const res = await fetch(`/api/dispatch/repos/${repoId}/open-issues${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to browse issues");
  return data.issues ?? [];
}

/** Browse a tracked repo's OPEN GitHub issues on demand for triage. Enabled only
 * while the panel is open — it shells out to gh, so never poll in the bg. */
export function useOpenIssuesQuery(
  repoId: string | null,
  search: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: [...dispatchKeys.openIssues(repoId ?? ""), search],
    queryFn: () => fetchOpenIssues(repoId as string, search),
    enabled: enabled && !!repoId,
    staleTime: 10000,
  });
}

export interface TriageDispatchInput {
  repoId: string;
  number: number;
  title?: string;
  url?: string | null;
  createdAt?: string;
}

/** Dispatch an EXISTING open issue picked during triage (spawns a worker now). */
export function useTriageDispatch() {
  const qc = useQueryClient();
  return useMutation({
    retry: 0, // spawning a worker is non-idempotent — never auto-retry
    mutationFn: async ({ repoId, ...rest }: TriageDispatchInput) => {
      const res = await fetch(`/api/dispatch/repos/${repoId}/open-issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rest),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to dispatch issue");
      return data as { dispatch: IssueDispatch };
    },
    onSuccess: (_data, v) => {
      qc.invalidateQueries({ queryKey: dispatchKeys.openIssues(v.repoId) });
      qc.invalidateQueries({ queryKey: dispatchKeys.pending() });
      qc.invalidateQueries({ queryKey: dispatchKeys.board() });
    },
  });
}

/** Merge a worker's PR (squash) — a deliberate user action from the cockpit. */
export function useMergeDispatch() {
  const qc = useQueryClient();
  return useMutation({
    retry: 0, // merge is non-idempotent — never auto-retry
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/dispatch/dispatches/${id}/merge`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Merge failed");
      return data;
    },
    onSuccess: (_data, id) => {
      // Flip the row to 'merged' immediately so the Merge button doesn't
      // re-enable in the window before the board refetch lands.
      qc.setQueryData<IssueDispatch[]>(dispatchKeys.board(), (old) =>
        (old ?? []).map((r) => (r.id === id ? { ...r, status: "merged" } : r))
      );
      qc.invalidateQueries({ queryKey: dispatchKeys.board() });
    },
  });
}

// ── Conflict-aware decomposition: the planner ────────────────────────────────

export type { PlanTask };

export type PlanRunStatus =
  | { status: "running" }
  | { status: "ready"; tasks: PlanTask[] }
  | { status: "failed"; error: string };

/** Start a planner run for a repo + spec; resolves to the planId the UI polls. */
export function useStartPlan() {
  return useMutation({
    mutationFn: async (input: {
      repoId: string;
      spec: string;
      taskCap?: number;
    }): Promise<string> => {
      const res = await fetch("/api/dispatch/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start the planner");
      return data.planId as string;
    },
  });
}

/** Poll a planner run while it's running (stops once ready/failed, or no planId). */
export function usePlanPoll(planId: string | null) {
  return useQuery({
    queryKey: planId ? dispatchKeys.plan(planId) : dispatchKeys.plan("none"),
    enabled: !!planId,
    queryFn: async (): Promise<PlanRunStatus> => {
      const res = await fetch(`/api/dispatch/plan/${planId}`);
      if (!res.ok) throw new Error("Failed to poll the planner");
      return res.json();
    },
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 3000 : false,
  });
}

/** File the reviewed tasks as issues + claimed dispatch rows; reclaims the worktree. */
export function useApprovePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      planId: string;
      tasks: PlanTask[];
      autoMerge?: boolean;
    }) => {
      const res = await fetch(`/api/dispatch/plan/${input.planId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: input.tasks,
          autoMerge: input.autoMerge,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to file the tasks");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dispatchKeys.pending() });
      qc.invalidateQueries({ queryKey: dispatchKeys.board() });
    },
  });
}

/** Cancel a planner run (reclaim its worktree + kill the planner). */
export function useCancelPlan() {
  return useMutation({
    mutationFn: async (planId: string) => {
      await fetch(`/api/dispatch/plan/${planId}`, { method: "DELETE" });
    },
  });
}

// ── Fleet memory: the per-repo lessons ledger (visibility) ───────────────────
export interface Lesson {
  id: string;
  lens: string | null;
  text: string;
  created_at: string;
}

/** What the critic has flagged for a repo (newest first). Lazy: only while open. */
export function useLessons(repoId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: repoId
      ? dispatchKeys.lessons(repoId)
      : dispatchKeys.lessons("none"),
    enabled: enabled && !!repoId,
    queryFn: async (): Promise<Lesson[]> => {
      const res = await fetch(`/api/dispatch/repos/${repoId}/lessons`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load lessons");
      return data.lessons ?? [];
    },
    staleTime: 5000,
  });
}

/** Forget a repo's lessons — all of them, or one (pass a lessonId). */
export function useClearLessons() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { repoId: string; lessonId?: string }) => {
      const qs = input.lessonId
        ? `?lesson=${encodeURIComponent(input.lessonId)}`
        : "";
      const res = await fetch(
        `/api/dispatch/repos/${input.repoId}/lessons${qs}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to clear lessons");
      }
    },
    onSuccess: (_d, input) =>
      qc.invalidateQueries({ queryKey: dispatchKeys.lessons(input.repoId) }),
  });
}

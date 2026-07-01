import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Session, Group } from "@/lib/db";
import type { AgentType } from "@/lib/providers";
import {
  respondErrorMessage,
  type RespondAction,
} from "@/lib/notification-actions";
import { sessionKeys } from "./keys";
import {
  removeSessionFromCache,
  patchSessionInCache,
  type SessionsCache,
} from "./optimistic";

type SessionsResponse = SessionsCache;

async function fetchSessions(): Promise<SessionsResponse> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error("Failed to fetch sessions");
  return res.json();
}

export function useSessionsQuery() {
  return useQuery({
    queryKey: sessionKeys.list(),
    queryFn: fetchSessions,
    staleTime: 5000,
    refetchInterval: 10000,
  });
}

export function useDeleteSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete session");
      return res.json();
    },
    onMutate: async (sessionId) => {
      await queryClient.cancelQueries({ queryKey: sessionKeys.list() });
      const previous = queryClient.getQueryData<SessionsResponse>(
        sessionKeys.list()
      );
      queryClient.setQueryData<SessionsResponse>(sessionKeys.list(), (old) =>
        removeSessionFromCache(old, sessionId)
      );
      return { previous };
    },
    onError: (_, __, context) => {
      if (context?.previous) {
        queryClient.setQueryData(sessionKeys.list(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
    onSuccess: (_data, sessionId) => {
      // The per-session ceremony entry is no longer relevant once deleted.
      queryClient.invalidateQueries({
        queryKey: sessionKeys.ceremony(sessionId),
      });
    },
  });
}

export function useRenameSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      newName,
    }: {
      sessionId: string;
      newName: string;
    }) => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) throw new Error("Failed to rename session");
      return res.json();
    },
    onMutate: async ({ sessionId, newName }) => {
      await queryClient.cancelQueries({ queryKey: sessionKeys.list() });
      const previous = queryClient.getQueryData<SessionsResponse>(
        sessionKeys.list()
      );
      queryClient.setQueryData<SessionsResponse>(sessionKeys.list(), (old) =>
        patchSessionInCache(old, sessionId, { name: newName })
      );
      return { previous };
    },
    onError: (_, __, context) => {
      if (context?.previous) {
        queryClient.setQueryData(sessionKeys.list(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export function useForkSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string): Promise<Session | null> => {
      const res = await fetch(`/api/sessions/${sessionId}/fork`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to fork session");
      const data = await res.json();
      return data.session || null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

/**
 * Stop a session in-place via the same /respond endpoint the push-notification
 * Stop button uses. The live status stream reflects the result; we also
 * invalidate the list as a backstop.
 */
export function useRespondToSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      action,
    }: {
      sessionId: string;
      action: RespondAction;
    }) => {
      const res = await fetch(`/api/sessions/${sessionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const msg = respondErrorMessage(res.status);
        if (msg) throw new Error(msg);
        // Only treat "session already gone" as benign; real server errors should surface.
        if (res.status === 404 || res.status === 410) {
          return { stale: true };
        }
        throw new Error(`Failed to respond to session (HTTP ${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export function useSummarizeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string): Promise<Session | null> => {
      const res = await fetch(`/api/sessions/${sessionId}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ createFork: true }),
      });
      if (!res.ok) throw new Error("Failed to summarize session");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.newSession || null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

/**
 * Read-only digest of what the agent did in a session. Hits the summarize
 * route's GET (no fork, no compaction), so it's safe to open mid-run. Only
 * fetched when `enabled` (the modal is open) and re-fetched on every open — a
 * long autonomous run keeps moving, so a cached digest would go stale fast.
 */
export function useSessionDigest(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.digest(sessionId),
    enabled,
    queryFn: async (): Promise<{ summary: string }> => {
      const res = await fetch(`/api/sessions/${sessionId}/summarize`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to summarize");
      return { summary: data.summary ?? "" };
    },
    staleTime: 0, // the run keeps moving — always re-summarize on open
    gcTime: 30000, // bound the cached digest's lifetime
    refetchOnWindowFocus: false,
    retry: false, // summarizing spawns `claude -p`; don't hammer it on failure
  });
}

export function useMoveSessionToGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      groupPath,
    }: {
      sessionId: string;
      groupPath: string;
    }) => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupPath }),
      });
      if (!res.ok) throw new Error("Failed to move session");
      return res.json();
    },
    onMutate: async ({ sessionId, groupPath }) => {
      await queryClient.cancelQueries({ queryKey: sessionKeys.list() });
      const previous = queryClient.getQueryData<SessionsResponse>(
        sessionKeys.list()
      );
      queryClient.setQueryData<SessionsResponse>(sessionKeys.list(), (old) =>
        patchSessionInCache(old, sessionId, { group_path: groupPath })
      );
      return { previous };
    },
    onError: (_, __, context) => {
      if (context?.previous) {
        queryClient.setQueryData(sessionKeys.list(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export function useMoveSessionToProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      projectId,
    }: {
      sessionId: string;
      projectId: string;
    }) => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) throw new Error("Failed to move session");
      return res.json();
    },
    onMutate: async ({ sessionId, projectId }) => {
      await queryClient.cancelQueries({ queryKey: sessionKeys.list() });
      const previous = queryClient.getQueryData<SessionsResponse>(
        sessionKeys.list()
      );
      queryClient.setQueryData<SessionsResponse>(sessionKeys.list(), (old) =>
        patchSessionInCache(old, sessionId, { project_id: projectId })
      );
      return { previous };
    },
    onError: (_, __, context) => {
      if (context?.previous) {
        queryClient.setQueryData(sessionKeys.list(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export interface CreateSessionInput {
  name?: string;
  workingDirectory: string;
  projectId: string | null;
  model: string;
  agentType: AgentType;
  useWorktree: boolean;
  featureName: string | null;
  baseBranch: string | null;
  // Attach to an existing worktree instead of creating one (recover a deleted
  // session's work). When set, the route skips createWorktree.
  existingWorktreePath?: string | null;
  existingWorktreeBranch?: string | null;
  // Multi-repo workspace: the picked sub-repos ({ path, name }) under a non-git
  // root. When set, the route builds one worktree per repo under one workspace dir.
  workspaceRepos?: { path: string; name: string }[] | null;
  autoApprove: boolean;
  enableOrchestration: boolean;
  useTmux: boolean;
  initialPrompt: string | null;
  /** #21: lifetime USD budget cap (null = no budget). */
  budgetUsd?: number | null;
}

interface CreateSessionResponse {
  session: Session;
  initialPrompt?: string;
  error?: string;
}

export function useCreateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      input: CreateSessionInput
    ): Promise<CreateSessionResponse> => {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create session");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

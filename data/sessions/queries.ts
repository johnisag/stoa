import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Session, Group } from "@/lib/db";
import type { AgentType } from "@/lib/providers";
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
      const data = await res.json();
      return data.session || null;
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
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.newSession || null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
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
    // NOT optimistic: the PATCH route currently ignores `projectId` (it only
    // handles name/status/workingDirectory/systemPrompt/groupPath), so the move
    // doesn't persist server-side. An optimistic patch would visibly move the
    // session and then snap it back on invalidation. Left as plain invalidate
    // until the server accepts projectId — see ROADMAP Priority A.
    onSuccess: () => {
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
  autoApprove: boolean;
  useTmux: boolean;
  initialPrompt: string | null;
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
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

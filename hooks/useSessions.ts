import { useCallback } from "react";
import type { Session } from "@/lib/db";
import {
  useSessionsQuery,
  useRenameSession,
  useForkSession,
  useSummarizeSession,
  useMoveSessionToGroup,
  useMoveSessionToProject,
} from "@/data/sessions";

export function useSessions() {
  const { data, refetch } = useSessionsQuery();
  const sessions = data?.sessions ?? [];
  const groups = data?.groups ?? [];
  // True once the query has returned at least once (vs. the initial undefined).
  // Guards pane reconciliation so we never detach restored tabs mid-load.
  const loaded = data !== undefined;

  const renameMutation = useRenameSession();
  const forkMutation = useForkSession();
  const summarizeMutation = useSummarizeSession();
  const moveToGroupMutation = useMoveSessionToGroup();
  const moveToProjectMutation = useMoveSessionToProject();

  const fetchSessions = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const renameSession = useCallback(
    async (sessionId: string, newName: string) => {
      await renameMutation.mutateAsync({ sessionId, newName });
    },
    [renameMutation]
  );

  const forkSession = useCallback(
    async (sessionId: string): Promise<Session | null> => {
      return await forkMutation.mutateAsync(sessionId);
    },
    [forkMutation]
  );

  const summarizeSession = useCallback(
    async (sessionId: string): Promise<Session | null> => {
      return await summarizeMutation.mutateAsync(sessionId);
    },
    [summarizeMutation]
  );

  const moveSessionToGroup = useCallback(
    async (sessionId: string, groupPath: string) => {
      await moveToGroupMutation.mutateAsync({ sessionId, groupPath });
    },
    [moveToGroupMutation]
  );

  const moveSessionToProject = useCallback(
    async (sessionId: string, projectId: string) => {
      await moveToProjectMutation.mutateAsync({ sessionId, projectId });
    },
    [moveToProjectMutation]
  );

  return {
    sessions,
    groups,
    loaded,
    summarizingSessionId: summarizeMutation.isPending
      ? (summarizeMutation.variables as string)
      : null,
    fetchSessions,
    renameSession,
    forkSession,
    summarizeSession,
    moveSessionToGroup,
    moveSessionToProject,
  };
}

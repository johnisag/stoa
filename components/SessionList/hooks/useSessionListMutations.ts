import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmProvider";
import {
  useDeleteSession,
  useRenameSession,
  useForkSession,
  useSummarizeSession,
  useMoveSessionToProject,
} from "@/data/sessions";
import {
  useToggleProject,
  useDeleteProject,
  useRenameProject,
} from "@/data/projects";
import { useToggleGroup, useCreateGroup, useDeleteGroup } from "@/data/groups";
import {
  useStopDevServer,
  useRestartDevServer,
  useRemoveDevServer,
} from "@/data/dev-servers";
import { sessionKeys } from "@/data/sessions/keys";
import {
  removeSessionFromCache,
  type SessionsCache,
} from "@/data/sessions/optimistic";
import { createUndoableRunner, UNDO_DELAY_MS } from "@/lib/undoable-action";

// #37: module-scoped so a pending delete survives re-renders/unmounts. The real
// DELETE only fires when the undo window elapses (or the same id is replaced).
const undoableSessionDelete = createUndoableRunner({ delayMs: UNDO_DELAY_MS });

interface UseSessionListMutationsOptions {
  onSelectSession: (sessionId: string) => void;
  /** The currently selected session — deleting IT jumps selection to the next
   * session so the pane doesn't sit on a ghost for the undo window. */
  activeSessionId?: string;
}

export function useSessionListMutations({
  onSelectSession,
  activeSessionId,
}: UseSessionListMutationsOptions) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  // Destructure the stable `mutateAsync` from each mutation rather than holding
  // the whole result object. react-query's useMutation returns a fresh
  // `{ ...result, mutate, mutateAsync }` object on EVERY render, but
  // `mutateAsync` itself is a single observer-bound method whose identity never
  // changes. Depending on `mutateAsync` (not the object) keeps the handlers
  // below referentially stable across the ~5s status poll — which is what lets
  // SessionCard's React.memo actually skip unchanged cards. (summarize keeps its
  // full object too, for the isPending/variables it reads below.)
  const { mutateAsync: deleteSession } = useDeleteSession();
  const { mutateAsync: renameSession } = useRenameSession();
  const { mutateAsync: forkSession } = useForkSession();
  const summarizeSessionMutation = useSummarizeSession();
  const { mutateAsync: summarizeSession } = summarizeSessionMutation;
  const { mutateAsync: moveSessionToProject } = useMoveSessionToProject();

  // Project mutations
  const { mutateAsync: toggleProject } = useToggleProject();
  const { mutateAsync: deleteProject } = useDeleteProject();
  const { mutateAsync: renameProject } = useRenameProject();

  // Group mutations
  const { mutateAsync: toggleGroup } = useToggleGroup();
  const { mutateAsync: createGroup } = useCreateGroup();
  const { mutateAsync: deleteGroup } = useDeleteGroup();

  // Dev server mutations
  const { mutateAsync: stopDevServer } = useStopDevServer();
  const { mutateAsync: restartDevServer } = useRestartDevServer();
  const { mutateAsync: removeDevServer } = useRemoveDevServer();

  // Derived state
  const summarizingSessionId = summarizeSessionMutation.isPending
    ? (summarizeSessionMutation.variables as string)
    : null;

  // Session handlers
  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      // Double-fire guard: a second delete of the SAME session inside the undo
      // window would flush the first (immediate delete) and leave its twin to
      // 404 later with a misleading error toast.
      if (undoableSessionDelete.pending().includes(`session:${sessionId}`))
        return;
      if (
        !(await confirm({
          title: "Delete session?",
          description:
            "This permanently deletes the session and, if it has one, its git " +
            "worktree (the branch is kept). You get a few seconds to undo.",
          confirmLabel: "Delete",
        }))
      )
        return;
      // #37: hide the row now, hold the real DELETE for the undo window. Undo
      // cancels the pending delete and refetches (the server never saw it);
      // the timeout executes it for real.
      const cached = queryClient.getQueryData<SessionsCache>(
        sessionKeys.list()
      );
      const name = cached?.sessions.find((s) => s.id === sessionId)?.name;
      undoableSessionDelete.schedule(
        `session:${sessionId}`,
        () => {
          deleteSession(sessionId).catch(() => {
            toast.error("Failed to delete session");
            queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
          });
        },
        () =>
          queryClient.setQueryData<SessionsCache>(sessionKeys.list(), (old) =>
            removeSessionFromCache(old, sessionId)
          )
      );
      // Deleting the session you're LOOKING AT: move selection to the next one
      // so the pane doesn't render a ghost during the grace window (an Undo
      // simply restores the row; re-selecting it re-attaches).
      if (sessionId === activeSessionId) {
        // Workers (conductor_session_id) aren't root-level rows — selecting
        // one would leave the list visually selection-less.
        const next = cached?.sessions.find(
          (s) => s.id !== sessionId && !s.conductor_session_id
        );
        if (next) onSelectSession(next.id);
      }
      toast(name ? `Deleted "${name}"` : "Session deleted", {
        duration: UNDO_DELAY_MS,
        action: {
          label: "Undo",
          onClick: () => {
            undoableSessionDelete.cancel(`session:${sessionId}`);
            queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
          },
        },
      });
    },
    [confirm, deleteSession, queryClient, activeSessionId, onSelectSession]
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, newName: string) => {
      await renameSession({ sessionId, newName });
    },
    [renameSession]
  );

  const handleForkSession = useCallback(
    async (sessionId: string) => {
      const forkedSession = await forkSession(sessionId);
      if (forkedSession) onSelectSession(forkedSession.id);
    },
    [forkSession, onSelectSession]
  );

  const handleSummarize = useCallback(
    async (sessionId: string) => {
      const newSession = await summarizeSession(sessionId);
      if (newSession) onSelectSession(newSession.id);
    },
    [summarizeSession, onSelectSession]
  );

  const handleMoveSessionToProject = useCallback(
    async (sessionId: string, projectId: string) => {
      await moveSessionToProject({ sessionId, projectId });
    },
    [moveSessionToProject]
  );

  // Project handlers
  const handleToggleProject = useCallback(
    async (projectId: string, expanded: boolean) => {
      await toggleProject({ projectId, expanded });
    },
    [toggleProject]
  );

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      if (
        !(await confirm({
          title: "Delete project?",
          description:
            "Sessions in this project will be moved to Uncategorized.",
          confirmLabel: "Delete",
        }))
      )
        return;
      await deleteProject(projectId);
    },
    [confirm, deleteProject]
  );

  const handleRenameProject = useCallback(
    async (projectId: string, newName: string) => {
      await renameProject({ projectId, newName });
    },
    [renameProject]
  );

  // Group handlers
  const handleToggleGroup = useCallback(
    async (path: string, expanded: boolean) => {
      await toggleGroup({ path, expanded });
    },
    [toggleGroup]
  );

  const handleCreateGroup = useCallback(
    async (name: string, parentPath?: string) => {
      await createGroup({ name, parentPath });
    },
    [createGroup]
  );

  const handleDeleteGroup = useCallback(
    async (path: string) => {
      if (
        !(await confirm({
          title: "Delete group?",
          description: "Sessions in this group will be moved to the parent.",
          confirmLabel: "Delete",
        }))
      )
        return;
      await deleteGroup(path);
    },
    [confirm, deleteGroup]
  );

  // Dev server handlers
  const handleStopDevServer = useCallback(
    async (serverId: string) => {
      await stopDevServer(serverId);
    },
    [stopDevServer]
  );

  const handleRestartDevServer = useCallback(
    async (serverId: string) => {
      await restartDevServer(serverId);
    },
    [restartDevServer]
  );

  const handleRemoveDevServer = useCallback(
    async (serverId: string) => {
      await removeDevServer(serverId);
    },
    [removeDevServer]
  );

  // Bulk delete handler
  const handleBulkDelete = useCallback(
    async (sessionIds: string[]) => {
      const count = sessionIds.length;
      const hasWorktrees = sessionIds.length > 0; // Assume some might have worktrees

      // Show toast with progress
      const toastId = toast.loading(
        hasWorktrees
          ? `Deleting ${count} session${count > 1 ? "s" : ""}... cleaning up worktrees in background`
          : `Deleting ${count} session${count > 1 ? "s" : ""}...`
      );

      let succeeded = 0;
      let failed = 0;

      // Delete all sessions in parallel for speed
      await Promise.allSettled(
        sessionIds.map(async (sessionId) => {
          try {
            const response = await fetch(`/api/sessions/${sessionId}`, {
              method: "DELETE",
            });
            if (response.ok) {
              succeeded++;
            } else {
              failed++;
            }
          } catch (error) {
            console.error(`Failed to delete session ${sessionId}:`, error);
            failed++;
          }
        })
      );

      // Invalidate cache to refresh UI
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });

      // Update toast based on results
      if (failed === 0) {
        toast.success(
          `Deleted ${succeeded} session${succeeded > 1 ? "s" : ""}`,
          { id: toastId }
        );
      } else if (succeeded === 0) {
        toast.error(
          `Failed to delete ${failed} session${failed > 1 ? "s" : ""}`,
          {
            id: toastId,
          }
        );
      } else {
        toast.warning(
          `Deleted ${succeeded}, failed ${failed} session${failed > 1 ? "s" : ""}`,
          { id: toastId }
        );
      }
    },
    [queryClient]
  );

  // Refresh handler
  const handleRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
  }, [queryClient]);

  return {
    // Derived state
    summarizingSessionId,

    // Session handlers
    handleDeleteSession,
    handleRenameSession,
    handleForkSession,
    handleSummarize,
    handleMoveSessionToProject,

    // Project handlers
    handleToggleProject,
    handleDeleteProject,
    handleRenameProject,

    // Group handlers
    handleToggleGroup,
    handleCreateGroup,
    handleDeleteGroup,

    // Dev server handlers
    handleStopDevServer,
    handleRestartDevServer,
    handleRemoveDevServer,

    // Bulk operations
    handleBulkDelete,
    handleRefresh,
  };
}

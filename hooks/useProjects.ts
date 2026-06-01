import { useCallback } from "react";
import {
  useProjectsQuery,
  useToggleProject,
  useRenameProject,
} from "@/data/projects";

export function useProjects() {
  const { data: projects = [], refetch } = useProjectsQuery();
  const toggleMutation = useToggleProject();
  const renameMutation = useRenameProject();

  const toggleProject = useCallback(
    async (projectId: string, expanded: boolean) => {
      await toggleMutation.mutateAsync({ projectId, expanded });
    },
    [toggleMutation]
  );

  const renameProject = useCallback(
    async (projectId: string, newName: string) => {
      await renameMutation.mutateAsync({ projectId, newName });
    },
    [renameMutation]
  );

  const fetchProjects = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return {
    projects,
    fetchProjects,
    toggleProject,
    renameProject,
  };
}

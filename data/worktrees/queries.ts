import { useQuery } from "@tanstack/react-query";
import { worktreesKeys } from "./keys";

export interface StoaWorktree {
  path: string;
  branch: string;
  projectId: string;
  projectName: string;
  attached: boolean;
  sessionId: string | null;
  sessionName: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

async function fetchWorktrees(): Promise<StoaWorktree[]> {
  const res = await fetch("/api/worktrees");
  if (!res.ok) throw new Error("Failed to fetch worktrees");
  const data = await res.json();
  return data.worktrees || [];
}

export function useWorktrees() {
  return useQuery({
    queryKey: worktreesKeys.all,
    queryFn: fetchWorktrees,
    staleTime: 10000,
  });
}

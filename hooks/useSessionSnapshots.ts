"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
// Keep these `import type` — lib/snapshots + lib/checkpoints pull in server-only
// git/child_process/db; a value import would bundle them into the client.
import type { Snapshot } from "@/lib/snapshots";
import type { CheckpointView } from "@/lib/checkpoints";

export type { Snapshot, CheckpointView };

const key = (sessionId: string) => ["session-snapshots", sessionId];
const ckey = (sessionId: string) => ["session-checkpoints", sessionId];

/** A session's turn snapshots (newest handling left to the caller). */
export function useSessionSnapshots(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(sessionId),
    enabled,
    queryFn: async (): Promise<Snapshot[]> => {
      const res = await fetch(`/api/sessions/${sessionId}/snapshots`);
      if (!res.ok) throw new Error(`snapshots ${res.status}`);
      const data = await res.json();
      return data.snapshots ?? [];
    },
    staleTime: 0,
    gcTime: 30000,
    refetchOnWindowFocus: false,
  });
}

/** A session's durable, labeled checkpoints (newest-first, `expired`-flagged). */
export function useSessionCheckpoints(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ckey(sessionId),
    enabled,
    queryFn: async (): Promise<CheckpointView[]> => {
      const res = await fetch(`/api/sessions/${sessionId}/checkpoints`);
      if (!res.ok) throw new Error(`checkpoints ${res.status}`);
      const data = await res.json();
      return data.checkpoints ?? [];
    },
    staleTime: 0,
    gcTime: 30000,
    refetchOnWindowFocus: false,
  });
}

/** Pin the current tree as a durable, labeled checkpoint; refreshes both lists
 *  (creating a checkpoint captures a snapshot under the hood). */
export function useCreateCheckpoint(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (label?: string): Promise<{ created: boolean }> => {
      const res = await fetch(`/api/sessions/${sessionId}/checkpoints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label ?? "" }),
      });
      if (!res.ok) throw new Error(`checkpoint ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key(sessionId) });
      queryClient.invalidateQueries({ queryKey: ckey(sessionId) });
    },
  });
}

/** Fork a new isolated session from a turn's snapshot (a worktree branched at
 *  that point + the provider's conversation fork). */
export function useForkFromSnapshot(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      seq: number;
      name?: string;
    }): Promise<{ session: { id: string; name: string } }> => {
      const res = await fetch(
        `/api/sessions/${sessionId}/snapshots/${vars.seq}/fork`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: vars.name }),
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `fork ${res.status}`);
      }
      return res.json();
    },
    // A fresh session appeared — refresh the session list.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

/** Rewind the working tree to a snapshot; refreshes the list (safety snapshot). */
export function useRestoreSnapshot(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      seq: number
    ): Promise<{ restored: boolean; safetySeq: number | null }> => {
      const res = await fetch(
        `/api/sessions/${sessionId}/snapshots/${seq}/restore`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error(`restore ${res.status}`);
      return res.json();
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: key(sessionId) }),
  });
}

/** The diff a snapshot introduced (immutable past turn → cached long). */
export function useSnapshotDiff(sessionId: string, seq: number | null) {
  return useQuery({
    queryKey: ["snapshot-diff", sessionId, seq],
    enabled: seq != null,
    queryFn: async (): Promise<string> => {
      const res = await fetch(
        `/api/sessions/${sessionId}/snapshots/${seq}/diff`
      );
      if (!res.ok) throw new Error(`snapshot diff ${res.status}`);
      const data = await res.json();
      return data.diff ?? "";
    },
    staleTime: 60000, // a past turn's diff is immutable
    gcTime: 60000, // ≥ staleTime, else the entry is evicted before it's reused
    refetchOnWindowFocus: false,
  });
}

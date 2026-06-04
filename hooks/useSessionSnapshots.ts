"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
// Keep this `import type` — lib/snapshots pulls in server-only git/child_process;
// a value import here would bundle it into the client.
import type { Snapshot } from "@/lib/snapshots";

export type { Snapshot };

const key = (sessionId: string) => ["session-snapshots", sessionId];

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

/** Capture a checkpoint now; refreshes the list. */
export function useCreateCheckpoint(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<Snapshot | null> => {
      const res = await fetch(`/api/sessions/${sessionId}/snapshots`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`checkpoint ${res.status}`);
      const data = await res.json();
      return data.snapshot ?? null;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: key(sessionId) }),
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

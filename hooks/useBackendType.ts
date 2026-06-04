"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * The active session backend ("pty" on Windows / STOA_BACKEND=pty, else "tmux").
 * Cached for the session — the live mini-terminal (observer attach) only works
 * on the pty path, so the UI gates the expand affordance on this.
 */
export function useBackendType(): "pty" | "tmux" | null {
  const { data } = useQuery({
    queryKey: ["backend-type"],
    queryFn: async (): Promise<"pty" | "tmux"> => {
      const res = await fetch("/api/backend");
      // Throw on a bad response so react-query retries instead of parsing an
      // error page as JSON and getting wedged at null (which hides the feature).
      if (!res.ok) throw new Error(`/api/backend returned ${res.status}`);
      const json = await res.json();
      return json.backend === "pty" ? "pty" : "tmux";
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? null;
}

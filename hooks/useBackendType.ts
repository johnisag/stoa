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
    // Self-heal a transient failure: a one-shot capability probe shouldn't get
    // wedged at null (hiding the feature) for the page's life if the first few
    // attempts blip. Poll only WHILE we have no answer; stop once resolved.
    refetchInterval: (query) => (query.state.data ? false : 30000),
  });
  return data ?? null;
}

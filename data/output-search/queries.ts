import { useQuery } from "@tanstack/react-query";
import { outputSearchKeys } from "./keys";

export interface OutputSearchHit {
  role: "user" | "assistant";
  snippet: string;
}

export interface OutputSearchSessionResult {
  id: string;
  name: string;
  agentType: string;
  /** Total matching lines in this session's transcript (hits may be capped). */
  total: number;
  hits: OutputSearchHit[];
}

interface OutputSearchResponse {
  results: OutputSearchSessionResult[];
  query: string;
  count: number;
  error?: string;
}

async function fetchOutputSearch(
  query: string,
  signal?: AbortSignal
): Promise<OutputSearchResponse> {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`/api/output-search?${params}`, { signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to search output");
  return data;
}

/**
 * Cross-session agent-output search. Enabled only past 2 chars (a 1-char query
 * matches everything); react-query dedupes by the query key and aborts a stale
 * in-flight request via the `signal` it threads into the queryFn.
 */
export function useOutputSearch(query: string, enabled = false) {
  return useQuery({
    queryKey: outputSearchKeys.search(query),
    queryFn: ({ signal }) => fetchOutputSearch(query, signal),
    enabled: enabled && query.trim().length > 1,
    staleTime: 15000,
    gcTime: 30000,
  });
}

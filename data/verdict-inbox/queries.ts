import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// Type-only imports are erased at build (no server modules in the client bundle).
import type { InboxItem } from "@/lib/verdict-inbox";
import type { ReviewerFinding } from "@/lib/dispatch/reviewer";
import { dispatchKeys } from "@/data/dispatch/keys";
import { sessionKeys } from "@/data/sessions/keys";
import { inboxKeys } from "./keys";

export type { InboxItem, ReviewerFinding };

/** The shared inbox fetch — one definition for both the open-dialog poll
 * (`useInbox`) and the always-on nav-badge count (`useAttentionCount`) so the two
 * observers hit the SAME query key + endpoint and react-query dedupes the request. */
export async function fetchInbox(): Promise<InboxItem[]> {
  const res = await fetch("/api/verdict-inbox");
  if (!res.ok) throw new Error("Failed to load the review queue");
  return (await res.json()).items ?? [];
}

/** The fleet review queue. Polls every 6s while the inbox is open. */
export function useInbox(enabled = true) {
  return useQuery({
    queryKey: inboxKeys.list(),
    queryFn: fetchInbox,
    enabled,
    staleTime: 4000,
    refetchInterval: enabled ? 6000 : false,
  });
}

/** Per-lens critic findings for one item, fetched LIVE on demand (card expand). */
export function useFindings(item: InboxItem | null, enabled: boolean) {
  return useQuery({
    queryKey: item
      ? inboxKeys.findings(item.type, item.id)
      : inboxKeys.findings("none", "none"),
    queryFn: async (): Promise<ReviewerFinding[]> => {
      if (!item || item.prNumber == null) return [];
      const p = new URLSearchParams({
        type: item.type,
        id: item.id,
        pr: String(item.prNumber),
      });
      if (item.sessionId) p.set("session", item.sessionId);
      const res = await fetch(`/api/verdict-inbox/findings?${p}`);
      if (!res.ok) throw new Error("Failed to load findings");
      return (await res.json()).findings ?? [];
    },
    enabled: enabled && !!item && item.prNumber != null,
    staleTime: 10000,
  });
}

async function act(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Action failed");
  return data;
}

/**
 * Merge / dismiss / retry for one inbox item, routed by type to the EXISTING
 * dispatch + ceremony endpoints (no new action surface). Merge is non-idempotent
 * → retry:0. All invalidate the list so the item updates/drops after acting.
 */
export function useInboxActions() {
  const qc = useQueryClient();
  // Acting from the inbox must also refresh the sibling surfaces that show the
  // same row — the Dispatch board / backlog (dispatch items) and the session's
  // auto-mode pill (ceremony items) — not just the inbox list itself.
  const settle = (item: InboxItem) => {
    qc.invalidateQueries({ queryKey: inboxKeys.list() });
    if (item.type === "dispatch") {
      qc.invalidateQueries({ queryKey: dispatchKeys.board() });
      qc.invalidateQueries({ queryKey: dispatchKeys.pending() });
    } else if (item.sessionId) {
      qc.invalidateQueries({ queryKey: sessionKeys.ceremony(item.sessionId) });
    }
  };

  const merge = useMutation({
    retry: 0,
    mutationFn: (item: InboxItem) =>
      item.type === "dispatch"
        ? act(`/api/dispatch/dispatches/${item.id}/merge`, "POST")
        : act(`/api/sessions/${item.sessionId}/ceremony`, "PUT"),
    onSuccess: (_d, item) => settle(item),
  });
  const dismiss = useMutation({
    mutationFn: (item: InboxItem) =>
      item.type === "dispatch"
        ? act(`/api/dispatch/dispatches/${item.id}`, "POST", {
            action: "dismiss",
          })
        : act(`/api/sessions/${item.sessionId}/ceremony`, "DELETE"),
    onSuccess: (_d, item) => settle(item),
  });
  const retry = useMutation({
    mutationFn: (item: InboxItem) =>
      act(`/api/dispatch/dispatches/${item.id}`, "POST", { action: "retry" }),
    onSuccess: (_d, item) => settle(item),
  });
  return { merge, dismiss, retry };
}

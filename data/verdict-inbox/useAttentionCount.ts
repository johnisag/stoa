import { useQuery } from "@tanstack/react-query";
// Type-only import is erased at build (no server modules in the client bundle);
// the selector lives in a db-free module for the same reason.
import type { InboxItem } from "@/lib/verdict-inbox";
import { countNeedsMe } from "@/lib/verdict-inbox-selectors";
import { fetchInbox } from "./queries";
import { inboxKeys } from "./keys";

/**
 * Always-on "needs me" count for the nav badges (Verdict Inbox + Fleet Board).
 *
 * The product thesis is "render verdicts from anywhere", so the nav icons need an
 * ambient signal even when no dialog is open. This reuses the EXISTING inbox
 * endpoint and query key (via the shared `fetchInbox`) so it shares ONE cache
 * entry with the open-dialog `useInbox` — the count and the open queue can't
 * disagree. (Each observer still keeps its own refetch timer, so while the inbox
 * is open there's the 6s poll plus this cheap 30s one; that's the intended cost,
 * not a double-poll of the same instant.)
 *
 * Cost is one cheap `/api/verdict-inbox` GET every 30s (the read model is pure DB
 * rows — see lib/verdict-inbox.ts — no `gh`); the count is derived from the SAME
 * `needsMe` selector the inbox view's "Needs me" tab uses. Pass `enabled = false`
 * on surfaces that don't render the badge (e.g. the desktop sidebar footer) to
 * avoid keeping a timer no one reads.
 */
export function useAttentionCount(enabled = true): number {
  const { data = 0 } = useQuery({
    queryKey: inboxKeys.list(),
    queryFn: fetchInbox,
    enabled,
    // A cheap 30s background poll, far below the inbox's open 6s.
    staleTime: 30000,
    refetchInterval: 30000,
    // We only need the count; selecting collapses the list to a number so a poll
    // that returns an unchanged count doesn't re-render every badge consumer.
    select: (items: InboxItem[]) => countNeedsMe(items),
  });
  return data;
}

import { useQuery } from "@tanstack/react-query";
// Type-only import is erased at build (no server modules in the client bundle);
// the selector lives in a db-free module for the same reason.
import type { InboxItem } from "@/lib/verdict-inbox";
import { countNeedsMe } from "@/lib/verdict-inbox-selectors";
import { fetchInbox } from "./queries";
import { inboxKeys } from "./keys";
import {
  fetchElicitations,
  ELICITATIONS_KEY,
  type PendingElicitation,
} from "@/data/mcp-elicitations/queries";
import { fetchFleetRuns } from "@/data/fleet/queries";
import { fleetKeys } from "@/data/fleet/keys";

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
 * Cost is two cheap DB-read requests every 30s (`/api/verdict-inbox` and the
 * shared Fleet run list; neither invokes `gh`). Pass `enabled = false` on
 * surfaces that don't render the badge to avoid keeping timers no one reads.
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

  // A pending MCP elicitation (#48) is an agent BLOCKED on the operator — it must
  // bump the same ambient badge so it's discoverable without the Inbox tab open.
  // Shares the elicitations cache entry (ELICITATIONS_KEY) with the inbox card.
  const { data: elicitations = 0 } = useQuery({
    queryKey: ELICITATIONS_KEY,
    queryFn: fetchElicitations,
    enabled,
    staleTime: 30000,
    refetchInterval: 30000,
    select: (items: PendingElicitation[]) => items.length,
  });

  const { data: fleetAttention = 0 } = useQuery({
    queryKey: fleetKeys.runs(),
    queryFn: fetchFleetRuns,
    enabled,
    staleTime: 30000,
    refetchInterval: 30000,
    // Keep the global badge item-based: one noisy Fleet run is one board card,
    // while that card retains its more detailed run/task/worker signal count.
    select: (runs) => runs.filter((run) => run.attentionCount > 0).length,
  });

  return data + elicitations + fleetAttention;
}

"use client";

import { cn } from "@/lib/utils";
import { InboxCard } from "@/components/views/VerdictInboxView/InboxCard";
import {
  AGENT_BADGE,
  STATUS_META,
  timeAgo,
} from "@/components/views/DispatchView/shared";
import { taskLabel } from "@/lib/dispatch/task-label";
import type { FleetCard as FleetCardData } from "@/lib/fleet-board/lanes";
import type { DispatchRepo } from "@/lib/dispatch/types";

/**
 * One fleet card. Inbox-sourced rows (pr_open / ceremonies) reuse the rich
 * InboxCard verbatim — verdict + per-lens findings + merge/dismiss/retry in place.
 * Queued/working/merged dispatch rows (no inbox item) get a light read-only card.
 */
export function FleetCard({
  card,
  repoById,
}: {
  card: FleetCardData;
  repoById: Map<string, DispatchRepo>;
}) {
  if (card.source === "inbox" && card.inbox) {
    return <InboxCard item={card.inbox} />;
  }
  const d = card.dispatch;
  if (!d) return null;
  const repo = repoById.get(d.repo_id);
  const meta = STATUS_META[d.status];
  const when = d.dispatched_at ?? d.created_at;
  return (
    <div className="bg-card flex flex-col gap-1 rounded-md border p-2.5 text-sm">
      <div className="flex items-center gap-2">
        {repo && (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
              AGENT_BADGE[repo.agent_type]
            )}
          >
            {repo.agent_type}
          </span>
        )}
        <span
          className="truncate font-medium"
          title={d.issue_title ?? undefined}
        >
          {taskLabel(d)}
        </span>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        {meta && (
          <span className={cn("rounded px-1.5 py-0.5 text-[10px]", meta.badge)}>
            {meta.label}
          </span>
        )}
        {repo?.repo_slug && <span className="truncate">{repo.repo_slug}</span>}
        {when && <span>· {timeAgo(when)}</span>}
      </div>
    </div>
  );
}

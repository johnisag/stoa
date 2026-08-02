"use client";

import { useState } from "react";
import { ChevronDown, Loader2, Network } from "lucide-react";

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
import type { FleetRunDto } from "@/lib/fleet/types";
import { useFleetRunQuery } from "@/data/fleet/queries";
import { Button } from "@/components/ui/button";

function FleetRunCard({
  run,
  onOpenFleetRun,
}: {
  run: FleetRunDto;
  onOpenFleetRun?: (runId: string, taskId?: string) => void;
}) {
  const [tasksOpen, setTasksOpen] = useState(false);
  const detail = useFleetRunQuery(run.id, tasksOpen);

  return (
    <article
      className="bg-card grid min-w-0 gap-2 rounded-md border p-2.5 text-sm"
      data-testid={`fleet-board-run-${run.id}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="bg-primary/10 text-primary flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
          <Network className="h-3 w-3" /> Fleet
        </span>
        <span className="truncate font-medium" title={run.name}>
          {run.name}
        </span>
      </div>
      <p className="text-muted-foreground line-clamp-2 text-xs">{run.goal}</p>
      <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
          {run.awaitingManualMerge
            ? "ready to merge"
            : run.status.replaceAll("_", " ")}
        </span>
        {run.attentionCount > 0 && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
            {run.attentionCount === 1
              ? "Needs you"
              : `${run.attentionCount} signals`}
          </span>
        )}
        <span>{run.taskCount} tasks</span>
        <span>{run.workerCount} workers</span>
      </div>
      <div className="grid grid-cols-1 gap-1 min-[28rem]:grid-cols-2">
        <Button
          size="sm"
          variant="outline"
          className="min-w-0 justify-center"
          aria-expanded={tasksOpen}
          aria-label={`${tasksOpen ? "Hide" : "Show"} tasks for Fleet run ${run.name}`}
          onClick={() => setTasksOpen((open) => !open)}
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              tasksOpen && "rotate-180"
            )}
          />
          {tasksOpen ? "Hide tasks" : "Show tasks"}
        </Button>
        {onOpenFleetRun && (
          <Button
            size="sm"
            variant="outline"
            className="min-w-0 justify-center"
            onClick={() => onOpenFleetRun(run.id)}
          >
            Open run
          </Button>
        )}
      </div>
      {tasksOpen && (
        <div className="grid min-w-0 gap-1 border-t pt-2">
          {detail.isLoading ? (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading tasks
            </span>
          ) : detail.error ? (
            <span className="text-destructive text-xs break-words">
              {detail.error.message}
            </span>
          ) : detail.data?.tasks.length ? (
            detail.data.tasks.map((task) =>
              onOpenFleetRun ? (
                <button
                  key={task.id}
                  type="button"
                  className="hover:bg-accent/60 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded border px-2 py-1.5 text-left"
                  onClick={() => onOpenFleetRun(run.id, task.id)}
                >
                  <span className="truncate text-xs">{task.title}</span>
                  <span className="text-muted-foreground text-[10px] uppercase">
                    {task.status.replaceAll("_", " ")}
                  </span>
                </button>
              ) : (
                <div
                  key={task.id}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 rounded border px-2 py-1.5"
                >
                  <span className="truncate text-xs">{task.title}</span>
                  <span className="text-muted-foreground text-[10px] uppercase">
                    {task.status.replaceAll("_", " ")}
                  </span>
                </div>
              )
            )
          ) : (
            <span className="text-muted-foreground text-xs">No tasks yet</span>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * One fleet card. Inbox-sourced rows (pr_open / ceremonies) reuse the rich
 * InboxCard verbatim — verdict + per-lens findings + merge/dismiss/retry in place.
 * Queued/working/merged dispatch rows get a light card. Durable Fleet runs add a
 * lazy task drilldown and exact run/task handoff to Fleet Management.
 */
export function FleetCard({
  card,
  repoById,
  onOpenSession,
  onOpenFleetRun,
}: {
  card: FleetCardData;
  repoById: Map<string, DispatchRepo>;
  onOpenSession?: (sessionId: string) => void;
  onOpenFleetRun?: (runId: string, taskId?: string) => void;
}) {
  if (card.source === "fleet" && card.fleetRun) {
    return <FleetRunCard run={card.fleetRun} onOpenFleetRun={onOpenFleetRun} />;
  }
  if (card.source === "inbox" && card.inbox) {
    return <InboxCard item={card.inbox} onOpenSession={onOpenSession} />;
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

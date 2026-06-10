"use client";

import { Loader2 } from "lucide-react";
import { useListRuns } from "@/data/pipelines/queries";
import { cn } from "@/lib/utils";
import { Centered, RUN_STATUS_META, timeAgoMs } from "./shared";

/** A terminal step no longer counts as outstanding work. */
function doneCount(steps: { status: string }[]): number {
  return steps.filter(
    (s) =>
      s.status === "succeeded" ||
      s.status === "failed" ||
      s.status === "skipped"
  ).length;
}

/** The recent-runs list. Polls while open; click a row to open its detail. */
export function RunsList({
  open,
  onOpen,
}: {
  open: boolean;
  onOpen: (id: string) => void;
}) {
  const { data: runs = [], isLoading, isError } = useListRuns(open);

  if (isLoading) {
    return (
      <Centered>
        <Loader2 className="h-4 w-4 animate-spin" /> Loading runs…
      </Centered>
    );
  }
  if (isError) {
    return (
      <Centered className="text-red-500">
        Failed to load runs. Retrying…
      </Centered>
    );
  }
  if (runs.length === 0) {
    return (
      <Centered>
        No pipeline runs yet — start one from the Templates tab.
      </Centered>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {runs.map((run) => {
        const steps = Object.values(run.steps);
        const meta = RUN_STATUS_META[run.status];
        return (
          <button
            key={run.id}
            type="button"
            onClick={() => onOpen(run.id)}
            className="bg-card hover:border-foreground/20 flex flex-col gap-1.5 rounded-md border p-3 text-left text-sm transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{run.spec.name}</span>
              <span
                className={cn(
                  "flex-shrink-0 rounded px-1.5 py-0.5 text-[11px]",
                  meta.badge
                )}
              >
                {meta.label}
              </span>
            </div>
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span>
                {doneCount(steps)}/{steps.length} steps
              </span>
              <span>·</span>
              <span>{timeAgoMs(run.createdAt)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import { usePollRun } from "@/data/pipelines/queries";
import { cn } from "@/lib/utils";
import {
  AGENT_BADGE,
  Centered,
  formatDuration,
  RUN_STATUS_META,
  STEP_STATUS_META,
  timeAgoMs,
} from "./shared";

/**
 * One run's live step board. Polls via usePollRun (fast while active, stops once
 * terminal). Steps are rendered in the spec's authored order so the DAG reads
 * top-down; each row shows status, agent, dependencies, elapsed time, and any
 * failure/skip detail. A status dot pulses while a step is running.
 */
export function RunDetail({
  runId,
  open,
  onBack,
}: {
  runId: string;
  open: boolean;
  onBack: () => void;
}) {
  const { data: run, isError } = usePollRun(runId, open);
  const meta = run ? RUN_STATUS_META[run.status] : null;

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-xs"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All runs
      </button>

      {!run ? (
        isError ? (
          <Centered className="text-red-500">
            Run not found — it may have been lost on a server restart (runs are
            kept in memory).
          </Centered>
        ) : (
          <Centered>
            <Loader2 className="h-4 w-4 animate-spin" /> Loading run…
          </Centered>
        )
      ) : (
        <>
          <div>
            <div className="flex items-center justify-between gap-2">
              <h3 className="truncate text-sm font-medium">{run.spec.name}</h3>
              {meta && (
                <span
                  className={cn(
                    "flex-shrink-0 rounded px-1.5 py-0.5 text-[11px]",
                    meta.badge
                  )}
                >
                  {meta.label}
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              started {timeAgoMs(run.createdAt)} · {run.spec.steps.length} steps
            </p>
          </div>

          <ol className="flex flex-col gap-2">
            {run.spec.steps.map((step) => {
              const st = run.steps[step.id];
              const sm = STEP_STATUS_META[st?.status ?? "pending"];
              return (
                <li
                  key={step.id}
                  className="bg-card flex flex-col gap-1 rounded-md border p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          "h-2 w-2 flex-shrink-0 rounded-full",
                          sm.dot,
                          st?.status === "running" && "animate-pulse"
                        )}
                      />
                      <span className="truncate font-medium">
                        {step.name || step.id}
                      </span>
                      <span
                        className={cn(
                          "flex-shrink-0 rounded px-1 py-0.5 text-[10px]",
                          AGENT_BADGE[step.agent] ??
                            "bg-muted text-muted-foreground"
                        )}
                      >
                        {step.agent}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "flex-shrink-0 rounded px-1.5 py-0.5 text-[11px]",
                        sm.badge
                      )}
                    >
                      {sm.label}
                    </span>
                  </div>

                  {step.dependsOn && step.dependsOn.length > 0 && (
                    <span className="text-muted-foreground text-[11px]">
                      depends on: {step.dependsOn.join(", ")}
                    </span>
                  )}
                  {st?.detail && (
                    <span className="text-muted-foreground text-xs leading-relaxed">
                      {st.detail}
                    </span>
                  )}
                  {st?.startedAt != null && (
                    <span className="text-muted-foreground text-[11px]">
                      {formatDuration(st.startedAt, st.endedAt)}
                      {st.endedAt == null ? " elapsed" : ""}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}

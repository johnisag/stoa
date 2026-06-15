"use client";

import { useMemo } from "react";
import { ArrowLeft, GitBranch, Loader2, Terminal } from "lucide-react";
import { usePollRun } from "@/data/pipelines/queries";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { StepStatus } from "@/lib/pipeline/types";
import type { Session } from "@/lib/db";
import { describeStepWorktree } from "@/lib/pipeline/worktree-display";
import { baseName } from "@/lib/path-display";
import { PipelineGraph } from "./PipelineGraph";
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
 *
 * Once a step has spawned its worker it carries a `sessionId` (StepState) — the
 * only produced-artifact identifier a pipeline step exposes (there is no PR/
 * branch on the run/step shape). When `onOpenSession` is wired, each such step
 * offers an "Open session" jump so a finished run hands off to its terminal
 * rather than dead-ending at "done".
 */
export function RunDetail({
  runId,
  open,
  onBack,
  onOpenSession,
  sessions,
}: {
  runId: string;
  open: boolean;
  onBack: () => void;
  /**
   * Jump to a step's spawned worker session by its Stoa session id. Optional —
   * supplied from app/page.tsx (it owns the attach/terminal machinery); absent
   * in contexts that can't drive a terminal, where the affordance is hidden.
   */
  onOpenSession?: (sessionId: string) => void;
  /**
   * All Stoa sessions — used to surface each step's git worktree (branch +
   * path) by joining the step's worker sessionId to its session row. Optional;
   * the worktree line is simply omitted when absent.
   */
  sessions?: Session[];
}) {
  const { data: run, isError } = usePollRun(runId, open);
  const meta = run ? RUN_STATUS_META[run.status] : null;

  // sessionId → session, so each step row can show its worker's worktree.
  const sessionsById = useMemo(
    () => new Map((sessions ?? []).map((s) => [s.id, s])),
    [sessions]
  );

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

          {/* DAG overview — the same steps as the list below, laid out by
              dependency depth so the topology (fan-out/fan-in) reads at a glance,
              colored live by each step's status. Collapsed by default so the
              actionable step list (with its Open-session jumps) stays the first
              thing on a phone; the list already shows each step's "depends on". */}
          <details className="bg-card/40 rounded-md border">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer px-3 py-2 text-xs font-medium select-none">
              Dependency graph
            </summary>
            <div className="border-t p-2">
              <PipelineGraph
                spec={run.spec}
                statusById={Object.fromEntries(
                  run.spec.steps.map((s) => [
                    s.id,
                    run.steps[s.id]?.status as StepStatus | undefined,
                  ])
                )}
              />
            </div>
          </details>

          <ol className="flex flex-col gap-2">
            {run.spec.steps.map((step) => {
              const st = run.steps[step.id];
              const sm = STEP_STATUS_META[st?.status ?? "pending"];
              const stepSessionId = st?.sessionId ?? null;
              const worker = stepSessionId
                ? sessionsById.get(stepSessionId)
                : undefined;
              const worktree = describeStepWorktree({
                worktreePath: worker?.worktree_path,
                branchName: worker?.branch_name,
                worktreePolicy: step.worktreePolicy,
              });
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
                  {/* The step's git worktree — its on-disk isolation. An "own"
                      step shows its branch + worktree folder; a shared step
                      notes it runs in the one shared workflow worktree. */}
                  {worktree &&
                    (worktree.kind === "own" ? (
                      <span
                        className="text-muted-foreground inline-flex w-fit items-center gap-1 text-[11px]"
                        title={worktree.path}
                      >
                        <GitBranch className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">
                          {worktree.branch ?? "(detached)"}
                        </span>
                        <span className="opacity-70">
                          · {baseName(worktree.path)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground inline-flex w-fit items-center gap-1 text-[11px]">
                        <GitBranch className="h-3 w-3 flex-shrink-0" />
                        shared workflow worktree
                      </span>
                    ))}
                  {/* Hand off to the step's spawned worker session — the only
                      produced artifact a step exposes. Shown once a worker
                      exists (sessionId set) and a jump handler is wired. */}
                  {onOpenSession && stepSessionId && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1 w-fit"
                      onClick={() => onOpenSession(stepSessionId)}
                    >
                      <Terminal className="mr-1.5 h-3 w-3" />
                      Open session
                    </Button>
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

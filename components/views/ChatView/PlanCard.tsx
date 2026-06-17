"use client";

import { Check, Circle, Loader2, X, XCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlanStep, CreateSessionParams } from "@/lib/command/actions";

export interface StepProgress {
  stepId: string;
  status: "waiting" | "running" | "done" | "failed";
  summary?: string;
}

export interface PlanCardProps {
  name: string;
  steps: PlanStep[];
  projectNames: Record<string, string>;
  status: "pending" | "executing" | "confirmed" | "cancelled";
  progress?: StepProgress[];
  onConfirm?: () => void;
  onCancel?: () => void;
  confirmDisabled?: boolean;
}

/** Icon for a step's execution status. */
function StepIcon({ status }: { status: StepProgress["status"] }) {
  if (status === "done") {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />;
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />;
  }
  if (status === "running") {
    return (
      <Loader2 className="text-muted-foreground h-3.5 w-3.5 shrink-0 animate-spin" />
    );
  }
  // waiting
  return <Circle className="text-muted-foreground h-3.5 w-3.5 shrink-0 opacity-50" />;
}

/**
 * A compact confirm card for a multi-step plan proposed by the LLM. Shows the
 * plan title, a numbered list of steps (one line each), and Confirm / Cancel
 * buttons. During and after execution each step shows a status icon (waiting /
 * running / done / failed). Matches the existing single-action proposal card
 * style exactly.
 */
export function PlanCard({
  name,
  steps,
  projectNames,
  status,
  progress,
  onConfirm,
  onCancel,
  confirmDisabled,
}: PlanCardProps) {
  const isPendingOrExecuting =
    status === "pending" || status === "executing";

  return (
    <div className="border-border bg-muted/30 max-w-[90%] space-y-3 rounded-2xl rounded-bl-sm border px-4 py-3">
      {/* Header */}
      <div className="space-y-0.5">
        <p className="text-sm font-medium">Stoa has a plan</p>
        <p className="text-muted-foreground text-sm">{name}</p>
      </div>

      {/* Step list */}
      <ol className="space-y-1.5">
        {steps.map((step, si) => {
          const prog = progress?.find((p) => p.stepId === step.stepId);
          const stepStatus: StepProgress["status"] = prog?.status ?? "waiting";

          let where = "";
          if (step.action === "create_session") {
            const p = step.params as CreateSessionParams;
            const projName = projectNames[p.projectId];
            if (projName) where = projName;
          }

          return (
            <li key={step.stepId} className="flex items-start gap-2 text-sm">
              {/* Step number (before execution) or status icon (during/after) */}
              {progress ? (
                <span className="mt-0.5 shrink-0">
                  <StepIcon status={stepStatus} />
                </span>
              ) : (
                <span className="text-muted-foreground mt-0.5 w-4 shrink-0 text-right text-xs">
                  {si + 1}.
                </span>
              )}

              <div className="min-w-0">
                <span className="font-medium">{step.description}</span>
                <span className="text-muted-foreground ml-1.5 text-xs">
                  via{" "}
                  {step.action === "create_session"
                    ? `${(step.params as CreateSessionParams).agentType} session`
                    : "dispatch"}
                  {where ? ` in ${where}` : ""}
                </span>
                {prog?.summary && (
                  <p className="text-muted-foreground mt-0.5 truncate text-xs">
                    {prog.summary}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Buttons or terminal state */}
      {isPendingOrExecuting ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={confirmDisabled || status === "executing"}
            className="h-8"
          >
            {status === "executing" ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="mr-1 h-3.5 w-3.5" />
            )}
            {status === "executing"
              ? "Executing…"
              : `Run ${steps.length} step${steps.length === 1 ? "" : "s"}`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            disabled={status === "executing"}
            className="h-8"
          >
            <X className="mr-1 h-3.5 w-3.5" />
            Cancel
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {status === "confirmed" ? "Plan confirmed." : "Cancelled."}
        </p>
      )}
    </div>
  );
}

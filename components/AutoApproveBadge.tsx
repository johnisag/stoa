"use client";

import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** The badge's full warning — shown in the tooltip (hover/focus) and as a toast
 * on tap (Radix tooltips don't open on touch, so the tap is the mobile path). */
const AUTO_APPROVE_WARNING =
  "Auto-approve is on: this agent runs every tool call — file edits and shell commands — without asking you first. It can change or delete things unprompted.";

/**
 * Persistent danger signal for an auto-approving ("YOLO") session. It's RED and
 * visible so it reads at a glance on mobile too (where hover tooltips don't fire);
 * the tooltip carries the full "why" on hover/focus, and a tap surfaces it as a
 * toast. Callers render it only when the session is actually auto-approving — guard
 * on `Boolean(session.auto_approve)` (the column is a SQLite 0/1, not a boolean).
 *
 * `label` = full pill ("⚠ Auto-approve") for roomy spots like the session top bar;
 * `label={false}` = icon-only for cramped rows (mobile tab bar, sidebar card).
 */
export function AutoApproveBadge({ label = true }: { label?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Auto-approve is on — this agent runs tool calls without asking"
          onClick={(e) => {
            // Don't let a tap on the warning select/navigate the underlying card.
            e.stopPropagation();
            toast.warning(AUTO_APPROVE_WARNING);
          }}
          className={cn(
            "focus-visible:ring-ring/60 inline-flex shrink-0 items-center gap-1 outline-none focus-visible:ring-2",
            label
              ? // Darker red text in light mode keeps the small label readable (AA);
                // dark mode uses the destructive token.
                "border-destructive/30 bg-destructive/15 dark:text-destructive rounded-full border px-2 py-0.5 text-xs font-semibold text-red-700"
              : "text-destructive rounded-full p-0.5"
          )}
        >
          <ShieldAlert className="h-3.5 w-3.5" />
          {label && "Auto-approve"}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        {AUTO_APPROVE_WARNING}
      </TooltipContent>
    </Tooltip>
  );
}

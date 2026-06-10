import type { ReactNode } from "react";
import type { RunStatus, StepStatus } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";

/** Compact "2h ago" from epoch-ms; "" when null. (Pipeline timestamps are ms,
 * unlike Dispatch's ISO strings — hence a local variant of DispatchView's timeAgo.) */
export function timeAgoMs(ms: number | null | undefined): string {
  if (ms == null) return "";
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

/** "1m 20s" elapsed from `start` to `end` (end defaults to now). "" when no start. */
export function formatDuration(
  start: number | null,
  end: number | null
): string {
  if (start == null) return "";
  const ms = (end ?? Date.now()) - start;
  if (ms < 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

// Same agent palette the session list + Dispatch board use, so a worker's
// provider reads identically across the app.
export const AGENT_BADGE: Record<string, string> = {
  claude: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  codex: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  hermes: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  shell: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
};

export const STEP_STATUS_META: Record<
  StepStatus,
  { label: string; badge: string; dot: string }
> = {
  pending: {
    label: "Pending",
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/40",
  },
  running: {
    label: "Running",
    badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    dot: "bg-blue-500",
  },
  succeeded: {
    label: "Succeeded",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  failed: {
    label: "Failed",
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
    dot: "bg-red-500",
  },
  skipped: {
    label: "Skipped",
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/30",
  },
};

export const RUN_STATUS_META: Record<
  RunStatus,
  { label: string; badge: string }
> = {
  pending: { label: "Pending", badge: "bg-muted text-muted-foreground" },
  running: {
    label: "Running",
    badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  succeeded: {
    label: "Succeeded",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  failed: {
    label: "Failed",
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
  partial: {
    label: "Partial",
    badge: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  },
};

/** Shared loading / empty / error placeholder (centred muted text). */
export function Centered({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center justify-center gap-2 py-10 text-center text-sm",
        className
      )}
    >
      {children}
    </div>
  );
}

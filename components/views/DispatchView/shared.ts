import type { DispatchStatus } from "@/lib/dispatch/types";

/** Compact "2h ago" / "3d ago" relative time. Returns "" for null. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
}

// Same palette the session list uses (components/SessionCard.tsx) so the agent
// badge reads identically across the app.
export const AGENT_BADGE: Record<string, string> = {
  claude: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  codex: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  hermes: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  shell: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
  kilo: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  kimi: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

export const STATUS_META: Record<
  DispatchStatus,
  { label: string; badge: string }
> = {
  scheduled: {
    label: "Scheduled",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  pending: { label: "Pending", badge: "bg-muted text-muted-foreground" },
  dispatched: {
    label: "Working",
    badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  pr_open: {
    label: "PR open",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  merged: {
    label: "Merged",
    badge: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  failed: {
    label: "Failed",
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
  cancelled: { label: "Cancelled", badge: "bg-muted text-muted-foreground" },
};

/**
 * A clickable URL for a repo slug, or `null` when there isn't a sensible one.
 * #34: only a GitHub `owner/name` slug maps to a github.com URL — a `linear:`/
 * other-source slug returned a broken `github.com/linear:TEAM` 404, so those
 * render as plain text (callers coalesce a null href to no link).
 */
export const repoUrl = (slug: string): string | null =>
  slug.includes(":") ? null : `https://github.com/${slug}`;

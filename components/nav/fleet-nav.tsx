import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Rocket,
  Workflow,
  Inbox,
  Columns3,
  Bell,
  Compass,
  Command,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Single source of truth for the fleet's icon-button destinations (Insight,
 * Dispatch, Workflows, Verdict Inbox, Fleet Board, Notifications, Guide, Quick
 * switch). Both the desktop header (`DesktopView`) and the sidebar footer
 * (`SidebarFooter`) render their nav from this descriptor so the two surfaces
 * can't silently drift apart again.
 *
 * The `aria-label`s here are the canonical, descriptive ones (e.g. "Dispatch
 * (GitHub issues to agents)"). The onClick handlers DIFFER per surface — they
 * are wired by each surface, not stored here.
 */
export interface FleetNavEntry {
  /** Stable identifier (used as the React key and in tests). */
  id: string;
  /** Tooltip title — the short, human label. */
  label: string;
  /** The lucide icon component for this destination. */
  icon: LucideIcon;
  /** Canonical, descriptive accessible name. */
  ariaLabel: string;
  /** Optional keyboard-shortcut hint shown as muted subtext in the tooltip. */
  tooltipHint?: string;
}

export const FLEET_NAV: readonly FleetNavEntry[] = [
  {
    id: "insight",
    label: "Insight",
    icon: BarChart3,
    ariaLabel: "Insight (analytics over the audit ledger)",
  },
  {
    id: "dispatch",
    label: "Dispatch",
    icon: Rocket,
    ariaLabel: "Dispatch (GitHub issues to agents)",
  },
  {
    id: "workflows",
    label: "Workflows",
    icon: Workflow,
    ariaLabel: "Workflows (run an agent pipeline from a template)",
  },
  {
    id: "verdict-inbox",
    label: "Verdict Inbox",
    icon: Inbox,
    ariaLabel: "Verdict Inbox (the fleet review queue)",
  },
  {
    id: "fleet-board",
    label: "Fleet Board",
    icon: Columns3,
    ariaLabel: "Fleet Board (the fleet by lifecycle stage)",
  },
  {
    id: "ask-stoa",
    label: "Ask Stoa",
    icon: Sparkles,
    ariaLabel: "Ask Stoa (chat about your fleet)",
    tooltipHint: "⌘⇧C",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    ariaLabel: "Notifications (sound, per-event toggles, push)",
  },
  {
    id: "guide",
    label: "What Stoa can do",
    icon: Compass,
    ariaLabel: "What Stoa can do — feature guide",
  },
  {
    id: "quick-switch",
    label: "Quick switch",
    icon: Command,
    ariaLabel: "Quick switch (Cmd/Ctrl+K)",
    tooltipHint: "⌘K",
  },
] as const;

/** Look up a single entry by id (throws if the id is unknown). */
export function fleetNavEntry(id: string): FleetNavEntry {
  const entry = FLEET_NAV.find((e) => e.id === id);
  if (!entry) throw new Error(`Unknown fleet nav entry: ${id}`);
  return entry;
}

/**
 * The "needs me" count pill — an amber badge tucked into the icon button's
 * top-right corner. Mirrors the SessionListHeader attention pill's amber palette
 * (`bg-amber-500/15` + amber text) so the fleet's two attention signals read the
 * same; >9 collapses to "9+" so it never widens the icon button. Decorative — the
 * count is also voiced in the button's `aria-label`, so this is `aria-hidden`.
 */
export function CountBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/15 px-1 text-[10px] leading-none font-medium text-amber-600 dark:text-amber-400"
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * Renders one {@link FleetNavEntry} as a tooltipped icon button. `variant`
 * picks the surface styling: "header" uses the shared ui `Button` (ghost,
 * icon-sm) as in the desktop header; "footer" uses the footer's raw muted
 * button. The onClick is supplied by the caller so each surface keeps its own
 * wiring (e.g. the footer also closes the sidebar).
 *
 * `count` is the optional "needs me" badge: when > 0 an amber corner pill is
 * overlaid on the icon (and folded into the accessible name); omit it / pass 0
 * for the plain icon — backward-compatible with every existing call site.
 */
export function NavIconButton({
  entry,
  onClick,
  variant,
  tooltipSide,
  count,
  showLabel = false,
}: {
  entry: FleetNavEntry;
  onClick: () => void;
  variant: "header" | "footer";
  /** Tooltip placement; defaults to "top" (the footer's side). */
  tooltipSide?: "top" | "bottom";
  /** "Needs me" count; renders an amber corner badge when > 0 (no badge otherwise). */
  count?: number;
  /** Render the label text BESIDE the icon — a prominent, unmistakable button for
   * a flagship destination (e.g. the chatbox), and skip the now-redundant tooltip.
   * Header variant only. */
  showLabel?: boolean;
}) {
  const Icon = entry.icon;
  const side = tooltipSide ?? "top";
  const showBadge = (count ?? 0) > 0;
  // Fold the count into the accessible name so the badge isn't sighted-only.
  const ariaLabel = showBadge
    ? `${entry.ariaLabel} — ${count} ${count === 1 ? "needs" : "need"} you`
    : entry.ariaLabel;

  const trigger =
    variant === "header" ? (
      <Button
        variant="ghost"
        size={showLabel ? "sm" : "icon-sm"}
        aria-label={ariaLabel}
        onClick={onClick}
        className="relative"
      >
        <Icon className="h-4 w-4" />
        {showLabel && <span className="ml-1.5">{entry.label}</span>}
        {showBadge && <CountBadge count={count!} />}
      </Button>
    ) : (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className="text-muted-foreground hover:text-foreground hover:bg-accent relative rounded p-1 transition-colors"
      >
        <Icon className="h-4 w-4" />
        {showBadge && <CountBadge count={count!} />}
      </button>
    );

  // A visible label is its own affordance, but if there's a keyboard shortcut
  // hint we still surface it in a compact tooltip so the chord is discoverable.
  if (showLabel) {
    if (!entry.tooltipHint) return trigger;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side={side}>
          <p className="text-muted-foreground text-xs">{entry.tooltipHint}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side={side}>
        <p>{entry.label}</p>
        {showBadge && (
          <p className="font-medium text-amber-600 dark:text-amber-400">
            {count} {count === 1 ? "needs" : "need"} you
          </p>
        )}
        {entry.tooltipHint && (
          <p className="text-muted-foreground text-xs">{entry.tooltipHint}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

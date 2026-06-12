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
 * Renders one {@link FleetNavEntry} as a tooltipped icon button. `variant`
 * picks the surface styling: "header" uses the shared ui `Button` (ghost,
 * icon-sm) as in the desktop header; "footer" uses the footer's raw muted
 * button. The onClick is supplied by the caller so each surface keeps its own
 * wiring (e.g. the footer also closes the sidebar).
 */
export function NavIconButton({
  entry,
  onClick,
  variant,
  tooltipSide,
}: {
  entry: FleetNavEntry;
  onClick: () => void;
  variant: "header" | "footer";
  /** Tooltip placement; defaults to "top" (the footer's side). */
  tooltipSide?: "top" | "bottom";
}) {
  const Icon = entry.icon;
  const side = tooltipSide ?? "top";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {variant === "header" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={entry.ariaLabel}
            onClick={onClick}
          >
            <Icon className="h-4 w-4" />
          </Button>
        ) : (
          <button
            type="button"
            onClick={onClick}
            aria-label={entry.ariaLabel}
            className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 transition-colors"
          >
            <Icon className="h-4 w-4" />
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side={side}>
        <p>{entry.label}</p>
        {entry.tooltipHint && (
          <p className="text-muted-foreground text-xs">{entry.tooltipHint}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

"use client";

import { ThemeToggle } from "@/components/ThemeToggle";
import { Keyboard } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fleetNavEntry, NavIconButton } from "@/components/nav/fleet-nav";
import { useAttentionCount } from "@/data/verdict-inbox/useAttentionCount";
import { WorktreesButton } from "@/components/Worktrees/WorktreesButton";

interface SidebarFooterProps {
  /** Opens the plain-English feature guide ("what can Stoa do?"). */
  onShowGuide?: () => void;
  /** Opens the keyboard-shortcut cheatsheet (also bound to `?`). */
  onShowShortcuts?: () => void;
  /** Opens the Dispatch control plane (GitHub issues -> agent fleet). */
  onShowDispatch?: () => void;
  /** Opens the Insight / analytics view over the audit ledger. */
  onShowAnalytics?: () => void;
  /** Opens the Workflows view (run an agent pipeline from a template). */
  onShowWorkflows?: () => void;
  /** Opens the Verdict Inbox (the fleet review queue). */
  onShowVerdictInbox?: () => void;
  /** Opens the Fleet Board (the fleet by lifecycle stage). */
  onShowFleetBoard?: () => void;
  /** Opens the notification settings (sound, per-event toggles, push). */
  onShowNotifications?: () => void;
  /** Opens the Ask Stoa chatbox. */
  onShowChat?: () => void;
  /** Opens the Notes / shared knowledge base dialog. */
  onShowNotes?: () => void;
}

export function SidebarFooter({
  onShowGuide,
  onShowShortcuts,
  onShowDispatch,
  onShowAnalytics,
  onShowWorkflows,
  onShowVerdictInbox,
  onShowFleetBoard,
  onShowNotifications,
  onShowChat,
  onShowNotes,
}: SidebarFooterProps = {}) {
  // "Needs me" count for the Verdict Inbox / Fleet Board nav badges — a cheap 30s
  // background poll shared with the desktop header (same query key). Only run it
  // when this footer actually renders the fleet nav (mobile); on desktop the
  // footer omits those entries, so there's nothing to badge.
  const attentionCount = useAttentionCount(
    !!(onShowVerdictInbox || onShowFleetBoard)
  );
  return (
    <div className="mt-auto px-3 pt-2 pb-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">Theme</span>
        <div className="flex items-center gap-1">
          {/* Fleet destinations — rendered from the shared FLEET_NAV descriptor
              so this footer stays in lockstep with the desktop header. Each
              button is still gated on its own handler prop, and onClick wiring
              (which also closes the sidebar via the caller's handler) stays the
              caller's responsibility. */}
          {onShowAnalytics && (
            <NavIconButton
              entry={fleetNavEntry("insight")}
              variant="footer"
              onClick={onShowAnalytics}
            />
          )}
          {onShowDispatch && (
            <NavIconButton
              entry={fleetNavEntry("dispatch")}
              variant="footer"
              onClick={onShowDispatch}
            />
          )}
          {onShowWorkflows && (
            <NavIconButton
              entry={fleetNavEntry("workflows")}
              variant="footer"
              onClick={onShowWorkflows}
            />
          )}
          {onShowVerdictInbox && (
            <NavIconButton
              entry={fleetNavEntry("verdict-inbox")}
              variant="footer"
              onClick={onShowVerdictInbox}
              count={attentionCount}
            />
          )}
          {onShowFleetBoard && (
            <NavIconButton
              entry={fleetNavEntry("fleet-board")}
              variant="footer"
              onClick={onShowFleetBoard}
              count={attentionCount}
            />
          )}
          {onShowChat && (
            <NavIconButton
              entry={fleetNavEntry("ask-stoa")}
              variant="footer"
              onClick={onShowChat}
            />
          )}
          {onShowNotes && (
            <NavIconButton
              entry={fleetNavEntry("notes")}
              variant="footer"
              onClick={onShowNotes}
            />
          )}
          {onShowNotifications && (
            <NavIconButton
              entry={fleetNavEntry("notifications")}
              variant="footer"
              onClick={onShowNotifications}
            />
          )}
          {onShowGuide && (
            <NavIconButton
              entry={fleetNavEntry("guide")}
              variant="footer"
              onClick={onShowGuide}
            />
          )}
          {onShowShortcuts && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onShowShortcuts}
                  aria-label="Keyboard shortcuts"
                  className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 transition-colors"
                >
                  <Keyboard className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Keyboard shortcuts (?)</p>
              </TooltipContent>
            </Tooltip>
          )}
          <WorktreesButton />
          <ThemeToggle />
        </div>
      </div>
      <div className="text-muted-foreground/50 mt-2 text-center text-[10px]">
        Made with{" "}
        <span role="img" aria-label="love" className="text-rose-400">
          ♥
        </span>{" "}
        using{" "}
        <a
          href="https://claude.com/claude-code"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-muted-foreground transition-colors"
        >
          Claude
        </a>{" "}
        &amp;{" "}
        <a
          href="https://github.com/nousresearch/hermes-agent"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-muted-foreground transition-colors"
        >
          Hermes
        </a>
      </div>
    </div>
  );
}

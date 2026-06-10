import { ThemeToggle } from "@/components/ThemeToggle";
import { Keyboard, Rocket, BarChart3, Workflow, Inbox } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorktreesButton } from "@/components/Worktrees/WorktreesButton";

interface SidebarFooterProps {
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
}

export function SidebarFooter({
  onShowShortcuts,
  onShowDispatch,
  onShowAnalytics,
  onShowWorkflows,
  onShowVerdictInbox,
}: SidebarFooterProps = {}) {
  return (
    <div className="mt-auto px-3 pt-2 pb-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">Theme</span>
        <div className="flex items-center gap-1">
          {onShowAnalytics && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onShowAnalytics}
                  aria-label="Insight"
                  className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 transition-colors"
                >
                  <BarChart3 className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Insight</p>
              </TooltipContent>
            </Tooltip>
          )}
          {onShowDispatch && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onShowDispatch}
                  aria-label="Dispatch"
                  className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 transition-colors"
                >
                  <Rocket className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Dispatch</p>
              </TooltipContent>
            </Tooltip>
          )}
          {onShowWorkflows && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onShowWorkflows}
                  aria-label="Workflows"
                  className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 transition-colors"
                >
                  <Workflow className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Workflows</p>
              </TooltipContent>
            </Tooltip>
          )}
          {onShowVerdictInbox && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onShowVerdictInbox}
                  aria-label="Verdict Inbox"
                  className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 transition-colors"
                >
                  <Inbox className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Verdict Inbox</p>
              </TooltipContent>
            </Tooltip>
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

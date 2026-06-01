import { ThemeToggle } from "@/components/ThemeToggle";
import { Keyboard } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SidebarFooterProps {
  /** Opens the keyboard-shortcut cheatsheet (also bound to `?`). */
  onShowShortcuts?: () => void;
}

export function SidebarFooter({ onShowShortcuts }: SidebarFooterProps = {}) {
  return (
    <div className="mt-auto px-3 pt-2 pb-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">Theme</span>
        <div className="flex items-center gap-1">
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
          <ThemeToggle />
        </div>
      </div>
      <div className="text-muted-foreground/50 mt-2 text-center text-[10px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="https://aterm.app"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-muted-foreground transition-colors"
            >
              aTerm
            </a>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>Desktop terminal workspace for AI coding agents</p>
          </TooltipContent>
        </Tooltip>
        <span className="mx-1.5">·</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href="https://lumifyhub.io"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-muted-foreground transition-colors"
            >
              LumifyHub
            </a>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="flex items-center gap-1.5">
              Team collaboration with chat and documentation
              <span className="bg-primary/15 text-primary rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                Sponsor
              </span>
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

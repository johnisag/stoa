import { ADropdownMenu, menuItem } from "@/components/a/ADropdownMenu";
import {
  Plus,
  FolderPlus,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Trash2,
  AlertCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CostIndicator } from "@/components/CostIndicator";

interface SessionListHeaderProps {
  onNewProject: () => void;
  onOpenProject: () => void;
  onCloneFromGithub: () => void;
  onKillAll: () => void;
  /** Count of sessions waiting/errored; renders a clickable badge when > 0. */
  attentionCount?: number;
  /** Jump to the next session needing attention (badge click). */
  onJumpToAttention?: () => void;
}

export function SessionListHeader({
  onNewProject,
  onOpenProject,
  onCloneFromGithub,
  onKillAll,
  attentionCount = 0,
  onJumpToAttention,
}: SessionListHeaderProps) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          role="img"
          aria-label="Stoa"
          className="text-foreground h-5 w-5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <path d="M7 20c-3-2-4.5-5.5-2.5-8.5C5 13 6 13.5 7 13c-.5-3 1-5.5 3-7.5C10.5 8 11 10.5 10.5 13c-.2 1.2.3 2.5 1.5 3C10.5 18.5 9 20.5 7 20z" />
          <path d="M12.5 12h3.5" />
          <path d="M14.5 10.5l1.5 1.5-1.5 1.5" />
          <rect x="17" y="8.5" width="5.5" height="5" rx="1.5" />
          <path d="M19.75 8.5V7" />
          <circle cx="18.8" cy="11" r="0.5" fill="currentColor" stroke="none" />
          <circle cx="20.7" cy="11" r="0.5" fill="currentColor" stroke="none" />
          <path d="M18 13.5v1.5M21.5 13.5v1.5" />
        </svg>
        {attentionCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onJumpToAttention}
                aria-label={`${attentionCount} session${
                  attentionCount > 1 ? "s" : ""
                } need attention — jump to next`}
                className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-500 transition-colors hover:bg-amber-500/25"
              >
                <AlertCircle className="h-3 w-3" />
                {attentionCount}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>
                {attentionCount} session{attentionCount > 1 ? "s" : ""} need
                attention — click to jump
              </p>
            </TooltipContent>
          </Tooltip>
        )}
        <CostIndicator />
      </div>
      <div className="flex gap-1">
        <ADropdownMenu
          icon={Plus}
          tooltip="New project"
          items={[
            menuItem("New Project", onNewProject, { icon: FolderPlus }),
            menuItem("Open Project", onOpenProject, { icon: FolderOpen }),
            menuItem("Clone from GitHub", onCloneFromGithub, {
              icon: GitBranch,
            }),
          ]}
        />
        <ADropdownMenu
          icon={MoreHorizontal}
          tooltip="More options"
          items={[
            menuItem("Kill all sessions", onKillAll, {
              icon: Trash2,
              variant: "destructive",
            }),
          ]}
        />
      </div>
    </div>
  );
}

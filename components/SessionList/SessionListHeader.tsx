import { ADropdownMenu, menuItem } from "@/components/a/ADropdownMenu";
import {
  Plus,
  FolderPlus,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Trash2,
  AlertCircle,
  PanelLeftClose,
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
  /** Collapse the sidebar to its icon rail (renders a chevron when provided). */
  onCollapse?: () => void;
}

export function SessionListHeader({
  onNewProject,
  onOpenProject,
  onCloneFromGithub,
  onKillAll,
  attentionCount = 0,
  onJumpToAttention,
  onCollapse,
}: SessionListHeaderProps) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </svg>
        <h2 className="font-semibold">Stoa</h2>
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
        {onCollapse && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Collapse sidebar"
                className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 transition-colors"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Collapse sidebar</p>
              <p className="text-muted-foreground text-xs">⌘B</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

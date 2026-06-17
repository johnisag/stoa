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
        {/* Agent trio — Claude (amber) · Codex (emerald) · Hermes (violet) */}
        <div
          aria-label="Stoa"
          role="img"
          className="relative flex h-5 items-center"
          style={{ width: "2.75rem" }}
        >
          {/* Claude — front (z-3, leftmost) */}
          <span className="border-sidebar-background absolute left-0 z-[3] flex h-5 w-5 items-center justify-center rounded-full border-2 bg-amber-500/20 text-[10px] font-bold text-amber-500 shadow-sm">
            C
          </span>
          {/* Codex — middle (z-2) */}
          <span className="border-sidebar-background absolute left-[0.75rem] z-[2] flex h-5 w-5 items-center justify-center rounded-full border-2 bg-emerald-500/20 text-[10px] font-bold text-emerald-500 shadow-sm">
            X
          </span>
          {/* Hermes — back (z-1) */}
          <span className="border-sidebar-background absolute left-[1.5rem] z-[1] flex h-5 w-5 items-center justify-center rounded-full border-2 bg-violet-500/20 text-[10px] font-bold text-violet-500 shadow-sm">
            H
          </span>
        </div>
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

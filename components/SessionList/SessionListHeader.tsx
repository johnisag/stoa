import { ADropdownMenu, menuItem } from "@/components/a/ADropdownMenu";
import {
  Bot,
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
        {/* Agent bot trio — Claude (amber) · Codex (emerald) · Hermes (violet) */}
        <div
          aria-label="Stoa"
          role="img"
          className="relative flex h-5 w-[2.75rem] items-center"
        >
          {(
            [
              ["left-0",          "z-[3]", "text-amber-600 dark:text-amber-400"  ],
              ["left-[0.75rem]",  "z-[2]", "text-emerald-600 dark:text-emerald-400"],
              ["left-[1.5rem]",   "z-[1]", "text-violet-600 dark:text-violet-400" ],
            ] as const
          ).map(([left, z, color], i) => (
            <span key={i} className={`bg-sidebar-background absolute ${left} ${z} h-5 w-5`}>
              <Bot className={`h-5 w-5 ${color}`} />
            </span>
          ))}
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

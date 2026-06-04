"use client";

import { memo, useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useTick30s } from "@/hooks/useSharedTicker";
import {
  GitFork,
  GitBranch,
  GitPullRequest,
  Circle,
  AlertCircle,
  Loader2,
  MoreHorizontal,
  FolderInput,
  Trash2,
  Copy,
  Pencil,
  Sparkles,
  Square,
  CheckSquare,
  ExternalLink,
  Download,
  GitCompare,
} from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SessionQuickActions } from "./SessionQuickActions";
import { SessionDiffModal } from "./SessionDiffModal";
import { cardActionsForStatus } from "@/lib/notification-actions";
import type { Session, Group } from "@/lib/db";
import type { ProjectWithDevServers } from "@/lib/projects";

type TmuxStatus = "idle" | "running" | "waiting" | "error" | "dead";

interface SessionCardProps {
  session: Session;
  isActive?: boolean;
  isSummarizing?: boolean;
  tmuxStatus?: TmuxStatus;
  /** Last rendered terminal line — a live one-line preview for running/waiting
   * agents. A primitive string so React.memo only repaints when it changes. */
  lastLine?: string;
  groups?: Group[];
  projects?: ProjectWithDevServers[];
  // Selection props
  isSelected?: boolean;
  isInSelectMode?: boolean;
  // Callbacks are id-threaded (the card passes its own session.id) so callers
  // can hand down the same stable function reference for every card instead of
  // minting a fresh `() => fn(session.id)` closure per row. That stability is
  // what lets React.memo (below) skip re-rendering unchanged cards when the
  // status/sessions polls refresh the list.
  onToggleSelect?: (id: string, shiftKey: boolean) => void;
  // Navigation
  onSelect?: (id: string) => void;
  onOpenInTab?: (id: string) => void;
  onMove?: (id: string, groupPath: string) => void;
  onMoveToProject?: (id: string, projectId: string) => void;
  onFork?: (id: string) => void;
  onSummarize?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string, newName: string) => void;
  onCreatePR?: (id: string) => void;
}

// Module-level stable empty arrays for the optional list props. Using a fresh
// `[]` default per render would defeat React.memo's shallow prop compare for
// any card not passed groups/projects (e.g. worker rows).
const EMPTY_GROUPS: Group[] = [];
const EMPTY_PROJECTS: ProjectWithDevServers[] = [];

const statusConfig: Record<
  TmuxStatus,
  { color: string; label: string; icon: React.ReactNode }
> = {
  idle: {
    color: "text-muted-foreground",
    label: "idle",
    icon: <Circle className="h-2 w-2 fill-current" />,
  },
  running: {
    color: "text-blue-500",
    label: "running",
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
  },
  waiting: {
    color: "text-yellow-500 animate-pulse",
    label: "waiting",
    icon: <AlertCircle className="h-3 w-3" />,
  },
  error: {
    color: "text-red-500",
    label: "error",
    icon: <Circle className="h-2 w-2 fill-current" />,
  },
  dead: {
    color: "text-muted-foreground/50",
    label: "stopped",
    icon: <Circle className="h-2 w-2" />,
  },
};

function SessionCardComponent({
  session,
  isActive,
  isSummarizing,
  tmuxStatus,
  lastLine,
  groups = EMPTY_GROUPS,
  projects = EMPTY_PROJECTS,
  isSelected,
  isInSelectMode,
  onToggleSelect,
  onSelect,
  onOpenInTab,
  onMove,
  onMoveToProject,
  onFork,
  onSummarize,
  onDelete,
  onRename,
  onCreatePR,
}: SessionCardProps) {
  const status = tmuxStatus || "dead";
  const config = statusConfig[status];
  // Quick-action buttons take the row's right edge for actionable statuses; drop
  // the (lower-value) timestamp then so the row doesn't crowd on a phone.
  const hasQuickActions =
    !isInSelectMode && cardActionsForStatus(status).length > 0;
  // Live one-line preview of what the agent is doing/saying — only while it's
  // active (running/waiting), so idle/dead cards stay a clean single line.
  const preview = lastLine?.trim();
  const showPreview =
    !!preview &&
    !isInSelectMode &&
    (status === "running" || status === "waiting");
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const justStartedEditingRef = useRef(false);

  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
  };

  useEffect(() => {
    if (isEditing && inputRef.current) {
      const input = inputRef.current;
      // Mark that we just started editing to ignore immediate blur
      justStartedEditingRef.current = true;
      // Small timeout to ensure input is fully mounted
      setTimeout(() => {
        input.focus();
        input.select();
        // Clear the flag after focus is established
        setTimeout(() => {
          justStartedEditingRef.current = false;
        }, 100);
      }, 0);
    }
  }, [isEditing]);

  const handleRename = () => {
    // Ignore blur events that happen immediately after starting to edit
    if (justStartedEditingRef.current) return;

    if (editName.trim() && editName !== session.name && onRename) {
      onRename(session.id, editName.trim());
    }
    setIsEditing(false);
  };

  // Download the conversation transcript. A hidden-anchor click uses the
  // browser's native download flow (the route sets Content-Disposition) with no
  // blank-tab flash that window.open(..., "_blank") would cause.
  const exportConversation = (format: "md" | "json") => {
    const a = document.createElement("a");
    a.href = `/api/sessions/${session.id}/export?format=${format}`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // Handle card click - coordinates selection with navigation
  const handleCardClick = (e: React.MouseEvent) => {
    if (isEditing) return;

    // If in select mode (any items selected), any click toggles selection
    if (isInSelectMode && onToggleSelect) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect(session.id, e.shiftKey);
      return;
    }

    // Not in select mode - shift+click starts selection
    if (e.shiftKey && onToggleSelect) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect(session.id, false);
      return;
    }

    // Normal click - navigate to session
    onSelect?.(session.id);
  };

  // Handle checkbox click
  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleSelect?.(session.id, e.shiftKey);
  };

  // Shared menu items renderer for both context menu and dropdown
  const renderMenuItems = (isContextMenu: boolean) => {
    const MenuItem = isContextMenu ? ContextMenuItem : DropdownMenuItem;
    const MenuSeparator = isContextMenu
      ? ContextMenuSeparator
      : DropdownMenuSeparator;
    const MenuSub = isContextMenu ? ContextMenuSub : DropdownMenuSub;
    const MenuSubTrigger = isContextMenu
      ? ContextMenuSubTrigger
      : DropdownMenuSubTrigger;
    const MenuSubContent = isContextMenu
      ? ContextMenuSubContent
      : DropdownMenuSubContent;

    return (
      <>
        {/* Branch info for worktree sessions */}
        {session.branch_name && (
          <>
            <div className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-xs">
              <GitBranch className="h-3 w-3" />
              <span className="truncate">{session.branch_name}</span>
            </div>
            <MenuSeparator />
          </>
        )}
        {onOpenInTab && (
          <MenuItem onClick={() => onOpenInTab(session.id)}>
            <ExternalLink className="mr-2 h-3 w-3" />
            Open in new tab
          </MenuItem>
        )}
        {onRename && (
          <MenuItem onClick={() => setIsEditing(true)}>
            <Pencil className="mr-2 h-3 w-3" />
            Rename
          </MenuItem>
        )}
        {onFork && session.agent_type === "claude" && (
          <MenuItem onClick={() => onFork(session.id)}>
            <Copy className="mr-2 h-3 w-3" />
            Fork session
          </MenuItem>
        )}
        {onSummarize && (
          <MenuItem
            onClick={() => onSummarize(session.id)}
            disabled={isSummarizing}
          >
            {isSummarizing ? (
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-3 w-3" />
            )}
            {isSummarizing ? "Summarizing..." : "Fresh start"}
          </MenuItem>
        )}
        <MenuItem onClick={() => setShowDiff(true)}>
          <GitCompare className="mr-2 h-3 w-3" />
          Review changes
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger>
            <Download className="mr-2 h-3 w-3" />
            Export
          </MenuSubTrigger>
          <MenuSubContent>
            <MenuItem onClick={() => exportConversation("md")}>
              Markdown (.md)
            </MenuItem>
            <MenuItem onClick={() => exportConversation("json")}>
              JSON (.json)
            </MenuItem>
          </MenuSubContent>
        </MenuSub>
        {onCreatePR && session.branch_name && (
          <MenuItem
            onClick={() => {
              if (session.pr_url) {
                window.open(session.pr_url, "_blank");
              } else {
                onCreatePR(session.id);
              }
            }}
          >
            <GitPullRequest className="mr-2 h-3 w-3" />
            {session.pr_url ? "Open PR" : "Create PR"}
          </MenuItem>
        )}
        {onMoveToProject && projects.length > 0 && (
          <MenuSub>
            <MenuSubTrigger>
              <FolderInput className="mr-2 h-3 w-3" />
              Move to project...
            </MenuSubTrigger>
            <MenuSubContent>
              {projects
                .filter((p) => p.id !== session.project_id)
                .map((project) => (
                  <MenuItem
                    key={project.id}
                    onClick={() => onMoveToProject(session.id, project.id)}
                  >
                    {project.name}
                  </MenuItem>
                ))}
            </MenuSubContent>
          </MenuSub>
        )}
        {onMove && groups.length > 0 && (
          <MenuSub>
            <MenuSubTrigger>
              <FolderInput className="mr-2 h-3 w-3" />
              Move to group...
            </MenuSubTrigger>
            <MenuSubContent>
              {groups
                .filter((g) => g.path !== session.group_path)
                .map((group) => (
                  <MenuItem
                    key={group.path}
                    onClick={() => onMove(session.id, group.path)}
                  >
                    {group.name}
                  </MenuItem>
                ))}
            </MenuSubContent>
          </MenuSub>
        )}
        {onDelete && (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => onDelete(session.id)}
              className="text-red-500 focus:text-red-500"
            >
              <Trash2 className="mr-2 h-3 w-3" />
              Delete session
            </MenuItem>
          </>
        )}
      </>
    );
  };

  const cardContent = (
    <div
      onClick={handleCardClick}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left transition-colors",
        "min-h-[44px] md:min-h-0", // 44px tap target on mobile; compact on desktop
        isSelected
          ? "bg-primary/20"
          : isActive
            ? "bg-primary/10"
            : "hover:bg-accent/50",
        status === "waiting" && !isActive && !isSelected && "bg-yellow-500/5",
        status === "error" && !isActive && !isSelected && "bg-red-500/5"
      )}
    >
      {/* Selection checkbox - visible when in select mode */}
      {isInSelectMode && onToggleSelect && (
        <button
          onClick={handleCheckboxClick}
          aria-label="Select session"
          aria-pressed={isSelected}
          className="text-primary hover:text-primary/80 -m-1 flex-shrink-0 p-1"
        >
          {isSelected ? (
            <CheckSquare className="h-4 w-4" />
          ) : (
            <Square className="h-4 w-4" />
          )}
        </button>
      )}

      {/* Status indicator - hidden when in select mode */}
      {!isInSelectMode && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={cn("flex-shrink-0", config.color)}>
              {config.icon}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            <span className="capitalize">{config.label}</span>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Session name */}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRename();
            if (e.key === "Escape") {
              setEditName(session.name);
              setIsEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="border-primary min-w-0 flex-1 border-b bg-transparent text-sm outline-none"
        />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="truncate text-sm leading-tight">{session.name}</span>
          {showPreview && (
            <span
              className="text-muted-foreground truncate text-[11px] leading-tight"
              title={preview}
            >
              {preview}
            </span>
          )}
        </div>
      )}

      {/* Fork indicator */}
      {session.parent_session_id && (
        <GitFork className="text-muted-foreground h-3 w-3 flex-shrink-0" />
      )}

      {/* TODO: Show port indicator once auto dev server management is implemented.
          Each worktree gets a unique port (3100, 3110, etc.) for running dev servers.
          See lib/ports.ts and ideas.md for the planned feature. */}

      {/* PR status badge */}
      {session.pr_status && (
        <a
          href={session.pr_url || "#"}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex flex-shrink-0 items-center gap-0.5 rounded px-1 text-[10px]",
            session.pr_status === "open" && "bg-green-500/20 text-green-400",
            session.pr_status === "merged" &&
              "bg-purple-500/20 text-purple-400",
            session.pr_status === "closed" && "bg-red-500/20 text-red-400"
          )}
          title={`PR #${session.pr_number}: ${session.pr_status}`}
          aria-label={`Pull request #${session.pr_number}, ${session.pr_status}`}
        >
          <GitPullRequest className="h-2.5 w-2.5" />
          <span>
            {session.pr_status === "merged"
              ? "M"
              : session.pr_status === "closed"
                ? "X"
                : "O"}
          </span>
        </a>
      )}

      {/* Time ago — yields the space to quick actions when they're present */}
      {!hasQuickActions && (
        <span className="text-muted-foreground hidden flex-shrink-0 text-[10px] group-hover:hidden sm:block">
          <TimeAgo updatedAt={session.updated_at} />
        </span>
      )}

      {/* Quick actions (approve/reject/stop) — contextual to the live status */}
      {!isInSelectMode && (
        <SessionQuickActions
          sessionId={session.id}
          status={status}
          name={session.name}
        />
      )}

      {/* Actions menu (button) */}
      {
        <DropdownMenu onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Session actions"
              className="h-9 w-9 flex-shrink-0 opacity-100 md:h-5 md:w-5 md:opacity-0 md:group-hover:opacity-100"
            >
              <MoreHorizontal className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {renderMenuItems(false)}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    </div>
  );

  // Always wrap with the context menu — Export is available for every session,
  // so the menu always has at least one item.
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{cardContent}</ContextMenuTrigger>
        <ContextMenuContent>{renderMenuItems(true)}</ContextMenuContent>
      </ContextMenu>
      {showDiff && (
        <SessionDiffModal
          sessionId={session.id}
          name={session.name}
          onClose={() => setShowDiff(false)}
        />
      )}
    </>
  );
}

// Memoized: the session list re-renders on every status/sessions poll (~5–10s).
// With id-threaded, referentially-stable callbacks from the callers, a shallow
// prop compare lets every card whose own data didn't change skip re-rendering —
// only the session(s) that actually changed status repaint.
export const SessionCard = memo(SessionCardComponent);

// Relative timestamp on its own ~30s ticker. Because SessionCard is memoized,
// an idle card never re-renders and its "Xm ago" would freeze. Living in a
// separate (non-memoized) component with local state lets just this label
// repaint on the tick while the heavy card body stays put — a child's own
// state update isn't suppressed by the parent's memo.
function TimeAgo({ updatedAt }: { updatedAt: string }) {
  useTick30s(); // shared ~30s ticker — one interval for all cards, not N
  return <>{getTimeAgo(updatedAt)}</>;
}

function getTimeAgo(dateStr: string): string {
  const date = new Date(dateStr + "Z"); // Assume UTC
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

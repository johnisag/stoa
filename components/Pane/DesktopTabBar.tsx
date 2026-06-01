"use client";

import { Button } from "@/components/ui/button";
import {
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
  Unplug,
  Plus,
  FolderOpen,
  GitBranch,
  Users,
  Home,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { Session } from "@/lib/db";

type ViewMode = "terminal" | "files" | "git" | "workers";

interface Tab {
  id: string;
  sessionId: string | null;
  attachedTmux: string | null;
}

interface DesktopTabBarProps {
  tabs: Tab[];
  activeTabId: string;
  session: Session | null | undefined;
  sessions: Session[];
  viewMode: ViewMode;
  isFocused: boolean;
  isConductor: boolean;
  workerCount: number;
  canSplit: boolean;
  canClose: boolean;
  hasAttachedTmux: boolean;
  rightDrawer: "git" | "files" | null;
  shellDrawerOpen: boolean;
  onTabSwitch: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabAdd: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  onGitDrawerToggle: () => void;
  onFilesDrawerToggle: () => void;
  onShellDrawerToggle: () => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onClose: () => void;
  onDetach: () => void;
}

// A view-toggle icon button: labelled + focus-ringed in one place so every
// toggle is keyboard-accessible (icon-only buttons otherwise announce as "button").
function ViewToggleButton({
  label,
  active,
  onClick,
  className,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "focus-visible:ring-ring/60 rounded px-2 py-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset",
            active
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:text-foreground",
            className
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function DesktopTabBar({
  tabs,
  activeTabId,
  session,
  sessions,
  viewMode,
  isFocused,
  isConductor,
  workerCount,
  canSplit,
  canClose,
  hasAttachedTmux,
  rightDrawer,
  shellDrawerOpen,
  onTabSwitch,
  onTabClose,
  onTabAdd,
  onViewModeChange,
  onGitDrawerToggle,
  onFilesDrawerToggle,
  onShellDrawerToggle,
  onSplitHorizontal,
  onSplitVertical,
  onClose,
  onDetach,
}: DesktopTabBarProps) {
  const getTabName = (tab: Tab) => {
    if (tab.sessionId) {
      const s = sessions.find((sess) => sess.id === tab.sessionId);
      return s?.name || tab.attachedTmux || "Session";
    }
    if (tab.attachedTmux) return tab.attachedTmux;
    return "New Tab";
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 overflow-x-auto px-1 pt-1 transition-colors",
        isFocused ? "bg-muted" : "bg-muted/50"
      )}
    >
      {/* Tabs */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={(e) => {
              e.stopPropagation();
              onTabSwitch(tab.id);
            }}
            className={cn(
              "group flex cursor-pointer items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs transition-colors",
              tab.id === activeTabId
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:text-foreground/80 hover:bg-accent/50"
            )}
          >
            <span className="max-w-[120px] truncate">{getTabName(tab)}</span>
            {tabs.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.id);
                }}
                aria-label="Close tab"
                className="hover:text-foreground focus-visible:ring-ring/60 ml-1 rounded opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onTabAdd();
              }}
              aria-label="New tab"
              className="mx-1 h-6 w-6"
            >
              <Plus className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New tab</TooltipContent>
        </Tooltip>
      </div>

      {/* View Toggle */}
      {session?.working_directory && (
        <div className="bg-accent/50 mx-2 flex items-center rounded-md p-0.5">
          <ViewToggleButton
            label="Terminal"
            active={viewMode === "terminal"}
            onClick={() => onViewModeChange("terminal")}
          >
            <Home className="h-3.5 w-3.5" />
          </ViewToggleButton>
          <ViewToggleButton
            label="Files"
            active={rightDrawer === "files"}
            onClick={onFilesDrawerToggle}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </ViewToggleButton>
          <ViewToggleButton
            label="Git"
            active={rightDrawer === "git"}
            onClick={onGitDrawerToggle}
          >
            <GitBranch className="h-3.5 w-3.5" />
          </ViewToggleButton>
          <ViewToggleButton
            label="Shell"
            active={shellDrawerOpen}
            onClick={onShellDrawerToggle}
            className="font-mono text-xs"
          >
            {">_"}
          </ViewToggleButton>
          {isConductor && (
            <ViewToggleButton
              label="Workers"
              active={viewMode === "workers"}
              onClick={() => onViewModeChange("workers")}
              className="relative"
            >
              <Users className="h-3.5 w-3.5" />
              <span className="bg-primary text-primary-foreground absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full text-[9px] font-medium">
                {workerCount}
              </span>
            </ViewToggleButton>
          )}
        </div>
      )}

      {/* Pane Controls */}
      <div className="ml-auto flex items-center gap-0.5 px-2">
        {hasAttachedTmux && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onDetach();
                }}
                aria-label="Detach from tmux"
                className="h-6 w-6"
              >
                <Unplug className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Detach from tmux</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onSplitHorizontal();
              }}
              disabled={!canSplit}
              aria-label="Split pane horizontally"
              className="h-6 w-6"
            >
              <SplitSquareHorizontal className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Split horizontal</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onSplitVertical();
              }}
              disabled={!canSplit}
              aria-label="Split pane vertically"
              className="h-6 w-6"
            >
              <SplitSquareVertical className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Split vertical</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              disabled={!canClose}
              aria-label="Close pane"
              className="h-6 w-6"
            >
              <X className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close pane</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

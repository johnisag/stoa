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
  Copy,
  ClipboardPaste,
  Paperclip,
  PenLine,
  MessageSquarePlus,
  FileText,
  Workflow,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ContextMeter } from "@/components/ContextMeter";
import { AutoApproveBadge } from "@/components/AutoApproveBadge";
import { SnippetsModal } from "@/components/Terminal/SnippetsModal";
import { useState, type ReactNode } from "react";
import type { Session } from "@/lib/db";
import type { TabData } from "@/lib/panes";

type ViewMode = "terminal" | "files" | "git" | "workers";

interface DesktopTabBarProps {
  tabs: TabData[];
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
  // Terminal actions (copy/paste/attach) — only meaningful in terminal view;
  // they drive the active tab's terminal via its imperative handle. Attach is
  // gated separately (a scratch shell has no agent prompt to insert a path into).
  showTerminalActions: boolean;
  showTerminalAttach: boolean;
  onTerminalCopy: () => void;
  onTerminalPaste: () => void;
  onTerminalAttach: () => void;
  /** Inject the current terminal selection into the agent's prompt as context. */
  onTerminalAttachSelection: () => void;
  /** Insert a saved snippet's text into the active terminal (same store as the
   * mobile toolbar). */
  onSnippetInsert: (content: string) => void;
  /** Opens the full-screen prompt composer (sends straight to this terminal). */
  onCompose?: () => void;
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
  showTerminalActions,
  showTerminalAttach,
  onTerminalCopy,
  onTerminalPaste,
  onTerminalAttach,
  onTerminalAttachSelection,
  onSnippetInsert,
  onCompose,
}: DesktopTabBarProps) {
  const [showSnippets, setShowSnippets] = useState(false);

  const getTabName = (tab: TabData) => {
    if (tab.view === "workflows") return "Workflows";
    if (tab.sessionId) {
      const s = sessions.find((sess) => sess.id === tab.sessionId);
      return s?.name || tab.attachedTmux || "Session";
    }
    if (tab.attachedTmux) return tab.attachedTmux;
    return "New Tab";
  };

  return (
    <>
      <SnippetsModal
        open={showSnippets}
        onClose={() => setShowSnippets(false)}
        onInsert={onSnippetInsert}
      />
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
              {tab.view === "workflows" && <Workflow className="h-3.5 w-3.5" />}
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

        {/* Live context-window meter for this session (Claude-only; self-hides). */}
        {session && <ContextMeter sessionId={session.id} />}

        {/* Persistent danger signal when this session auto-approves all tool calls
            (auto_approve is a SQLite 0/1 — coerce so it can't render a stray "0"). */}
        {session && Boolean(session.auto_approve) && <AutoApproveBadge />}

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
          {/* Terminal actions (copy / paste / attach), separated from the pane
            controls. Only in terminal view — they act on the active terminal. */}
          {showTerminalActions && (
            <>
              {onCompose && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCompose();
                      }}
                      aria-label="Compose prompt"
                      className="h-6 w-6"
                    >
                      <PenLine className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Compose prompt</TooltipContent>
                </Tooltip>
              )}
              {/* Snippets — same localStorage-backed store as the mobile toolbar;
                selecting one inserts its text into the active terminal. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowSnippets(true);
                    }}
                    aria-label="Snippets"
                    className="h-6 w-6"
                  >
                    <FileText className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Snippets</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTerminalCopy();
                    }}
                    aria-label="Select text to copy"
                    className="h-6 w-6"
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Select text to copy</TooltipContent>
              </Tooltip>
              {showTerminalAttach && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      // preventDefault on mousedown so the click doesn't collapse
                      // the text selection we're about to read.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onTerminalAttachSelection();
                      }}
                      aria-label="Add selected text to agent"
                      className="h-6 w-6"
                    >
                      <MessageSquarePlus className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Add selection to agent</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTerminalPaste();
                    }}
                    aria-label="Paste from clipboard"
                    className="h-6 w-6"
                  >
                    <ClipboardPaste className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Paste from clipboard</TooltipContent>
              </Tooltip>
              {showTerminalAttach && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTerminalAttach();
                      }}
                      aria-label="Attach file"
                      className="h-6 w-6"
                    >
                      <Paperclip className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Attach file</TooltipContent>
                </Tooltip>
              )}
              <div className="bg-border mx-1 h-4 w-px" aria-hidden />
            </>
          )}
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
    </>
  );
}

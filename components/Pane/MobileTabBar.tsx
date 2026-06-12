"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Menu,
  Rocket,
  Workflow,
  Inbox,
  Columns3,
  Boxes,
  Sparkles,
  PenLine,
  ChevronLeft,
  ChevronRight,
  Terminal as TerminalIcon,
  FolderOpen,
  GitBranch,
  Users,
  ChevronDown,
  Circle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CountBadge } from "@/components/nav/fleet-nav";
import { useAttentionCount } from "@/data/verdict-inbox/useAttentionCount";
import { ContextMeter } from "@/components/ContextMeter";
import { getSwitchableSessionOrder } from "@/lib/session-navigation";
import { getActiveBackend } from "@/lib/client/backend";
import type { Session, Project } from "@/lib/db";
import type { LucideIcon } from "lucide-react";

type ViewMode = "terminal" | "files" | "git" | "workers";

interface ViewModeButtonProps {
  mode: ViewMode;
  currentMode: ViewMode;
  icon: LucideIcon;
  onClick: (mode: ViewMode) => void;
  badge?: React.ReactNode;
}

function ViewModeButton({
  mode,
  currentMode,
  icon: Icon,
  onClick,
  badge,
}: ViewModeButtonProps) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick(mode);
      }}
      className={cn(
        "rounded p-1.5 transition-colors",
        badge && "flex items-center gap-0.5",
        currentMode === mode
          ? "bg-secondary text-foreground"
          : "text-muted-foreground"
      )}
    >
      <Icon className="h-4 w-4" />
      {badge}
    </button>
  );
}

interface MobileTabBarProps {
  session: Session | null | undefined;
  sessions: Session[];
  projects: Project[];
  viewMode: ViewMode;
  isConductor: boolean;
  workerCount: number;
  onMenuClick?: () => void;
  /** Opens the Dispatch control plane (GitHub issues → agent fleet). */
  onDispatchClick?: () => void;
  /** Opens the Workflows view (run a multi-step agent pipeline from a template). */
  onWorkflowsClick?: () => void;
  /** Opens the Verdict Inbox (the fleet review queue). */
  onVerdictInboxClick?: () => void;
  /** Opens the Fleet Board (the fleet by lifecycle stage). */
  onFleetBoardClick?: () => void;
  /** Opens the Ask Stoa chatbox. */
  onAskStoaClick?: () => void;
  /** Opens the full-screen prompt composer (sends straight to this terminal). */
  onComposeClick?: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  onSelectSession?: (sessionId: string) => void;
}

export function MobileTabBar({
  session,
  sessions,
  projects,
  viewMode,
  isConductor,
  workerCount,
  onMenuClick,
  onDispatchClick,
  onWorkflowsClick,
  onVerdictInboxClick,
  onFleetBoardClick,
  onAskStoaClick,
  onComposeClick,
  onViewModeChange,
  onSelectSession,
}: MobileTabBarProps) {
  // Shared sidebar order (worker sessions excluded) so the chevrons, the
  // dropdown, the pane swipe, and Alt+arrows all switch in the same order.
  const order = useMemo(
    () => getSwitchableSessionOrder(sessions, projects),
    [sessions, projects]
  );
  const currentIndex = session ? order.indexOf(session.id) : -1;

  // Get project name for current session
  const projectName = session?.project_id
    ? projects.find((p) => p.id === session.project_id)?.name
    : null;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < order.length - 1;

  // Any fleet destination wired? Gates the single "Fleet" launcher so the bar
  // stays empty-handed when none of the callbacks are supplied (e.g. desktop).
  const hasFleetNav =
    onDispatchClick ||
    onWorkflowsClick ||
    onVerdictInboxClick ||
    onFleetBoardClick ||
    onAskStoaClick;

  // Ambient "needs me" count on the Fleet launcher — the only always-visible nav
  // on this mobile-first surface, so the signal belongs here too (shares the
  // header's 30s poll). Only run it when the launcher actually renders.
  const attentionCount = useAttentionCount(!!hasFleetNav);

  // Debounce to prevent rapid clicking causing command interference
  const [isNavigating, setIsNavigating] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const handleNavigate = useCallback(
    (sessionId: string) => {
      if (isNavigating || !onSelectSession) return;

      setIsNavigating(true);
      onSelectSession(sessionId);

      // Release the lock once the re-attach settles. pty re-attach is fast; tmux
      // needs its detach/attach ceremony, so keep the longer guard there.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void getActiveBackend().then((backend) => {
        const delay = backend === "pty" ? 150 : 500;
        debounceRef.current = setTimeout(() => setIsNavigating(false), delay);
      });
    },
    [isNavigating, onSelectSession]
  );

  const handlePrev = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (hasPrev && !isNavigating) {
      handleNavigate(order[currentIndex - 1]);
    }
  };

  const handleNext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (hasNext && !isNavigating) {
      handleNavigate(order[currentIndex + 1]);
    }
  };

  return (
    <div
      className="bg-muted flex items-center gap-1 px-2 py-1.5"
      onClick={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      {/* Menu button */}
      {onMenuClick && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={(e) => {
            e.stopPropagation();
            onMenuClick();
          }}
          className="h-8 w-8 shrink-0"
        >
          <Menu className="h-4 w-4" />
        </Button>
      )}

      {/* Fleet launcher — one button folding every fleet destination (Dispatch,
          Workflows, Verdict Inbox, Fleet Board) into a single dropdown. This
          replaces the former separate Dispatch + Workflows buttons: it makes the
          two buried review surfaces (Verdict Inbox, Fleet Board) reachable in
          ≤2 taps WITHOUT adding net always-on buttons — two fixed buttons become
          one — which hands the min-w-0 session name back its width. */}
      {hasFleetNav && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={
                attentionCount > 0
                  ? `Fleet — ${attentionCount} ${attentionCount === 1 ? "needs" : "need"} you`
                  : "Fleet"
              }
              onClick={(e) => e.stopPropagation()}
              className="relative h-8 w-8 shrink-0"
            >
              <Boxes className="h-4 w-4" />
              {attentionCount > 0 && <CountBadge count={attentionCount} />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            {onDispatchClick && (
              <DropdownMenuItem onSelect={() => onDispatchClick()}>
                <Rocket className="mr-2 h-4 w-4" />
                Dispatch
              </DropdownMenuItem>
            )}
            {onWorkflowsClick && (
              <DropdownMenuItem onSelect={() => onWorkflowsClick()}>
                <Workflow className="mr-2 h-4 w-4" />
                Workflows
              </DropdownMenuItem>
            )}
            {onVerdictInboxClick && (
              <DropdownMenuItem onSelect={() => onVerdictInboxClick()}>
                <Inbox className="mr-2 h-4 w-4" />
                Verdict Inbox
                {attentionCount > 0 && (
                  <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    {attentionCount > 9 ? "9+" : attentionCount}
                  </span>
                )}
              </DropdownMenuItem>
            )}
            {onFleetBoardClick && (
              <DropdownMenuItem onSelect={() => onFleetBoardClick()}>
                <Columns3 className="mr-2 h-4 w-4" />
                Fleet Board
              </DropdownMenuItem>
            )}
            {onAskStoaClick && (
              <DropdownMenuItem onSelect={() => onAskStoaClick()}>
                <Sparkles className="mr-2 h-4 w-4" />
                Ask Stoa
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Compose — a roomy full-screen prompt that sends straight to the active
          terminal, far easier than typing a long prompt into the xterm on a phone. */}
      {onComposeClick && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Compose prompt"
          onClick={(e) => {
            e.stopPropagation();
            onComposeClick();
          }}
          className="h-8 w-8 shrink-0"
        >
          <PenLine className="h-4 w-4" />
        </Button>
      )}

      {/* Session/Tab navigation */}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <button
          type="button"
          onClick={handlePrev}
          onTouchEnd={(e) => e.stopPropagation()}
          disabled={!hasPrev || isNavigating}
          className="hover:bg-accent flex h-8 w-8 shrink-0 items-center justify-center rounded-md disabled:pointer-events-none disabled:opacity-50"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {/* Session selector dropdown */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="hover:bg-accent active:bg-accent flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1"
            >
              <span className="truncate text-sm font-medium">
                {session?.name || "No session"}
                {projectName && projectName !== "Uncategorized" && (
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    [{projectName}]
                  </span>
                )}
              </span>
              <ChevronDown className="text-muted-foreground h-3 w-3 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="center"
            className="max-h-[300px] min-w-[200px] overflow-y-auto"
          >
            {order.map((id) => {
              const s = sessions.find((x) => x.id === id);
              if (!s) return null;
              const sessionProject = s.project_id
                ? projects.find((p) => p.id === s.project_id)
                : null;
              const isActive = s.id === session?.id;

              return (
                <DropdownMenuItem
                  key={s.id}
                  onSelect={() => onSelectSession?.(s.id)}
                  className={cn(
                    "flex items-center gap-2",
                    isActive && "bg-accent"
                  )}
                >
                  <Circle
                    className={cn(
                      "h-2 w-2",
                      isActive
                        ? "fill-primary text-primary"
                        : "text-muted-foreground"
                    )}
                  />
                  <span className="flex-1 truncate">{s.name}</span>
                  {sessionProject &&
                    sessionProject.name !== "Uncategorized" && (
                      <span className="text-muted-foreground text-xs">
                        [{sessionProject.name}]
                      </span>
                    )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          onClick={handleNext}
          onTouchEnd={(e) => e.stopPropagation()}
          disabled={!hasNext || isNavigating}
          className="hover:bg-accent flex h-8 w-8 shrink-0 items-center justify-center rounded-md disabled:pointer-events-none disabled:opacity-50"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Live context-window meter for this session (Claude-only; self-hides). */}
      {session && <ContextMeter sessionId={session.id} />}

      {/* View mode toggle */}
      {session?.working_directory && (
        <div className="bg-accent/50 flex shrink-0 items-center rounded-md p-0.5">
          <ViewModeButton
            mode="terminal"
            currentMode={viewMode}
            icon={TerminalIcon}
            onClick={onViewModeChange}
          />
          <ViewModeButton
            mode="files"
            currentMode={viewMode}
            icon={FolderOpen}
            onClick={onViewModeChange}
          />
          <ViewModeButton
            mode="git"
            currentMode={viewMode}
            icon={GitBranch}
            onClick={onViewModeChange}
          />
          {isConductor && (
            <ViewModeButton
              mode="workers"
              currentMode={viewMode}
              icon={Users}
              onClick={onViewModeChange}
              badge={
                <span className="bg-primary/20 text-primary rounded px-1 text-[10px]">
                  {workerCount}
                </span>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

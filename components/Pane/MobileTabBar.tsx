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
      className="bg-muted flex items-center gap-2 px-2 py-1.5"
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

      {/* Dispatch (GitHub issues → agent fleet) — mobile's one-tap entry, since
          the only other path is the rocket buried in the swipe-drawer footer. */}
      {onDispatchClick && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dispatch"
          onClick={(e) => {
            e.stopPropagation();
            onDispatchClick();
          }}
          className="h-8 w-8 shrink-0"
        >
          <Rocket className="h-4 w-4" />
        </Button>
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

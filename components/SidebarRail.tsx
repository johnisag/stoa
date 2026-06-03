"use client";

import { ChevronRight, Plus } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getSwitchableSessionOrder } from "@/lib/session-navigation";
import { statusGlyph } from "./status-glyph";
import type { Session } from "@/lib/db";
import type { ProjectWithDevServers } from "@/lib/projects";
import type { SessionStatus } from "./views/types";

interface SidebarRailProps {
  sessions: Session[];
  projects: ProjectWithDevServers[];
  sessionStatuses: Record<string, SessionStatus>;
  activeSessionId?: string;
  onSelect: (id: string) => void;
  onExpand: () => void;
  onNewSession: () => void;
}

/**
 * Collapsed-sidebar rail: a thin icon strip shown in place of the full session
 * list. Expand chevron, new-session, one status dot per (non-worker) session
 * (click to switch, tooltip = name), and the theme toggle. Width is fixed at
 * w-12; the parent container animates between this and w-60.
 */
export function SidebarRail({
  sessions,
  projects,
  sessionStatuses,
  activeSessionId,
  onSelect,
  onExpand,
  onNewSession,
}: SidebarRailProps) {
  const order = getSwitchableSessionOrder(sessions, projects);
  const byId = new Map(sessions.map((s) => [s.id, s]));

  return (
    <div className="flex h-full w-12 flex-col items-center py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Expand sidebar"
            onClick={onExpand}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-8 w-8 items-center justify-center rounded-md transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>Expand sidebar</p>
          <p className="text-muted-foreground text-xs">⌘B</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="New session"
            onClick={onNewSession}
            className="text-muted-foreground hover:bg-accent hover:text-foreground mt-1 flex h-8 w-8 items-center justify-center rounded-md transition-colors"
          >
            <Plus className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>New session</p>
        </TooltipContent>
      </Tooltip>

      <div className="bg-border my-2 h-px w-6 flex-shrink-0" />

      <ScrollArea className="min-h-0 w-full flex-1">
        <div className="flex flex-col items-center gap-1">
          {order.map((id) => {
            const session = byId.get(id);
            if (!session) return null;
            const isActive = id === activeSessionId;
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={session.name}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelect(id)}
                    className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                      isActive ? "bg-primary/15" : "hover:bg-accent"
                    }`}
                  >
                    {isActive && (
                      <span className="bg-primary absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-r" />
                    )}
                    {statusGlyph(sessionStatuses[id]?.status)}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{session.name}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </ScrollArea>

      <div className="mt-2 flex-shrink-0">
        <ThemeToggle />
      </div>
    </div>
  );
}

"use client";

import { useMemo, useCallback, useState, useEffect } from "react";
import { useSnapshot } from "valtio";
import { useTheme } from "next-themes";
import { ChevronRight, Plus, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectCard } from "./ProjectCard";
import { SessionCard } from "@/components/SessionCard";
import { MiniTerminal } from "@/components/MiniTerminal";
import { useBackendType } from "@/hooks/useBackendType";
import { DevServerCard } from "@/components/DevServers/DevServerCard";
import { selectionStore, selectionActions } from "@/stores/sessionSelection";
import type { Session, Group, DevServer } from "@/lib/db";
import type { ProjectWithDevServers } from "@/lib/projects";
import type { RateLimitState } from "@/lib/rate-limit";

interface SessionStatus {
  sessionName: string;
  status: "idle" | "running" | "waiting" | "error" | "dead";
  lastLine?: string;
  rateLimit?: RateLimitState | null;
  hasPrompt?: boolean;
}

interface ProjectsSectionProps {
  projects: ProjectWithDevServers[];
  sessions: Session[];
  groups: Group[]; // For backward compatibility with SessionCard move feature
  activeSessionId?: string;
  sessionStatuses?: Record<string, SessionStatus>;
  summarizingSessionId?: string | null;
  devServers?: DevServer[];
  onToggleProject?: (projectId: string, expanded: boolean) => void;
  onEditProject?: (projectId: string) => void;
  onDeleteProject?: (projectId: string) => void;
  onRenameProject?: (projectId: string, newName: string) => void;
  onNewSession?: (projectId: string) => void;
  onOpenTerminal?: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenSessionInTab?: (sessionId: string) => void;
  onMoveSession?: (sessionId: string, projectId: string) => void;
  onForkSession?: (sessionId: string) => void;
  onSummarize?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  onCreatePR?: (sessionId: string) => void;
  onStartDevServer?: (projectId: string) => void;
  onStopDevServer?: (serverId: string) => Promise<void>;
  onRestartDevServer?: (serverId: string) => Promise<void>;
  onRemoveDevServer?: (serverId: string) => Promise<void>;
  onViewDevServerLogs?: (serverId: string) => void;
}

export function ProjectsSection({
  projects,
  sessions,
  groups,
  activeSessionId,
  sessionStatuses,
  summarizingSessionId,
  devServers = [],
  onToggleProject,
  onEditProject,
  onDeleteProject,
  onRenameProject,
  onNewSession,
  onOpenTerminal,
  onSelectSession,
  onOpenSessionInTab,
  onMoveSession,
  onForkSession,
  onSummarize,
  onDeleteSession,
  onRenameSession,
  onCreatePR,
  onStartDevServer,
  onStopDevServer,
  onRestartDevServer,
  onRemoveDevServer,
  onViewDevServerLogs,
}: ProjectsSectionProps) {
  const { selectedIds } = useSnapshot(selectionStore);
  const isInSelectMode = selectedIds.size > 0;

  // Live worker mini-terminal: which worker rows are expanded. Only offered on
  // the pty backend (the observer attach is a pty-path primitive).
  const backend = useBackendType();
  // Match the full terminal's theme resolution so the preview isn't stuck dark.
  const { theme: currentTheme, resolvedTheme } = useTheme();
  const terminalTheme =
    (currentTheme === "system" ? resolvedTheme : currentTheme) || "dark";
  const [expandedWorkers, setExpandedWorkers] = useState<Set<string>>(
    new Set()
  );
  const toggleWorkerTerminal = useCallback((id: string) => {
    setExpandedWorkers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // Drop expanded ids for sessions that no longer exist (workers come and go),
  // so the Set can't grow unbounded. Returns the same ref when nothing changed.
  useEffect(() => {
    setExpandedWorkers((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(sessions.map((s) => s.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  // Flatten all session IDs for range selection (respecting render order)
  const allSessionIds = useMemo(() => {
    const ids: string[] = [];
    for (const project of projects) {
      const projectSessions = sessions.filter(
        (s) =>
          !s.conductor_session_id &&
          (s.project_id || "uncategorized") === project.id
      );
      for (const session of projectSessions) {
        ids.push(session.id);
        // Include workers under this session
        const workers = sessions.filter(
          (s) => s.conductor_session_id === session.id
        );
        for (const worker of workers) {
          ids.push(worker.id);
        }
      }
    }
    return ids;
  }, [projects, sessions]);

  // Handler for toggling session selection
  const handleToggleSelect = useCallback(
    (sessionId: string, shiftKey: boolean) => {
      selectionActions.toggle(sessionId, shiftKey, allSessionIds);
    },
    [allSessionIds]
  );

  // Group sessions by project (excluding workers) and workers by conductor —
  // recomputed only when `sessions` changes, not on every status-delta render.
  const sessionsByProject = useMemo(() => {
    const acc: Record<string, Session[]> = {};
    for (const session of sessions) {
      if (session.conductor_session_id) continue; // workers grouped below
      const projectId = session.project_id || "uncategorized";
      if (!acc[projectId]) acc[projectId] = [];
      acc[projectId].push(session);
    }
    return acc;
  }, [sessions]);

  const workersByConduct = useMemo(() => {
    const acc: Record<string, Session[]> = {};
    for (const session of sessions) {
      if (!session.conductor_session_id) continue;
      if (!acc[session.conductor_session_id])
        acc[session.conductor_session_id] = [];
      acc[session.conductor_session_id].push(session);
    }
    return acc;
  }, [sessions]);

  // Dev servers grouped by project (all + the running subset), precomputed in a
  // single O(devServers) pass so the per-project lookups in the render loop are
  // O(1) instead of the old O(projects × devServers) filter-per-project.
  const { devServersByProject, runningDevServersByProject } = useMemo(() => {
    const all: Record<string, DevServer[]> = {};
    const running: Record<string, DevServer[]> = {};
    for (const ds of devServers) {
      if (!all[ds.project_id]) all[ds.project_id] = [];
      all[ds.project_id].push(ds);
      if (ds.status === "running") {
        if (!running[ds.project_id]) running[ds.project_id] = [];
        running[ds.project_id].push(ds);
      }
    }
    return { devServersByProject: all, runningDevServersByProject: running };
  }, [devServers]);

  return (
    <div className="space-y-1">
      {projects.map((project) => {
        const projectSessions = sessionsByProject[project.id] || [];
        const runningServers = runningDevServersByProject[project.id] || [];
        const projectDevServers = devServersByProject[project.id] || [];

        return (
          <div key={project.id} className="space-y-0.5">
            {/* Project header */}
            <ProjectCard
              project={project}
              sessionCount={projectSessions.length}
              runningDevServers={runningServers}
              onToggleExpanded={(expanded) =>
                onToggleProject?.(project.id, expanded)
              }
              onEdit={
                !project.is_uncategorized && onEditProject
                  ? () => onEditProject(project.id)
                  : undefined
              }
              onNewSession={
                onNewSession ? () => onNewSession(project.id) : undefined
              }
              onOpenTerminal={
                onOpenTerminal ? () => onOpenTerminal(project.id) : undefined
              }
              onStartDevServer={
                !project.is_uncategorized && onStartDevServer
                  ? () => onStartDevServer(project.id)
                  : undefined
              }
              onDelete={
                !project.is_uncategorized && onDeleteProject
                  ? () => onDeleteProject(project.id)
                  : undefined
              }
              onRename={
                onRenameProject
                  ? (newName) => onRenameProject(project.id, newName)
                  : undefined
              }
            />

            {/* Project contents when expanded */}
            {project.expanded && (
              <div className="border-border/30 ml-3 space-y-px border-l pl-1.5">
                {/* Dev servers for this project */}
                {projectDevServers.length > 0 && (
                  <div className="space-y-px pb-0.5">
                    {projectDevServers.map((server) => (
                      <DevServerCard
                        key={server.id}
                        server={server}
                        onStart={
                          onRestartDevServer
                            ? (id) => onRestartDevServer(id)
                            : async () => {}
                        }
                        onStop={onStopDevServer || (async () => {})}
                        onRestart={onRestartDevServer || (async () => {})}
                        onRemove={onRemoveDevServer || (async () => {})}
                        onViewLogs={
                          onViewDevServerLogs
                            ? (id) => onViewDevServerLogs(id)
                            : () => {}
                        }
                      />
                    ))}
                  </div>
                )}

                {/* Project sessions */}
                {projectSessions.length === 0 &&
                projectDevServers.length === 0 ? (
                  <div className="flex flex-col items-start gap-1.5 px-2 py-2">
                    <p className="text-muted-foreground text-xs">
                      No sessions yet
                    </p>
                    {onNewSession && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-foreground -ml-1 h-7 px-2"
                        onClick={() => onNewSession(project.id)}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        New session
                      </Button>
                    )}
                  </div>
                ) : projectSessions.length === 0 ? null : (
                  projectSessions.map((session) => {
                    const workers = workersByConduct[session.id] || [];
                    const hasWorkers = workers.length > 0;

                    return (
                      <div key={session.id} className="space-y-0.5">
                        <div className="flex items-center gap-1">
                          <div className="min-w-0 flex-1">
                            <SessionCard
                              session={session}
                              isActive={session.id === activeSessionId}
                              isSummarizing={
                                summarizingSessionId === session.id
                              }
                              tmuxStatus={sessionStatuses?.[session.id]?.status}
                              hasPrompt={
                                sessionStatuses?.[session.id]?.hasPrompt
                              }
                              lastLine={sessionStatuses?.[session.id]?.lastLine}
                              rateLimited={
                                !!sessionStatuses?.[session.id]?.rateLimit
                              }
                              rateLimitResetAt={
                                sessionStatuses?.[session.id]?.rateLimit
                                  ?.resetAt ?? null
                              }
                              groups={groups}
                              projects={projects}
                              isSelected={selectedIds.has(session.id)}
                              isInSelectMode={isInSelectMode}
                              onToggleSelect={handleToggleSelect}
                              onSelect={onSelectSession}
                              onOpenInTab={onOpenSessionInTab}
                              onMoveToProject={onMoveSession}
                              onFork={onForkSession}
                              onSummarize={onSummarize}
                              onDelete={onDeleteSession}
                              onRename={onRenameSession}
                              onCreatePR={onCreatePR}
                            />
                          </div>
                          {/* Workers badge */}
                          {hasWorkers && (
                            <span className="bg-primary/20 text-primary flex-shrink-0 rounded-full px-1.5 py-0.5 text-xs">
                              {workers.length}
                            </span>
                          )}
                        </div>

                        {/* Nested workers */}
                        {hasWorkers && (
                          <div className="border-border/30 ml-3 space-y-px border-l pl-1.5">
                            {workers.map((worker) => {
                              const canPeek =
                                backend === "pty" && !!worker.tmux_name;
                              const expanded = expandedWorkers.has(worker.id);
                              return (
                                <div key={worker.id}>
                                  <div className="flex items-stretch gap-1">
                                    {canPeek && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          toggleWorkerTerminal(worker.id)
                                        }
                                        title={
                                          expanded
                                            ? "Hide live output"
                                            : "Watch live output"
                                        }
                                        aria-label="Toggle live worker output"
                                        aria-expanded={expanded}
                                        className="text-muted-foreground hover:text-foreground hover:bg-muted/50 flex w-5 flex-shrink-0 items-center justify-center rounded"
                                      >
                                        {expanded ? (
                                          <SquareTerminal className="h-3.5 w-3.5" />
                                        ) : (
                                          <ChevronRight className="h-3.5 w-3.5" />
                                        )}
                                      </button>
                                    )}
                                    <div className="min-w-0 flex-1">
                                      <SessionCard
                                        session={worker}
                                        isActive={worker.id === activeSessionId}
                                        tmuxStatus={
                                          sessionStatuses?.[worker.id]?.status
                                        }
                                        hasPrompt={
                                          sessionStatuses?.[worker.id]
                                            ?.hasPrompt
                                        }
                                        lastLine={
                                          sessionStatuses?.[worker.id]?.lastLine
                                        }
                                        rateLimited={
                                          !!sessionStatuses?.[worker.id]
                                            ?.rateLimit
                                        }
                                        rateLimitResetAt={
                                          sessionStatuses?.[worker.id]
                                            ?.rateLimit?.resetAt ?? null
                                        }
                                        groups={groups}
                                        projects={projects}
                                        isSelected={selectedIds.has(worker.id)}
                                        isInSelectMode={isInSelectMode}
                                        onToggleSelect={handleToggleSelect}
                                        onSelect={onSelectSession}
                                        onOpenInTab={onOpenSessionInTab}
                                        onDelete={onDeleteSession}
                                        onRename={onRenameSession}
                                      />
                                    </div>
                                  </div>
                                  {canPeek && expanded && worker.tmux_name && (
                                    <MiniTerminal
                                      key={worker.tmux_name}
                                      attachKey={worker.tmux_name}
                                      theme={terminalTheme}
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

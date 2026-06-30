"use client";

import { useCallback, useEffect, useRef } from "react";
import { SessionList } from "@/components/SessionList";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { NotificationSettings } from "@/components/NotificationSettings";
import { StartServerDialog } from "@/components/DevServers/StartServerDialog";
import { SidebarFooter } from "@/components/SidebarFooter";
import { SidebarRail } from "@/components/SidebarRail";
import { Button } from "@/components/ui/button";
import {
  PanelLeftClose,
  PanelLeft,
  Plus,
  Copy,
  Check,
  MoreHorizontal,
} from "lucide-react";
import { PaneLayout } from "@/components/PaneLayout";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CountBadge,
  fleetNavEntry,
  NavIconButton,
} from "@/components/nav/fleet-nav";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { useAttentionCount } from "@/data/verdict-inbox/useAttentionCount";
import type { ViewProps } from "./types";
import { fileOpenActions } from "@/stores/fileOpen";
import { joinPath } from "@/lib/path-display";

export function DesktopView({
  sessions,
  projects,
  sessionStatuses,
  sidebarOpen,
  setSidebarOpen,
  activeSession,
  focusedActiveTab,
  copiedSessionId,
  setCopiedSessionId,
  showNewSessionDialog,
  setShowNewSessionDialog,
  newSessionProjectId,
  showNotificationSettings,
  setShowNotificationSettings,
  showQuickSwitcher,
  setShowQuickSwitcher,
  onOpenDispatch,
  onOpenAnalytics,
  onOpenWorkflows,
  onOpenVerdictInbox,
  onOpenFleetBoard,
  onOpenLiveWall,
  onOpenAgentMonitor,
  onOpenAsk,
  onShowShortcuts,
  onShowGuide,
  onShowNotes,
  onShowCommands,
  notificationSettings,
  permissionGranted,
  updateSettings,
  requestPermission,
  attachToSession,
  openSessionInNewTab,
  handleNewSessionInProject,
  handleOpenTerminal,
  handleSessionCreated,
  handleCreateProject,
  handleStartDevServer,
  handleCreateDevServer,
  startDevServerProject,
  setStartDevServerProjectId,
  renderPane,
}: ViewProps) {
  // Stable id→session handlers: the session list re-renders on every status
  // poll (~5s); minting these inline would give SessionCard fresh props each
  // poll and defeat its React.memo. `sessions` is a separate query key the
  // status poll doesn't touch, so these refs stay stable between polls.
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (session) attachToSession(session);
    },
    [sessions, attachToSession]
  );
  const handleOpenInTab = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (session) openSessionInNewTab(session);
    },
    [sessions, openSessionInNewTab]
  );

  // Always-on "needs me" count for the Verdict Inbox / Fleet Board nav badges
  // (a cheap 30s background poll — see useAttentionCount). Both destinations
  // answer "what needs me?" off the one inbox count, so the badges agree.
  const attentionCount = useAttentionCount();

  return (
    <div className="bg-background flex h-screen overflow-hidden">
      {/* Desktop Sidebar — full list (w-60) or a thin icon rail (w-12). The
          container animates the width; the inner content is fixed-width so it
          slides cleanly instead of squishing during the transition. */}
      <div
        className={` ${sidebarOpen ? "w-60" : "w-12"} bg-sidebar-background flex-shrink-0 overflow-hidden shadow-xl shadow-black/10 transition-all duration-200 dark:shadow-black/30`}
      >
        {sidebarOpen ? (
          <div className="flex h-full w-60 flex-col">
            {/* Session list */}
            <div className="min-h-0 flex-1 overflow-hidden">
              <SessionList
                activeSessionId={focusedActiveTab?.sessionId || undefined}
                sessionStatuses={sessionStatuses}
                onSelect={handleSelect}
                onOpenInTab={handleOpenInTab}
                onNewSessionInProject={handleNewSessionInProject}
                onOpenTerminal={handleOpenTerminal}
                onStartDevServer={handleStartDevServer}
                onCreateDevServer={handleCreateDevServer}
              />
            </div>

            <SidebarFooter
              onShowShortcuts={onShowShortcuts}
              onShowGuide={onShowGuide}
              onShowNotes={onShowNotes}
              onShowCommands={onShowCommands}
            />
          </div>
        ) : (
          <SidebarRail
            sessions={sessions}
            projects={projects}
            sessionStatuses={sessionStatuses}
            activeSessionId={focusedActiveTab?.sessionId || undefined}
            onSelect={handleSelect}
            onExpand={() => setSidebarOpen(true)}
            onNewSession={() => setShowNewSessionDialog(true)}
          />
        )}
      </div>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    sidebarOpen ? "Collapse sidebar" : "Expand sidebar"
                  }
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                >
                  {sidebarOpen ? (
                    <PanelLeftClose className="h-4 w-4" />
                  ) : (
                    <PanelLeft className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}</p>
                <p className="text-muted-foreground text-xs">⌘B</p>
              </TooltipContent>
            </Tooltip>

            {activeSession && (
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="truncate font-medium"
                  title={activeSession.name}
                >
                  {activeSession.name}
                </span>
                {activeSession.tmux_name && (
                  <span className="text-muted-foreground max-w-[20ch] truncate text-xs">
                    {activeSession.tmux_name}
                  </span>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Copy session ID"
                      className="h-6 w-6"
                      onClick={async () => {
                        try {
                          if (navigator.clipboard) {
                            await navigator.clipboard.writeText(
                              activeSession.id
                            );
                          } else {
                            // Fallback for non-HTTPS contexts
                            const textarea = document.createElement("textarea");
                            textarea.value = activeSession.id;
                            textarea.style.position = "fixed";
                            textarea.style.opacity = "0";
                            document.body.appendChild(textarea);
                            textarea.select();
                            document.execCommand("copy");
                            document.body.removeChild(textarea);
                          }
                          setCopiedSessionId(true);
                          if (copyTimeoutRef.current) {
                            clearTimeout(copyTimeoutRef.current);
                          }
                          copyTimeoutRef.current = setTimeout(
                            () => setCopiedSessionId(false),
                            2000
                          );
                        } catch {
                          console.error("Failed to copy to clipboard");
                        }
                      }}
                    >
                      {copiedSessionId ? (
                        <Check className="h-3 w-3 text-green-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Copy session ID for orchestration</p>
                    <p className="text-muted-foreground font-mono text-xs">
                      {activeSession.id.slice(0, 8)}...
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* The secondary fleet destinations. At `lg`+ they render as the full
                icon row (today's behavior). Below `lg` they collapse into the
                overflow "More" menu just after this — a pure Tailwind reflow
                (`hidden lg:flex` / `flex lg:hidden`), no resize JS — so a
                narrow/split-screen window stops squeezing the session name. The
                two flagship destinations — Workflows + Ask Stoa — are NOT here;
                they stay always-visible (below) so they never hide behind "More".
                The onClick wiring stays here (it's surface-specific); labels/icons
                come from the shared FLEET_NAV descriptor either way. */}
            {(() => {
              // One source of truth for the collapsible entries, shared by the
              // wide icon row and the narrow overflow menu so they can't drift.
              const secondaryNav = [
                {
                  id: "insight",
                  onClick: onOpenAnalytics,
                },
                {
                  id: "dispatch",
                  onClick: onOpenDispatch,
                },
                {
                  id: "verdict-inbox",
                  onClick: onOpenVerdictInbox,
                  count: attentionCount,
                },
                {
                  id: "fleet-board",
                  onClick: onOpenFleetBoard,
                  count: attentionCount,
                },
                {
                  id: "live-wall",
                  onClick: onOpenLiveWall,
                },
                {
                  id: "agent-monitor",
                  onClick: onOpenAgentMonitor,
                },
              ];
              return (
                <>
                  {/* Wide: the full icon row, exactly as before. */}
                  <div className="hidden items-center gap-2 lg:flex">
                    {secondaryNav.map((item) => (
                      <NavIconButton
                        key={item.id}
                        entry={fleetNavEntry(item.id)}
                        variant="header"
                        onClick={item.onClick}
                        count={item.count}
                      />
                    ))}
                  </div>

                  {/* Narrow: one overflow "More" menu. The needs-me signal
                      survives the collapse as an amber CountBadge on the
                      trigger (and per-item next to Verdict Inbox / Fleet
                      Board). */}
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={
                              attentionCount > 0
                                ? `More fleet destinations — ${attentionCount} ${attentionCount === 1 ? "needs" : "need"} you`
                                : "More fleet destinations"
                            }
                            className="relative flex lg:hidden"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                            {attentionCount > 0 && (
                              <CountBadge count={attentionCount} />
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>More</p>
                        {attentionCount > 0 && (
                          <p className="font-medium text-amber-600 dark:text-amber-400">
                            {attentionCount}{" "}
                            {attentionCount === 1 ? "needs" : "need"} you
                          </p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end">
                      {secondaryNav.map((item) => {
                        const entry = fleetNavEntry(item.id);
                        const Icon = entry.icon;
                        const itemCount = item.count ?? 0;
                        return (
                          <DropdownMenuItem
                            key={item.id}
                            onClick={item.onClick}
                          >
                            <Icon className="h-4 w-4" />
                            <span>{entry.label}</span>
                            {itemCount > 0 && (
                              <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 text-[10px] leading-none font-medium text-amber-600 dark:text-amber-400">
                                {itemCount > 9 ? "9+" : itemCount}
                              </span>
                            )}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              );
            })()}
            {/* The flagship destinations — Workflows + Ask Stoa — plus Guide and
                Quick switch stay ALWAYS visible (never collapsed into "More"), so
                the chatbox and pipelines are always one click away. */}
            <NavIconButton
              entry={fleetNavEntry("workflows")}
              variant="header"
              onClick={onOpenWorkflows}
              showLabel
            />
            <NavIconButton
              entry={fleetNavEntry("ask-stoa")}
              variant="header"
              onClick={onOpenAsk}
              showLabel
            />
            <NavIconButton
              entry={fleetNavEntry("notes")}
              variant="header"
              onClick={onShowNotes}
            />
            <NavIconButton
              entry={fleetNavEntry("commands")}
              variant="header"
              onClick={onShowCommands}
            />
            {onShowGuide && (
              <NavIconButton
                entry={fleetNavEntry("guide")}
                variant="header"
                onClick={onShowGuide}
              />
            )}
            <NavIconButton
              entry={fleetNavEntry("quick-switch")}
              variant="header"
              onClick={() => setShowQuickSwitcher(true)}
            />
            <NotificationSettings
              open={showNotificationSettings}
              onOpenChange={setShowNotificationSettings}
              settings={notificationSettings}
              permissionGranted={permissionGranted}
              waitingSessions={sessions
                .filter((s) => sessionStatuses[s.id]?.status === "waiting")
                .map((s) => ({ id: s.id, name: s.name }))}
              onUpdateSettings={updateSettings}
              onRequestPermission={requestPermission}
              onSelectSession={(id) => {
                const session = sessions.find((s) => s.id === id);
                if (session) attachToSession(session);
              }}
            />
            <Button size="sm" onClick={() => setShowNewSessionDialog(true)}>
              <Plus className="mr-1 h-4 w-4" />
              New Session
            </Button>
          </div>
        </header>

        {/* Pane Layout - full height */}
        <div className="min-h-0 flex-1">
          <PaneLayout renderPane={renderPane} />
        </div>
      </div>

      {/* Dialogs */}
      <NewSessionDialog
        open={showNewSessionDialog}
        projects={projects}
        selectedProjectId={newSessionProjectId ?? undefined}
        onClose={() => setShowNewSessionDialog(false)}
        onCreated={handleSessionCreated}
        onCreateProject={handleCreateProject}
      />
      <QuickSwitcher
        sessions={sessions}
        open={showQuickSwitcher}
        onOpenChange={setShowQuickSwitcher}
        sessionStatuses={sessionStatuses}
        currentSessionId={focusedActiveTab?.sessionId ?? undefined}
        activeSessionWorkingDir={activeSession?.working_directory ?? undefined}
        onOpenDispatch={onOpenDispatch}
        onOpenWorkflows={onOpenWorkflows}
        onOpenVerdictInbox={onOpenVerdictInbox}
        onOpenFleetBoard={onOpenFleetBoard}
        onOpenInsight={onOpenAnalytics}
        onOpenAskStoa={onOpenAsk}
        onOpenNotes={onShowNotes}
        onOpenCommands={onShowCommands}
        onOpenLiveWall={onOpenLiveWall}
        onOpenAgentMonitor={onOpenAgentMonitor}
        onNewSession={() => setShowNewSessionDialog(true)}
        onSelectSession={(sessionId) => {
          const session = sessions.find((s) => s.id === sessionId);
          if (session) attachToSession(session);
        }}
        onSelectFile={(file, line) => {
          // Convert relative path to absolute by prepending working directory,
          // using the separator native to the base (backslash on Windows).
          const absolutePath = activeSession?.working_directory
            ? joinPath(activeSession.working_directory, file)
            : file;
          fileOpenActions.requestOpen(absolutePath, line);
        }}
      />
      {startDevServerProject && (
        <StartServerDialog
          project={startDevServerProject}
          projectDevServers={startDevServerProject.devServers}
          onStart={handleCreateDevServer}
          onClose={() => setStartDevServerProjectId(null)}
        />
      )}
    </div>
  );
}

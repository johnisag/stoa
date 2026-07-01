"use client";

import { useCallback } from "react";
import { SessionList } from "@/components/SessionList";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { StartServerDialog } from "@/components/DevServers/StartServerDialog";
import { SidebarFooter } from "@/components/SidebarFooter";
import { NotificationSettings } from "@/components/NotificationSettings";
import { PaneLayout } from "@/components/PaneLayout";
import { FleetBar } from "@/components/FleetBar/FleetBar";
import { SwipeSidebar } from "@/components/mobile/SwipeSidebar";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import type { ViewProps } from "./types";
import { fileOpenActions } from "@/stores/fileOpen";
import { joinPath } from "@/lib/path-display";

export function MobileView({
  sessions,
  projects,
  sessionStatuses,
  sidebarOpen,
  setSidebarOpen,
  activeSession,
  focusedActiveTab,
  showNewSessionDialog,
  setShowNewSessionDialog,
  newSessionProjectId,
  showQuickSwitcher,
  setShowQuickSwitcher,
  onOpenDispatch,
  onOpenAnalytics,
  onOpenWorkflows,
  onOpenVerdictInbox,
  onOpenFleetBoard,
  onOpenLiveWall,
  onOpenAgentMonitor,
  onOpenActivity,
  onOpenAsk,
  showNotificationSettings,
  setShowNotificationSettings,
  notificationSettings,
  permissionGranted,
  updateSettings,
  requestPermission,
  onShowShortcuts,
  onShowGuide,
  onShowNotes,
  onShowCommands,
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
  // Stable id→session handlers (see DesktopView): keep SessionCard's React.memo
  // effective across the ~5s status poll instead of minting fresh inline arrows.
  const handleSelect = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (session) attachToSession(session);
      setSidebarOpen(false);
    },
    [sessions, attachToSession, setSidebarOpen]
  );
  const handleOpenInTab = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (session) openSessionInNewTab(session);
      setSidebarOpen(false);
    },
    [sessions, openSessionInNewTab, setSidebarOpen]
  );

  return (
    <main className="bg-background h-app flex flex-col overflow-hidden">
      {/* h-app (not h-screen): tracks visualViewport via useViewportHeight so
          the terminal + toolbar shrink above the on-screen keyboard instead of
          sliding under it. Desktop stays h-screen (DesktopView). */}
      {/* Swipe sidebar */}
      <SwipeSidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpen={() => setSidebarOpen(true)}
      >
        <div className="flex h-full flex-col">
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
            onShowGuide={() => {
              onShowGuide();
              setSidebarOpen(false);
            }}
            onShowAnalytics={() => {
              onOpenAnalytics();
              setSidebarOpen(false);
            }}
            onShowDispatch={() => {
              onOpenDispatch();
              setSidebarOpen(false);
            }}
            onShowWorkflows={() => {
              onOpenWorkflows();
              setSidebarOpen(false);
            }}
            onShowVerdictInbox={() => {
              onOpenVerdictInbox();
              setSidebarOpen(false);
            }}
            onShowFleetBoard={() => {
              onOpenFleetBoard();
              setSidebarOpen(false);
            }}
            onShowNotifications={() => {
              setShowNotificationSettings(true);
              setSidebarOpen(false);
            }}
            onShowChat={() => {
              onOpenAsk();
              setSidebarOpen(false);
            }}
            onShowNotes={() => {
              onShowNotes();
              setSidebarOpen(false);
            }}
            onShowCommands={() => {
              onShowCommands();
              setSidebarOpen(false);
            }}
          />
        </div>
      </SwipeSidebar>

      {/* Attention-first fleet bar (#15) — always-visible, ranks live sessions by
          who needs you now. A single thin row so it costs minimal terminal height. */}
      <FleetBar
        sessions={sessions}
        sessionStatuses={sessionStatuses}
        activeSessionId={focusedActiveTab?.sessionId || undefined}
        onSelect={handleSelect}
      />

      {/* Terminal fills the screen */}
      <div className="min-h-0 w-full flex-1">
        <PaneLayout renderPane={renderPane} />
      </div>

      {/* Dialogs */}
      {/* Notification settings — reachable on mobile via the SidebarFooter
          Bell. hideTrigger presents the same controls as an overlay (the Bell
          trigger lives in the footer, not here). */}
      <NotificationSettings
        hideTrigger
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
        onOpenActivity={onOpenActivity}
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
    </main>
  );
}

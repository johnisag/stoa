"use client";

import { useRef, useCallback, useEffect, memo, useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { usePanes } from "@/contexts/PaneContext";
import { isViewTab, type TabData } from "@/lib/panes";
import { useViewport } from "@/hooks/useViewport";
import type {
  TerminalHandle,
  TerminalScrollState,
} from "@/components/Terminal";
import type { Session, Project } from "@/lib/db";
import { sessionKey } from "@/lib/providers/registry";
import { getSwitchableSessionOrder } from "@/lib/session-navigation";
import { sessionRegistry } from "@/lib/client/session-registry";
import { getActiveBackend, buildSpawnForSession } from "@/lib/client/backend";
import { cn } from "@/lib/utils";
import { ConductorPanel } from "@/components/ConductorPanel";
import { useFileEditor } from "@/hooks/useFileEditor";
import { MobileTabBar } from "./MobileTabBar";
import { DesktopTabBar } from "./DesktopTabBar";
import { shouldFocusPaneOnClick } from "./focus-guard";
import {
  TerminalSkeleton,
  FileExplorerSkeleton,
  GitPanelSkeleton,
} from "./PaneSkeletons";
import {
  Panel as ResizablePanel,
  Group as ResizablePanelGroup,
  Separator as ResizablePanelHandle,
} from "react-resizable-panels";
import { GitDrawer } from "@/components/GitDrawer";
import {
  parseWorktreePaths,
  worktreePathsToRepositories,
} from "@/lib/workspace-session";
import { ShellDrawer } from "@/components/ShellDrawer";
import { PromptQueueModal } from "@/components/PromptQueueModal";
import { useSnapshot } from "valtio";
import { fileOpenStore, fileOpenActions } from "@/stores/fileOpen";
import { paneCommandStore, paneCommandActions } from "@/stores/paneCommands";

// Dynamic imports for client-only components with loading states
const Terminal = dynamic(
  () => import("@/components/Terminal").then((mod) => mod.Terminal),
  { ssr: false, loading: () => <TerminalSkeleton /> }
);

const FileExplorer = dynamic(
  () => import("@/components/FileExplorer").then((mod) => mod.FileExplorer),
  { ssr: false, loading: () => <FileExplorerSkeleton /> }
);

const FileExplorerDrawer = dynamic(
  () =>
    import("@/components/FileExplorer/FileExplorerDrawer").then(
      (mod) => mod.FileExplorerDrawer
    ),
  { ssr: false, loading: () => <FileExplorerSkeleton /> }
);

const GitPanel = dynamic(
  () => import("@/components/GitPanel").then((mod) => mod.GitPanel),
  { ssr: false, loading: () => <GitPanelSkeleton /> }
);

const WorkflowsView = dynamic(
  () =>
    import("@/components/views/WorkflowsView").then((mod) => mod.WorkflowsView),
  { ssr: false }
);
const FleetBoardView = dynamic(
  () =>
    import("@/components/views/FleetBoardView").then(
      (mod) => mod.FleetBoardView
    ),
  { ssr: false }
);
const AnalyticsView = dynamic(
  () =>
    import("@/components/views/AnalyticsView").then((mod) => mod.AnalyticsView),
  { ssr: false }
);
const DispatchView = dynamic(
  () =>
    import("@/components/views/DispatchView").then((mod) => mod.DispatchView),
  { ssr: false }
);
const VerdictInboxView = dynamic(
  () =>
    import("@/components/views/VerdictInboxView").then(
      (mod) => mod.VerdictInboxView
    ),
  { ssr: false }
);
const ChatView = dynamic(
  () => import("@/components/views/ChatView").then((mod) => mod.ChatView),
  { ssr: false }
);
const BestOfNView = dynamic(
  () => import("@/components/views/BestOfNView").then((mod) => mod.BestOfNView),
  { ssr: false }
);
const LiveWallView = dynamic(
  () =>
    import("@/components/views/LiveWallView").then((mod) => mod.LiveWallView),
  { ssr: false }
);
const AgentMonitorView = dynamic(
  () =>
    import("@/components/views/AgentMonitorView").then(
      (mod) => mod.AgentMonitorView
    ),
  { ssr: false }
);
const ActivityView = dynamic(
  () =>
    import("@/components/views/ActivityView").then((mod) => mod.ActivityView),
  { ssr: false }
);

interface PaneProps {
  paneId: string;
  sessions: Session[];
  projects: Project[];
  onRegisterTerminal: (
    paneId: string,
    tabId: string,
    ref: TerminalHandle | null
  ) => void;
  onMenuClick?: () => void;
  onDispatchClick?: () => void;
  onWorkflowsClick?: () => void;
  onVerdictInboxClick?: () => void;
  onFleetBoardClick?: () => void;
  onAskStoaClick?: () => void;
  onSelectSession?: (sessionId: string) => void;
  /** Open a session in a new tab (side-by-side). Used by Workflows to surface a
   * run's worker next to the workflows tab rather than replacing it. */
  onOpenSessionInNewTab?: (sessionId: string) => void;
}

type ViewMode = "terminal" | "files" | "git" | "workers";

export const Pane = memo(function Pane({
  paneId,
  sessions,
  projects,
  onRegisterTerminal,
  onMenuClick,
  onDispatchClick,
  onWorkflowsClick,
  onVerdictInboxClick,
  onFleetBoardClick,
  onAskStoaClick,
  onSelectSession,
  onOpenSessionInNewTab,
}: PaneProps) {
  const { isMobile } = useViewport();
  const {
    focusedPaneId,
    canSplit,
    canClose,
    focusPane,
    splitHorizontal,
    splitVertical,
    close,
    getPaneData,
    getActiveTab,
    addTab,
    addViewTab,
    addBonRunTab,
    closeTab,
    switchTab,
    detachSession,
  } = usePanes();

  const [viewMode, setViewMode] = useState<ViewMode>("terminal");
  // The right-side drawer shows Git OR Files — never both. Persisted per-pane
  // (paneId is stable across reloads); migrates the old global `gitDrawerOpen`
  // boolean on first run.
  const [rightDrawer, setRightDrawer] = useState<"git" | "files" | null>(() => {
    if (typeof window === "undefined") return "git";
    const stored = localStorage.getItem(`rightDrawer:${paneId}`);
    if (stored === "git" || stored === "files") return stored;
    if (stored === "none") return null;
    return localStorage.getItem("gitDrawerOpen") === "false" ? null : "git";
  });
  const [shellDrawerOpen, setShellDrawerOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = localStorage.getItem("shellDrawerOpen");
    return stored === "true";
  });
  // Full-screen prompt composer — sends straight to this pane's active terminal.
  const [showCompose, setShowCompose] = useState(false);
  const terminalRefs = useRef<Map<string, TerminalHandle | null>>(new Map());
  const paneData = getPaneData(paneId);
  const activeTab = getActiveTab(paneId);

  // Get ref for active terminal
  const terminalRef = activeTab
    ? (terminalRefs.current.get(activeTab.id) ?? null)
    : null;
  const isFocused = focusedPaneId === paneId;
  const session = activeTab
    ? sessions.find((s) => s.id === activeTab.sessionId)
    : null;

  // File editor state - lifted here so it persists across view switches
  const fileEditor = useFileEditor();

  // Check if this session is a conductor (has workers)
  const workerCount = useMemo(() => {
    if (!session) return 0;
    return sessions.filter((s) => s.conductor_session_id === session.id).length;
  }, [session, sessions]);

  const isConductor = workerCount > 0;

  // Get current project and its repositories
  const currentProject = useMemo(() => {
    if (!session?.project_id) return null;
    return projects.find((p) => p.id === session.project_id) || null;
  }, [session?.project_id, projects]);

  // Type assertion for repositories (projects passed here should have repositories)
  const projectRepositories = useMemo(() => {
    if (!currentProject) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (currentProject as any).repositories || [];
  }, [currentProject]);

  // A multi-repo "workspace" session: its working_directory holds one git worktree
  // per picked sub-repo (paths in worktree_paths). Show THOSE in the Git panel (the
  // session's actual edits live there), not the project's original checkouts.
  const workspacePaths = useMemo(
    () => parseWorktreePaths(session?.worktree_paths),
    [session?.worktree_paths]
  );
  const effectiveRepositories = useMemo(
    () =>
      workspacePaths.length > 0
        ? worktreePathsToRepositories(workspacePaths, session?.project_id ?? "")
        : projectRepositories,
    [workspacePaths, session?.project_id, projectRepositories]
  );

  // Watch for file open requests
  const { request: fileOpenRequest } = useSnapshot(fileOpenStore);
  // Watch for keyboard pane-commands (view/drawer/tab nav) aimed at the focused pane.
  const { request: paneCommand } = useSnapshot(paneCommandStore);

  // Reset view mode and file editor when session changes
  useEffect(() => {
    setViewMode("terminal");
    fileEditor.reset();
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist drawer states
  useEffect(() => {
    localStorage.setItem(`rightDrawer:${paneId}`, rightDrawer ?? "none");
  }, [rightDrawer, paneId]);

  useEffect(() => {
    localStorage.setItem("shellDrawerOpen", String(shellDrawerOpen));
  }, [shellDrawerOpen]);

  // Handle file open requests (only if this pane is focused)
  useEffect(() => {
    if (fileOpenRequest && isFocused && session) {
      // Switch to files view
      setViewMode("files");
      // Open the file at the requested line (#23 — terminal links, code search)
      fileEditor.openFile(fileOpenRequest.path, fileOpenRequest.line);
      // Clear the request
      fileOpenActions.clearRequest();
    }
  }, [fileOpenRequest, isFocused, session, fileEditor]);

  // Handle keyboard pane-commands — only the focused pane reacts, then clears
  // the request (mirrors the fileOpen handler above). Lets global chords drive
  // this pane's drawers / tab navigation without lifting its local state up.
  useEffect(() => {
    if (!paneCommand || !isFocused) return;
    switch (paneCommand.command) {
      case "toggle-git":
        setRightDrawer((d) => (d === "git" ? null : "git"));
        break;
      case "toggle-files":
        setRightDrawer((d) => (d === "files" ? null : "files"));
        break;
      case "toggle-shell":
        setShellDrawerOpen((prev) => !prev);
        break;
      case "next-tab":
      case "prev-tab": {
        const { tabs, activeTabId } = paneData;
        if (tabs.length > 1) {
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          const delta = paneCommand.command === "next-tab" ? 1 : -1;
          const next = tabs[(idx + delta + tabs.length) % tabs.length];
          if (next) switchTab(paneId, next.id);
        }
        break;
      }
    }
    paneCommandActions.clear();
  }, [paneCommand, isFocused, paneData, paneId, switchTab]);

  const handleFocus = useCallback(() => {
    // Don't steal focus on the click that completes a drag-select in this pane's
    // terminal — focus() clears the xterm selection on mouse-up (so it can't be
    // copied). Mirrors the guard on the terminal host div in
    // components/Terminal/index.tsx. A plain click (no selection) still focuses.
    if (!shouldFocusPaneOnClick(terminalRef)) return;
    focusPane(paneId);
  }, [focusPane, paneId, terminalRef]);

  const handleDetach = useCallback(() => {
    void getActiveBackend().then((backend) => {
      // tmux: send Ctrl+B d to detach the live session. Native pty is
      // attach-driven, so injecting that keystroke would corrupt the session.
      if (backend === "tmux" && terminalRef) {
        terminalRef.sendInput("\x02d"); // Ctrl+B d to detach
      }
      detachSession(paneId);
    });
  }, [detachSession, paneId, terminalRef]);

  // Create ref callback for a specific tab
  const getTerminalRef = useCallback(
    (tabId: string) => (handle: TerminalHandle | null) => {
      if (handle) {
        terminalRefs.current.set(tabId, handle);
      } else {
        terminalRefs.current.delete(tabId);
      }
    },
    []
  );

  // Create onConnected callback for a specific tab
  const getTerminalConnectedHandler = useCallback(
    (tab: (typeof paneData.tabs)[0]) => () => {
      console.log(
        `[Stoa] Terminal connected for pane: ${paneId}, tab: ${tab.id}`
      );
      const handle = terminalRefs.current.get(tab.id);
      if (!handle) return;

      onRegisterTerminal(paneId, tab.id, handle);

      // Determine the session/key to attach
      const session = tab.sessionId
        ? sessions.find((s) => s.id === tab.sessionId)
        : undefined;
      const sessionName = session?.tmux_name || tab.attachedTmux;

      // Blank tab (the "+") → a scratch shell so the pane isn't an empty box.
      // pty: spawn a real shell keyed by the tab id (empty binary => the
      // transport's spawnShellSession). The tmux path already lands in a shell,
      // so leave it untouched.
      if (!sessionName) {
        void getActiveBackend().then((backend) => {
          if (backend === "pty") {
            handle.attachSession({
              key: sessionKey({ kind: "shell", id: tab.id }),
              spawn: { binary: "", args: [], cwd: "~" },
            });
          }
        });
        return;
      }

      void getActiveBackend().then((backend) => {
        if (backend === "pty") {
          // Native: (re)attach immediately — the WS is already open (this fires
          // from onConnected), so the old 100ms delay was dead time. spawn lets
          // the server respawn the session if it isn't running.
          // allSessions: so a native fork re-attaching before its first turn still
          // resumes its parent (--fork-session) instead of respawning blank.
          const spawn = session
            ? buildSpawnForSession(session, { allSessions: sessions })
            : undefined;
          handle.attachSession({ key: sessionName, spawn });
        } else {
          setTimeout(
            () => handle.sendCommand(`tmux attach -t ${sessionName}`),
            100
          );
        }
      });
    },
    [paneId, sessions, onRegisterTerminal]
  );

  // Attach the pane's terminal to a worker session (from the conductor panel),
  // backend-aware: native re-subscribe vs the legacy tmux detach/attach dance.
  const handleAttachToWorker = useCallback(
    (workerId: string) => {
      const worker = sessions.find((s) => s.id === workerId);
      if (!worker || !terminalRef) return;
      const sessionName =
        worker.tmux_name ||
        sessionKey({
          kind: "agent",
          provider: worker.agent_type,
          id: workerId,
        });
      void getActiveBackend().then((backend) => {
        if (backend === "pty") {
          terminalRef.attachSession({
            key: sessionName,
            spawn: buildSpawnForSession(worker, { allSessions: sessions }),
          });
        } else {
          terminalRef.sendInput("\x02d");
          setTimeout(() => {
            terminalRef.sendInput("\x15");
            setTimeout(() => {
              terminalRef.sendCommand(`tmux attach -t ${sessionName}`);
            }, 50);
          }, 100);
        }
      });
    },
    [sessions, terminalRef]
  );

  // Inject a file/folder path from the tree into the active agent's prompt
  // (right-click → "Add to agent"). Reuses the terminal's sendInput — the same
  // seam the file picker uses — then surfaces the terminal so the user sees the
  // path land and can keep typing.
  const handleAddToAgent = useCallback(
    (text: string) => {
      if (!terminalRef) return;
      terminalRef.sendInput(text);
      setViewMode("terminal");
      // Defer focus: the terminal is display:none until the view switch renders,
      // and focus() on a hidden element is ignored.
      requestAnimationFrame(() => terminalRef.focus());
    },
    [terminalRef]
  );

  // Insert a saved snippet (from the shared store the mobile toolbar also uses)
  // into the active terminal. Content is already control-char-sanitized by
  // SnippetsModal. Use bracketed PASTE (not sendInput) so a multi-line snippet
  // goes in as ONE paste and does NOT auto-submit — a raw \n through sendInput is
  // an Enter keystroke. The user reviews and presses Enter.
  const handleSnippetInsert = useCallback(
    (content: string) => {
      if (!terminalRef || !content) return;
      terminalRef.paste(content);
      setViewMode("terminal");
      requestAnimationFrame(() => terminalRef.focus());
    },
    [terminalRef]
  );

  // Track current tab ID for cleanup
  const activeTabIdRef = useRef<string | null>(null);
  activeTabIdRef.current = activeTab?.id || null;

  // Cleanup on unmount only
  useEffect(() => {
    console.log(
      `[Stoa] Pane ${paneId} mounted, activeTab: ${activeTab?.id || "null"}`
    );
    return () => {
      console.log(
        `[Stoa] Pane ${paneId} unmounting, clearing terminal ref for tab: ${activeTabIdRef.current}`
      );
      if (activeTabIdRef.current) {
        onRegisterTerminal(paneId, activeTabIdRef.current, null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, onRegisterTerminal]);

  // Swipe gesture handling for mobile session switching (terminal view only).
  // Cycle over the shared sidebar order so swipe agrees with the chevrons and
  // Alt+arrows (worker sessions excluded).
  const touchStartX = useRef<number | null>(null);
  const switchOrder = useMemo(
    () => getSwitchableSessionOrder(sessions, projects),
    [sessions, projects]
  );
  const currentIndex = session ? switchOrder.indexOf(session.id) : -1;
  const SWIPE_THRESHOLD = 120;

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (viewMode !== "terminal") return;
      touchStartX.current = e.touches[0].clientX;
    },
    [viewMode]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (viewMode !== "terminal" || touchStartX.current === null) return;

      const diff = e.changedTouches[0].clientX - touchStartX.current;
      touchStartX.current = null;

      if (Math.abs(diff) <= SWIPE_THRESHOLD) return;

      if (currentIndex === -1) return;
      const nextIndex = diff > 0 ? currentIndex - 1 : currentIndex + 1;
      if (nextIndex >= 0 && nextIndex < switchOrder.length) {
        onSelectSession?.(switchOrder[nextIndex]);
      }
    },
    [viewMode, currentIndex, switchOrder, onSelectSession]
  );

  // Render the component for a non-terminal VIEW tab. One place wires every
  // fleet view to this pane's handlers, so the mobile + desktop tab-render paths
  // share it (no per-view if-blocks duplicated across both). An unknown view kind
  // returns null (renders an empty pane) rather than mis-rendering a terminal.
  function renderPaneView(tab: TabData) {
    switch (tab.view) {
      case "workflows":
        return (
          <WorkflowsView
            tabId={tab.id}
            sessions={sessions}
            activeSessionId={activeTab?.sessionId ?? undefined}
            onOpenSession={onSelectSession}
            onOpenSessionInNewTab={onOpenSessionInNewTab}
            onOpenDispatch={onDispatchClick}
            onOpenVerdictInbox={onVerdictInboxClick}
            onOpenFleetBoard={onFleetBoardClick}
            onClose={() => closeTab(paneId, tab.id)}
          />
        );
      case "fleet-board":
        return (
          <FleetBoardView
            onOpenSession={onOpenSessionInNewTab ?? onSelectSession}
            onOpenDispatch={onDispatchClick}
            onOpenWorkflows={onWorkflowsClick}
            onOpenVerdictInbox={onVerdictInboxClick}
            onClose={() => closeTab(paneId, tab.id)}
          />
        );
      case "analytics":
        return <AnalyticsView onClose={() => closeTab(paneId, tab.id)} />;
      case "dispatch":
        return (
          <DispatchView
            onOpenWorkflows={onWorkflowsClick}
            onOpenVerdictInbox={onVerdictInboxClick}
            onOpenFleetBoard={onFleetBoardClick}
            onClose={() => closeTab(paneId, tab.id)}
          />
        );
      case "verdict-inbox":
        return (
          <VerdictInboxView
            onOpenSession={onOpenSessionInNewTab ?? onSelectSession}
            onOpenDispatch={onDispatchClick}
            onOpenWorkflows={onWorkflowsClick}
            onOpenFleetBoard={onFleetBoardClick}
            onClose={() => closeTab(paneId, tab.id)}
          />
        );
      case "ask":
        return (
          <ChatView
            onClose={() => closeTab(paneId, tab.id)}
            onNavigate={(view) => {
              if (view === "dispatch") onDispatchClick?.();
              else if (view === "analytics") addViewTab(paneId, "analytics");
              else if (view === "verdict-inbox") onVerdictInboxClick?.();
              else if (view === "fleet-board") onFleetBoardClick?.();
            }}
            onOpenBonRun={(runId) => addBonRunTab(paneId, runId)}
          />
        );
      case "best-of-n":
        return tab.bonRunId ? (
          <BestOfNView
            runId={tab.bonRunId}
            onOpenSession={onOpenSessionInNewTab ?? onSelectSession}
            onClose={() => closeTab(paneId, tab.id)}
          />
        ) : null;
      case "live-wall":
        return (
          <LiveWallView
            sessions={sessions}
            onOpenSession={onOpenSessionInNewTab ?? onSelectSession}
            onClose={() => closeTab(paneId, tab.id)}
          />
        );
      case "agent-monitor":
        return (
          <AgentMonitorView
            sessions={sessions}
            onOpenSession={onOpenSessionInNewTab ?? onSelectSession}
            onClose={() => closeTab(paneId, tab.id)}
          />
        );
      case "activity":
        return <ActivityView onClose={() => closeTab(paneId, tab.id)} />;
      default:
        return null;
    }
  }

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden",
        !isMobile && "rounded-lg shadow-lg shadow-black/10 dark:shadow-black/30"
      )}
      onClick={handleFocus}
    >
      {/* Tab Bar - Mobile vs Desktop */}
      {isMobile ? (
        <MobileTabBar
          session={session}
          sessions={sessions}
          projects={projects}
          viewMode={viewMode}
          isConductor={isConductor}
          workerCount={workerCount}
          onMenuClick={onMenuClick}
          onDispatchClick={onDispatchClick}
          onWorkflowsClick={onWorkflowsClick}
          onVerdictInboxClick={onVerdictInboxClick}
          onFleetBoardClick={onFleetBoardClick}
          onAskStoaClick={onAskStoaClick}
          onComposeClick={session ? () => setShowCompose(true) : undefined}
          onViewModeChange={setViewMode}
          onSelectSession={onSelectSession}
        />
      ) : (
        <DesktopTabBar
          tabs={paneData.tabs}
          activeTabId={paneData.activeTabId}
          session={session}
          sessions={sessions}
          viewMode={viewMode}
          isFocused={isFocused}
          isConductor={isConductor}
          workerCount={workerCount}
          canSplit={canSplit}
          canClose={canClose}
          hasAttachedTmux={!!activeTab?.attachedTmux}
          rightDrawer={rightDrawer}
          shellDrawerOpen={shellDrawerOpen}
          onTabSwitch={(tabId) => switchTab(paneId, tabId)}
          onTabClose={(tabId) => closeTab(paneId, tabId)}
          onTabAdd={() => addTab(paneId)}
          onViewModeChange={setViewMode}
          onGitDrawerToggle={() =>
            setRightDrawer((d) => (d === "git" ? null : "git"))
          }
          onFilesDrawerToggle={() =>
            setRightDrawer((d) => (d === "files" ? null : "files"))
          }
          onShellDrawerToggle={() => setShellDrawerOpen((prev) => !prev)}
          onSplitHorizontal={() => splitHorizontal(paneId)}
          onSplitVertical={() => splitVertical(paneId)}
          onClose={() => close(paneId)}
          onDetach={handleDetach}
          showTerminalActions={viewMode === "terminal" && !!activeTab}
          showTerminalAttach={
            !!(activeTab?.sessionId || activeTab?.attachedTmux)
          }
          onTerminalCopy={() => terminalRef?.enterSelectMode()}
          onTerminalPaste={() => terminalRef?.pasteFromClipboard()}
          onTerminalAttach={() => terminalRef?.openFilePicker()}
          onTerminalAttachSelection={() =>
            terminalRef?.attachSelectionToAgent()
          }
          onSnippetInsert={handleSnippetInsert}
          onCompose={session ? () => setShowCompose(true) : undefined}
        />
      )}

      {/* Content Area - Mobile: simple flex, Desktop: resizable panels */}
      {isMobile ? (
        <div
          className="relative min-h-0 w-full flex-1"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {/* Tabs - terminal or workflows */}
          {paneData.tabs.map((tab) => {
            const isActive = tab.id === activeTab?.id;
            if (isViewTab(tab.view)) {
              return (
                <div
                  key={tab.id}
                  className={isActive ? "h-full w-full" : "hidden"}
                >
                  {renderPaneView(tab)}
                </div>
              );
            }
            const savedState = sessionRegistry.getTerminalState(paneId, tab.id);
            return (
              <div
                key={tab.id}
                className={
                  viewMode === "terminal" && isActive
                    ? "h-full w-full"
                    : "hidden"
                }
              >
                <Terminal
                  ref={getTerminalRef(tab.id)}
                  onConnected={getTerminalConnectedHandler(tab)}
                  onBeforeUnmount={(scrollState) => {
                    sessionRegistry.saveTerminalState(paneId, tab.id, {
                      scrollTop: scrollState.scrollTop,
                      scrollHeight: 0,
                      lastActivity: Date.now(),
                      cursorY: scrollState.cursorY,
                    });
                  }}
                  initialScrollState={
                    savedState
                      ? {
                          scrollTop: savedState.scrollTop,
                          cursorY: savedState.cursorY,
                          baseY: 0,
                        }
                      : undefined
                  }
                  // 📎 inserts a file path into the agent's prompt — only useful
                  // when the tab is attached to a session (a scratch shell isn't).
                  showImageButton={!!(tab.sessionId || tab.attachedTmux)}
                  // Desktop pane surfaces copy/paste/attach in the tab bar, not
                  // floating over the terminal.
                  floatingActions={false}
                  // Open the attach picker in the session's project, not HOME.
                  filePickerInitialPath={
                    sessions.find((s) => s.id === tab.sessionId)
                      ?.working_directory ?? undefined
                  }
                />
              </div>
            );
          })}

          {/* Files */}
          {session?.working_directory && (
            <div className={viewMode === "files" ? "h-full" : "hidden"}>
              <FileExplorer
                workingDirectory={session.working_directory}
                fileEditor={fileEditor}
                onAddToAgent={handleAddToAgent}
              />
            </div>
          )}

          {/* Git - mobile only */}
          {session?.working_directory && (
            <div className={viewMode === "git" ? "h-full" : "hidden"}>
              <GitPanel
                workingDirectory={session.working_directory}
                projectId={currentProject?.id}
                repositories={effectiveRepositories}
                repoPaths={
                  workspacePaths.length > 0 ? workspacePaths : undefined
                }
              />
            </div>
          )}

          {/* Workers */}
          {viewMode === "workers" && session && (
            <ConductorPanel
              conductorSessionId={session.id}
              onAttachToWorker={(workerId) => {
                setViewMode("terminal");
                handleAttachToWorker(workerId);
              }}
            />
          )}
        </div>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
        >
          {/* Left column: Main content + Shell drawer */}
          <ResizablePanel defaultSize={rightDrawer ? 70 : 100} minSize={20}>
            <ResizablePanelGroup orientation="vertical" className="h-full">
              {/* Main content */}
              <ResizablePanel
                defaultSize={shellDrawerOpen ? 70 : 100}
                minSize={10}
              >
                <div className="relative h-full">
                  {/* Tabs - terminal or workflows */}
                  {paneData.tabs.map((tab) => {
                    const isActive = tab.id === activeTab?.id;
                    if (isViewTab(tab.view)) {
                      return (
                        <div
                          key={tab.id}
                          className={isActive ? "h-full" : "hidden"}
                        >
                          {renderPaneView(tab)}
                        </div>
                      );
                    }
                    const savedState = sessionRegistry.getTerminalState(
                      paneId,
                      tab.id
                    );
                    return (
                      <div
                        key={tab.id}
                        className={
                          viewMode === "terminal" && isActive
                            ? "h-full"
                            : "hidden"
                        }
                      >
                        <Terminal
                          ref={getTerminalRef(tab.id)}
                          onConnected={getTerminalConnectedHandler(tab)}
                          onBeforeUnmount={(scrollState) => {
                            sessionRegistry.saveTerminalState(paneId, tab.id, {
                              scrollTop: scrollState.scrollTop,
                              scrollHeight: 0,
                              lastActivity: Date.now(),
                              cursorY: scrollState.cursorY,
                            });
                          }}
                          initialScrollState={
                            savedState
                              ? {
                                  scrollTop: savedState.scrollTop,
                                  cursorY: savedState.cursorY,
                                  baseY: 0,
                                }
                              : undefined
                          }
                          showImageButton={
                            !!(tab.sessionId || tab.attachedTmux)
                          }
                          // Desktop surfaces copy/paste/attach in the tab bar.
                          floatingActions={false}
                          // Open the attach picker in the session's project, not HOME.
                          filePickerInitialPath={
                            sessions.find((s) => s.id === tab.sessionId)
                              ?.working_directory ?? undefined
                          }
                        />
                      </div>
                    );
                  })}

                  {/* Files */}
                  {session?.working_directory && (
                    <div className={viewMode === "files" ? "h-full" : "hidden"}>
                      <FileExplorer
                        workingDirectory={session.working_directory}
                        fileEditor={fileEditor}
                        onAddToAgent={handleAddToAgent}
                      />
                    </div>
                  )}

                  {/* Workers */}
                  {viewMode === "workers" && session && (
                    <ConductorPanel
                      conductorSessionId={session.id}
                      onAttachToWorker={(workerId) => {
                        setViewMode("terminal");
                        handleAttachToWorker(workerId);
                      }}
                    />
                  )}
                </div>
              </ResizablePanel>

              {/* Shell drawer - under main content */}
              {shellDrawerOpen && session?.working_directory && (
                <>
                  <ResizablePanelHandle className="bg-border/30 hover:bg-primary/30 active:bg-primary/50 h-px cursor-row-resize transition-colors" />
                  <ResizablePanel defaultSize={30} minSize={10}>
                    <ShellDrawer
                      open={true}
                      onOpenChange={setShellDrawerOpen}
                      workingDirectory={session.working_directory}
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </ResizablePanel>

          {/* Right drawer - Git OR Files (mutually exclusive), full height */}
          {rightDrawer && session?.working_directory && (
            <>
              <ResizablePanelHandle className="bg-border/30 hover:bg-primary/30 active:bg-primary/50 w-px cursor-col-resize transition-colors" />
              <ResizablePanel defaultSize={30} minSize={10}>
                {rightDrawer === "git" ? (
                  <GitDrawer
                    open={true}
                    onOpenChange={(o) => !o && setRightDrawer(null)}
                    workingDirectory={session.working_directory}
                    projectId={currentProject?.id}
                    repositories={effectiveRepositories}
                    repoPaths={
                      workspacePaths.length > 0 ? workspacePaths : undefined
                    }
                  />
                ) : (
                  <FileExplorerDrawer
                    open={true}
                    onOpenChange={(o) => !o && setRightDrawer(null)}
                    workingDirectory={session.working_directory}
                  />
                )}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      )}

      {/* Full-screen composer — sends the prompt straight to the active
          terminal, then closes. Uses xterm BRACKETED paste (not sendCommand,
          which is a raw write that would submit a multi-line prompt line-by-line)
          then a single Enter, and surfaces the terminal so the send is visible. */}
      {showCompose && session && (
        <PromptQueueModal
          sessionId={session.id}
          name={session.name}
          mode="compose"
          onSend={(text) => {
            terminalRef?.paste(text);
            terminalRef?.sendInput("\r");
            setViewMode("terminal");
          }}
          onClose={() => setShowCompose(false)}
        />
      )}
    </div>
  );
});

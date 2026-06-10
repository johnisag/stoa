"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";

// Debug log buffer - persists even if console is closed
const debugLogs: string[] = [];
const MAX_DEBUG_LOGS = 100;

function debugLog(message: string) {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 12);
  const entry = `[${timestamp}] ${message}`;
  debugLogs.push(entry);
  if (debugLogs.length > MAX_DEBUG_LOGS) debugLogs.shift();
  console.log(`[Stoa] ${message}`);
}

// Expose to window for debugging
if (typeof window !== "undefined") {
  (window as unknown as { stoaLogs: () => void }).stoaLogs = () => {
    console.log("=== Stoa Debug Logs ===");
    debugLogs.forEach((log) => console.log(log));
    console.log("=== End Logs ===");
  };
}
import { PaneProvider, usePanes } from "@/contexts/PaneContext";
import { Pane } from "@/components/Pane";
import { useNotifications } from "@/hooks/useNotifications";
import { useViewport } from "@/hooks/useViewport";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useSessions } from "@/hooks/useSessions";
import { useProjects } from "@/hooks/useProjects";
import { useDevServersManager } from "@/hooks/useDevServersManager";
import { useSessionStatuses } from "@/hooks/useSessionStatuses";
import { useStatusEventStream } from "@/data/statuses";
import type { Session } from "@/lib/db";
import type { TerminalHandle } from "@/components/Terminal";
import {
  getProvider,
  buildAgentArgs,
  shellQuoteArg,
  buildTmuxFlags,
} from "@/lib/providers";
import { sessionKey } from "@/lib/providers/registry";
import { DesktopView } from "@/components/views/DesktopView";
import { MobileView } from "@/components/views/MobileView";
import { DispatchView } from "@/components/views/DispatchView";
import { AnalyticsView } from "@/components/views/AnalyticsView";
import { WorkflowsView } from "@/components/views/WorkflowsView";
import { getPendingPrompt, clearPendingPrompt } from "@/stores/initialPrompt";
import { paneCommandActions } from "@/stores/paneCommands";
import { getSwitchableSessionOrder } from "@/lib/session-navigation";
import { getActiveBackend } from "@/lib/client/backend";
import { useGlobalKeybindings } from "@/hooks/useGlobalKeybindings";
import { ShortcutsHelp } from "@/components/ShortcutsHelp";
import type { Keybinding } from "@/lib/keybindings";

// Global navigation shortcuts (mod = ⌘ on macOS, Ctrl elsewhere). Module-level
// so the bindings array identity stays stable across renders.
const NAV_KEYBINDINGS: Keybinding[] = [
  {
    chord: "mod+k",
    action: "open-switcher",
    allowInInput: true,
    description: "Open the session / code switcher",
  },
  {
    chord: "alt+arrowdown",
    action: "next-session",
    description: "Next session",
  },
  {
    chord: "alt+arrowup",
    action: "prev-session",
    description: "Previous session",
  },
  {
    // No allowInInput: these are app-chrome actions, and on the tmux backend
    // `mod` is Ctrl — so ⌘/Ctrl+B would otherwise collide with the tmux prefix
    // (and ⌘/Ctrl+\ with SIGQUIT) while typing. The .xterm guard suppresses them
    // when the terminal is focused; they still fire from the rest of the UI.
    chord: "mod+b",
    action: "toggle-sidebar",
    description: "Toggle the sidebar",
  },
  {
    chord: "mod+\\",
    action: "split-pane",
    description: "Split the focused pane",
  },
  // Focused-pane view/drawer toggles + tab nav. Like mod+b above, these are not
  // allowInInput, so the .xterm guard lets the keystrokes reach a focused
  // terminal; they fire from the rest of the UI. mod+shift+letter / +arrow are
  // chosen to dodge browser-reserved chords (⌘T reopen-tab, ⌘1..9 browser tabs)
  // and shifted-punctuation normalization. Routed to the focused pane via
  // paneCommandStore (a global handler can't reach a pane's local state).
  {
    chord: "mod+shift+g",
    action: "pane-toggle-git",
    description: "Toggle the Git panel (focused pane)",
  },
  {
    chord: "mod+shift+e",
    action: "pane-toggle-files",
    description: "Toggle the file explorer (focused pane)",
  },
  {
    chord: "mod+shift+s",
    action: "pane-toggle-shell",
    description: "Toggle the shell drawer (focused pane)",
  },
  {
    chord: "mod+shift+arrowright",
    action: "pane-next-tab",
    description: "Next tab (focused pane)",
  },
  {
    chord: "mod+shift+arrowleft",
    action: "pane-prev-tab",
    description: "Previous tab (focused pane)",
  },
  {
    chord: "shift+?",
    action: "show-help",
    description: "Show keyboard shortcuts",
  },
];

function HomeContent() {
  // UI State
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(
    null
  );
  const [showNotificationSettings, setShowNotificationSettings] =
    useState(false);
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false);
  const [showDispatch, setShowDispatch] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showWorkflows, setShowWorkflows] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map());

  // Pane context
  const {
    focusedPaneId,
    attachSession,
    getActiveTab,
    addTab,
    splitHorizontal,
    reconcileSessions,
  } = usePanes();
  const focusedActiveTab = getActiveTab(focusedPaneId);
  const { isMobile, isHydrated } = useViewport();

  // Data hooks
  const { sessions, fetchSessions, loaded: sessionsLoaded } = useSessions();
  const { projects, fetchProjects } = useProjects();
  const {
    startDevServerProjectId,
    setStartDevServerProjectId,
    startDevServer,
    createDevServer,
  } = useDevServersManager();

  // Once the session list has loaded, detach any pane tab whose session no
  // longer exists (e.g. all sessions deleted) so it can't linger as a live
  // orphan pane. Guarded on `sessionsLoaded` so we never wipe restored tabs
  // before the first fetch resolves.
  useEffect(() => {
    if (!sessionsLoaded) return;
    reconcileSessions(new Set(sessions.map((s) => s.id)));
  }, [sessionsLoaded, sessions, reconcileSessions]);

  // Helper to get init script command from API
  const getInitScriptCommand = useCallback(
    async (agentCommand: string): Promise<string> => {
      try {
        const res = await fetch("/api/sessions/init-script", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentCommand }),
        });
        const data = await res.json();
        return data.command || agentCommand;
      } catch {
        return agentCommand;
      }
    },
    []
  );

  // Set CSS variable for viewport height (handles mobile keyboard)
  useViewportHeight();

  // Terminal ref management
  const registerTerminalRef = useCallback(
    (paneId: string, tabId: string, ref: TerminalHandle | null) => {
      const key = `${paneId}:${tabId}`;
      if (ref) {
        terminalRefs.current.set(key, ref);
        debugLog(
          `Terminal registered: ${key}, total refs: ${terminalRefs.current.size}`
        );
      } else {
        terminalRefs.current.delete(key);
        debugLog(
          `Terminal unregistered: ${key}, total refs: ${terminalRefs.current.size}`
        );
      }
    },
    []
  );

  // Get terminal for a pane, with fallback to first available
  const getTerminalWithFallback = useCallback(():
    | { terminal: TerminalHandle; paneId: string; tabId: string }
    | undefined => {
    debugLog(
      `getTerminalWithFallback called, total refs: ${terminalRefs.current.size}, focusedPaneId: ${focusedPaneId}`
    );

    // Try focused pane first
    const activeTab = getActiveTab(focusedPaneId);
    debugLog(`activeTab for focused pane: ${activeTab?.id || "null"}`);

    if (activeTab) {
      const key = `${focusedPaneId}:${activeTab.id}`;
      const terminal = terminalRefs.current.get(key);
      debugLog(
        `Looking for terminal at key "${key}": ${terminal ? "found" : "not found"}`
      );
      if (terminal) {
        return { terminal, paneId: focusedPaneId, tabId: activeTab.id };
      }
    }

    // Fallback to first available terminal
    const firstEntry = terminalRefs.current.entries().next().value;
    if (firstEntry) {
      const [key, terminal] = firstEntry as [string, TerminalHandle];
      const [paneId, tabId] = key.split(":");
      debugLog(`Using fallback terminal: ${key}`);
      return { terminal, paneId, tabId };
    }

    debugLog(
      `NO TERMINAL FOUND. Available keys: ${Array.from(terminalRefs.current.keys()).join(", ") || "none"}`
    );
    return undefined;
  }, [focusedPaneId, getActiveTab]);

  // Build tmux command for a session
  const buildSessionCommand = useCallback(
    async (
      session: Session
    ): Promise<{
      sessionName: string;
      cwd: string;
      command: string;
      spawn: { binary: string; args: string[]; cwd: string };
    }> => {
      const provider = getProvider(session.agent_type || "claude");
      const sessionName =
        session.tmux_name ||
        sessionKey({ kind: "agent", provider: provider.id, id: session.id });
      const cwd = session.working_directory?.replace("~", "$HOME") || "$HOME";
      // Raw cwd for the pty backend (the registry expands a leading "~").
      const ptyCwd = session.working_directory || "~";

      // Shell sessions just open a terminal - no agent command
      if (provider.id === "shell") {
        return {
          sessionName,
          cwd,
          command: "",
          spawn: { binary: "", args: [], cwd: ptyCwd },
        };
      }

      // TODO: Add explicit "Enable Orchestration" toggle that creates .mcp.json
      // for conductor sessions. Removed auto-creation because it pollutes projects
      // with .mcp.json files that aren't in their .gitignore.
      // See: /api/sessions/[id]/mcp-config, lib/mcp-config.ts

      // Get parent session ID for forking
      let parentSessionId: string | null = null;
      if (!session.claude_session_id && session.parent_session_id) {
        const parentSession = sessions.find(
          (s) => s.id === session.parent_session_id
        );
        parentSessionId = parentSession?.claude_session_id || null;
      }

      // Check for pending initial prompt
      const initialPrompt = getPendingPrompt(session.id);
      if (initialPrompt) {
        clearPendingPrompt(session.id);
      }

      // Conductor MCP wiring persisted on the session (e.g. Codex's
      // `-c mcp_servers.stoa.*`), replayed verbatim on every spawn. NULL for
      // non-conductors and file-configured providers (Claude's .mcp.json).
      let extraArgs: string[] = [];
      if (session.mcp_launch_args) {
        try {
          const parsed = JSON.parse(session.mcp_launch_args);
          if (Array.isArray(parsed)) extraArgs = parsed.map(String);
        } catch {
          // Malformed — spawn without the conductor flags rather than fail.
        }
      }

      const buildFlagsOptions = {
        sessionId: session.claude_session_id,
        parentSessionId,
        autoApprove: session.auto_approve,
        model: session.model,
        initialPrompt: initialPrompt || undefined,
        extraArgs,
      };

      // tmux execs a shell command, so shell-quote the conductor tokens here
      // (buildFlags itself doesn't emit extraArgs); the pty path gets them as
      // clean argv via buildAgentArgs below. extraArgs (the `-c mcp_servers.*`
      // conductor wiring) must land BEFORE the positional prompt — same order
      // as the pty path — so splice rather than append.
      const flags = buildTmuxFlags(
        provider.buildFlags(buildFlagsOptions),
        extraArgs.map(shellQuoteArg),
        !!buildFlagsOptions.initialPrompt?.trim()
      );
      const flagsStr = flags.join(" ");

      const agentCmd = `${provider.command} ${flagsStr}`;
      // The init-script POST writes a bash .sh banner used only by the tmux
      // backend's `command` field. The native pty backend spawns via
      // binary/args and ignores `command`, so skip the round-trip there.
      const backend = await getActiveBackend();
      const command =
        backend === "tmux" ? await getInitScriptCommand(agentCmd) : agentCmd;

      // Structured argv for the native pty backend (no shell quoting).
      const { binary, args } = buildAgentArgs(
        session.agent_type || "claude",
        buildFlagsOptions
      );

      return {
        sessionName,
        cwd,
        command,
        spawn: { binary, args, cwd: ptyCwd },
      };
    },
    [sessions, getInitScriptCommand]
  );

  // Attach a session to a terminal
  const runSessionInTerminal = useCallback(
    (
      terminal: TerminalHandle,
      paneId: string,
      session: Session,
      sessionInfo: {
        sessionName: string;
        cwd: string;
        command: string;
        spawn: { binary: string; args: string[]; cwd: string };
      },
      backend: "pty" | "tmux"
    ) => {
      const { sessionName, cwd, command, spawn } = sessionInfo;
      if (backend === "pty") {
        // Native: subscribe to (or spawn) the registry session directly.
        terminal.attachSession({ key: sessionName, spawn });
      } else {
        const tmuxNew = command
          ? `tmux new -s ${sessionName} -c "${cwd}" "${command}"`
          : `tmux new -s ${sessionName} -c "${cwd}"`;
        terminal.sendCommand(
          `tmux set -g mouse on 2>/dev/null; tmux attach -t ${sessionName} 2>/dev/null || ${tmuxNew}`
        );
      }
      attachSession(paneId, session.id, sessionName);
      terminal.focus();
    },
    [attachSession]
  );

  // Attach session to terminal
  const attachToSession = useCallback(
    async (session: Session) => {
      const terminalInfo = getTerminalWithFallback();
      if (!terminalInfo) {
        debugLog(
          `ERROR: No terminal available to attach session: ${session.name}`
        );
        toast.error("No terminal available", {
          description: "Run stoaLogs() in the console to see debug logs.",
        });
        return;
      }

      const { terminal, paneId } = terminalInfo;
      const activeTab = getActiveTab(paneId);
      const backend = await getActiveBackend();

      if (backend === "pty") {
        // Native: switching sessions just re-subscribes the socket; the server
        // detaches the previous session and repaints the new one. No tmux
        // detach (Ctrl-B d) / Ctrl-C dance.
        const sessionInfo = await buildSessionCommand(session);
        runSessionInTerminal(terminal, paneId, session, sessionInfo, "pty");
        return;
      }

      const isInTmux = !!activeTab?.attachedTmux;

      if (isInTmux) {
        terminal.sendInput("\x02d");
      }

      setTimeout(
        () => {
          terminal.sendInput("\x03");
          setTimeout(async () => {
            const sessionInfo = await buildSessionCommand(session);
            runSessionInTerminal(
              terminal,
              paneId,
              session,
              sessionInfo,
              "tmux"
            );
          }, 50);
        },
        isInTmux ? 100 : 0
      );
    },
    [
      getTerminalWithFallback,
      getActiveTab,
      buildSessionCommand,
      runSessionInTerminal,
    ]
  );

  // Open session in new tab
  const openSessionInNewTab = useCallback(
    (session: Session) => {
      const existingKeys = new Set(terminalRefs.current.keys());
      addTab(focusedPaneId);

      let attempts = 0;
      const maxAttempts = 20;

      const waitForNewTerminal = () => {
        attempts++;

        for (const key of terminalRefs.current.keys()) {
          if (!existingKeys.has(key) && key.startsWith(`${focusedPaneId}:`)) {
            const terminal = terminalRefs.current.get(key);
            if (terminal) {
              buildSessionCommand(session).then(async (sessionInfo) => {
                const backend = await getActiveBackend();
                runSessionInTerminal(
                  terminal,
                  focusedPaneId,
                  session,
                  sessionInfo,
                  backend
                );
              });
              return;
            }
          }
        }

        if (attempts < maxAttempts) {
          setTimeout(waitForNewTerminal, 50);
        } else {
          debugLog(`Failed to find new terminal after ${maxAttempts} attempts`);
        }
      };

      setTimeout(waitForNewTerminal, 50);
    },
    [addTab, focusedPaneId, buildSessionCommand, runSessionInTerminal]
  );

  // Notification click handler
  const handleNotificationClick = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        attachToSession(session);
      }
    },
    [sessions, attachToSession]
  );

  // Notifications
  const {
    settings: notificationSettings,
    checkStateChanges,
    updateSettings,
    requestPermission,
    permissionGranted,
  } = useNotifications({ onSessionClick: handleNotificationClick });

  // Session statuses
  const { sessionStatuses } = useSessionStatuses({
    sessions,
    activeSessionId: focusedActiveTab?.sessionId,
    checkStateChanges,
  });
  // Live status push (/ws/events) merges transitions into the same cache the
  // poll above fills — instant board updates; the poll stays as the backstop.
  useStatusEventStream();

  // Set initial sidebar state based on viewport (only after hydration)
  useEffect(() => {
    if (isHydrated && !isMobile) setSidebarOpen(true);
  }, [isMobile, isHydrated]);

  // Global keyboard shortcuts are wired below (after handleSelectSession is
  // defined), via useGlobalKeybindings + NAV_KEYBINDINGS.

  // Session selection handler
  const handleSelectSession = useCallback(
    (sessionId: string) => {
      debugLog(`handleSelectSession called for: ${sessionId}`);
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        debugLog(`Found session: ${session.name}, calling attachToSession`);
        attachToSession(session);
      } else {
        debugLog(
          `Session not found in sessions array (length: ${sessions.length})`
        );
      }
    },
    [sessions, attachToSession]
  );

  // Cycle to the next/previous individually-navigable session (wraps around),
  // over the shared sidebar order (getSwitchableSessionOrder) so Alt+arrows,
  // mobile chevrons, and the pane swipe all agree. Workers are excluded — they
  // aren't standalone rows. No-op if it would land on the already-focused
  // session: a re-attach is destructive on tmux (sends Ctrl-C, restarts attach).
  const selectRelativeSession = useCallback(
    (delta: number) => {
      const order = getSwitchableSessionOrder(sessions, projects);
      if (order.length === 0) return;
      const currentId = focusedActiveTab?.sessionId;
      const idx = currentId ? order.indexOf(currentId) : -1;
      // From no/unknown selection, "next" starts at the first and "prev" at the last.
      const base = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
      const next = (base + delta + order.length) % order.length;
      const targetId = order[next];
      if (targetId === currentId) return;
      handleSelectSession(targetId);
    },
    [sessions, projects, focusedActiveTab?.sessionId, handleSelectSession]
  );

  // Global keyboard shortcuts: ⌘/Ctrl-K switcher, Alt+↓/↑ next/prev session.
  useGlobalKeybindings(NAV_KEYBINDINGS, (action) => {
    if (action === "open-switcher") setShowQuickSwitcher(true);
    else if (action === "next-session") selectRelativeSession(1);
    else if (action === "prev-session") selectRelativeSession(-1);
    else if (action === "toggle-sidebar") setSidebarOpen((v) => !v);
    else if (action === "split-pane") splitHorizontal(focusedPaneId);
    else if (action === "pane-toggle-git")
      paneCommandActions.send("toggle-git");
    else if (action === "pane-toggle-files")
      paneCommandActions.send("toggle-files");
    else if (action === "pane-toggle-shell")
      paneCommandActions.send("toggle-shell");
    else if (action === "pane-next-tab") paneCommandActions.send("next-tab");
    else if (action === "pane-prev-tab") paneCommandActions.send("prev-tab");
    else if (action === "show-help") setShowHelp(true);
  });

  // Pane renderer
  const renderPane = useCallback(
    (paneId: string) => (
      <Pane
        key={paneId}
        paneId={paneId}
        sessions={sessions}
        projects={projects}
        onRegisterTerminal={registerTerminalRef}
        onMenuClick={isMobile ? () => setSidebarOpen(true) : undefined}
        onDispatchClick={isMobile ? () => setShowDispatch(true) : undefined}
        onSelectSession={handleSelectSession}
      />
    ),
    [sessions, projects, registerTerminalRef, isMobile, handleSelectSession]
  );

  // New session in project handler
  const handleNewSessionInProject = useCallback((projectId: string) => {
    setNewSessionProjectId(projectId);
    setShowNewSessionDialog(true);
  }, []);

  // Session created handler (shared between desktop/mobile)
  const handleSessionCreated = useCallback(
    async (sessionId: string) => {
      setShowNewSessionDialog(false);
      setNewSessionProjectId(null);
      await fetchSessions();

      const res = await fetch(`/api/sessions/${sessionId}`);
      const data = await res.json();
      if (!data.session) return;

      setTimeout(() => attachToSession(data.session), 100);
    },
    [fetchSessions, attachToSession]
  );

  // Project created handler (shared between desktop/mobile)
  const handleCreateProject = useCallback(
    async (
      name: string,
      workingDirectory: string,
      agentType?: string
    ): Promise<string | null> => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, workingDirectory, agentType }),
      });
      const data = await res.json();
      if (data.project) {
        await fetchProjects();
        return data.project.id;
      }
      return null;
    },
    [fetchProjects]
  );

  // Open terminal in project handler (shell session, not AI agent)
  const handleOpenTerminal = useCallback(
    async (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;

      // Create a shell session with the project's working directory
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${project.name} Terminal`,
          workingDirectory: project.working_directory || "~",
          agentType: "shell",
          projectId,
        }),
      });

      const data = await res.json();
      if (!data.session) return;

      await fetchSessions();

      // Small delay to ensure state updates, then attach
      setTimeout(() => {
        attachToSession(data.session);
      }, 100);
    },
    [projects, fetchSessions, attachToSession]
  );

  // Active session and dev server project
  const activeSession = sessions.find(
    (s) => s.id === focusedActiveTab?.sessionId
  );
  const startDevServerProject = startDevServerProjectId
    ? (projects.find((p) => p.id === startDevServerProjectId) ?? null)
    : null;

  // View props
  const viewProps = {
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
    showDispatch,
    setShowDispatch,
    showAnalytics,
    setShowAnalytics,
    showWorkflows,
    setShowWorkflows,
    onShowShortcuts: () => setShowHelp(true),
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
    handleStartDevServer: startDevServer,
    handleCreateDevServer: createDevServer,
    startDevServerProject,
    setStartDevServerProjectId,
    renderPane,
  };

  return (
    <>
      {/* Gate the view on isHydrated so phones never flash DesktopView for a
          frame before snapping to mobile. SSR and the first client render both
          show this neutral shell (so they match — no hydration mismatch); once
          hydrated, isMobile is already correct and the right view renders. */}
      {!isHydrated ? (
        <div className="bg-background flex h-screen w-screen items-center justify-center">
          <div className="border-muted-foreground/30 border-t-foreground h-6 w-6 animate-spin rounded-full border-2" />
        </div>
      ) : isMobile ? (
        <MobileView {...viewProps} />
      ) : (
        <DesktopView {...viewProps} />
      )}
      {/* Global keyboard-shortcuts cheatsheet (opened via the `?` shortcut). */}
      <ShortcutsHelp
        bindings={NAV_KEYBINDINGS}
        open={showHelp}
        onOpenChange={setShowHelp}
      />
      {/* Dispatch control plane (GitHub-issue -> agent fleet). Self-contained
          dialog; the nav buttons in Desktop/MobileView open it via setShowDispatch. */}
      <DispatchView open={showDispatch} onOpenChange={setShowDispatch} />
      {/* Insight / analytics over the audit ledger. Self-contained dialog;
          opened from the Desktop/Mobile nav via setShowAnalytics. */}
      <AnalyticsView open={showAnalytics} onOpenChange={setShowAnalytics} />
      {/* Workflows — run agent pipelines from the template catalog. Needs the
          sessions list for the conductor picker; opened via setShowWorkflows. */}
      <WorkflowsView
        open={showWorkflows}
        onOpenChange={setShowWorkflows}
        sessions={sessions}
        activeSessionId={focusedActiveTab?.sessionId ?? undefined}
      />
    </>
  );
}

export default function Home() {
  return (
    <PaneProvider>
      <HomeContent />
    </PaneProvider>
  );
}

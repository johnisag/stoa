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
import { useOfflineQueueDrain } from "@/hooks/useOfflineQueue";
import { useSessions } from "@/hooks/useSessions";
import { useProjects } from "@/hooks/useProjects";
import { useDevServersManager } from "@/hooks/useDevServersManager";
import { useSessionStatuses } from "@/hooks/useSessionStatuses";
import { useStatusEventStream } from "@/data/statuses";
import type { Session } from "@/lib/db";
import type { TerminalHandle } from "@/components/Terminal";
import {
  getProvider,
  shellQuoteArg,
  escapeForDoubleQuotes,
  buildTmuxFlags,
  buildAgentArgs,
} from "@/lib/providers";
import { sessionKey } from "@/lib/providers/registry";
import { resolveSessionLaunchOptions } from "@/lib/session-launch";
import { DesktopView } from "@/components/views/DesktopView";
import { MobileView } from "@/components/views/MobileView";
import { getPendingPrompt, clearPendingPrompt } from "@/stores/initialPrompt";
import { paneCommandActions } from "@/stores/paneCommands";
import { getSwitchableSessionOrder } from "@/lib/session-navigation";
import { nextAttentionSession } from "@/lib/session-attention";
import { parseAppAction } from "@/lib/share-intake";
import { getActiveBackend } from "@/lib/client/backend";
import { useGlobalKeybindings } from "@/hooks/useGlobalKeybindings";
import { ShortcutsHelp } from "@/components/ShortcutsHelp";
import { StoaGuide } from "@/components/StoaGuide";
import { NotesDialog } from "@/components/Notes/NotesDialog";
import { CommandsDialog } from "@/components/Commands/CommandsDialog";
import { SessionDiffModal } from "@/components/SessionDiffModal";
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
    // mod+shift+letter (not alt+letter) to dodge the macOS Alt-glyph
    // normalization the pane toggles below also avoid. Jumps to the next
    // session that needs you (waiting / error), wrapping.
    chord: "mod+shift+a",
    action: "next-attention",
    description: "Jump to next session needing attention",
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
  // Top-level fleet views (the header icons). Same convention as the pane
  // toggles above: mod+shift+letter (not alt+letter) to dodge the macOS
  // Alt-glyph normalization, and no allowInInput so the .xterm guard lets the
  // keystrokes reach a focused terminal while they still fire from the rest of
  // the UI. Letters are vetted against browser-reserved chords — the obvious
  // mnemonics ⌘⇧D (bookmark all tabs), ⌘⇧W (close window), ⌘⇧V (paste plain),
  // ⌘⇧B (bookmarks bar) and ⌘⇧I (devtools) are all taken — and ⌘⇧F is the app's
  // OWN terminal-search chord (useTerminalSearch) — so we use the nearest free
  // letter for each view. (⌘⇧U also triggers IBus Unicode entry on some Linux
  // desktops; it's the last free letter for Insight and degrades gracefully —
  // don't "fix" it to a reserved one without re-vetting.)
  {
    chord: "mod+shift+x",
    action: "open-dispatch",
    description: "Open Dispatch",
  },
  {
    chord: "mod+shift+z",
    action: "open-workflows",
    description: "Open Workflows",
  },
  {
    chord: "mod+shift+y",
    action: "open-verdict-inbox",
    description: "Open the Verdict Inbox",
  },
  {
    chord: "mod+shift+l",
    action: "open-fleet-board",
    description: "Open the Fleet Board",
  },
  {
    chord: "mod+shift+u",
    action: "open-insight",
    description: "Open Insight",
  },
  {
    // mod+shift+m — mnemonic "Monitor" (the live wall). NOT mod+shift+w: on
    // Windows/Linux Ctrl+Shift+W closes the browser tab and is not reliably
    // cancelable via preventDefault. Vetted free of the bindings above.
    chord: "mod+shift+m",
    action: "open-live-wall",
    description: "Open the Live Wall",
  },
  {
    // mod+shift+c — mnemonic "Chat". mod+shift+a is taken (next-attention).
    // Vetted: not browser-reserved and not claimed by any other binding above.
    chord: "mod+shift+c",
    action: "open-ask-stoa",
    description: "Open Ask Stoa",
  },
];

function HomeContent() {
  // UI State
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(
    null
  );
  // #17: a shared-text prompt (from the /share redirect) seeded into the New
  // Session dialog the next time it opens; cleared when the dialog closes so a
  // later manual "New Session" starts blank.
  const [newSessionPromptSeed, setNewSessionPromptSeed] = useState<
    string | null
  >(null);
  useEffect(() => {
    // Fires on open/close transitions only; the closure's seed value is from
    // the same render, so clearing on close is always acting on fresh state.
    if (!showNewSessionDialog) {
      setNewSessionPromptSeed(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNewSessionDialog]);
  const [showNotificationSettings, setShowNotificationSettings] =
    useState(false);
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false);

  const [showHelp, setShowHelp] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  // Session whose diff to show via the "See changes" jump (fired when a turn
  // completes). null = the diff modal is closed.
  const [seeChangesSessionId, setSeeChangesSessionId] = useState<string | null>(
    null
  );
  const [copiedSessionId, setCopiedSessionId] = useState(false);
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map());

  // Pane context
  const {
    focusedPaneId,
    attachSession,
    getActiveTab,
    addTab,
    addWorkflowsTab,
    addViewTab,
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
      // Fallback when the init-script POST is unavailable. The init-script path
      // returns a bare `bash <path>` (metacharacter-free), but the raw
      // agentCommand is not — and the tmux backend interpolates `command` into an
      // OUTER double-quoted `"${command}"`. Escape it for that context (shared
      // helper, same char-class shellQuoteArg uses) so a metacharacter-bearing
      // token (e.g. a free-text model) can't break out of that wrapper; the agent
      // CLI in the pane still receives the original command (buildFlags' per-token
      // quoting keeps it safe there). Also preserves a literal `$` in the prompt.
      const safeFallback = escapeForDoubleQuotes(agentCommand);
      try {
        const res = await fetch("/api/sessions/init-script", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentCommand }),
        });
        if (!res.ok) return safeFallback;
        const data = await res.json();
        return data.command || safeFallback;
      } catch {
        return safeFallback;
      }
    },
    []
  );

  // Set CSS variable for viewport height (handles mobile keyboard)
  useViewportHeight();

  // Replay any actions queued while offline (e.g. a prompt sent in a dead spot)
  // when connectivity returns — #12, mounted once here at the app root.
  useOfflineQueueDrain();

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
    { terminal: TerminalHandle; paneId: string; tabId: string } | undefined => {
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

      // Check for pending initial prompt
      const initialPrompt = getPendingPrompt(session.id);
      if (initialPrompt) {
        clearPendingPrompt(session.id);
      }

      // SINGLE chokepoint (lib/session-launch): resolve the launch options from the
      // Session once — the shell short-circuit, the NON-BYPASSABLE model clamp, the
      // conductor MCP-arg parse, and the native-fork parent resolution all live
      // there, so this tmux/pty path and buildSpawnForSession's re-attach path can't
      // drift or skip a step. The shell short-circuit already returned above, so a
      // non-shell session always resolves here.
      const resolved = resolveSessionLaunchOptions(session, {
        initialPrompt: initialPrompt || undefined,
        allSessions: sessions,
      });
      // Defensive: only a shell session yields null, and that path returned above.
      const buildFlagsOptions = resolved?.options ?? {};
      const extraArgs = buildFlagsOptions.extraArgs ?? [];

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

      // Structured argv for the native pty backend (no shell quoting) — built from
      // the SAME resolved object as the tmux flags above (not a second resolve),
      // so the tmux and pty argv are guaranteed identical by construction.
      const { binary, args } = resolved
        ? buildAgentArgs(resolved.agentType, resolved.options)
        : { binary: "", args: [] };

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
  } = useNotifications({
    onSessionClick: handleNotificationClick,
    onSeeChanges: setSeeChangesSessionId,
  });

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

  // Open a worker session in a NEW tab beside the current one. Used by the
  // Workflows view so opening a run's worker sits side-by-side with the
  // workflows tab instead of replacing it.
  const handleOpenSessionInNewTab = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        toast.error("Session not found — it may have been deleted.");
        return;
      }
      openSessionInNewTab(session);
    },
    [sessions, openSessionInNewTab]
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

  // Jump to the next session that needs you (waiting / error), wrapping — over
  // the same sidebar order as Alt+arrows. No-op with a toast when nothing does.
  const jumpToNextAttention = useCallback(() => {
    const order = getSwitchableSessionOrder(sessions, projects);
    const targetId = nextAttentionSession(
      order,
      focusedActiveTab?.sessionId,
      sessionStatuses
    );
    if (!targetId) {
      toast("Nothing needs you", {
        description: "No session is waiting for input or errored.",
      });
      return;
    }
    handleSelectSession(targetId);
  }, [
    sessions,
    projects,
    focusedActiveTab?.sessionId,
    sessionStatuses,
    handleSelectSession,
  ]);

  // Global keyboard shortcuts: ⌘/Ctrl-K switcher, Alt+↓/↑ next/prev session.
  useGlobalKeybindings(NAV_KEYBINDINGS, (action) => {
    if (action === "open-switcher") setShowQuickSwitcher(true);
    else if (action === "next-session") selectRelativeSession(1);
    else if (action === "prev-session") selectRelativeSession(-1);
    else if (action === "next-attention") jumpToNextAttention();
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
    else if (action === "open-dispatch") addViewTab(focusedPaneId, "dispatch");
    else if (action === "open-workflows") addWorkflowsTab(focusedPaneId);
    else if (action === "open-verdict-inbox")
      addViewTab(focusedPaneId, "verdict-inbox");
    else if (action === "open-fleet-board")
      addViewTab(focusedPaneId, "fleet-board");
    else if (action === "open-insight") addViewTab(focusedPaneId, "analytics");
    else if (action === "open-live-wall")
      addViewTab(focusedPaneId, "live-wall");
    else if (action === "open-ask-stoa") addViewTab(focusedPaneId, "ask");
  });

  // #17: app-shortcut / share-target deep links. Read `?action=…` ONCE on
  // launch (mount-only, no deps; the ref also guards StrictMode's dev
  // double-invoke), dispatch to the same handlers the keybindings use, then
  // strip the query from the URL so a reload (or the PWA restoring the
  // location) can't re-fire the action.
  const appActionHandledRef = useRef(false);
  useEffect(() => {
    if (appActionHandledRef.current) return;
    appActionHandledRef.current = true;
    const parsed = parseAppAction(window.location.search);
    if (!parsed) return;
    if (parsed.action === "new-session") {
      if (parsed.prompt) setNewSessionPromptSeed(parsed.prompt);
      setShowNewSessionDialog(true);
    } else if (parsed.action === "board") {
      addViewTab(focusedPaneId, "fleet-board");
    } else if (parsed.action === "ask") {
      addViewTab(focusedPaneId, "ask");
    } else if (parsed.action === "live-wall") {
      addViewTab(focusedPaneId, "live-wall");
    }
    window.history.replaceState(null, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        onDispatchClick={() => addViewTab(paneId, "dispatch")}
        onWorkflowsClick={() => addWorkflowsTab(paneId)}
        onVerdictInboxClick={() => addViewTab(paneId, "verdict-inbox")}
        onFleetBoardClick={() => addViewTab(paneId, "fleet-board")}
        onAskStoaClick={isMobile ? () => addViewTab(paneId, "ask") : undefined}
        onSelectSession={handleSelectSession}
        onOpenSessionInNewTab={handleOpenSessionInNewTab}
      />
    ),
    [
      sessions,
      projects,
      registerTerminalRef,
      isMobile,
      handleSelectSession,
      handleOpenSessionInNewTab,
      addViewTab,
      addWorkflowsTab,
    ]
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.session) return;

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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("Failed to create project:", data.error || res.status);
        return null;
      }
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

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.session) return;

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
  // The session whose "See changes" diff is showing (null when closed).
  const seeChangesSession = seeChangesSessionId
    ? sessions.find((s) => s.id === seeChangesSessionId)
    : undefined;
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
    newSessionPromptSeed,
    showNotificationSettings,
    setShowNotificationSettings,
    showQuickSwitcher,
    setShowQuickSwitcher,
    onOpenDispatch: () => addViewTab(focusedPaneId, "dispatch"),
    onOpenAnalytics: () => addViewTab(focusedPaneId, "analytics"),
    onOpenWorkflows: () => addWorkflowsTab(focusedPaneId),
    onOpenVerdictInbox: () => addViewTab(focusedPaneId, "verdict-inbox"),
    onOpenFleetBoard: () => addViewTab(focusedPaneId, "fleet-board"),
    onOpenLiveWall: () => addViewTab(focusedPaneId, "live-wall"),
    onOpenAgentMonitor: () => addViewTab(focusedPaneId, "agent-monitor"),
    onOpenActivity: () => addViewTab(focusedPaneId, "activity"),
    onOpenAsk: () => addViewTab(focusedPaneId, "ask"),
    onShowShortcuts: () => setShowHelp(true),
    onShowGuide: () => setShowGuide(true),
    onShowNotes: () => setShowNotes(true),
    onShowCommands: () => setShowCommands(true),
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
      {/* Plain-English feature tour (opened from the sidebar footer). */}
      <StoaGuide open={showGuide} onOpenChange={setShowGuide} />
      <NotesDialog open={showNotes} onOpenChange={setShowNotes} />
      <CommandsDialog open={showCommands} onOpenChange={setShowCommands} />
      {/* Dispatch + Verdict Inbox are now first-class pane TABs (see addViewTab),
          not dialogs — opened from the nav / cross-links via onOpenDispatch /
          onOpenVerdictInbox. */}
      {/* Fleet Board + Insight + Ask Stoa are now first-class pane TABs (see
          addViewTab), not dialogs — opened from the nav / cross-links. Every fleet
          view is a window now; no fleet dialogs remain. */}
      {/* "See changes" jump-to-diff: opened by the transient toast action when a
          session's turn completes (useNotifications -> onSeeChanges). */}
      {seeChangesSessionId && (
        <SessionDiffModal
          sessionId={seeChangesSessionId}
          name={seeChangesSession?.name ?? "Session"}
          onClose={() => setSeeChangesSessionId(null)}
        />
      )}
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

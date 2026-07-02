"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { baseName } from "@/lib/path-display";
import {
  Terminal,
  GitBranch,
  Clock,
  Check,
  Rocket,
  Workflow,
  Inbox,
  Columns3,
  BarChart3,
  Plus,
  Sparkles,
  NotebookPen,
  LayoutGrid,
  Gauge,
  TerminalSquare,
  History,
  Pin,
} from "lucide-react";
import { statusGlyph } from "@/components/status-glyph";
import type { Session } from "@/lib/db";
import type { SessionStatus } from "@/components/views/types";
import dynamic from "next/dynamic";
import { useRipgrepAvailable } from "@/data/code-search";
import { searchSessions } from "@/lib/session-search";
import {
  filterCommands,
  type QuickCommand,
} from "@/lib/quick-switcher-commands";
import {
  getPins,
  getRecents,
  rankWithRecents,
  recordRecent,
  togglePin,
  type PaletteStorage,
} from "@/lib/palette-recents";
import { useViewport } from "@/hooks/useViewport";

// react-syntax-highlighter is heavy; load the code-search results lazily so it
// stays out of the eager bundle (only needed once a code search runs).
const CodeSearchResults = dynamic(
  () =>
    import("@/components/CodeSearch/CodeSearchResults").then(
      (m) => m.CodeSearchResults
    ),
  {
    ssr: false,
    loading: () => (
      <div className="text-muted-foreground p-4 text-center text-sm">
        Loading…
      </div>
    ),
  }
);

// Cross-session output search results — lazy, like code search (its data hook is
// only needed once the Output tab is used).
const OutputSearchResults = dynamic(
  () =>
    import("@/components/OutputSearch/OutputSearchResults").then(
      (m) => m.OutputSearchResults
    ),
  {
    ssr: false,
    loading: () => (
      <div className="text-muted-foreground p-4 text-center text-sm">
        Loading…
      </div>
    ),
  }
);

type SwitcherMode = "sessions" | "code" | "output";

// localStorage access itself can throw (privacy mode / sandboxed iframe);
// treat it as absent so the palette still works, just without memory.
function paletteStorage(): PaletteStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// SQLite's datetime("now") yields a naive UTC string ("YYYY-MM-DD HH:MM:SS")
// with no zone. `new Date()` would parse the space-separated, offset-less form
// as LOCAL time, skewing "Xm ago" by the viewer's TZ offset. Mirror
// SessionCard.getTimeAgo: treat a zone-less value as UTC by appending "Z".
export function parseDbTimestamp(dateStr: string): Date {
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(dateStr);
  return new Date(hasZone ? dateStr : `${dateStr.replace(" ", "T")}Z`);
}

interface QuickSwitcherProps {
  sessions: Session[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSession: (sessionId: string) => void;
  onSelectFile?: (file: string, line: number) => void;
  currentSessionId?: string;
  activeSessionWorkingDir?: string;
  /** Live status per session id, so the switcher shows what each agent is doing
   * (glyph + a one-line preview) instead of being status-blind. */
  sessionStatuses?: Record<string, SessionStatus>;
  // Command-lane callbacks. Each is OPTIONAL: a command is only offered when its
  // callback is wired, so the palette never surfaces an action the page can't
  // perform. These let Cmd+K reach views/actions that were otherwise mouse-only.
  /** Open the Dispatch control plane. */
  onOpenDispatch?: () => void;
  /** Open the Workflows view. */
  onOpenWorkflows?: () => void;
  /** Open the Verdict Inbox (fleet review queue). */
  onOpenVerdictInbox?: () => void;
  /** Open the Fleet Board (fleet by lifecycle stage). */
  onOpenFleetBoard?: () => void;
  /** Open the Insight / analytics view. */
  onOpenInsight?: () => void;
  /** Start a new session. */
  onNewSession?: () => void;
  /** Open the Ask Stoa chatbox. */
  onOpenAskStoa?: () => void;
  /** Open the Notes / shared knowledge base dialog. */
  onOpenNotes?: () => void;
  onOpenCommands?: () => void;
  onOpenLiveWall?: () => void;
  onOpenAgentMonitor?: () => void;
  onOpenActivity?: () => void;
}

/**
 * Quick session switcher with search
 * Triggered by Cmd+K or button tap
 */
export function QuickSwitcher({
  sessions,
  open,
  onOpenChange,
  onSelectSession,
  onSelectFile,
  currentSessionId,
  activeSessionWorkingDir,
  sessionStatuses,
  onOpenDispatch,
  onOpenWorkflows,
  onOpenVerdictInbox,
  onOpenFleetBoard,
  onOpenInsight,
  onNewSession,
  onOpenAskStoa,
  onOpenNotes,
  onOpenCommands,
  onOpenLiveWall,
  onOpenAgentMonitor,
  onOpenActivity,
}: QuickSwitcherProps) {
  const { isMobile } = useViewport();
  const [mode, setMode] = useState<SwitcherMode>("sessions");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Palette memory (lib/palette-recents): pinned ids always sort first on an
  // empty query, then most-recently-used. Loaded from localStorage on open.
  const [recents, setRecents] = useState<string[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check if ripgrep is available
  const { data: ripgrepAvailable } = useRipgrepAvailable();

  // The command lane: built only from the callbacks the page actually wired, so
  // a command never appears unless it can run. `icon` is presentational only —
  // matching keys off label + keywords (see filterCommands).
  const commands = useMemo<(QuickCommand & { icon: React.ReactNode })[]>(() => {
    const list: (QuickCommand & { icon: React.ReactNode })[] = [];
    const add = (
      id: string,
      label: string,
      keywords: string[],
      run: (() => void) | undefined,
      icon: React.ReactNode
    ) => {
      if (run) list.push({ id, label, keywords, run, icon });
    };
    add(
      "new-session",
      "New Session",
      ["create", "start", "agent"],
      onNewSession,
      <Plus className="h-4 w-4" />
    );
    add(
      "open-dispatch",
      "Open Dispatch",
      ["fleet", "issues", "github", "agents", "control"],
      onOpenDispatch,
      <Rocket className="h-4 w-4" />
    );
    add(
      "open-verdict-inbox",
      "Open Verdict Inbox",
      ["review", "queue", "verdict", "approve"],
      onOpenVerdictInbox,
      <Inbox className="h-4 w-4" />
    );
    add(
      "open-fleet-board",
      "Open Fleet Board",
      ["kanban", "lifecycle", "board", "stages"],
      onOpenFleetBoard,
      <Columns3 className="h-4 w-4" />
    );
    add(
      "open-insight",
      "Open Insight",
      ["analytics", "ledger", "metrics", "stats", "cost"],
      onOpenInsight,
      <BarChart3 className="h-4 w-4" />
    );
    add(
      "open-workflows",
      "Open Workflows",
      ["pipeline", "template", "run"],
      onOpenWorkflows,
      <Workflow className="h-4 w-4" />
    );
    add(
      "open-ask-stoa",
      "Open Ask Stoa",
      ["chat", "ask", "question", "help", "ai", "assistant"],
      onOpenAskStoa,
      <Sparkles className="h-4 w-4" />
    );
    add(
      "open-notes",
      "Open Notes",
      ["note", "notes", "knowledge", "doc", "markdown", "scratchpad"],
      onOpenNotes,
      <NotebookPen className="h-4 w-4" />
    );
    add(
      "open-commands",
      "Open Commands",
      ["command", "skill", "slash", "macro", "snippet"],
      onOpenCommands,
      <TerminalSquare className="h-4 w-4" />
    );
    add(
      "open-live-wall",
      "Open Live Wall",
      ["wall", "grid", "terminals", "monitor", "live", "fleet", "watch"],
      onOpenLiveWall,
      <LayoutGrid className="h-4 w-4" />
    );
    add(
      "open-agent-monitor",
      "Open Agent Monitor",
      ["monitor", "telemetry", "metrics", "tokens", "context", "cost", "htop"],
      onOpenAgentMonitor,
      <Gauge className="h-4 w-4" />
    );
    add(
      "open-activity",
      "Open Activity",
      ["activity", "audit", "timeline", "events", "log", "history", "trail"],
      onOpenActivity,
      <History className="h-4 w-4" />
    );
    return list;
  }, [
    onNewSession,
    onOpenDispatch,
    onOpenVerdictInbox,
    onOpenFleetBoard,
    onOpenInsight,
    onOpenWorkflows,
    onOpenAskStoa,
    onOpenNotes,
    onOpenCommands,
    onOpenLiveWall,
    onOpenAgentMonitor,
    onOpenActivity,
  ]);

  // Fuzzy-match + rank commands by the same query the session lane uses.
  const filteredCommands = useMemo(
    () =>
      filterCommands(commands, query) as (QuickCommand & {
        icon: React.ReactNode;
      })[],
    [commands, query]
  );

  // Fuzzy-match + rank sessions by the query (name, path, agent, branch, group).
  // Recents/pins only reorder the DEFAULT (empty-query) list — pinned first,
  // then MRU, then the rest; with an active query the fuzzy ranking stays king
  // (rankWithRecents is skipped so a deliberate search is never hijacked).
  const filteredSessions = useMemo(() => {
    const matches = searchSessions(sessions, query);
    return query.trim() ? matches : rankWithRecents(matches, recents, pins);
  }, [sessions, query, recents, pins]);

  // Sessions render first, then commands; keyboard nav / Enter index into this
  // single ordered list so ↑↓ flows across both groups seamlessly.
  const totalResults = filteredCommands.length + filteredSessions.length;

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setMode("sessions");
      setQuery("");
      setSelectedIndex(0);
      // Refresh palette memory each open (another tab may have updated it).
      const storage = paletteStorage();
      if (storage) {
        setRecents(getRecents(storage));
        setPins(getPins(storage));
      }
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Force sessions mode if ripgrep is not available
  useEffect(() => {
    if (ripgrepAvailable === false && mode === "code") {
      setMode("sessions");
    }
  }, [ripgrepAvailable, mode]);

  // Reset selected index when filtered results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Clamp the selection if the result list shrank — e.g. a background `sessions`
  // refresh dropped a match — so the highlight and Enter never point past the
  // end. Keyed on length (not identity) so a mere re-rank keeps the position.
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, totalResults - 1)));
  }, [totalResults]);

  // Select a session and remember it: recordRecent floats it to the top of the
  // empty-query list next time the palette opens (MRU, pinned still first).
  const selectSession = useCallback(
    (id: string) => {
      const storage = paletteStorage();
      if (storage) setRecents(recordRecent(storage, id));
      onSelectSession(id);
      onOpenChange(false);
    },
    [onSelectSession, onOpenChange]
  );

  // Pin/unpin a session row — pinned sessions always sort first on an empty
  // query, across palette opens. Pinning REORDERS the list under the keyboard
  // highlight, so the highlight follows the previously highlighted SESSION
  // (by id, recomputed against the new order) — a stale index would make the
  // next Enter fire on the wrong session.
  const handleTogglePin = useCallback(
    (id: string) => {
      const storage = paletteStorage();
      if (!storage) return;
      const highlightedId =
        selectedIndex < filteredSessions.length
          ? filteredSessions[selectedIndex]?.id
          : null;
      const nextPins = togglePin(storage, id);
      setPins(nextPins);
      if (highlightedId && !query.trim()) {
        const reordered = rankWithRecents(
          searchSessions(sessions, query),
          recents,
          nextPins
        );
        const nextIndex = reordered.findIndex((s) => s.id === highlightedId);
        if (nextIndex >= 0) setSelectedIndex(nextIndex);
      }
    },
    [selectedIndex, filteredSessions, query, sessions, recents]
  );

  // Fire the result at `selectedIndex` (sessions render first, then commands)
  // and close the palette.
  const activateSelected = useCallback(() => {
    if (selectedIndex < filteredSessions.length) {
      const session = filteredSessions[selectedIndex];
      if (session) selectSession(session.id);
      return;
    }
    const command = filteredCommands[selectedIndex - filteredSessions.length];
    if (command) {
      onOpenChange(false);
      command.run();
    }
  }, [
    selectedIndex,
    filteredCommands,
    filteredSessions,
    selectSession,
    onOpenChange,
  ]);

  // The modes Tab cycles through: Sessions, Code (only when ripgrep is present),
  // and Output (cross-session transcript search, always available).
  const availableModes = useMemo<SwitcherMode[]>(() => {
    const m: SwitcherMode[] = ["sessions"];
    if (ripgrepAvailable !== false) m.push("code");
    m.push("output");
    return m;
  }, [ripgrepAvailable]);

  // Handle keyboard navigation. ↑↓/Enter drive the sessions+commands list ONLY in
  // "sessions" mode; in code/output mode their own results panel owns nav (its
  // window keydown listener), so we don't also move a hidden list here.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Tab") {
        e.preventDefault();
        setMode((m) => {
          const i = availableModes.indexOf(m);
          return availableModes[(i + 1) % availableModes.length];
        });
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
        return;
      }
      if (mode !== "sessions") return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, totalResults - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          activateSelected();
          break;
      }
    },
    [mode, availableModes, totalResults, activateSelected, onOpenChange]
  );

  // Format relative time
  const formatTime = (dateStr: string | null) => {
    if (!dateStr) return "";
    const now = new Date();
    const date = parseDbTimestamp(dateStr);
    const diff = now.getTime() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  // Handle file selection from code search
  const handleSelectFile = useCallback(
    (file: string, line: number) => {
      onOpenChange(false);
      onSelectFile?.(file, line);
    },
    [onOpenChange, onSelectFile]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        sheet={isMobile}
        className="gap-0 overflow-hidden p-0 sm:max-w-md"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Switch Session / Search Code</DialogTitle>
        </DialogHeader>

        {/* Mode Toggle — always rendered so users can discover code search.
            When ripgrep is unavailable the Code Search tab is dimmed + disabled
            with a tooltip explaining what to install. */}
        <div className="border-border flex gap-2 border-b p-2">
          <button
            onClick={() => setMode("sessions")}
            className={cn(
              "rounded-full px-3 py-1 text-sm transition-colors",
              mode === "sessions"
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent"
            )}
          >
            Sessions
          </button>
          {ripgrepAvailable === false ? (
            <span
              title="Install ripgrep to enable code search"
              className="cursor-not-allowed rounded-full px-3 py-1 text-sm opacity-40"
            >
              Code Search
            </span>
          ) : (
            <button
              onClick={() => setMode("code")}
              className={cn(
                "rounded-full px-3 py-1 text-sm transition-colors",
                mode === "code"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              )}
            >
              Code Search
            </button>
          )}
          <button
            onClick={() => setMode("output")}
            title="Search agent output across your Claude sessions"
            className={cn(
              "rounded-full px-3 py-1 text-sm transition-colors",
              mode === "output"
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent"
            )}
          >
            Output
          </button>
        </div>

        {/* Search Input */}
        <div className="border-border border-b p-3">
          <Input
            ref={inputRef}
            placeholder={
              mode === "output"
                ? "Search agent output (min 2 chars)..."
                : mode === "sessions" || !ripgrepAvailable
                  ? "Search sessions & commands..."
                  : "Search code (min 3 chars)..."
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-10"
          />
        </div>

        {/* Content */}
        <div className="max-h-[300px] overflow-y-auto py-2">
          {mode === "sessions" ? (
            totalResults === 0 ? (
              <div className="text-muted-foreground px-4 py-8 text-center text-sm">
                No matches found
              </div>
            ) : (
              <>
                {/* Sessions group — FIRST, so the palette's primary action
                    (⌘K → Enter on an empty/short query) still lands on the top
                    session, not a command. */}
                {filteredSessions.length > 0 && (
                  <>
                    {filteredCommands.length > 0 && (
                      <div className="text-muted-foreground px-4 pt-1 pb-1 text-xs font-medium tracking-wide uppercase">
                        Sessions
                      </div>
                    )}
                    {filteredSessions.map((session, index) => {
                      const isCurrent = session.id === currentSessionId;
                      const isPinned = pins.includes(session.id);
                      const st = sessionStatuses?.[session.id];
                      const preview =
                        (st?.status === "running" ||
                          st?.status === "waiting") &&
                        st.lastLine?.trim()
                          ? st.lastLine.trim()
                          : null;
                      return (
                        <button
                          key={session.id}
                          onClick={() => selectSession(session.id)}
                          className={cn(
                            "group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
                            index === selectedIndex
                              ? "bg-accent"
                              : "hover:bg-accent/50",
                            isCurrent && "bg-primary/10"
                          )}
                        >
                          {/* Icon */}
                          <div
                            className={cn(
                              "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md",
                              session.worktree_path
                                ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                                : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            )}
                          >
                            {session.worktree_path ? (
                              <GitBranch className="h-4 w-4" />
                            ) : (
                              <Terminal className="h-4 w-4" />
                            )}
                          </div>

                          {/* Content */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="flex-shrink-0">
                                {statusGlyph(st?.status)}
                              </span>
                              <span className="truncate font-medium">
                                {session.name || "Unnamed Session"}
                              </span>
                              {isCurrent && (
                                <Check className="text-primary h-3.5 w-3.5 flex-shrink-0" />
                              )}
                            </div>
                            {preview ? (
                              <div
                                className="text-muted-foreground truncate text-xs"
                                title={preview}
                              >
                                {preview}
                              </div>
                            ) : (
                              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                                <span className="truncate">
                                  {session.working_directory
                                    ? baseName(session.working_directory)
                                    : "~"}
                                </span>
                                <span>•</span>
                                <span className="capitalize">
                                  {session.agent_type || "claude"}
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Time */}
                          <div className="text-muted-foreground flex flex-shrink-0 items-center gap-1 text-xs">
                            <Clock className="h-3 w-3" />
                            <span>{formatTime(session.updated_at)}</span>
                          </div>

                          {/* Pin toggle — a span (not a nested <button>) so the
                              row stays valid HTML; stopPropagation keeps a pin
                              tap from also selecting the session. Hidden until
                              hover/highlight unless pinned. */}
                          <span
                            title={
                              isPinned ? "Unpin session" : "Pin to top of ⌘K"
                            }
                            role="button"
                            tabIndex={0}
                            aria-pressed={isPinned}
                            aria-label={
                              isPinned ? "Unpin session" : "Pin session"
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTogglePin(session.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                handleTogglePin(session.id);
                              }
                            }}
                            className={cn(
                              "hover:text-foreground flex-shrink-0 rounded p-1 transition-opacity",
                              // Touch has no hover: keep unpinned pins faintly
                              // visible below sm so the affordance is
                              // discoverable on phones.
                              isPinned
                                ? "text-primary"
                                : "text-muted-foreground opacity-40 sm:opacity-0 sm:group-hover:opacity-100",
                              index === selectedIndex && "opacity-100"
                            )}
                          >
                            <Pin
                              className={cn(
                                "h-3.5 w-3.5",
                                isPinned && "fill-current"
                              )}
                            />
                          </span>
                        </button>
                      );
                    })}
                  </>
                )}

                {/* Commands group — AFTER sessions; a command's highlight index
                    is offset by the session count so ↑↓ flows across both. */}
                {filteredCommands.length > 0 && (
                  <>
                    <div className="text-muted-foreground px-4 pt-2 pb-1 text-xs font-medium tracking-wide uppercase">
                      Commands
                    </div>
                    {filteredCommands.map((command, i) => {
                      const index = filteredSessions.length + i;
                      return (
                        <button
                          key={command.id}
                          onClick={() => {
                            onOpenChange(false);
                            command.run();
                          }}
                          className={cn(
                            "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
                            index === selectedIndex
                              ? "bg-accent"
                              : "hover:bg-accent/50"
                          )}
                        >
                          <div className="bg-primary/10 text-primary flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md">
                            {command.icon}
                          </div>
                          <span className="truncate font-medium">
                            {command.label}
                          </span>
                        </button>
                      );
                    })}
                  </>
                )}
              </>
            )
          ) : mode === "code" ? (
            <CodeSearchResults
              workingDirectory={activeSessionWorkingDir || "~"}
              query={query}
              onSelectFile={handleSelectFile}
            />
          ) : (
            <OutputSearchResults
              query={query}
              onSelectSession={selectSession}
            />
          )}
        </div>

        {/* Footer Hint */}
        <div className="border-border text-muted-foreground flex items-center gap-4 border-t px-4 py-2 text-xs">
          <span>
            <kbd className="bg-muted rounded px-1.5 py-0.5">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="bg-muted rounded px-1.5 py-0.5">↵</kbd> select
          </span>
          <span>
            <kbd className="bg-muted rounded px-1.5 py-0.5">esc</kbd> close
          </span>
          <span className="ml-auto">
            <kbd className="bg-muted rounded px-1.5 py-0.5">Tab</kbd> switch
            mode
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

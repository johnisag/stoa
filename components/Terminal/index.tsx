"use client";

import {
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useState,
  useMemo,
  useEffect,
} from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import "@xterm/xterm/css/xterm.css";
import {
  WifiOff,
  Upload,
  Loader2,
  RotateCcw,
  Copy,
  ClipboardPaste,
  Paperclip,
  MessageSquarePlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchBar } from "./SearchBar";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { TerminalToolbar } from "./TerminalToolbar";
import { useTerminalConnection, useTerminalSearch } from "./hooks";
import type { TerminalScrollState } from "./hooks";
import type { AttachPayload } from "./hooks/useTerminalConnection.types";
import { useViewport } from "@/hooks/useViewport";
import { useFileDrop } from "@/hooks/useFileDrop";
import { uploadFileToTemp, partitionUploads } from "@/lib/file-upload";
import {
  formatPathsForAgent,
  formatTerminalTextForAgent,
} from "@/lib/path-display";
import { FilePicker } from "@/components/FilePicker";

export type { TerminalScrollState };

export interface TerminalHandle {
  sendCommand: (command: string) => void;
  sendInput: (data: string) => void;
  /** Inject text via xterm's bracketed paste (multi-line goes in as ONE paste,
   * not executed line-by-line). Does NOT submit — follow with sendInput("\r"). */
  paste: (text: string) => void;
  attachSession: (payload: AttachPayload) => void;
  focus: () => void;
  hasSelection: () => boolean;
  getScrollState: () => TerminalScrollState | null;
  restoreScrollState: (state: TerminalScrollState) => void;
  // Driven by the pane tab bar's terminal-action buttons (copy/paste/attach),
  // which live there instead of floating over the terminal.
  enterSelectMode: () => void;
  pasteFromClipboard: () => void;
  openFilePicker: () => void;
  /** Inject the current terminal selection into the agent's prompt as context
   * (bracketed paste, no Enter). Returns false if there's nothing selected. */
  attachSelectionToAgent: () => boolean;
}

interface TerminalProps {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onBeforeUnmount?: (scrollState: TerminalScrollState) => void;
  initialScrollState?: TerminalScrollState;
  /** Show the desktop image-picker (attach) button (default: true). */
  showImageButton?: boolean;
  /** Render the floating copy/paste/attach buttons in the terminal's corner.
   *  The main session pane sets this false and surfaces them in its tab bar
   *  instead; surfaces without a tab bar (shell drawer) keep them (default). */
  floatingActions?: boolean;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  function Terminal(
    {
      onConnected,
      onDisconnected,
      onBeforeUnmount,
      initialScrollState,
      showImageButton = true,
      floatingActions = true,
    },
    ref
  ) {
    const terminalRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const { isMobile } = useViewport();
    const { theme: currentTheme, resolvedTheme } = useTheme();
    const [showFilePicker, setShowFilePicker] = useState(false);
    const [selectMode, setSelectMode] = useState(false);
    const [isUploading, setIsUploading] = useState(false);

    // Use the full theme string (e.g., "dark-purple") for terminal theming
    const terminalTheme = useMemo(() => {
      // For system theme, use the resolved theme
      if (currentTheme === "system") {
        return resolvedTheme || "dark";
      }
      return currentTheme || "dark";
    }, [currentTheme, resolvedTheme]);

    const {
      connectionState,
      isAttaching,
      isAtBottom,
      xtermRef,
      searchAddonRef,
      scrollToBottom,
      copySelection,
      hasSelection,
      sendInput,
      sendCommand,
      attachSession,
      focus,
      paste,
      getScrollState,
      restoreScrollState,
      reconnect,
      sessionEnded,
      relaunch,
      autoRetry,
      cancelAutoRetry,
    } = useTerminalConnection({
      terminalRef,
      onConnected,
      onDisconnected,
      onBeforeUnmount,
      initialScrollState,
      isMobile,
      theme: terminalTheme,
      selectMode,
    });

    const {
      searchVisible,
      searchQuery,
      setSearchQuery,
      searchInputRef,
      closeSearch,
      findNext,
      findPrevious,
    } = useTerminalSearch(searchAddonRef, xtermRef);

    // Handle image selection - paste file path into terminal
    const handleImageSelect = useCallback(
      (filePath: string) => {
        sendInput(formatPathsForAgent(filePath));
        setShowFilePicker(false);
        focus();
      },
      [sendInput, focus]
    );

    // Handle a bulk attach - inject every uploaded path in ONE injection.
    const handleImagesSelect = useCallback(
      (filePaths: string[]) => {
        sendInput(formatPathsForAgent(filePaths));
        setShowFilePicker(false);
        focus();
      },
      [sendInput, focus]
    );

    // Handle file drop - upload and insert path(s) into terminal. A multi-file
    // drop uploads every file in parallel (allSettled) and injects the paths
    // that landed in one go.
    const handleFileDrop = useCallback(
      async (files: File[]) => {
        if (files.length === 0) return;
        setIsUploading(true);
        try {
          const settled = await Promise.allSettled(
            files.map((file) => uploadFileToTemp(file))
          );
          const { paths, failures } = partitionUploads(settled);
          if (failures > 0) {
            toast.error(
              failures === 1
                ? "1 file failed to upload"
                : `${failures} files failed to upload`
            );
          }
          if (paths.length > 0) {
            sendInput(formatPathsForAgent(paths));
            focus();
          }
        } catch (err) {
          console.error("Failed to upload files:", err);
          toast.error("Failed to upload files");
        } finally {
          setIsUploading(false);
        }
      },
      [sendInput, focus]
    );

    // Drag and drop for file uploads
    const { isDragging, dragHandlers } = useFileDrop(
      containerRef,
      handleFileDrop,
      { disabled: isUploading || showFilePicker }
    );

    // Paste the clipboard into the terminal through xterm so bracketed-paste
    // mode is honored (multi-line text goes in as one paste, not executed line
    // by line). Used by the desktop Paste button.
    const handlePasteFromClipboard = useCallback(async () => {
      try {
        const text = await navigator.clipboard?.readText?.();
        if (text) {
          paste(text);
          focus();
        }
      } catch {
        // Clipboard read blocked/unavailable — no-op (user can still ⌘V).
      }
    }, [paste, focus]);

    // Grab the current selection and inject it into the agent's prompt as
    // context — kills the copy-the-stack-trace-then-paste dance. In select mode
    // the selectable text is the overlay <pre> (a real DOM selection); outside
    // it the xterm canvas owns its own selection model. Try the DOM first, fall
    // back to xterm. Strip control chars (keystroke-injection guard) and go in
    // as ONE bracketed paste with NO trailing Enter, so the user can add their
    // question before submitting.
    const attachSelectionToAgent = useCallback(() => {
      // Pick the selection source by MODE — not "any page selection first", which
      // would inject a stray selection elsewhere on the page (sidebar, a drawer).
      // In select mode the text is the overlay <pre> (a real DOM selection);
      // outside it xterm owns its own selection model.
      const raw = selectMode
        ? (window.getSelection()?.toString() ?? "")
        : (xtermRef.current?.getSelection() ?? "");
      const text = formatTerminalTextForAgent(raw);
      if (!text) {
        toast.error("Select some terminal text first");
        return false;
      }
      setSelectMode(false);
      paste(text);
      focus();
      toast.success("Added to agent");
      return true;
    }, [selectMode, xtermRef, paste, focus]);

    // Expose imperative methods
    useImperativeHandle(ref, () => ({
      sendCommand,
      sendInput,
      paste,
      attachSession,
      focus,
      hasSelection,
      getScrollState,
      restoreScrollState,
      enterSelectMode: () => setSelectMode(true),
      pasteFromClipboard: handlePasteFromClipboard,
      openFilePicker: () => setShowFilePicker(true),
      attachSelectionToAgent,
    }));

    // Extract terminal text for select mode overlay
    const terminalText = useMemo(() => {
      if (!selectMode || !xtermRef.current) return "";

      const term = xtermRef.current;
      const buffer = term.buffer.active;
      const startRow = Math.max(0, buffer.baseY - 500);
      const endRow = buffer.baseY + term.rows;
      const lines: string[] = [];

      for (let i = startRow; i < endRow; i++) {
        const line = buffer.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }

      return lines.join("\n");
    }, [selectMode, xtermRef]);

    // Seconds left until a pending auto-retry fires — ticked once a second so the
    // "retrying in Ns" affordance counts down live. Derived from the absolute
    // retryAtMs so it stays correct even if a tick is dropped (e.g. backgrounded).
    const [retrySecondsLeft, setRetrySecondsLeft] = useState(0);
    useEffect(() => {
      if (!autoRetry) return;
      const tick = () =>
        setRetrySecondsLeft(
          Math.max(0, Math.ceil((autoRetry.retryAtMs - Date.now()) / 1000))
        );
      tick();
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    }, [autoRetry]);

    return (
      <div
        ref={containerRef}
        className="bg-background flex flex-col overflow-hidden"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
        }}
        {...dragHandlers}
      >
        {/* Search Bar */}
        <SearchBar
          ref={searchInputRef}
          visible={searchVisible}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onFindNext={findNext}
          onFindPrevious={findPrevious}
          onClose={closeSearch}
        />

        {/* Terminal container - NO padding! FitAddon reads offsetHeight which includes padding */}
        <div
          ref={terminalRef}
          className={cn(
            "terminal-container min-h-0 w-full flex-1 overflow-hidden",
            selectMode && "ring-primary ring-2 ring-inset",
            isDragging && "ring-primary ring-2 ring-inset"
          )}
          onClick={() => {
            // Don't re-focus when text is selected: the focus() fired by the
            // click that completes a drag-select was clearing the selection on
            // mouse-up (so it couldn't be copied). Plain clicks still focus.
            if (!xtermRef.current?.hasSelection()) focus();
          }}
          onTouchStart={selectMode ? (e) => e.stopPropagation() : undefined}
          onTouchEnd={selectMode ? (e) => e.stopPropagation() : undefined}
        />

        {/* Select mode overlay - shows terminal text in a selectable format */}
        {selectMode && (
          <div
            className="bg-background absolute inset-0 z-40 flex flex-col"
            onTouchStart={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
          >
            <div className="bg-primary text-primary-foreground flex items-center justify-between px-3 py-2 text-xs font-medium">
              <span>Select text, then Copy or Attach</span>
              <div className="flex items-center gap-2">
                <button
                  // preventDefault on mousedown so the click doesn't first
                  // collapse the text selection we're about to read.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={attachSelectionToAgent}
                  className="bg-primary-foreground/20 flex items-center gap-1 rounded px-2 py-0.5 text-xs"
                >
                  <MessageSquarePlus className="h-3 w-3" />
                  Add to agent
                </button>
                <button
                  onClick={() => {
                    const sel = window.getSelection()?.toString();
                    const text = sel && sel.length > 0 ? sel : terminalText;
                    if (text && navigator.clipboard?.writeText) {
                      navigator.clipboard.writeText(text).catch(() => {});
                    }
                    setSelectMode(false);
                  }}
                  className="bg-primary-foreground/20 rounded px-2 py-0.5 text-xs"
                >
                  Copy
                </button>
                <button
                  onClick={() => setSelectMode(false)}
                  className="bg-primary-foreground/20 rounded px-2 py-0.5 text-xs"
                >
                  Done
                </button>
              </div>
            </div>
            <pre
              className="flex-1 overflow-auto p-3 font-mono text-xs break-all whitespace-pre-wrap select-text"
              style={{
                userSelect: "text",
                WebkitUserSelect: "text",
              }}
            >
              {terminalText}
            </pre>
          </div>
        )}

        {/* Drag and drop overlay */}
        {isDragging && (
          <div className="bg-primary/10 pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
            <div className="border-primary bg-background/90 rounded-lg border px-6 py-4 text-center shadow-lg">
              <Upload className="text-primary mx-auto mb-2 h-8 w-8" />
              <p className="text-sm font-medium">Drop file to upload</p>
            </div>
          </div>
        )}

        {/* Upload in progress overlay */}
        {isUploading && (
          <div className="bg-background/50 pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
            <div className="bg-background rounded-lg border px-6 py-4 text-center shadow-lg">
              <Loader2 className="text-primary mx-auto mb-2 h-6 w-6 animate-spin" />
              <p className="text-sm">Uploading file...</p>
            </div>
          </div>
        )}

        {/* Desktop copy/paste/attach. The main session pane sets
            floatingActions={false} and renders these in its tab bar instead
            (they used to float here and cover the select-mode Copy/Done);
            surfaces without a tab bar (shell drawer) keep them. Hidden in select
            mode regardless. Mobile uses the bottom TerminalToolbar. */}
        {!isMobile && floatingActions && !selectMode && (
          <div className="absolute top-3 right-3 z-40 flex items-center gap-2">
            <button
              onClick={() => setSelectMode(true)}
              className="bg-secondary hover:bg-accent focus-visible:ring-ring flex h-9 w-9 items-center justify-center rounded-full shadow-lg transition-all outline-none focus-visible:ring-2"
              title="Select text to copy (TUIs grab the mouse; ⌥-drag also works)"
              aria-label="Select text to copy"
            >
              <Copy className="h-4 w-4" />
            </button>
            <button
              onClick={handlePasteFromClipboard}
              className="bg-secondary hover:bg-accent focus-visible:ring-ring flex h-9 w-9 items-center justify-center rounded-full shadow-lg transition-all outline-none focus-visible:ring-2"
              title="Paste from clipboard"
              aria-label="Paste from clipboard"
            >
              <ClipboardPaste className="h-4 w-4" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={attachSelectionToAgent}
              className="bg-secondary hover:bg-accent focus-visible:ring-ring flex h-9 w-9 items-center justify-center rounded-full shadow-lg transition-all outline-none focus-visible:ring-2"
              title="Add selected text to agent"
              aria-label="Add selected text to agent"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
            {showImageButton && (
              <button
                onClick={() => setShowFilePicker(true)}
                className="bg-secondary hover:bg-accent focus-visible:ring-ring flex h-9 w-9 items-center justify-center rounded-full shadow-lg transition-all outline-none focus-visible:ring-2"
                title="Attach file"
                aria-label="Attach file"
              >
                <Paperclip className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        {/* Image picker modal */}
        {showFilePicker && (
          <FilePicker
            initialPath="~"
            onSelect={handleImageSelect}
            onSelectMany={handleImagesSelect}
            onClose={() => setShowFilePicker(false)}
          />
        )}

        {/* Scroll to bottom button */}
        <ScrollToBottomButton visible={!isAtBottom} onClick={scrollToBottom} />

        {/* Mobile: Toolbar with special keys (native keyboard handles text) */}
        {isMobile && (
          <TerminalToolbar
            onKeyPress={sendInput}
            onFilePicker={() => setShowFilePicker(true)}
            onCopy={copySelection}
            onAttachSelection={attachSelectionToAgent}
            selectMode={selectMode}
            onSelectModeChange={setSelectMode}
            visible={true}
          />
        )}

        {/* Connection status overlays */}
        {connectionState === "connecting" && (
          <div className="bg-background absolute inset-0 z-20 flex flex-col items-center justify-center gap-3">
            <div className="bg-primary h-2 w-2 animate-pulse rounded-full" />
            <span className="text-muted-foreground text-sm">Connecting...</span>
          </div>
        )}

        {connectionState === "reconnecting" && (
          <div className="absolute top-4 left-4 flex items-center gap-2 rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-400">
            <div className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
            Reconnecting...
          </div>
        )}

        {/* Switching to another session: cover the blank reset until the
            incoming snapshot paints (cleared on first output / 2s fallback). */}
        {connectionState === "connected" && isAttaching && (
          <div className="bg-background pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-3">
            <div className="bg-primary h-2 w-2 animate-pulse rounded-full" />
            <span className="text-muted-foreground text-sm">Switching…</span>
          </div>
        )}

        {/* Session-ended bar — the agent process exited. A bottom bar (not a
            full overlay) keeps the final output readable; auto-reconnect won't
            silently respawn, so relaunch is explicit. When the exit was a
            TRANSIENT failure (rate-limit / network), an auto-retry is armed: show
            a live countdown + Cancel (the user override) in place of the plain
            Relaunch — the backoff timer fires the relaunch on its own. */}
        {sessionEnded && (
          <div className="border-border bg-background/95 absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-3 border-t px-3 py-2 backdrop-blur-sm">
            {autoRetry ? (
              <>
                <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Retrying in {retrySecondsLeft}s
                </span>
                <button
                  onClick={cancelAutoRetry}
                  className="bg-secondary hover:bg-accent focus-visible:ring-ring rounded-full px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="text-muted-foreground text-sm">
                  Session ended
                </span>
                <button
                  onClick={relaunch}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Relaunch
                </button>
              </>
            )}
          </div>
        )}

        {/* Disconnected overlay - shows tap to reconnect button */}
        {connectionState === "disconnected" && !sessionEnded && (
          <button
            onClick={reconnect}
            className="bg-background/80 active:bg-background/90 absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 backdrop-blur-sm transition-all"
          >
            <WifiOff className="text-muted-foreground h-8 w-8" />
            <span className="text-foreground text-sm font-medium">
              Connection lost
            </span>
            <span className="bg-primary text-primary-foreground rounded-full px-4 py-2 text-sm font-medium">
              Tap to reconnect
            </span>
          </button>
        )}
      </div>
    );
  }
);

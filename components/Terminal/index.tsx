"use client";

import {
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useState,
  useMemo,
} from "react";
import { useTheme } from "next-themes";
import "@xterm/xterm/css/xterm.css";
import {
  Paperclip,
  WifiOff,
  Upload,
  Loader2,
  RotateCcw,
  ClipboardPaste,
  Copy,
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
import { uploadFileToTemp } from "@/lib/file-upload";
import { FilePicker } from "@/components/FilePicker";

export type { TerminalScrollState };

export interface TerminalHandle {
  sendCommand: (command: string) => void;
  sendInput: (data: string) => void;
  attachSession: (payload: AttachPayload) => void;
  focus: () => void;
  hasSelection: () => boolean;
  getScrollState: () => TerminalScrollState | null;
  restoreScrollState: (state: TerminalScrollState) => void;
}

interface TerminalProps {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onBeforeUnmount?: (scrollState: TerminalScrollState) => void;
  initialScrollState?: TerminalScrollState;
  /** Show image picker button (default: true) */
  showImageButton?: boolean;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  function Terminal(
    {
      onConnected,
      onDisconnected,
      onBeforeUnmount,
      initialScrollState,
      showImageButton = true,
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
        sendInput(filePath);
        setShowFilePicker(false);
        focus();
      },
      [sendInput, focus]
    );

    // Handle file drop - upload and insert path into terminal
    const handleFileDrop = useCallback(
      async (file: File) => {
        setIsUploading(true);
        try {
          const path = await uploadFileToTemp(file);
          if (path) {
            sendInput(path);
            focus();
          }
        } catch (err) {
          console.error("Failed to upload file:", err);
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

    // Expose imperative methods
    useImperativeHandle(ref, () => ({
      sendCommand,
      sendInput,
      attachSession,
      focus,
      hasSelection,
      getScrollState,
      restoreScrollState,
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
              <span>Select text, then Copy</span>
              <div className="flex items-center gap-2">
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

        {/* Desktop terminal actions (top-right): select/copy text, paste, attach.
            Mobile uses the bottom TerminalToolbar instead. */}
        {!isMobile && (
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
            silently respawn, so relaunch is explicit. */}
        {sessionEnded && (
          <div className="border-border bg-background/95 absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-3 border-t px-3 py-2 backdrop-blur-sm">
            <span className="text-muted-foreground text-sm">Session ended</span>
            <button
              onClick={relaunch}
              className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Relaunch
            </button>
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

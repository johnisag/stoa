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
import {
  CommandBlockHeader,
  type CommandBlockHeaderState,
} from "./CommandBlockHeader";
import {
  parseTerminalBlocks,
  blockIndexForLine,
  nextBlockLine,
  truncateLabel,
  type TerminalBlock,
} from "@/lib/terminal-blocks";
import {
  useTerminalConnection,
  useTerminalGestures,
  useTerminalSearch,
} from "./hooks";
import type { TerminalScrollState } from "./hooks";
import type { AttachPayload } from "./hooks/useTerminalConnection.types";
import { useViewport } from "@/hooks/useViewport";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useFileDrop } from "@/hooks/useFileDrop";
import { uploadFileToTemp, partitionUploads } from "@/lib/file-upload";
import {
  formatPathsForAgent,
  formatTerminalTextForAgent,
} from "@/lib/path-display";
import { FilePicker } from "@/components/FilePicker";
import { fileOpenActions } from "@/stores/fileOpen";
import { resolveLinkTarget } from "@/lib/terminal-links";

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
  /** #53 Jump the viewport to the previous (-1) / next (+1) command block —
   *  prompt-boundary navigation over the rendered buffer. No-op if there's no
   *  block in that direction. */
  jumpBlock: (direction: -1 | 1) => void;
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
  /** Where the attach (📎) FilePicker opens. Pass the session's working
   *  directory so it lands in the project instead of HOME (the default). */
  filePickerInitialPath?: string;
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
      filePickerInitialPath,
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

    // #23 file:line links: the provider is registered at terminal creation, so
    // the handler reads everything through refs (latest isMobile / cwd / the
    // hook's own sendInput, which only exists after the hook call below).
    const isMobileRef = useRef(isMobile);
    isMobileRef.current = isMobile;
    const filePickerPathRef = useRef(filePickerInitialPath);
    filePickerPathRef.current = filePickerInitialPath;
    const sendInputRef = useRef<(data: string) => void>(() => {});
    const handleFileLink = useCallback(
      (path: string, line: number, matchedText: string) => {
        if (isMobileRef.current) {
          // No comfortable editor pane on mobile — insert the reference into
          // the agent prompt instead (same path the 📎 picker takes).
          sendInputRef.current(formatPathsForAgent(matchedText));
          return;
        }
        fileOpenActions.requestOpen(
          resolveLinkTarget(path, filePickerPathRef.current ?? ""),
          line
        );
      },
      []
    );

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
      triggerResize,
      reconnect,
      sessionEnded,
      attachError,
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
      onFileLink: handleFileLink,
    });
    sendInputRef.current = sendInput;

    const {
      searchVisible,
      searchQuery,
      setSearchQuery,
      searchInputRef,
      closeSearch,
      findNext,
      findPrevious,
    } = useTerminalSearch(searchAddonRef, xtermRef);

    // #29 mobile gestures: long-press-drag moves the cursor via arrow keys,
    // double-tap sends Tab, pinch adjusts the font size. Disabled in select
    // mode (its overlay owns touches) and on desktop; plain touch scrolling
    // still flows through touch-scroll.ts untouched.
    useTerminalGestures({
      terminalRef,
      xtermRef,
      enabled: isMobile && !selectMode,
      sendInput,
      triggerResize,
    });

    // #39 keep the screen awake while watching a live run — mobile screens
    // otherwise dim mid-agent. Feature-detected inside the hook (no Wake Lock
    // API = silent no-op); it releases on tab-hide and re-acquires on return.
    useWakeLock(connectionState === "connected");

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
    // by line). Handles images by uploading them to a temp path and injecting
    // the path string, then falls back to plain text. Used by both the desktop
    // floating Paste button and the mobile TerminalToolbar paste button.
    const handlePasteFromClipboard = useCallback(async () => {
      try {
        if (navigator.clipboard?.read) {
          const items = await navigator.clipboard.read();
          // Collect image blobs from all clipboard items
          const imageFiles: File[] = [];
          for (const item of items) {
            for (const type of [
              "image/png",
              "image/jpeg",
              "image/gif",
              "image/webp",
            ]) {
              if (item.types.includes(type)) {
                const blob = await item.getType(type);
                const ext = type.split("/")[1];
                imageFiles.push(new File([blob], `clipboard.${ext}`, { type }));
                break;
              }
            }
          }
          if (imageFiles.length > 0) {
            setIsUploading(true);
            try {
              const settled = await Promise.allSettled(
                imageFiles.map((file) => uploadFileToTemp(file))
              );
              const { paths, failures } = partitionUploads(settled);
              if (failures > 0) {
                toast.error(
                  failures === 1
                    ? "1 image failed to upload"
                    : `${failures} images failed to upload`
                );
              }
              if (paths.length > 0) {
                sendInput(formatPathsForAgent(paths));
                focus();
              }
            } finally {
              setIsUploading(false);
            }
            return;
          }
          // No images — check for plain text
          for (const item of items) {
            if (item.types.includes("text/plain")) {
              const blob = await item.getType("text/plain");
              const text = await blob.text();
              if (text) {
                paste(text);
                focus();
              }
              return;
            }
          }
          return;
        }
        // Fallback: clipboard.read() unavailable, try readText()
        const text = await navigator.clipboard?.readText?.();
        if (text) {
          paste(text);
          focus();
        }
      } catch {
        // Clipboard read blocked/unavailable — no-op (user can still ⌘V).
      }
    }, [paste, focus, sendInput, setIsUploading]);

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
        // Outside select mode, xterm has no selection when a full-screen TUI is
        // capturing the mouse (it forwards drags to the app) — point the user at
        // select mode, which reads the rendered buffer instead.
        toast.error(
          selectMode
            ? "Select some terminal text first"
            : "No selection — use the select-text button to copy from a full-screen app"
        );
        return false;
      }
      setSelectMode(false);
      paste(text);
      focus();
      toast.success("Added to agent");
      return true;
    }, [selectMode, xtermRef, paste, focus]);

    // #53 Command-block navigation. State drives the sticky header; only shown
    // after the first jump so a fresh terminal isn't cluttered. The parse itself
    // is the pure lib/terminal-blocks — this host only bridges the xterm buffer.
    const [commandBlock, setCommandBlock] =
      useState<CommandBlockHeaderState | null>(null);
    const [blockNavActive, setBlockNavActive] = useState(false);

    // Read the FULL rendered buffer (scrollback + screen) as an array of lines,
    // then parse it into command blocks. Same buffer traversal select mode uses.
    const readBlocks = useCallback((): {
      blocks: TerminalBlock[];
      viewportY: number;
    } | null => {
      const term = xtermRef.current;
      if (!term) return null;
      const buffer = term.buffer.active;
      const endRow = buffer.baseY + term.rows;
      const lines: string[] = [];
      for (let i = 0; i < endRow; i++) {
        const line = buffer.getLine(i);
        lines.push(line ? line.translateToString(true) : "");
      }
      return {
        blocks: parseTerminalBlocks(lines),
        viewportY: buffer.viewportY,
      };
    }, [xtermRef]);

    // Recompute the header for whatever block the top of the viewport sits in.
    const refreshBlockHeader = useCallback(() => {
      const read = readBlocks();
      if (!read || read.blocks.length === 0) {
        setCommandBlock(null);
        return;
      }
      const idx = blockIndexForLine(read.blocks, read.viewportY);
      const block = read.blocks[idx];
      setCommandBlock({
        index: idx + 1,
        total: read.blocks.length,
        label: truncateLabel(block.label),
        kind: block.kind,
      });
    }, [readBlocks]);

    const jumpBlock = useCallback(
      (direction: -1 | 1) => {
        const term = xtermRef.current;
        const read = readBlocks();
        if (!term || !read || read.blocks.length === 0) return;
        setBlockNavActive(true);
        const target = nextBlockLine(read.blocks, read.viewportY, direction);
        if (target !== null) term.scrollToLine(target);
        // Recompute against the post-scroll viewport (scrollToLine is synchronous).
        refreshBlockHeader();
      },
      [xtermRef, readBlocks, refreshBlockHeader]
    );

    // Keep the header in sync as the user scrolls by hand (only once nav is
    // active, so we don't pay the parse on every scroll of an untouched pane).
    useEffect(() => {
      const term = xtermRef.current;
      if (!term || !blockNavActive) return;
      const disposable = term.onScroll(() => refreshBlockHeader());
      return () => disposable.dispose();
    }, [xtermRef, blockNavActive, refreshBlockHeader]);

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
      jumpBlock,
    }));

    // Extract terminal text for select mode overlay
    const terminalText = useMemo(() => {
      if (!selectMode || !xtermRef.current) return "";

      const term = xtermRef.current;
      const buffer = term.buffer.active;
      // Include the FULL scrollback (not just the last 500 lines) so a user can
      // select/copy older output — select mode is an explicit, on-demand action.
      const startRow = 0;
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

        {/* #53 Sticky command-block header — hidden in select mode (its overlay
            owns the surface) and until the first block jump. */}
        <CommandBlockHeader
          state={commandBlock}
          visible={blockNavActive && !selectMode}
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
            initialPath={filePickerInitialPath || "~"}
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
            onPaste={paste}
            onFilePicker={() => setShowFilePicker(true)}
            onCopy={copySelection}
            onAttachSelection={attachSelectionToAgent}
            selectMode={selectMode}
            onSelectModeChange={setSelectMode}
            visible={true}
            onPasteFromClipboard={handlePasteFromClipboard}
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

        {/* Session-ended bar — the agent process exited, OR an attach/spawn
            failed (attachError, shown in place of "Session ended"). A bottom bar
            (not a full overlay) keeps the final output readable; auto-reconnect
            won't silently respawn, so relaunch is explicit. When the exit was a
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
                <span
                  className={cn(
                    "text-sm",
                    attachError ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {attachError ?? "Session ended"}
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

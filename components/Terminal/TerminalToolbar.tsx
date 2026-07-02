"use client";

import { useCallback, useState } from "react";
import {
  Clipboard,
  X,
  Send,
  Mic,
  MicOff,
  Paperclip,
  FileText,
  MousePointer2,
  Copy,
  FileCode,
  MessageSquarePlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toMarkdownBlock } from "@/lib/markdown-block";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { SnippetsModal } from "./SnippetsModal";

// ANSI escape sequences
const SPECIAL_KEYS = {
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  LEFT: "\x1b[D",
  RIGHT: "\x1b[C",
  ESC: "\x1b",
  TAB: "\t",
  CTRL_C: "\x03",
  CTRL_D: "\x04",
  CTRL_Z: "\x1a",
  CTRL_L: "\x0c",
} as const;

interface TerminalToolbarProps {
  onKeyPress: (key: string) => void;
  onFilePicker?: () => void;
  onCopy?: () => boolean; // Returns true if selection was copied
  onAttachSelection?: () => boolean; // Inject the selection into the agent's prompt
  selectMode?: boolean;
  onSelectModeChange?: (enabled: boolean) => void;
  visible?: boolean;
  onPasteFromClipboard?: () => Promise<void>;
}

// Paste modal for when clipboard API isn't available
function PasteModal({
  open,
  onClose,
  onPaste,
}: {
  open: boolean;
  onClose: () => void;
  onPaste: (text: string) => void;
}) {
  const [text, setText] = useState("");

  const handleSend = () => {
    if (text) {
      onPaste(text);
      setText("");
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-background w-[90%] max-w-md rounded-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">Paste text</span>
          <button onClick={onClose} className="hover:bg-muted rounded-md p-1">
            <X className="h-5 w-5" />
          </button>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData?.getData("text");
            if (pasted) {
              e.preventDefault();
              setText((prev) => prev + pasted);
            }
          }}
          placeholder="Tap here, then long-press to paste..."
          autoFocus
          className="bg-muted focus:ring-primary h-24 w-full resize-none rounded-lg px-3 py-2 text-sm focus:ring-2 focus:outline-none"
        />
        <button
          onClick={handleSend}
          disabled={!text}
          className="bg-primary text-primary-foreground mt-3 flex w-full items-center justify-center gap-2 rounded-lg py-2.5 font-medium disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          Send to Terminal
        </button>
      </div>
    </div>
  );
}

export function TerminalToolbar({
  onKeyPress,
  onFilePicker,
  onCopy,
  onAttachSelection,
  selectMode = false,
  onSelectModeChange,
  visible = true,
  onPasteFromClipboard,
}: TerminalToolbarProps) {
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [showSnippetsModal, setShowSnippetsModal] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [markdownFeedback, setMarkdownFeedback] = useState(false);

  // Send text character-by-character to terminal
  const sendText = useCallback(
    (text: string) => {
      for (const char of text) {
        onKeyPress(char);
      }
    },
    [onKeyPress]
  );

  const {
    isListening,
    isSupported: isMicSupported,
    toggle: toggleMic,
  } = useSpeechRecognition(sendText);

  // Handle paste - try clipboard API first, fall back to modal
  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText?.();
      if (text) {
        sendText(text);
        return;
      }
    } catch {
      // Clipboard API failed or unavailable
    }
    setShowPasteModal(true);
  }, [sendText]);

  // Handle copy with visual feedback
  const handleCopy = useCallback(() => {
    if (onCopy?.()) {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1000);
    }
  }, [onCopy]);

  // Copy the selection as a fenced Markdown code block (ANSI/control bytes
  // stripped), ready to paste into an issue / notes / channel. Reads the DOM
  // selection directly: this action only renders in select mode, where the
  // selectable text is the overlay <pre> — a real DOM selection, the same
  // source the parent's select-mode Copy/Attach actions read. An empty
  // selection is a silent no-op (matches handleCopy's no-feedback behavior).
  const handleCopyMarkdown = useCallback(() => {
    const markdown = toMarkdownBlock(window.getSelection()?.toString() ?? "");
    if (!markdown || !navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(markdown).catch(() => {});
    setMarkdownFeedback(true);
    setTimeout(() => setMarkdownFeedback(false), 1000);
  }, []);

  if (!visible) return null;

  const buttons = [
    { label: "Esc", key: SPECIAL_KEYS.ESC },
    { label: "^C", key: SPECIAL_KEYS.CTRL_C, highlight: true },
    { label: "Tab", key: SPECIAL_KEYS.TAB },
    { label: "^D", key: SPECIAL_KEYS.CTRL_D },
    { label: "←", key: SPECIAL_KEYS.LEFT },
    { label: "→", key: SPECIAL_KEYS.RIGHT },
    { label: "↑", key: SPECIAL_KEYS.UP },
    { label: "↓", key: SPECIAL_KEYS.DOWN },
  ];

  return (
    <>
      <PasteModal
        open={showPasteModal}
        onClose={() => setShowPasteModal(false)}
        onPaste={sendText}
      />
      <SnippetsModal
        open={showSnippetsModal}
        onClose={() => setShowSnippetsModal(false)}
        onInsert={sendText}
      />
      <div
        className="bg-background/95 border-border scrollbar-none flex items-center gap-1 overflow-x-auto border-t px-2 py-1.5 backdrop-blur"
        onTouchEnd={(e) => e.stopPropagation()}
      >
        {/* Mic button */}
        {isMicSupported && (
          <button
            type="button"
            title={isListening ? "Stop dictation" : "Dictate to terminal"}
            aria-label={isListening ? "Stop dictation" : "Dictate to terminal"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleMic();
            }}
            className={cn(
              "flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium",
              isListening
                ? "animate-pulse bg-red-500 text-white"
                : "bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground"
            )}
          >
            {isListening ? (
              <MicOff className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </button>
        )}

        {/* Paste button */}
        <button
          type="button"
          title="Paste from clipboard"
          aria-label="Paste from clipboard"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            if (onPasteFromClipboard) {
              void onPasteFromClipboard();
            } else {
              void handlePaste();
            }
          }}
          className="bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium"
        >
          <Clipboard className="h-4 w-4" />
        </button>

        {/* Select mode toggle */}
        {onSelectModeChange && (
          <button
            type="button"
            title="Select text"
            aria-label="Select text"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onSelectModeChange(!selectMode);
            }}
            className={cn(
              "flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium",
              selectMode
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground"
            )}
          >
            <MousePointer2 className="h-4 w-4" />
          </button>
        )}

        {/* Copy button - shown when in select mode */}
        {selectMode && onCopy && (
          <button
            type="button"
            title="Copy selection"
            aria-label="Copy selection"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              handleCopy();
            }}
            className={cn(
              "flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium",
              copyFeedback
                ? "bg-green-500 text-white"
                : "bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground"
            )}
          >
            <Copy className="h-4 w-4" />
          </button>
        )}

        {/* Copy-as-Markdown button - shown next to Copy in select mode. Wraps
            the selection in a fenced code block ready to paste into an
            issue/Notes/channel. */}
        {selectMode && onCopy && (
          <button
            type="button"
            title="Copy selection as Markdown"
            aria-label="Copy selection as Markdown"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              handleCopyMarkdown();
            }}
            className={cn(
              "flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium",
              markdownFeedback
                ? "bg-green-500 text-white"
                : "bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground"
            )}
          >
            <FileCode className="h-4 w-4" />
          </button>
        )}

        {/* Attach-to-agent button - shown when in select mode. Injects the
            selected text into the active agent's prompt (toast comes from the
            handler in the parent Terminal). */}
        {selectMode && onAttachSelection && (
          <button
            type="button"
            title="Attach selection to running agent"
            aria-label="Attach selection to running agent"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onAttachSelection();
            }}
            className="bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        )}

        {/* File picker button */}
        {onFilePicker && (
          <button
            type="button"
            title="Attach file"
            aria-label="Attach file"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onFilePicker();
            }}
            className="bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium"
          >
            <Paperclip className="h-4 w-4" />
          </button>
        )}

        {/* Snippets button */}
        <button
          type="button"
          title="Insert snippet"
          aria-label="Insert snippet"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            setShowSnippetsModal(true);
          }}
          className="bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium"
        >
          <FileText className="h-4 w-4" />
        </button>

        {/* Divider */}
        <div className="bg-border mx-1 h-6 w-px" />

        {/* Shift toggle — tap first, then ↵ to send a newline (Shift+Enter) */}
        <button
          type="button"
          title="Shift+Enter for newline — tap ⇧ then ↵"
          aria-label="Shift modifier — tap then press Enter to send a newline"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            setShiftActive(!shiftActive);
          }}
          className={cn(
            "flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium",
            shiftActive
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground"
          )}
        >
          ⇧
        </button>

        {/* Enter key - sends \n if shift active, \r otherwise */}
        <button
          type="button"
          title={shiftActive ? "Send newline (Shift+Enter)" : "Send Enter"}
          aria-label={shiftActive ? "Send newline (Shift+Enter)" : "Send Enter"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onKeyPress(shiftActive ? "\n" : "\r");
            setShiftActive(false);
          }}
          className="bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium"
        >
          ↵
        </button>

        {/* Special keys */}
        {buttons.map((btn) => (
          <button
            type="button"
            key={btn.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onKeyPress(btn.key);
            }}
            className={cn(
              "flex-shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium",
              "active:bg-primary active:text-primary-foreground",
              btn.highlight
                ? "bg-red-500/20 text-red-500"
                : "bg-secondary text-secondary-foreground"
            )}
          >
            {btn.label}
          </button>
        ))}
      </div>
    </>
  );
}

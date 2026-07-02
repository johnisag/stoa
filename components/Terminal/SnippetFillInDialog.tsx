"use client";

import { useMemo, useState, useEffect } from "react";
import { X, Send } from "lucide-react";
import {
  extractPlaceholders,
  substitutePlaceholders,
  buildPlaceholderValues,
} from "@/lib/snippets";
import { formatTerminalTextForAgent } from "@/lib/path-display";

// Fill-in dialog for snippet template variables (roadmap #33). Presentational
// shell over the pure core in lib/snippets.ts: one input per distinct
// {{placeholder}} (in order of appearance); Insert substitutes the typed
// values and hands the result to `onInsert` ALREADY SANITIZED through
// formatTerminalTextForAgent — the same control-char-safe path every snippet
// insert takes (the values are user-typed free text). A blank input keeps its
// token verbatim (never silently drop text). Callers own closing themselves
// after onInsert; Cancel/backdrop/Escape fire onClose only.
export function SnippetFillInDialog({
  body,
  snippetName,
  onInsert,
  onClose,
}: {
  body: string;
  snippetName?: string;
  onInsert: (sanitized: string) => void;
  onClose: () => void;
}) {
  const placeholders = useMemo(() => extractPlaceholders(body), [body]);
  const [inputs, setInputs] = useState<string[]>(() =>
    placeholders.map(() => "")
  );

  const handleInsert = () => {
    const substituted = substitutePlaceholders(
      body,
      buildPlaceholderValues(placeholders, inputs)
    );
    onInsert(formatTerminalTextForAgent(substituted));
  };

  // Escape closes (parity with the other modals). preventDefault so no
  // browser default stacks on top of the close. Window keydown listeners fire
  // in REGISTRATION order, so when the snippets modal is the parent it sees
  // the event too — it skips its own close while this dialog is open (its
  // `fillIn` guard). When the chip bar is the parent there is no other Escape
  // handler at all, and xterm never sees the key either way: it reads from
  // its own textarea, and focus is inside this dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      // Above the snippets modal (z-50): the dialog can be opened from it.
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center"
      onClick={onClose}
    >
      <div
        className="bg-background flex max-h-[70vh] w-full flex-col rounded-t-xl sm:max-w-md sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-border flex items-center justify-between border-b px-4 py-3">
          <span className="truncate text-sm font-medium">
            {snippetName ? `Fill in "${snippetName}"` : "Fill in snippet"}
          </span>
          <button onClick={onClose} className="hover:bg-muted rounded-md p-1.5">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* A form so Enter in any input inserts (matters with a hardware
            keyboard — this dialog also serves the desktop snippets modal). */}
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            handleInsert();
          }}
        >
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <div className="text-muted-foreground mb-3 truncate font-mono text-xs">
              {body}
            </div>
            {placeholders.map((name, i) => (
              <label key={name} className="mb-3 block">
                <span className="text-muted-foreground mb-1 block font-mono text-xs">
                  {`{{${name}}}`}
                </span>
                <input
                  type="text"
                  value={inputs[i] ?? ""}
                  autoFocus={i === 0}
                  onChange={(e) =>
                    setInputs((prev) => {
                      const next = [...prev];
                      next[i] = e.target.value;
                      return next;
                    })
                  }
                  placeholder={`Leave blank to keep {{${name}}}`}
                  className="bg-muted focus:ring-primary w-full rounded-lg px-3 py-2 font-mono text-sm focus:ring-2 focus:outline-none"
                />
              </label>
            ))}
          </div>

          <div className="border-border border-t px-4 py-3">
            <button
              type="submit"
              className="bg-primary text-primary-foreground flex w-full items-center justify-center gap-2 rounded-lg py-2.5 font-medium"
            >
              <Send className="h-4 w-4" />
              Insert
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

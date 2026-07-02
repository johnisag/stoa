"use client";

import { useState, useEffect } from "react";
import {
  type Snippet,
  extractPlaceholders,
  SNIPPETS_CHANGED_EVENT,
} from "@/lib/snippets";
import { formatTerminalTextForAgent } from "@/lib/path-display";
import { getVisibleSnippets } from "./SnippetsModal";
import { SnippetFillInDialog } from "./SnippetFillInDialog";

// One-tap snippet chips above the mobile toolbar (roadmap #33). A horizontally
// scrollable row of the user's saved snippets, ordered as stored; tapping a
// chip runs the SAME insert flow as the snippets modal — direct insert for a
// plain body, the fill-in dialog when the body has {{placeholders}} — and
// every path sanitizes through formatTerminalTextForAgent before touching the
// pty. Renders nothing when no snippets exist; desktop never mounts it (the
// parent toolbar is mobile-only via the existing isMobile plumbing).
// Design intent: the bar trades one row of mobile screen space for one-tap
// snippet discoverability (vs. burying them behind the modal); it costs
// nothing when the user has no snippets. Revisit with a collapse affordance
// only if real usage complains.
export function SnippetChipBar({
  onInsert,
}: {
  onInsert: (text: string) => void;
}) {
  const [snippets, setSnippets] = useState<Snippet[]>(() =>
    typeof window === "undefined" ? [] : getVisibleSnippets()
  );
  // Snippet whose {{placeholders}} are being filled in before insert.
  const [fillIn, setFillIn] = useState<Snippet | null>(null);

  // Stay in sync with the snippets modal (add / delete / undo) — it emits
  // SNIPPETS_CHANGED_EVENT on every visible-list change, same tab.
  useEffect(() => {
    const refresh = () => setSnippets(getVisibleSnippets());
    window.addEventListener(SNIPPETS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(SNIPPETS_CHANGED_EVENT, refresh);
  }, []);

  const handleTap = (snippet: Snippet) => {
    if (extractPlaceholders(snippet.content).length > 0) {
      setFillIn(snippet);
      return;
    }
    // Same sanitization as SnippetsModal.handleInsert — control-char safety
    // is non-negotiable on every insert surface.
    onInsert(formatTerminalTextForAgent(snippet.content));
  };

  // Keep the fill-in dialog alive even if the last snippet vanishes mid-fill.
  if (snippets.length === 0 && !fillIn) return null;

  return (
    <>
      {fillIn && (
        <SnippetFillInDialog
          key={fillIn.id}
          body={fillIn.content}
          snippetName={fillIn.name}
          onInsert={(text) => {
            // Already sanitized by the dialog (formatTerminalTextForAgent).
            onInsert(text);
            setFillIn(null);
          }}
          onClose={() => setFillIn(null)}
        />
      )}
      {/* If the list empties while a fill-in is alive (a delete on another
          surface), only the dialog survives — no empty bordered strip. */}
      {snippets.length > 0 && (
        <div
          className="bg-background/95 border-border scrollbar-none flex items-center gap-1.5 overflow-x-auto border-t px-2 py-1.5 backdrop-blur"
          onTouchEnd={(e) => e.stopPropagation()}
        >
          {snippets.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              title={snippet.content}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                handleTap(snippet);
              }}
              className="bg-secondary text-secondary-foreground active:bg-primary active:text-primary-foreground max-w-[10rem] flex-shrink-0 truncate rounded-full px-3 py-1.5 text-xs font-medium"
            >
              {snippet.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

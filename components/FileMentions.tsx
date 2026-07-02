"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode, RefObject, KeyboardEvent } from "react";
import { FileText } from "lucide-react";
import { useRecursiveFilesQuery } from "@/data/files/queries";
import {
  detectMention,
  mentionCandidatesFromTree,
  filterMentionFiles,
  applyMention,
  type MentionState,
} from "@/lib/mention-files";
import { cn } from "@/lib/utils";

/**
 * @-mention file autocomplete for a compose/queue textarea (#24). Typing `@`
 * opens an inline dropdown over the session cwd's file tree (the picker's
 * bounded recursive listing, fetched only while a mention is active); ↑/↓
 * navigate, Enter/Tab insert the RELATIVE path, Escape dismisses. The pure
 * detection/rank/replace logic lives in lib/mention-files.ts.
 *
 * Returned pieces: spread `onKeyDown` onto the textarea (call it BEFORE any
 * of your own key handling — it claims keys only while the dropdown is open)
 * and render `dropdown` inside a `relative` wrapper around the textarea.
 */
export function useFileMentions({
  text,
  setText,
  taRef,
  workingDirectory,
  placement = "above",
}: {
  text: string;
  setText: (value: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  /** The session cwd the file index is rooted at; undefined disables mentions. */
  workingDirectory?: string;
  /** Where the dropdown anchors relative to its wrapper: "above" (a bottom
   *  input row) or "inside-top" (a full-body composer, whose wrapper clips
   *  overflow). */
  placement?: "above" | "inside-top";
}): {
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  dropdown: ReactNode;
} {
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // One-shot suppression after Escape: the mention state re-derives from the
  // text, so without this the dropdown would reopen on the next keystroke of
  // the SAME token the user just dismissed.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  // Re-derive the active mention whenever the text changes. The caret is read
  // from the textarea AFTER the change landed (onChange fires post-mutation).
  // Gated on the textarea being FOCUSED: a programmatic setText (history
  // reuse) fires this with a stale caret while focus is still elsewhere — a
  // stale @ in the reused text must not pop the dropdown.
  useEffect(() => {
    if (!workingDirectory) return;
    const el = taRef.current;
    if (!el || document.activeElement !== el) {
      setMention(null);
      return;
    }
    const caret = el.selectionStart ?? text.length;
    const m = detectMention(text, caret);
    setMention(m && dismissedAt === m.start ? null : m);
    if (m && dismissedAt !== null && dismissedAt !== m.start) {
      setDismissedAt(null); // a different token → re-arm
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, workingDirectory]);

  // The bounded recursive index (depth 4, same as the file picker's fuzzy
  // search) — fetched only while a mention is actually open.
  const { data } = useRecursiveFilesQuery(
    workingDirectory ?? "",
    !!mention && !!workingDirectory
  );

  const candidates = useMemo(
    () =>
      data
        ? mentionCandidatesFromTree(
            data.files,
            data.resolvedPath || workingDirectory || ""
          )
        : [],
    [data, workingDirectory]
  );

  // Dropdown only opens once the user has TYPED something after the @ (a bare
  // @ still warms the index fetch above, so results feel instant by the first
  // character) — an unfiltered first-8 listing is noise, not help.
  const results = useMemo(
    () =>
      mention && mention.query.length > 0
        ? filterMentionFiles(candidates, mention.query)
        : [],
    [candidates, mention]
  );

  // Re-clamp the selection whenever the visible results change (a late index
  // fetch or a query edit must not leave Enter pointing at a shifted entry).
  useEffect(() => {
    setActiveIndex(0);
  }, [results]);

  const pick = useCallback(
    (rel: string) => {
      const el = taRef.current;
      if (!el) return;
      const caret = el.selectionStart ?? text.length;
      // Re-derive the mention at PICK time: the caret can move without a text
      // change (mouse click, Home/End) and the effect-held state would then
      // splice the wrong range.
      const m = detectMention(text, caret);
      if (!m) {
        setMention(null);
        return;
      }
      const applied = applyMention(text, m, caret, rel);
      setText(applied.next);
      setMention(null);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(applied.caret, applied.caret);
      });
    },
    [taRef, text, setText]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!mention || results.length === 0) {
        // Escape with an open-but-empty dropdown still just dismisses it.
        if (mention && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setDismissedAt(mention.start);
          setMention(null);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % results.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + results.length) % results.length);
      } else if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        // Horizontal caret movement leaves the token — dismiss (no
        // preventDefault: the caret still moves). Typing re-detects.
        setMention(null);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(results[Math.min(activeIndex, results.length - 1)].rel);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Keep the modal's window-level Escape handler from ALSO firing (it
        // would close the whole composer instead of just this dropdown).
        e.stopPropagation();
        setDismissedAt(mention.start);
        setMention(null);
      }
    },
    [mention, results, activeIndex, pick]
  );

  const dropdown: ReactNode =
    mention && results.length > 0 ? (
      <div
        className={cn(
          "border-border bg-background absolute z-20 max-h-56 overflow-auto rounded-md border shadow-lg",
          placement === "above"
            ? "inset-x-0 bottom-full mb-1"
            : "top-3 right-3 left-3"
        )}
      >
        <ul className="p-1">
          {results.map((r, i) => (
            <li key={r.rel}>
              <button
                type="button"
                // Fires before the textarea's blur — a click must not lose
                // the mention state mid-pick.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r.rel);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                  i === activeIndex ? "bg-muted" : "hover:bg-muted/60"
                )}
              >
                <FileText className="text-muted-foreground h-3.5 w-3.5 flex-shrink-0" />
                <span className="flex-shrink-0">{r.name}</span>
                {r.rel !== r.name && (
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    {r.rel}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return { onKeyDown, dropdown };
}

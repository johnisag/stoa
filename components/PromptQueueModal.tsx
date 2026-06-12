"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  ListPlus,
  Trash2,
  Loader2,
  Plus,
  Send,
  PenLine,
  ChevronUp,
  ChevronDown,
  History,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useSessionQueue,
  useEnqueuePrompt,
  useQueueItemAction,
  useClearQueue,
} from "@/hooks/useSessionQueue";
import { isSendable, normalizeForSend } from "@/lib/prompt-compose";
import { getHistory, recordPrompt, searchHistory } from "@/lib/prompt-history";

/**
 * Queue follow-up prompts to a session while it works (`mode="queue"`, the
 * default): the server dispatches them one at a time as the agent goes idle, so
 * you can line up the next tasks (from your phone) without interrupting the
 * current turn.
 *
 * In `mode="compose"` the same shell becomes a roomy full-screen composer that
 * sends straight to the active terminal on submit (via `onSend`) — great for
 * long/structured prompts on mobile. The queue is untouched in this mode.
 *
 * Both modes auto-focus the textarea on open and close on Escape.
 */
export function PromptQueueModal({
  sessionId,
  name,
  mode = "queue",
  onSend,
  onClose,
}: {
  sessionId: string;
  name: string;
  /** "queue" enqueues for idle dispatch; "compose" sends now via `onSend`. */
  mode?: "queue" | "compose";
  /** Required in compose mode — receives the normalized prompt on submit. */
  onSend?: (text: string) => void;
  onClose: () => void;
}) {
  const compose = mode === "compose";
  // The queue list only matters when queueing; skip the poll in compose mode.
  const { data: queue, isLoading } = useSessionQueue(sessionId, !compose);
  const enqueue = useEnqueuePrompt(sessionId);
  const itemAction = useQueueItemAction(sessionId);
  const clear = useClearQueue(sessionId);
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Recent prompts sent to THIS session (localStorage-backed, newest-first), and
  // whether the history picker is open. Loaded after mount — localStorage doesn't
  // exist on the server.
  const [history, setHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const items = queue ?? [];

  // Auto-focus the textarea on open so you can start typing immediately. Mount
  // only — re-focusing on later renders would fight the user's cursor.
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // Hydrate the prompt history from localStorage once mounted (keyed by session).
  useEffect(() => {
    setHistory(getHistory(window.localStorage, sessionId));
  }, [sessionId]);

  // Record a prompt into this session's history and reflect it in local state.
  const remember = (t: string) => {
    setHistory(recordPrompt(window.localStorage, sessionId, t));
  };

  // Escape dismisses (mobile keyboards have no obvious close). The history picker
  // is a sub-layer, so Escape closes it first and only then the whole modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showHistory) setShowHistory(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, showHistory]);

  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  };

  const add = () => {
    const t = normalizeForSend(text);
    if (!t) return;
    enqueue.mutate(t);
    remember(t);
    setText("");
    requestAnimationFrame(grow); // shrink back after clearing
  };

  // Compose mode: send straight to the active terminal, then close.
  const send = () => {
    const t = normalizeForSend(text);
    if (!t) return;
    remember(t);
    onSend?.(t);
    onClose();
  };

  // Drop a past prompt back into the input and return focus there to edit/send.
  const reuse = (prompt: string) => {
    setText(prompt);
    setShowHistory(false);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(prompt.length, prompt.length);
      grow();
    });
  };

  return (
    <div
      // Pin to the top and size to --app-height (the VISUAL viewport, tracked
      // app-wide by useViewportHeight in page.tsx) rather than a full-100vh
      // `inset-0`. On mobile this shrinks the overlay above the on-screen
      // keyboard so the footer (Send/Add) stays reachable instead of being
      // pushed under it. Falls back to 100vh where --app-height is unset.
      className="bg-background h-app max-h-app fixed inset-x-0 top-0 z-50 flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-border bg-background/95 flex items-center gap-2 border-b p-3 backdrop-blur-sm">
        {compose ? (
          <PenLine className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        ) : (
          <ListPlus className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">
            {compose ? "Compose" : "Queue"} · {name}
          </h3>
          <p className="text-muted-foreground text-xs">
            {compose
              ? "Sends straight to the agent on submit"
              : items.length === 0
                ? "Runs when the agent next goes idle"
                : `${items.length} queued · dispatched one at a time on idle`}
          </p>
        </div>
        {!compose && items.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => clear.mutate()}
            disabled={clear.isPending}
            className="h-9"
          >
            <Trash2 className="mr-1 h-4 w-4" />
            Clear
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="h-9 w-9"
          aria-label={compose ? "Close composer" : "Close queue"}
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      {compose ? (
        // Roomy composer — the textarea fills the body so long, structured
        // prompts are comfortable to write on a phone. `min-h-0 flex-1` lets
        // this region shrink (the overlay tracks the visual viewport above the
        // keyboard) so the pinned Send footer always stays on-screen; the
        // textarea scrolls internally rather than pushing the footer down.
        <div className="min-h-0 flex-1 overflow-hidden p-3">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write a prompt to send now… (multi-line OK)"
            className="border-input bg-background focus-visible:ring-ring/60 h-full w-full resize-none overflow-auto rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {isLoading ? (
            <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="text-muted-foreground mx-auto max-w-sm py-10 text-center text-sm">
              No queued tasks. Add a prompt below and it runs as soon as the
              agent finishes its current turn.
            </div>
          ) : (
            <ol className="space-y-1">
              {items.map((item, i) => (
                <li
                  key={`${i}-${item.slice(0, 24)}`}
                  className="bg-muted/40 flex items-start gap-2 rounded-md px-2 py-2 sm:gap-3 sm:px-3"
                >
                  <span className="text-muted-foreground mt-1 w-5 flex-shrink-0 text-xs tabular-nums">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 self-center text-sm break-words whitespace-pre-wrap">
                    {item}
                  </span>
                  {/* Per-item reorder + remove. Bounds-disabled (first can't go up,
                      last can't go down); a single mutation in flight disables all
                      to avoid racing concurrent reorders against the shared queue. */}
                  <div className="flex flex-shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        itemAction.mutate({
                          action: "up",
                          index: i,
                          text: item,
                        })
                      }
                      disabled={i === 0 || itemAction.isPending}
                      className="h-9 w-9"
                      aria-label="Move up"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        itemAction.mutate({
                          action: "down",
                          index: i,
                          text: item,
                        })
                      }
                      disabled={i === items.length - 1 || itemAction.isPending}
                      className="h-9 w-9"
                      aria-label="Move down"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        itemAction.mutate({
                          action: "remove",
                          index: i,
                          text: item,
                        })
                      }
                      disabled={itemAction.isPending}
                      className="text-muted-foreground hover:text-destructive h-9 w-9"
                      aria-label="Remove from queue"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="border-border bg-background/95 safe-area-bottom border-t p-3 backdrop-blur-sm">
        {/* Re-fire a past prompt without retyping it. Only shown once this
            session has some history to reuse. */}
        {history.length > 0 && (
          <div className="mb-2 flex">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowHistory(true)}
              className="text-muted-foreground h-8"
              aria-label="Reuse a recent prompt"
            >
              <History className="mr-1 h-4 w-4" />
              Recent prompts
            </Button>
          </div>
        )}
        {compose ? (
          <Button
            onClick={send}
            disabled={!isSendable(text)}
            className="h-11 w-full"
            aria-label="Send to agent"
          >
            <Send className="mr-1 h-4 w-4" />
            Send to agent
          </Button>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                grow();
              }}
              rows={1}
              placeholder="Queue a prompt… (multi-line OK)"
              className="border-input bg-background focus-visible:ring-ring/60 max-h-32 min-h-[44px] flex-1 resize-none rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
            />
            <Button
              onClick={add}
              disabled={enqueue.isPending || !isSendable(text)}
              className="h-11"
              aria-label="Add to queue"
            >
              {enqueue.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              Add
            </Button>
          </div>
        )}
      </div>

      {showHistory && (
        <PromptHistoryPicker
          history={history}
          onPick={reuse}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}

/**
 * Overlay picker over the prompts recently sent to this session: type to fuzzy-
 * filter (reusing the QuickSwitcher matcher), tap one to drop it back into the
 * input. Newest-first when the query is empty.
 */
function PromptHistoryPicker({
  history,
  onPick,
  onClose,
}: {
  history: string[];
  onPick: (prompt: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Auto-focus the filter on open. Mount only.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const results = useMemo(
    () => searchHistory(history, query),
    [history, query]
  );

  return (
    <div
      className="bg-background/80 absolute inset-0 z-10 flex flex-col backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="border-border bg-background mx-auto mt-12 flex max-h-[80%] w-full max-w-lg flex-col overflow-hidden rounded-lg border shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-border flex items-center gap-2 border-b p-2">
          <Search className="text-muted-foreground ml-1 h-4 w-4 flex-shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter recent prompts…"
            className="placeholder:text-muted-foreground flex-1 bg-transparent text-sm outline-none"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="h-8 w-8"
            aria-label="Close recent prompts"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="overflow-auto p-1">
          {results.length === 0 ? (
            <div className="text-muted-foreground px-3 py-8 text-center text-sm">
              No matching prompts.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {results.map((prompt, i) => (
                <li key={`${i}-${prompt.slice(0, 32)}`}>
                  <button
                    type="button"
                    onClick={() => onPick(prompt)}
                    className="hover:bg-muted focus-visible:bg-muted w-full rounded-md px-3 py-2 text-left text-sm break-words whitespace-pre-wrap outline-none"
                  >
                    {prompt}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

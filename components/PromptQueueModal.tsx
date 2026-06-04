"use client";

import { useRef, useState } from "react";
import { X, ListPlus, Trash2, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useSessionQueue,
  useEnqueuePrompt,
  useClearQueue,
} from "@/hooks/useSessionQueue";

/**
 * Queue follow-up prompts to a session while it works. The server dispatches
 * them one at a time as the agent goes idle, so you can line up the next tasks
 * (from your phone) without interrupting the current turn.
 */
export function PromptQueueModal({
  sessionId,
  name,
  onClose,
}: {
  sessionId: string;
  name: string;
  onClose: () => void;
}) {
  const { data: queue, isLoading } = useSessionQueue(sessionId, true);
  const enqueue = useEnqueuePrompt(sessionId);
  const clear = useClearQueue(sessionId);
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const items = queue ?? [];

  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  };

  const add = () => {
    const t = text.trim();
    if (!t) return;
    enqueue.mutate(t);
    setText("");
    requestAnimationFrame(grow); // shrink back after clearing
  };

  return (
    <div
      className="bg-background fixed inset-0 z-50 flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-border bg-background/95 flex items-center gap-2 border-b p-3 backdrop-blur-sm">
        <ListPlus className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">Queue · {name}</h3>
          <p className="text-muted-foreground text-xs">
            {items.length === 0
              ? "Runs when the agent next goes idle"
              : `${items.length} queued · dispatched one at a time on idle`}
          </p>
        </div>
        {items.length > 0 && (
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
          aria-label="Close queue"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {isLoading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="text-muted-foreground mx-auto max-w-sm py-10 text-center text-sm">
            No queued tasks. Add a prompt below and it runs as soon as the agent
            finishes its current turn.
          </div>
        ) : (
          <ol className="space-y-1">
            {items.map((item, i) => (
              <li
                key={`${i}-${item.slice(0, 24)}`}
                className="bg-muted/40 flex items-start gap-3 rounded-md px-3 py-2"
              >
                <span className="text-muted-foreground w-5 flex-shrink-0 text-xs tabular-nums">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm break-words whitespace-pre-wrap">
                  {item}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="border-border bg-background/95 safe-area-bottom border-t p-3 backdrop-blur-sm">
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
            disabled={enqueue.isPending || !text.trim()}
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
      </div>
    </div>
  );
}

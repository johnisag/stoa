"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  CHAT_PROVIDER_OPTIONS,
  loadChatProvider,
  saveChatProvider,
  type ChatProvider,
} from "@/lib/chat-settings";
import { useViewport } from "@/hooks/useViewport";
import { useAsk, type ChatMessage } from "@/data/chat/useAsk";

// Starter questions for the empty state — they double as a hint at what the
// read-only Ask-Stoa endpoint can actually answer: it's grounded in the fleet's
// current state + recent activity (not Stoa how-to docs).
const EXAMPLE_QUESTIONS = [
  "What did the fleet do today?",
  "Which sessions are stuck on me?",
  "How much has the fleet cost today?",
];

/**
 * Ask Stoa — a self-contained, read-only chat dialog. The user asks
 * natural-language questions about their fleet + sessions and a chosen agent
 * (Claude or Codex) answers via the /api/ask backend, grounded in a live
 * fleet-state snapshot.
 *
 * User turns render as plain text in a right-aligned bubble; assistant turns
 * render as markdown (react-markdown + remark-gfm, the repo's MarkdownRenderer
 * stack). The conversation resets on open so reopening is fresh.
 */
export function ChatView({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [provider, setProvider] = useState<ChatProvider>("claude");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const { isMobile } = useViewport();

  const ask = useAsk();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Hydrate the persisted provider once mounted — localStorage is client-only.
  useEffect(() => {
    setProvider(loadChatProvider());
  }, []);

  // On open: start a fresh conversation so a late answer from a previously-closed
  // request can't orphan a stray bubble on reopen.
  useEffect(() => {
    if (open) {
      setMessages([]);
      setInput("");
    }
  }, [open]);

  // Autofocus the composer on open — but NOT on mobile, where focusing pops the
  // on-screen keyboard over the empty-state hints before the user reads them.
  useEffect(() => {
    if (open && !isMobile) {
      // rAF so the textarea exists (Radix mounts content on open) before focus.
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [open, isMobile]);

  // Keep the newest turn (and the thinking indicator) in view as it arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, ask.isPending]);

  function handleProviderChange(value: string) {
    const next = value as ChatProvider;
    setProvider(next);
    saveChatProvider(next);
  }

  // Auto-grow the composer up to a cap (mirrors PromptQueueModal's grow()).
  function grow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }

  function send() {
    const question = input.trim();
    if (!question || ask.isPending) return;

    // Snapshot the prior turns as history BEFORE appending the new question, so
    // the backend gets the conversation that preceded it.
    const history = messages;
    const userMessage: ChatMessage = { role: "user", content: question };
    setMessages([...history, userMessage]);
    setInput("");
    requestAnimationFrame(grow); // shrink back after clearing

    ask.mutate(
      { question, history, provider },
      {
        onSuccess: (answer) => {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: answer },
          ]);
        },
        onError: (err) => {
          // Drop the optimistic question back into the composer so it isn't lost.
          toast.error(
            err instanceof Error ? err.message : "Failed to get an answer"
          );
          setMessages((prev) => prev.slice(0, -1));
          setInput(question);
        },
      }
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Reset the conversation + input on close so reopening is a clean slate.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setMessages([]);
      setInput("");
      ask.reset();
    }
    onOpenChange(next);
  }

  const canSend = input.trim().length > 0 && !ask.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        sheet={isMobile}
        className="flex h-[85vh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <DialogHeader className="space-y-3 px-6 pt-6 pb-3 text-left">
          <div className="space-y-1">
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              Ask Stoa
            </DialogTitle>
            <DialogDescription>
              Ask about your fleet, sessions, and recent activity.
            </DialogDescription>
          </div>
          {/* Which agent answers — persisted across reloads. */}
          <Select value={provider} onValueChange={handleProviderChange}>
            <SelectTrigger
              className="h-8 w-auto gap-1.5 text-xs"
              aria-label="Answering agent"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHAT_PROVIDER_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                  {option.value === "claude" && (
                    <span className="text-muted-foreground ml-1.5 text-xs">
                      · default
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </DialogHeader>

        {/* Message list */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6">
          {messages.length === 0 && !ask.isPending ? (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-4 text-center text-sm">
              <Sparkles className="h-8 w-8 opacity-40" />
              <p className="max-w-xs">
                Ask anything about your fleet. For example:
              </p>
              <ul className="space-y-1.5">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <li key={q}>
                    <button
                      type="button"
                      onClick={() => {
                        setInput(q);
                        requestAnimationFrame(() => {
                          taRef.current?.focus();
                          grow();
                        });
                      }}
                      className="bg-muted/40 hover:bg-muted rounded-full px-3 py-1.5 text-xs transition-colors"
                    >
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-4 py-4">
              {messages.map((message, i) =>
                message.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="bg-secondary text-secondary-foreground max-w-[85%] rounded-2xl rounded-br-sm px-3 py-2 text-sm whitespace-pre-wrap">
                      {message.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-start">
                    <div className="bg-muted/40 max-w-[90%] rounded-2xl rounded-bl-sm px-3 py-2">
                      <article className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {message.content}
                        </ReactMarkdown>
                      </article>
                    </div>
                  </div>
                )
              )}
              {ask.isPending && (
                <div className="flex justify-start">
                  <div className="bg-muted/40 text-muted-foreground flex items-center gap-2 rounded-2xl rounded-bl-sm px-3 py-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Thinking…
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t p-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                grow();
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={ask.isPending}
              placeholder="Ask about your fleet…"
              className="border-input bg-background focus-visible:ring-ring/60 max-h-32 min-h-[44px] flex-1 resize-none rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-60"
            />
            <Button
              onClick={send}
              disabled={!canSend}
              className="h-11"
              aria-label="Send question"
            >
              {ask.isPending ? (
                <Loader2 className={cn("h-4 w-4 animate-spin")} />
              ) : (
                <Send className="mr-1 h-4 w-4" />
              )}
              Send
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

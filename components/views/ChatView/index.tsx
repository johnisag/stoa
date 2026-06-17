"use client";

import { useEffect, useRef, useState, type AnchorHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, HelpCircle, Loader2, Send, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
  DEFAULT_CHAT_PROVIDER,
  loadChatProvider,
  saveChatProvider,
  defaultChatModel,
  loadChatModel,
  saveChatModel,
  type ChatProvider,
} from "@/lib/chat-settings";
import { getModelOptions } from "@/lib/model-catalog";
import { useViewport } from "@/hooks/useViewport";
import {
  useProposeCommand,
  useExecuteCommand,
  useExecutePlan,
  type ChatItem,
  type ChatMessage,
  type StepProgress,
} from "@/data/chat/useCommand";
import { setPendingPrompt } from "@/stores/initialPrompt";
import { ChatHelp } from "./ChatHelp";
import { PlanCard } from "./PlanCard";

/** Renders markdown links so external URLs open in a new tab. */
function MarkdownLink({
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const isExternal = typeof href === "string" && /^https?:\/\//i.test(href);
  return (
    <a
      href={href}
      {...(isExternal
        ? { target: "_blank", rel: "noopener noreferrer" }
        : undefined)}
      {...props}
    >
      {children}
    </a>
  );
}

// Starter prompts for the empty state — a mix of read-only questions (grounded in
// the fleet's live state + recent activity) and one ACTION, hinting that Stoa can
// also do things (it always confirms first).
const EXAMPLE_QUESTIONS = [
  "What did the fleet do today?",
  "Which sessions are stuck on me?",
  "Start a new Claude session",
];

/**
 * Ask Stoa — a chat PANE (a window, like a session — not a dialog) that can both
 * ANSWER and ACT. The user asks natural-language questions about their fleet +
 * sessions, and a chosen agent (Claude or Codex) responds via the
 * /api/command/propose backend, grounded in a live fleet-state snapshot. A request
 * the agent maps to an allowlisted action (create_session, dispatch_issue,
 * open_view, or list_sessions) comes back as a CONFIRM CARD; nothing runs until
 * the user confirms, which calls /api/command/execute (re-validated + audited
 * server-side).
 *
 * User turns render as plain text in a right-aligned bubble; assistant ANSWERS
 * render as markdown; PROPOSALS render as a confirm card; RESULTS as a status
 * bubble. The conversation lives as long as the tab does (a fresh tab starts
 * empty); closing the tab discards it.
 */
export function ChatView({
  onClose,
  onNavigate,
  onOpenBonRun,
}: {
  /** Optional close affordance, used on mobile where the tab strip is hidden. */
  onClose?: () => void;
  /** Navigate to a named view (analytics, dispatch, verdict-inbox, fleet-board).
   * Called when the user confirms an open_view action. Without this callback the
   * open_view card is still shown but no navigation occurs. */
  onNavigate?: (view: string) => void;
  /** Open a Best-of-N run in a dedicated pane tab.
   * Called when the user confirms a best_of_n action. */
  onOpenBonRun?: (runId: string) => void;
}) {
  const [provider, setProvider] = useState<ChatProvider>(DEFAULT_CHAT_PROVIDER);
  // Defaults to Opus for Claude (the chatbox default, not the agent's Sonnet) —
  // sourced from chat-settings so the literal lives in exactly one place.
  const [model, setModel] = useState(() =>
    defaultChatModel(DEFAULT_CHAT_PROVIDER)
  );
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const { isMobile } = useViewport();

  const propose = useProposeCommand();
  const execute = useExecuteCommand();
  const executePlan = useExecutePlan();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Synchronous re-entrancy lock for Confirm — a ref (not state) so a fast
  // double-tap can't fire two executes before React re-renders the disabled state.
  const executingRef = useRef(false);

  // Hydrate the persisted provider + model once mounted — localStorage is
  // client-only.
  useEffect(() => {
    const p = loadChatProvider();
    setProvider(p);
    setModel(loadChatModel(p));
  }, []);

  // Autofocus the composer when the tab mounts — but NOT on mobile, where focusing
  // pops the on-screen keyboard over the empty-state hints before the user reads
  // them. (The conversation lives as long as the tab does; a fresh tab starts
  // empty via useState, so there's no open-gated reset.)
  useEffect(() => {
    if (!isMobile) {
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [isMobile]);

  // Keep the newest turn (and the thinking indicator) in view as it arrives —
  // but when the help panel is open, pin to the TOP so it reads from the start and
  // an arriving answer can't yank it mid-read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = showHelp ? 0 : el.scrollHeight;
  }, [messages, propose.isPending, showHelp]);

  function handleProviderChange(value: string) {
    const next = value as ChatProvider;
    setProvider(next);
    saveChatProvider(next);
    // The model is provider-specific — re-resolve (keeps the saved model if it's
    // valid for the new provider, else falls back to that provider's default).
    setModel(loadChatModel(next));
  }

  function handleModelChange(value: string) {
    setModel(value);
    saveChatModel(provider, value);
  }

  // Auto-grow the composer up to a cap (mirrors PromptQueueModal's grow()).
  function grow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }

  // Drop an example prompt into the composer (from the empty-state chips or the
  // help panel): fill it, close help, focus. The user reviews/edits before sending.
  // No-op while a request is in flight (the composer is disabled then — picking
  // would fill a disabled field and a failing send could clobber the example).
  function pickExample(text: string) {
    if (propose.isPending) return;
    setInput(text);
    setShowHelp(false);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      grow();
    });
  }

  function send() {
    const question = input.trim();
    if (!question || propose.isPending) return;

    // History = prior user turns + assistant ANSWERS, plus successful action
    // RESULTS (so the agent knows what it already did); pending proposal/plan
    // cards are local UI state, not context. Snapshot BEFORE appending the new
    // question. Confirmed plan items serialize to a human-readable summary line.
    const history: ChatMessage[] = messages
      .filter(
        (m) =>
          m.role === "user" ||
          (m.role === "assistant" && m.kind === "answer") ||
          (m.role === "assistant" && m.kind === "result" && m.ok) ||
          (m.role === "assistant" &&
            m.kind === "plan" &&
            m.status === "confirmed")
      )
      .map((m) => {
        if (m.role === "assistant" && m.kind === "plan") {
          const succeeded = (m.progress ?? []).filter(
            (p: StepProgress) => p.status === "done"
          ).length;
          const total = m.steps.length;
          // Intentionally terse — a one-liner tells the LLM what happened
          // without bloating the context window. Step-level detail lives in
          // the result bubble below the card; the LLM doesn't need it for
          // follow-up turns.
          return {
            role: m.role as "assistant",
            content: `Plan "${m.name}" confirmed. ${succeeded}/${total} steps succeeded.`,
          };
        }
        return {
          role: m.role,
          content: (m as { content: string }).content,
        };
      });

    // Keep a reference to the optimistic turn so onError can remove exactly IT,
    // not "the last message" — a concurrent execute may append a result first.
    const userItem: ChatItem = { role: "user", content: question };
    setMessages((prev) => [...prev, userItem]);
    setInput("");
    requestAnimationFrame(grow); // shrink back after clearing

    propose.mutate(
      { message: question, history, provider, model },
      {
        onSuccess: (reply) => {
          if (reply.kind === "answer") {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", kind: "answer", content: reply.text },
            ]);
          } else if (reply.kind === "plan") {
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                kind: "plan",
                name: reply.name,
                steps: reply.steps,
                projectNames: reply.projectNames,
                status: "pending" as const,
              },
            ]);
          } else {
            // Destructure the discriminated proposal (kind omitted) so TS
            // preserves the action discriminant on the stored proposal object.
            const { kind: _k, ...proposal } = reply;
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                kind: "proposal",
                proposal,
                status: "pending" as const,
              },
            ]);
          }
        },
        onError: (err) => {
          // Drop the optimistic question back into the composer so it isn't lost.
          toast.error(
            err instanceof Error ? err.message : "Failed to get a response"
          );
          setMessages((prev) => prev.filter((m) => m !== userItem));
          setInput(question);
        },
      }
    );
  }

  // Confirm a pending proposal: run it via the execute endpoint (which re-validates
  // server-side). The card flips to "executing" (synchronously, + a ref lock) so a
  // double-tap can't run it twice; then to "confirmed" with a result bubble, or
  // back to "pending" with an error bubble so it can be retried.
  function handleConfirm(index: number) {
    if (executingRef.current) return; // sync guard against a double-tap
    const item = messages[index];
    if (
      !item ||
      item.role !== "assistant" ||
      item.kind !== "proposal" ||
      item.status !== "pending"
    ) {
      return;
    }
    executingRef.current = true;
    const { proposal } = item;
    const setStatus = (status: "executing" | "confirmed" | "pending") =>
      setMessages((prev) =>
        prev.map((m, i) =>
          i === index && m.role === "assistant" && m.kind === "proposal"
            ? { ...m, status }
            : m
        )
      );
    setStatus("executing");
    execute.mutate(
      {
        action: proposal.action as
          | "create_session"
          | "dispatch_issue"
          | "open_view"
          | "list_sessions",
        params: proposal.params,
      },
      {
        onSuccess: (res) => {
          let content: string;
          if ("sessionId" in res) {
            if (res.initialPrompt) {
              setPendingPrompt(res.sessionId, res.initialPrompt);
            }
            const promptNote = res.initialPrompt
              ? ` Seed prompt queued: "${res.initialPrompt.slice(0, 60)}${res.initialPrompt.length > 60 ? "…" : ""}".`
              : "";
            content = `Created session **${res.name}** in **${res.project.name}**. Open it from the sidebar to start working.${promptNote}`;
          } else if ("clientAction" in res) {
            const ca = (res as Record<string, unknown>).clientAction;
            if (ca === "open_view") {
              onNavigate?.((res as { view: string }).view);
              content = `Navigating to the **${(res as { view: string }).view}** view.`;
            } else if (ca === "open_best_of_n") {
              const runId = (res as Record<string, unknown>).runId as string;
              const nAgents = ((res as Record<string, unknown>).n as number) ?? 2;
              onOpenBonRun?.(runId);
              content = `Started a Best-of-${nAgents} run. The comparison view is opening now.`;
            } else {
              content = "Action completed.";
            }
          } else if ("dispatchId" in res) {
            content = `Dispatch task created: **${res.title}** in ${res.repoSlug}.`;
          } else if ("sessions" in res) {
            if (res.total === 0) {
              content = "No sessions found matching that filter.";
            } else {
              const lines = res.sessions
                .slice(0, 10)
                .map((s) => `- **${s.name}** (${s.agentType}, ${s.status})`);
              if (res.total > 10) lines.push(`…and ${res.total - 10} more`);
              content = `Found ${res.total} session${res.total === 1 ? "" : "s"}:\n\n${lines.join("\n")}`;
            }
          } else {
            content = "Action completed.";
          }
          setMessages((prev) => [
            ...prev.map((m, i) =>
              i === index && m.role === "assistant" && m.kind === "proposal"
                ? { ...m, status: "confirmed" as const }
                : m
            ),
            {
              role: "assistant",
              kind: "result",
              ok: true,
              content,
            },
          ]);
        },
        onError: (err) => {
          // Revert to pending so it can be retried; surface why it failed.
          setStatus("pending");
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              kind: "result",
              ok: false,
              content:
                err instanceof Error ? err.message : "Failed to run the action",
            },
          ]);
        },
        onSettled: () => {
          executingRef.current = false;
        },
      }
    );
  }

  // Decline a pending proposal — nothing runs; mark it cancelled.
  function handleCancel(index: number) {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === index &&
        m.role === "assistant" &&
        m.kind === "proposal" &&
        m.status === "pending"
          ? { ...m, status: "cancelled" as const }
          : m
      )
    );
  }

  // Confirm a pending plan: run all steps sequentially via the execute endpoint.
  // Uses the same re-entrancy guard as handleConfirm. The card flips to
  // "executing" synchronously; on completion each step shows its result icon.
  function handleConfirmPlan(index: number) {
    if (executingRef.current) return;
    const item = messages[index];
    if (
      !item ||
      item.role !== "assistant" ||
      item.kind !== "plan" ||
      item.status !== "pending"
    ) {
      return;
    }
    executingRef.current = true;
    const { name, steps } = item;

    const setPlanStatus = (
      status: "executing" | "confirmed" | "pending",
      progress?: StepProgress[]
    ) =>
      setMessages((prev) =>
        prev.map((m, i) =>
          i === index && m.role === "assistant" && m.kind === "plan"
            ? { ...m, status, ...(progress !== undefined ? { progress } : {}) }
            : m
        )
      );

    // Initialize all steps as "waiting" and flip card to executing.
    setPlanStatus("executing", steps.map((s) => ({ stepId: s.stepId, status: "waiting" as const })));

    executePlan.mutate(
      { kind: "plan", name, steps },
      {
        onSuccess: (res) => {
          const progress: StepProgress[] = res.results.map((r) => ({
            stepId: r.stepId,
            status: r.ok ? ("done" as const) : ("failed" as const),
            summary: r.summary,
          }));
          const succeeded = res.results.filter((r) => r.ok).length;
          const total = res.results.length;

          // Deliver initialPrompts for any created sessions.
          for (const r of res.results) {
            if (r.ok && r.sessionId) {
              const extR = r as typeof r & { initialPrompt?: string };
              if (extR.initialPrompt) {
                setPendingPrompt(r.sessionId, extR.initialPrompt);
              }
            }
          }

          // Use "- " list markers with a blank line separator so ReactMarkdown
          // (remarkGfm) renders them as a proper unordered list, not flat prose.
          const resultLines = res.results.map((r) => {
            const icon = r.ok ? "✓" : "✗";
            return `- ${icon} ${r.summary}`;
          });
          const content = [
            `Plan complete: ${succeeded}/${total} step${total === 1 ? "" : "s"} succeeded.`,
            "",
            ...resultLines,
          ].join("\n");

          setMessages((prev) => [
            ...prev.map((m, i) =>
              i === index && m.role === "assistant" && m.kind === "plan"
                ? { ...m, status: "confirmed" as const, progress }
                : m
            ),
            { role: "assistant", kind: "result", ok: succeeded === total, content },
          ]);
        },
        onError: (err) => {
          setPlanStatus("pending");
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              kind: "result",
              ok: false,
              content:
                err instanceof Error ? err.message : "Failed to execute the plan",
            },
          ]);
        },
        onSettled: () => {
          executingRef.current = false;
        },
      }
    );
  }

  // Decline a pending plan — nothing runs; mark it cancelled.
  function handleCancelPlan(index: number) {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === index &&
        m.role === "assistant" &&
        m.kind === "plan" &&
        m.status === "pending"
          ? { ...m, status: "cancelled" as const }
          : m
      )
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const canSend = input.trim().length > 0 && !propose.isPending;
  // Only one action runs at a time (executingRef). Surface that on the cards: a
  // pending Confirm disables while ANOTHER card is executing, so it never looks
  // tappable-but-dead. Includes both proposal and plan cards.
  const anyExecuting = messages.some(
    (m) =>
      m.role === "assistant" &&
      (m.kind === "proposal" || m.kind === "plan") &&
      m.status === "executing"
  );

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col gap-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium">Ask Stoa</span>
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="How Ask Stoa works"
            title="How Ask Stoa works"
            aria-pressed={showHelp}
            onClick={() => setShowHelp((v) => !v)}
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close Ask Stoa"
              title="Close Ask Stoa"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      {/* Which agent + model answers — both persisted across reloads. */}
      <div className="flex items-center gap-2 px-4 pb-2">
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
        <Select value={model} onValueChange={handleModelChange}>
          <SelectTrigger
            className="h-8 w-auto gap-1.5 text-xs"
            aria-label="Model"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {getModelOptions(provider).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
                {option.value === defaultChatModel(provider) && (
                  <span className="text-muted-foreground ml-1.5 text-xs">
                    · default
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Message list (or the help panel, toggled by the header "?") */}
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        className="min-h-0 flex-1 overflow-y-auto px-4"
      >
        {showHelp ? (
          <ChatHelp
            onClose={() => setShowHelp(false)}
            onPickExample={pickExample}
          />
        ) : messages.length === 0 && !propose.isPending ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-4 text-center text-sm">
            <Sparkles className="h-8 w-8 opacity-40" />
            <p className="max-w-xs">
              Ask about your fleet, or tell Stoa to do something. For example:
            </p>
            <ul className="space-y-1.5">
              {EXAMPLE_QUESTIONS.map((q) => (
                <li key={q}>
                  <button
                    type="button"
                    disabled={propose.isPending}
                    onClick={() => pickExample(q)}
                    className="bg-muted/40 hover:bg-muted rounded-full px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
                  >
                    {q}
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground/70 max-w-xs text-xs">
              Actions (like starting a session) always ask you to confirm first.
            </p>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            {messages.map((message, i) => {
              if (message.role === "user") {
                return (
                  <div key={i} className="flex justify-end">
                    <div className="bg-secondary text-secondary-foreground max-w-[85%] rounded-2xl rounded-br-sm px-3 py-2 text-sm whitespace-pre-wrap">
                      {message.content}
                    </div>
                  </div>
                );
              }
              if (message.kind === "answer") {
                return (
                  <div key={i} className="flex justify-start">
                    <div className="bg-muted/40 max-w-[90%] rounded-2xl rounded-bl-sm px-3 py-2">
                      <article className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{ a: MarkdownLink }}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </article>
                    </div>
                  </div>
                );
              }
              if (message.kind === "result") {
                return (
                  <div key={i} className="flex justify-start">
                    <div
                      className={cn(
                        "flex max-w-[90%] items-start gap-2 rounded-2xl rounded-bl-sm px-3 py-2 text-sm [&_p]:m-0",
                        message.ok
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "bg-destructive/10 text-destructive"
                      )}
                    >
                      {message.ok ? (
                        <Check className="mt-0.5 h-4 w-4 shrink-0" />
                      ) : (
                        <X className="mt-0.5 h-4 w-4 shrink-0" />
                      )}
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{ a: MarkdownLink }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                );
              }
              // Plan — a multi-step confirm card. Nothing runs until the user confirms.
              if (message.kind === "plan") {
                return (
                  <div key={i} className="flex justify-start">
                    <PlanCard
                      name={message.name}
                      steps={message.steps}
                      projectNames={message.projectNames}
                      status={message.status}
                      progress={message.progress}
                      onConfirm={() => handleConfirmPlan(i)}
                      onCancel={() => handleCancelPlan(i)}
                      confirmDisabled={anyExecuting}
                    />
                  </div>
                );
              }
              // Proposal — a confirm card. Nothing runs until the user confirms.
              return (
                <div key={i} className="flex justify-start">
                  <div className="border-border bg-muted/30 max-w-[90%] space-y-3 rounded-2xl rounded-bl-sm border px-4 py-3">
                    <div className="flex items-start gap-2">
                      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">Stoa wants to act</p>
                        <p className="text-muted-foreground text-sm">
                          {message.proposal.summary}
                        </p>
                        {message.proposal.action === "create_session" &&
                          message.proposal.params.initialPrompt && (
                            <p className="text-muted-foreground mt-1 max-w-xs truncate text-xs">
                              Seed prompt:{" "}
                              <span className="italic">
                                {message.proposal.params.initialPrompt.slice(
                                  0,
                                  80
                                )}
                                {message.proposal.params.initialPrompt.length >
                                  80 && "…"}
                              </span>
                            </p>
                          )}
                      </div>
                    </div>
                    {message.status === "pending" ||
                    message.status === "executing" ? (
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleConfirm(i)}
                          disabled={anyExecuting}
                          className="h-8"
                        >
                          {message.status === "executing" ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="mr-1 h-3.5 w-3.5" />
                          )}
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleCancel(i)}
                          disabled={message.status === "executing"}
                          className="h-8"
                        >
                          <X className="mr-1 h-3.5 w-3.5" />
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        {message.status === "confirmed"
                          ? "Confirmed."
                          : "Cancelled."}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
            {propose.isPending && (
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
      <div className="border-t px-4 py-3">
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
            disabled={propose.isPending}
            placeholder="Ask about your fleet, or start a session…"
            aria-label="Ask Stoa a question"
            className="border-input bg-background focus-visible:ring-ring/60 max-h-32 min-h-[44px] flex-1 resize-none rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-60"
          />
          <Button
            onClick={send}
            disabled={!canSend}
            className="h-11"
            aria-label="Send"
          >
            {propose.isPending ? (
              <Loader2 className={cn("h-4 w-4 animate-spin")} />
            ) : (
              <Send className="mr-1 h-4 w-4" />
            )}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

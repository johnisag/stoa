"use client";

import { X, MessagesSquare, Wand2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Example prompts grouped by what they do. Clicking one drops it into the
 * composer (the user can edit a `<project>` placeholder before sending). */
const ASK_EXAMPLES = [
  "What did the fleet do today?",
  "Which sessions are stuck on me?",
  "Which sessions are running right now?",
  "How much have my Claude sessions cost today?",
];

const COMMAND_EXAMPLES = [
  "Start a new Claude session in <project>",
  "Open a Codex session on <project>",
  "Create a dispatch task: <short title>",
  "Show me my running sessions",
  "Navigate to the fleet board",
];

/**
 * In-pane primer for Ask / Command Stoa: what it can ANSWER (grounded in the
 * fleet's live state) and what it can DO (actions, always proposed → confirmed →
 * executed). Shown in the chat pane's content area, toggled by the header "?".
 * Mirrors DispatchHelp / WorkflowsHelp. Examples are clickable — they fill the
 * composer rather than send, so the user reviews (and edits placeholders) first.
 */
export function ChatHelp({
  onClose,
  onPickExample,
}: {
  onClose: () => void;
  onPickExample: (text: string) => void;
}) {
  return (
    <div
      role="region"
      aria-label="How Ask Stoa works"
      className="mx-auto max-w-2xl space-y-5 py-4 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold">How to use Ask Stoa</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close help"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <p className="text-muted-foreground leading-relaxed">
        Ask Stoa is grounded in your fleet’s live state — what your sessions are
        doing right now, plus recent activity and cost. It answers questions and
        can take four safe actions for you: starting a session, creating a
        dispatch task, navigating to a view, or listing your sessions. It’s
        about your fleet, not a general coding chat.
      </p>

      <section className="space-y-2">
        <h4 className="text-foreground flex items-center gap-2 font-medium">
          <MessagesSquare className="h-4 w-4" aria-hidden="true" /> Ask about
          your fleet
        </h4>
        <ul className="flex flex-wrap gap-1.5">
          {ASK_EXAMPLES.map((q) => (
            <li key={q}>
              <button
                type="button"
                onClick={() => onPickExample(q)}
                className="bg-muted/40 hover:bg-muted rounded-full px-3 py-1.5 text-xs transition-colors"
              >
                {q}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h4 className="text-foreground flex items-center gap-2 font-medium">
          <Wand2 className="h-4 w-4" aria-hidden="true" /> Tell Stoa to do
          something
        </h4>
        <ul className="flex flex-wrap gap-1.5">
          {COMMAND_EXAMPLES.map((c) => (
            <li key={c}>
              <button
                type="button"
                onClick={() => onPickExample(c)}
                className="bg-muted/40 hover:bg-muted rounded-full px-3 py-1.5 text-xs transition-colors"
              >
                {c}
              </button>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Tap an example to drop it into the message box — swap{" "}
          <span className="text-foreground">&lt;project&gt;</span> or{" "}
          <span className="text-foreground">&lt;short title&gt;</span> for your
          own values, then Send. Stoa proposes a card for each action —{" "}
          <span className="text-foreground">
            create_session, dispatch_issue, open_view, list_sessions
          </span>{" "}
          — and nothing runs until you confirm.
        </p>
      </section>

      <section className="bg-muted/30 space-y-1.5 rounded-lg p-3">
        <h4 className="text-foreground flex items-center gap-2 font-medium">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Nothing happens
          without your OK
        </h4>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Questions are answered directly — no confirmation needed. Actions
          never run on their own:{" "}
          <span className="text-foreground">propose → confirm → execute</span>.
          Stoa shows a card describing exactly what it will do — nothing happens
          until you press <span className="text-foreground">Confirm</span>, and
          Cancel does nothing. A confirmed action is re-checked on the server
          before it runs, and every outcome is logged. So you can ask freely.
        </p>
      </section>

      <p className="text-muted-foreground text-xs leading-relaxed">
        Pick which agent (Claude or Codex) and model answers from the selectors
        in the header — it defaults to Claude on Opus. Enter sends · Shift+Enter
        for a new line · the conversation stays while this tab is open (close
        the tab to start fresh).
      </p>
    </div>
  );
}

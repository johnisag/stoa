"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A short in-dialog primer on what a Workflow run is and how the steps execute.
 * The full example catalog + authoring docs are a separate, larger surface. */
export function WorkflowsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="region"
      aria-label="How Workflows work"
      className="flex flex-col gap-4 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium">How Workflows work</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close help"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ol className="text-muted-foreground flex flex-col gap-3 leading-relaxed">
        <li>
          <span className="text-foreground font-medium">
            1. Pick a template.
          </span>{" "}
          Each one is a small DAG of steps — e.g. the 3-agent review gate fans a
          change out to three independent critics, then folds their findings
          into a final pass. Read-only templates (badged) change no code.
        </li>
        <li>
          <span className="text-foreground font-medium">
            2. Fill the slots.
          </span>{" "}
          Templates take a repo path plus a few specifics (the task, an issue
          number, the modules to cover). Choose a{" "}
          <span className="text-foreground">conductor session</span> — an
          existing Stoa session the pipeline spawns its workers from.
        </li>
        <li>
          <span className="text-foreground font-medium">3. Watch it run.</span>{" "}
          Each step spawns a worker (Claude, Codex, or Hermes) in its own git
          worktree off the base branch. Independent steps run in parallel; a
          step starts only once every step it depends on has succeeded. If a
          step fails, its dependents are skipped rather than chasing a broken
          precondition.
        </li>
      </ol>

      <p className="text-muted-foreground text-xs leading-relaxed">
        The board shows each step’s status — to read a worker’s full output,
        open its session from the sidebar. Steps pass context by convention
        today (a step writes its findings to a file; a later step reads its
        siblings’ worktrees). Runs are held in memory — a server restart clears
        them.
      </p>
    </div>
  );
}

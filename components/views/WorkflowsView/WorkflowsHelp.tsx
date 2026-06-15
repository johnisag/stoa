"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A short in-dialog primer on what a Workflow run is and how the steps execute.
 * The full pattern catalog lives in the Examples tab. */
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
        <li>
          <span className="text-foreground font-medium">Or build it.</span> The{" "}
          <span className="text-foreground">Build</span> tab is a visual canvas
          — tap <span className="text-foreground">Add step</span> to drop a
          node, drag the boxes to arrange your DAG, and tap one to edit its
          agent, task, dependencies, and exit criteria. Drag the dot on a
          box&apos;s right edge onto another box to make it depend on this one,
          and tap an edge to remove it. It validates live and runs the same way;
          under the hood it&apos;s the same spec as Custom. Use the{" "}
          <span className="text-foreground">Saved</span> menu to save the
          current canvas (its positions included), reload one later, save a
          copy, <span className="text-foreground">Tidy layout</span> to
          auto-arrange the boxes, or{" "}
          <span className="text-foreground">Import/Export</span> a workflow as a
          JSON file to share it. Saving over a loaded workflow overwrites it; an
          amber dot on the Saved button means you have unsaved changes.
        </li>
        <li>
          <span className="text-foreground font-medium">
            Let AI design it for you.
          </span>{" "}
          The <span className="text-foreground">Build</span> tab&apos;s{" "}
          <span className="text-foreground">Design a workflow with AI</span> bar
          turns a one-line goal into a full role-fleet DAG —{" "}
          <span className="text-foreground">
            researchers → architects → engineers
          </span>{" "}
          + ui/ux → testers → integrator → a final review gate — each node
          pre-filled with its task, inputs, outputs, and dependencies. Pick a{" "}
          <span className="text-foreground">Project context</span>, describe
          what to build, and tap{" "}
          <span className="text-foreground">Generate</span>: an agent{" "}
          <span className="text-foreground">designs</span> the workflow and
          loads it onto the canvas. It only ever <em>designs</em> — nothing runs
          until you review, tweak the 20% that needs your touch, and hit Start.
        </li>
        <li>
          <span className="text-foreground font-medium">Or go Custom.</span> The{" "}
          <span className="text-foreground">Custom</span> tab lets you author a
          pipeline by hand — paste a spec (a name, a working directory, and a
          list of steps each with an <code className="text-foreground">id</code>
          , <code className="text-foreground">agent</code>,{" "}
          <code className="text-foreground">task</code>, and optional{" "}
          <code className="text-foreground">dependsOn</code>). It validates as
          you type; tap <span className="text-foreground">Load example</span> to
          start from a working one. A step reads an upstream step&apos;s result
          with{" "}
          <code className="text-foreground">{"{{steps.<id>.output}}"}</code>.
          Add <code className="text-foreground">exitCriteria</code> (unbreakable
          rules folded into the worker&apos;s prompt) or{" "}
          <code className="text-foreground">
            {'"worktreePolicy": "shared"'}
          </code>{" "}
          to make steps reuse one workflow worktree (those steps run one at a
          time).
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

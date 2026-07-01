"use client";

import {
  GitBranch,
  ShieldAlert,
  Users,
  Folder,
  HelpCircle,
  BookMarked,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Plain-language "New Session" guide. Shown inside the NewSessionDialog
 * (toggled by the header "?"), mirroring DispatchHelp / WorkflowsHelp.
 * Focuses on the three concepts most likely to confuse: auto-approve,
 * orchestration mode, and worktrees.
 */
export function NewSessionHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="region"
      aria-label="New Session help"
      className="space-y-5 text-sm"
    >
      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Folder className="h-4 w-4" aria-hidden="true" /> Working directory
        </h3>
        <p className="text-muted-foreground">
          The folder the agent runs in. It reads and edits files relative to
          this path. If you open a git repo, extra options appear below it.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <GitBranch className="h-4 w-4" aria-hidden="true" /> Worktree (git
          repos only)
        </h3>
        <p className="text-muted-foreground">
          A <span className="text-foreground font-medium">git worktree</span> is
          an isolated checkout of your repo on a fresh branch. The agent works
          there without touching your main working copy — so you can keep coding
          on <code className="text-foreground">main</code> while it experiments
          on its own branch. When you accept the work you merge the branch; if
          you discard it the checkout is deleted and nothing lingers.
        </p>
        <p className="text-muted-foreground">
          Skip it if you want the agent to edit files in place on the current
          branch.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <ShieldAlert className="h-4 w-4" aria-hidden="true" /> Auto-approve
          tool calls
        </h3>
        <p className="text-muted-foreground">
          Normally the agent pauses before each file edit or shell command and
          waits for your permission.{" "}
          <span className="text-foreground font-medium">Auto-approve</span>{" "}
          removes that pause — the agent edits files and runs shell commands
          without asking. Use it only for code and machines you trust; it is
          irreversible mid-session.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Users className="h-4 w-4" aria-hidden="true" /> Orchestration mode
          (conductor)
        </h3>
        <p className="text-muted-foreground">
          Turns this session into a{" "}
          <span className="text-foreground font-medium">conductor</span> that
          can delegate subtasks to parallel worker sessions via the{" "}
          <code className="text-foreground">spawn_worker</code> MCP tool. The
          conductor coordinates the fleet; each worker inherits auto-approve.
          Leave this off for a normal single-agent session. Only Claude supports
          it today.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <HelpCircle className="h-4 w-4" aria-hidden="true" /> Initial prompt
        </h3>
        <p className="text-muted-foreground">
          Optional text sent to the agent the moment the session opens — handy
          for scripted tasks or Dispatch workflows. Leave blank to start with an
          empty terminal and type your first message yourself.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <BookMarked className="h-4 w-4" aria-hidden="true" /> Playbooks &amp;
          pinned knowledge
        </h3>
        <p className="text-muted-foreground">
          A <span className="text-foreground font-medium">playbook</span> is a
          named, reusable prompt — a recipe (success criteria + guardrails).
          Save the current prompt as one with{" "}
          <span className="text-foreground">Save current as…</span>, then click
          any saved recipe to load it into the prompt. Choose a project first to{" "}
          <span className="text-foreground font-medium">pin</span> a recipe: a
          pinned recipe (📌) is <em>auto-prepended</em> to every future session
          in that project — curated per-project knowledge (e.g. “this repo uses
          npm, not yarn”) the agent always sees, no clicking required.
        </p>
      </section>

      <div className="pt-1">
        <Button size="sm" onClick={onClose}>
          Got it
        </Button>
      </div>
    </div>
  );
}

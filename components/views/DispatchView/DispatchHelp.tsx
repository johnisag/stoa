"use client";

import {
  Rocket,
  Clock,
  CheckCircle,
  Bot,
  AlertCircle,
  GitMerge,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Plain-language "How Dispatch works" guide for non-technical users. Shown in the
 * Dispatch dialog's content area (toggled by the header "?"), reachable from
 * every tab. Kept jargon-light on purpose.
 */
export function DispatchHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="region"
      aria-label="How Dispatch works"
      className="mx-auto max-w-2xl space-y-5 text-sm"
    >
      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Rocket className="h-4 w-4" aria-hidden="true" /> What is Dispatch?
        </h3>
        <p className="text-muted-foreground">
          Dispatch turns GitHub issues into finished work. You point it at a
          repository, and an AI agent works on each issue and proposes the
          changes for you to review and accept.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-base font-semibold">The three tabs</h3>
        <ul className="text-muted-foreground space-y-1">
          <li>
            <span className="text-foreground font-medium">Allocation</span> —
            set up which repositories to watch, which agent, how many issues per
            day, and whether work runs on its own or waits for you. Tap a
            repo&apos;s{" "}
            <span className="text-foreground font-medium">inbox</span> icon to
            browse all its open GitHub issues (even ones outside your label
            filter) and dispatch any of them with one tap; issues already being
            worked show their status instead.
          </li>
          <li>
            <span className="text-foreground font-medium">Backlog</span> —
            create new issues, and approve ones waiting for an agent.
          </li>
          <li>
            <span className="text-foreground font-medium">In flight</span> —
            watch agents work, review the changes, and accept them.
          </li>
        </ul>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-base font-semibold">Two ways a repo runs</h3>
        <ul className="text-muted-foreground space-y-1">
          <li>
            <span className="text-foreground font-medium">Auto</span> — agents
            start on their own, up to your daily limit.
          </li>
          <li>
            <span className="text-foreground font-medium">Review</span> — new
            issues wait in the Backlog for you to approve first.
          </li>
        </ul>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-base font-semibold">When you create an issue</h3>
        <ul className="text-muted-foreground space-y-1">
          <li>
            <span className="text-foreground font-medium">Dispatch now</span> —
            creates the issue <em>and</em> starts an agent on it right away.
          </li>
          <li>
            <span className="text-foreground font-medium">Add to backlog</span>{" "}
            — creates it and queues it: if the repo is set to auto, an agent
            starts within about a minute; if review, it waits for your approval.
          </li>
          <li>
            <span className="text-foreground inline-flex items-center gap-1 font-medium">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Schedule
            </span>{" "}
            — creates it and starts it at a time you choose.
          </li>
        </ul>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Sparkles className="h-4 w-4" aria-hidden="true" /> Plan (optional)
        </h3>
        <p className="text-muted-foreground">
          On the <span className="text-foreground font-medium">Plan</span> tab,
          paste a spec and Stoa proposes a set of tasks that each own a
          different part of the codebase, so several agents can work at once
          without stepping on each other. You review the split (overlaps are
          flagged in red), then approve — it files the issues for you. Two tasks
          that touch the same files never run at the same time; the second waits
          for the first to merge.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Bot className="h-4 w-4" aria-hidden="true" /> Critic (optional)
        </h3>
        <p className="text-muted-foreground">
          Turn on <span className="text-foreground font-medium">critic</span>{" "}
          for a repo and a second agent checks each agent&apos;s work. If it
          asks for changes, a fixer makes them (up to a couple of rounds); if it
          still can&apos;t, the work surfaces for you to decide. The repo also{" "}
          <span className="text-foreground">remembers</span> what the critic
          flagged, so the next agent on that repo is told the known pitfalls up
          front and stops repeating them.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <GitMerge className="h-4 w-4" aria-hidden="true" /> Auto-rebase
          (optional)
        </h3>
        <p className="text-muted-foreground">
          Turn on <span className="text-foreground font-medium">rebase</span>{" "}
          for a repo and, once a PR is approved and its checks are green but it
          conflicts with the base (something else landed first), its author
          rebases, resolves the conflicts, and re-pushes — so it stays ready to
          merge without you untangling it by hand. It tries a couple of times;
          if it still can&apos;t, the PR is left for you to rebase. It only
          keeps PRs landable — accepting the merge is still your tap (or
          auto-merge, if you armed it).
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Verify
          (optional)
        </h3>
        <p className="text-muted-foreground">
          Turn on <span className="text-foreground font-medium">verify</span>{" "}
          and give the repo a command (e.g.{" "}
          <span className="text-foreground">npm run verify</span>, or chain
          steps with <span className="text-foreground">&amp;&amp;</span>). Stoa
          runs it in each worker&apos;s PR checkout (typecheck/test/build) and
          shows the result on the card —{" "}
          <span className="text-foreground">verified</span>,{" "}
          <span className="text-foreground">verify failed</span> (output one tap
          away), or <span className="text-foreground">verify error</span>. So
          you approve from evidence, not by reading code — and auto-merge waits
          for a local pass. Especially useful for repos with no GitHub CI. If
          the checkout needs dependencies installed, include that as a step.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <GitMerge className="h-4 w-4" aria-hidden="true" /> Auto-merge
          (optional)
        </h3>
        <p className="text-muted-foreground">
          By default, accepting a PR is your one tap. Arm{" "}
          <span className="text-foreground font-medium">auto-merge</span> on an
          issue and Stoa merges its PR for you the moment it&apos;s truly ready
          — no conflicts, checks green (or none configured — arm{" "}
          <span className="text-foreground">verify</span> for repos with no CI),
          the critic approved (if the repo is gated), and the verify command
          passed (if armed). It only ever merges what those gates allow, so it
          can run an overnight fleet end-to-end without you. Leave it off and
          every merge stays your call.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <CheckCircle className="h-4 w-4" aria-hidden="true" /> Accepting the
          work
        </h3>
        <p className="text-muted-foreground">
          Always your tap (unless you armed auto-merge), from the In-flight
          card. Stoa never accepts changes without you.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <AlertCircle className="h-4 w-4" aria-hidden="true" /> If something
          goes wrong
        </h3>
        <p className="text-muted-foreground">
          A stuck agent&apos;s card turns red. Use{" "}
          <span className="text-foreground font-medium">Retry</span> to run it
          again, or <span className="text-foreground font-medium">Dismiss</span>{" "}
          to clear it.
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

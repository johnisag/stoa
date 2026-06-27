"use client";

import {
  Smartphone,
  Columns3,
  Mic,
  Search,
  FolderOpen,
  GitBranch,
  GitFork,
  Server,
  Network,
  Workflow,
  Rocket,
  Bot,
  Inbox,
  GitMerge,
  Sparkles,
  ShieldCheck,
  Compass,
  Navigation,
  Brain,
  HeartPulse,
  ScanSearch,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Item = { icon: LucideIcon; title: string; blurb: string };

// The cockpit — what you drive by hand.
const COCKPIT: Item[] = [
  {
    icon: Smartphone,
    title: "Mobile-first",
    blurb:
      "Full control from your phone — not a stripped-down responsive view.",
  },
  {
    icon: Columns3,
    title: "Multi-pane",
    blurb: "Run up to four agent sessions side by side.",
  },
  {
    icon: Mic,
    title: "Voice-to-text",
    blurb: "Dictate prompts to a session hands-free.",
  },
  {
    icon: Search,
    title: "Code search",
    blurb: "Fast, syntax-highlighted codebase search (Cmd/Ctrl+K).",
  },
  {
    icon: ScanSearch,
    title: "Output search",
    blurb:
      "Search what your agents actually said across every session — find the one that hit a TypeError (Cmd/Ctrl+K → Output).",
  },
  {
    icon: FolderOpen,
    title: "File picker",
    blurb: "Browse and attach files, with direct upload from mobile.",
  },
  {
    icon: GitBranch,
    title: "Git built in",
    blurb: "Status, diffs, commits, PRs, and GitHub clone — from the UI.",
  },
  {
    icon: GitFork,
    title: "Git worktrees",
    blurb: "Isolated branches with automatic setup per session.",
  },
  {
    icon: TriangleAlert,
    title: "Conflict warning",
    blurb:
      "Flags when two sessions share a working directory and could clobber each other's edits — isolate one in a worktree.",
  },
  {
    icon: Server,
    title: "Dev servers",
    blurb: "Start and stop Node.js and Docker servers per project.",
  },
  {
    icon: Network,
    title: "Session orchestration",
    blurb: "Coordinate conductor/worker agent fleets over MCP.",
  },
  {
    icon: Workflow,
    title: "Workflows",
    blurb:
      "Declarative agent-pipeline DAGs: fan out agents in their own worktrees, fan in, gate on results.",
  },
];

// The autonomous fleet — what runs itself. Each is opt-in per repo.
const FLEET: Item[] = [
  {
    icon: Rocket,
    title: "Dispatch",
    blurb:
      "Turns a GitHub issue into a worker in an isolated worktree, opens a PR, and drives the whole ceremony.",
  },
  {
    icon: Bot,
    title: "3-critic review gate",
    blurb:
      "Three independent agents review each PR on a distinct lens; a fixer addresses what they flag.",
  },
  {
    icon: Inbox,
    title: "Verdict Inbox",
    blurb:
      "One fleet-wide review queue with live per-lens findings and merge / retry / dismiss in place.",
  },
  {
    icon: GitMerge,
    title: "Merge Train",
    blurb:
      "A ready-but-conflicting PR rebases, resolves, and re-pushes itself instead of paging you.",
  },
  {
    icon: Sparkles,
    title: "Conflict-aware decomposition",
    blurb:
      "Splits a spec into tasks that own disjoint files, so agents run in parallel without colliding.",
  },
  {
    icon: ShieldCheck,
    title: "Verification harness",
    blurb:
      "Runs your typecheck/test/build in each worktree and gates the merge on real evidence.",
  },
  {
    icon: Navigation,
    title: "Auto-steer",
    blurb:
      "Resumes after a rate-limit, answers routine prompts, escalates risky ones, and can page you when a session is stuck in an error loop — enabled with server flags.",
  },
  {
    icon: HeartPulse,
    title: "Self-healing watchdog",
    blurb:
      "Keeps an unattended fleet alive: reaps a hung worker that would pin a concurrency slot forever, and pages you when a session wedges (spinner never settles) — enabled with server flags.",
  },
  {
    icon: Brain,
    title: "Fleet memory",
    blurb:
      "Remembers every blocking review finding and warns the next agent, so the fleet stops repeating mistakes.",
  },
];

function Group({ title, items }: { title: string; items: Item[] }) {
  return (
    <section className="space-y-2">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      <ul className="space-y-2">
        {items.map(({ icon: Icon, title: t, blurb }) => (
          <li key={t} className="flex items-start gap-2.5">
            <Icon
              className="text-muted-foreground mt-0.5 h-4 w-4 flex-shrink-0"
              aria-hidden="true"
            />
            <span className="text-sm leading-snug">
              <span className="font-medium">{t}</span>
              <span className="text-muted-foreground"> — {blurb}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Guide — a plain-English tour of what Stoa can do, one short sentence per
 * capability, grouped into the hands-on cockpit and the autonomous fleet. The
 * in-app home for "what is all this?" — deeper config-by-config help lives behind
 * the `?` inside each feature's own panel (Dispatch, Workflows, …).
 */
export function StoaGuide({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden sm:max-w-lg">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Compass className="h-5 w-5" /> What Stoa can do
          </DialogTitle>
          <DialogDescription>
            A quick tour of every feature. Each special panel has its own{" "}
            <span className="font-medium">?</span> for the details.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5 overflow-y-auto py-3">
          <Group title="The cockpit — you drive" items={COCKPIT} />
          <Group
            title="The autonomous fleet — it runs itself (opt-in)"
            items={FLEET}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

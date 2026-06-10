"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Zap, Loader2, X, GitMerge } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  useCeremony,
  useStartCeremony,
  useCancelCeremony,
  useMergeCeremony,
} from "@/data/sessions/ceremony";
import type { Session } from "@/lib/db";
import type { SessionCeremonyStep } from "@/lib/dispatch/types";

const STEP_LABEL: Record<
  SessionCeremonyStep,
  { label: string; badge: string }
> = {
  queued: {
    label: "Waiting for the session to settle",
    badge: "bg-muted text-muted-foreground",
  },
  reviewing: {
    label: "3-critic panel reviewing the PR",
    badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  fixing: {
    label: "Fixer applying requested changes",
    badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  ci_fixing: {
    label: "Healing red CI checks",
    badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  ready: {
    label: "Approved — waiting on CI / mergeability",
    badge: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  },
  awaiting_merge: {
    label: "Approved & green — ready to merge",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  merging: {
    label: "Merging…",
    badge: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  },
  merged: {
    label: "Merged ✓",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  stuck: {
    label: "Needs you — review the PR",
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
};

/**
 * "Go to auto" control + live status for a session. Hands the session's PR off to
 * the dispatch ceremony (critic panel → fix loop → CI auto-fix → auto-merge).
 * Includes the in-app help inline (what auto mode does). Polls the ceremony while
 * open so the status stays live.
 */
export function AutoModeDialog({
  session,
  open,
  onClose,
}: {
  session: Session;
  open: boolean;
  onClose: () => void;
}) {
  const [seed, setSeed] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const { data: ceremony, isLoading } = useCeremony(session.id, open);
  const start = useStartCeremony(session.id);
  const cancel = useCancelCeremony(session.id);
  const merge = useMergeCeremony(session.id);

  const hasBranch = !!session.branch_name && !!session.worktree_path;
  const enrolled = !!ceremony;
  const step = ceremony ? STEP_LABEL[ceremony.step] : null;
  const awaitingMerge = ceremony?.step === "awaiting_merge";

  async function handleStart() {
    try {
      await start.mutateAsync({
        seedPrompt: seed.trim() || undefined,
        autoMerge,
      });
      toast.success("Sent to auto — the ceremony takes it from here");
      setSeed("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start auto mode");
    }
  }
  async function handleMerge() {
    try {
      await merge.mutateAsync();
      toast.success("Merged");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to merge");
    }
  }
  async function handleCancel() {
    try {
      await cancel.mutateAsync();
      toast.success("Auto mode cancelled");
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to cancel auto mode"
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="space-y-1 px-6 pt-6 pb-3 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Auto mode
          </DialogTitle>
          <DialogDescription>
            Hand this session off — Stoa takes its PR the rest of the way
            through the ceremony, hands-free.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {/* In-app help — what auto mode actually does. */}
          <ol className="text-muted-foreground mb-4 flex flex-col gap-2 text-xs leading-relaxed">
            <li>
              <span className="text-foreground font-medium">1.</span> A 3-critic
              panel reviews your PR through three lenses (correctness ·
              conventions · simplicity).
            </li>
            <li>
              <span className="text-foreground font-medium">2.</span> If changes
              are requested, a fixer applies them and pushes to the same branch
              — then it’s re-reviewed.
            </li>
            <li>
              <span className="text-foreground font-medium">3.</span> If CI goes
              red, a fixer diagnoses and repairs it until the checks are green.
            </li>
            <li>
              <span className="text-foreground font-medium">4.</span> Once
              approved + green + mergeable, it’s ready — you merge with one tap,
              or flip on auto-merge below to land it unattended. If it gets
              stuck, it waits for you.
            </li>
          </ol>

          {isLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : enrolled && step ? (
            <div className="flex flex-col gap-3">
              <div className="bg-card flex items-center justify-between gap-2 rounded-md border p-3 text-sm">
                <span>Status</span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px]",
                    step.badge
                  )}
                >
                  {step.label}
                </span>
              </div>
              {ceremony.pr_number != null && (
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Working{" "}
                  {ceremony.pr_url ? (
                    <a
                      href={ceremony.pr_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground underline underline-offset-2"
                    >
                      PR #{ceremony.pr_number}
                    </a>
                  ) : (
                    <>PR #{ceremony.pr_number}</>
                  )}
                  . The reviewers and fixers run in this session’s worktree.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {awaitingMerge && (
                  <Button
                    onClick={handleMerge}
                    disabled={merge.isPending}
                    className="w-full sm:w-auto"
                  >
                    {merge.isPending ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <GitMerge className="mr-1.5 h-4 w-4" />
                    )}
                    Merge now
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={handleCancel}
                  disabled={cancel.isPending}
                  className="w-full sm:w-auto"
                >
                  {cancel.isPending ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <X className="mr-1.5 h-4 w-4" />
                  )}
                  Cancel auto mode
                </Button>
              </div>
            </div>
          ) : !hasBranch ? (
            <p className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-xs leading-relaxed">
              Auto mode needs this session on its own worktree + branch.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">
                  Seed prompt (optional)
                </span>
                <Textarea
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  rows={3}
                  placeholder="A final instruction before it goes autonomous — e.g. 'tighten the error handling, then you're done'. Leave blank to hand off as-is."
                />
              </label>
              <label className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm">
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">Auto-merge when ready</span>
                  <span className="text-muted-foreground text-xs leading-relaxed">
                    Off (default): it reviews + CI-fixes the PR to green, then
                    you merge with one tap. On: it merges unattended once
                    approved + green (pinned to the reviewed commit).
                  </span>
                </span>
                <Switch
                  checked={autoMerge}
                  onCheckedChange={setAutoMerge}
                  className="mt-0.5"
                  aria-label="Auto-merge when ready"
                />
              </label>
              <p className="text-muted-foreground rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
                Needs an <span className="text-foreground">open PR</span> for
                this branch. It runs gh/git unattended in this session’s
                worktree, and waits for the session to be idle before it starts
                reviewing.
              </p>
              <Button
                onClick={handleStart}
                disabled={start.isPending}
                className="w-full sm:w-auto sm:self-start"
              >
                {start.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="mr-1.5 h-4 w-4" />
                )}
                Send to auto
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

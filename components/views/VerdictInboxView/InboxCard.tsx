"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  GitMerge,
  X,
  RotateCcw,
  Loader2,
  ExternalLink,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmProvider";
import { Button } from "@/components/ui/button";
import { STATUS_META } from "@/components/views/DispatchView/shared";
import type { DispatchStatus } from "@/lib/dispatch/types";
import {
  useFindings,
  useInboxActions,
  type InboxItem,
} from "@/data/verdict-inbox/queries";
import { useAddLesson } from "@/data/dispatch/queries";

// Verdict badge palette — matches the Dispatch board (InFlightBoard) so the same
// verdict reads identically across surfaces: approved=emerald, changes=amber.
const VERDICT: Record<string, { label: string; badge: string }> = {
  APPROVED: {
    label: "approved",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  CHANGES_REQUESTED: {
    label: "changes requested",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
};
const IN_REVIEW = {
  label: "in review",
  badge: "bg-muted text-muted-foreground",
};
const NO_GATE = { label: "no review", badge: "bg-muted text-muted-foreground" };

const LENS_BADGE: Record<string, string> = {
  correctness: "bg-red-500/15 text-red-600 dark:text-red-400",
  conventions: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  simplicity: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
};

// The local verify harness verdict (typecheck/test/build run in the worktree).
const VERIFY: Record<string, { label: string; badge: string }> = {
  pass: {
    label: "verified",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  fail: {
    label: "verify failed",
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
  error: {
    label: "verify error",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  running: { label: "verifying…", badge: "bg-muted text-muted-foreground" },
};

// Friendly labels for ceremony steps (dispatch statuses reuse STATUS_META).
const CEREMONY_LABEL: Record<string, string> = {
  queued: "Queued",
  reviewing: "Reviewing",
  fixing: "Fixing",
  ci_fixing: "Fixing CI",
  ready: "Ready",
  awaiting_merge: "Awaiting merge",
  merging: "Merging",
  stuck: "Stuck",
};

function stateLabel(item: InboxItem): string {
  return item.type === "dispatch"
    ? (STATUS_META[item.state as DispatchStatus]?.label ?? item.state)
    : (CEREMONY_LABEL[item.state] ?? item.state);
}

/** One review item — issue/session, verdict badge, expand for the critic's
 * per-lens findings (loaded live on expand), and merge / dismiss / retry. When
 * `onOpenSession` is wired, ceremony items (which carry a Stoa session id) get an
 * "Open session" button to jump into the live worker terminal and intervene. */
export function InboxCard({
  item,
  onOpenSession,
}: {
  item: InboxItem;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const findingsId = useId();
  const { data: findings = [], isLoading: loadingFindings } = useFindings(
    item,
    open
  );
  const { merge, dismiss, retry } = useInboxActions();
  const addLesson = useAddLesson();
  const confirm = useConfirm();

  // "Remember this": promote a finding into a permanent per-repo rule (fleet
  // memory) so a future worker is warned up front. Dispatch items only (a repo).
  const remember = (text: string, lens: string | null) => {
    if (!item.repoId) return;
    addLesson.mutate(
      { repoId: item.repoId, text, lens },
      {
        onSuccess: () => toast.success("Added to the repo's memory"),
        onError: (e) =>
          toast.error(e instanceof Error ? e.message : "Couldn't remember"),
      }
    );
  };

  const verdict = item.reviewDecision
    ? (VERDICT[item.reviewDecision] ?? IN_REVIEW)
    : item.reviewGate
      ? IN_REVIEW
      : NO_GATE;
  const busy = merge.isPending || dismiss.isPending || retry.isPending;
  const failed = item.type === "dispatch" && item.state === "failed";
  // Only offer Merge where the endpoint will actually accept it — otherwise a
  // one-tap merge from a *review* queue lands an unreviewed PR (dispatch /merge
  // has no review gate) or just error-toasts (ceremony PUT requires ready+sha).
  // Dispatch: APPROVED, or ungated (no verdict will ever come → human merges).
  // Ceremony: APPROVED and past review (the PUT enforces ready/awaiting_merge).
  const canMerge =
    item.prNumber != null &&
    (item.type === "dispatch"
      ? item.reviewDecision === "APPROVED" || !item.reviewGate
      : item.reviewDecision === "APPROVED" &&
        (item.state === "ready" || item.state === "awaiting_merge")) &&
    // If the verify harness is armed, don't offer a one-tap Merge on a non-passing
    // build — the server's auto-merge gate would refuse it anyway (matches it).
    (!item.verifyGate || item.verifyStatus === "pass");
  // Dispatch dismiss is server-gated to failed; ceremony cancel (DELETE) is always valid.
  const canDismiss = item.type === "ceremony" || item.state === "failed";

  const run = (m: typeof merge, label: string) => async () => {
    try {
      await m.mutateAsync(item);
      toast.success(label);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    }
  };

  // Merge lands the PR on its base branch — irreversible from the UI, so confirm
  // first (every other destructive action in the repo routes through useConfirm).
  const onMerge = async () => {
    if (
      !(await confirm({
        title: `Merge PR #${item.prNumber}?`,
        description: "This merges the pull request into its base branch.",
        confirmLabel: "Merge",
        destructive: false,
      }))
    )
      return;
    await run(merge, "Merged")();
  };

  return (
    <div className="bg-card flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={findingsId}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
        >
          {open ? (
            <ChevronDown className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <ChevronRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          )}
          <span className="min-w-0">
            <span className="block truncate font-medium">{item.title}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {item.subtitle}
              {item.branch ? ` · ${item.branch}` : ""}
            </span>
          </span>
        </button>
        <div className="flex flex-shrink-0 items-center gap-1">
          {item.verifyGate &&
            item.verifyStatus &&
            VERIFY[item.verifyStatus] && (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px]",
                  VERIFY[item.verifyStatus].badge
                )}
              >
                {VERIFY[item.verifyStatus].label}
              </span>
            )}
          <span
            className={cn("rounded px-1.5 py-0.5 text-[11px]", verdict.badge)}
          >
            {verdict.label}
          </span>
        </div>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-2 pl-5 text-[11px]">
        <span className="bg-muted rounded px-1.5 py-0.5">
          {item.type === "ceremony" ? "session" : "dispatch"} ·{" "}
          {stateLabel(item)}
        </span>
        {item.fixRounds > 0 && <span>fix round {item.fixRounds}</span>}
        {item.autoMerge && <span>auto-merge</span>}
        {item.prUrl && item.prNumber != null && (
          <a
            href={item.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground inline-flex items-center gap-0.5 underline underline-offset-2"
          >
            PR #{item.prNumber} <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {open && (
        <div id={findingsId} className="flex flex-col gap-1.5 pl-5">
          {loadingFindings ? (
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading findings…
            </span>
          ) : findings.length === 0 ? (
            <span className="text-muted-foreground text-xs">
              {item.prNumber == null
                ? "No PR yet — nothing to review."
                : "No critic findings yet (the panel may still be reviewing)."}
            </span>
          ) : (
            findings.map((f) => (
              <div key={f.lens} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "rounded px-1 py-0.5 text-[10px]",
                      LENS_BADGE[f.lens] ?? "bg-muted text-muted-foreground"
                    )}
                  >
                    {f.lens}
                  </span>
                  <span
                    className={cn(
                      "rounded px-1 py-0.5 text-[10px]",
                      f.verdict === "APPROVE"
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-red-500/15 text-red-600 dark:text-red-400"
                    )}
                  >
                    {f.verdict === "APPROVE" ? "approve" : "changes"}
                  </span>
                </span>
                {f.text && (
                  <p className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                    {f.text}
                  </p>
                )}
                {f.text && item.repoId && (
                  <button
                    type="button"
                    disabled={addLesson.isPending}
                    onClick={() => remember(f.text, f.lens)}
                    className="text-muted-foreground hover:text-foreground self-start text-[11px] disabled:opacity-50"
                  >
                    + Remember this
                  </button>
                )}
              </div>
            ))
          )}
          {/* Verification evidence — the build/test output tail, beside the critic
              findings, so the operator approves from proof (fail/error only). */}
          {item.verifyGate &&
            (item.verifyStatus === "fail" || item.verifyStatus === "error") &&
            item.verifyOutput && (
              <div className="flex flex-col gap-0.5">
                <span className="text-foreground text-[11px] font-medium">
                  Verification output
                </span>
                <pre className="text-muted-foreground bg-muted/50 max-h-48 overflow-auto rounded p-2 text-[10px] leading-relaxed whitespace-pre-wrap">
                  {item.verifyOutput}
                </pre>
              </div>
            )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pl-5">
        {/* Jump into the live worker session to intervene — the in-app path the
            "needs me" rows (stuck / changes requested) were missing. Only ceremony
            items carry a Stoa session id; dispatch items don't, so it's hidden there. */}
        {onOpenSession && item.sessionId && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenSession(item.sessionId!)}
          >
            <Terminal className="mr-1.5 h-3.5 w-3.5" />
            Open session
          </Button>
        )}
        {canMerge && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onMerge}>
            {merge.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitMerge className="mr-1.5 h-3.5 w-3.5" />
            )}
            Merge
          </Button>
        )}
        {failed && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={run(retry, "Retrying")}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry
          </Button>
        )}
        {canDismiss && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={run(
              dismiss,
              item.type === "ceremony" ? "Auto mode stopped" : "Dismissed"
            )}
            className="text-muted-foreground"
          >
            {dismiss.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <X className="mr-1.5 h-3.5 w-3.5" />
            )}
            {item.type === "ceremony" ? "Stop auto" : "Dismiss"}
          </Button>
        )}
      </div>
    </div>
  );
}

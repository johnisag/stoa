"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  GitMerge,
  X,
  RotateCcw,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  useFindings,
  useInboxActions,
  type InboxItem,
} from "@/data/verdict-inbox/queries";

const VERDICT: Record<string, { label: string; badge: string }> = {
  APPROVED: {
    label: "approved",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  CHANGES_REQUESTED: {
    label: "changes requested",
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
};
const IN_REVIEW = {
  label: "in review",
  badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
};

const LENS_BADGE: Record<string, string> = {
  correctness: "bg-red-500/15 text-red-600 dark:text-red-400",
  conventions: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  simplicity: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
};

/** One review item — issue/session, verdict badge, expand for the critic's
 * per-lens findings (loaded live on expand), and merge / dismiss / retry. */
export function InboxCard({ item }: { item: InboxItem }) {
  const [open, setOpen] = useState(false);
  const { data: findings = [], isLoading: loadingFindings } = useFindings(
    item,
    open
  );
  const { merge, dismiss, retry } = useInboxActions();

  const verdict = item.reviewDecision
    ? (VERDICT[item.reviewDecision] ?? IN_REVIEW)
    : IN_REVIEW;
  const busy = merge.isPending || dismiss.isPending || retry.isPending;
  const failed = item.type === "dispatch" && item.state === "failed";
  const canMerge =
    item.prNumber != null && item.reviewDecision !== "CHANGES_REQUESTED";

  const run = (m: typeof merge, label: string) => async () => {
    try {
      await m.mutateAsync(item);
      toast.success(label);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    }
  };

  return (
    <div className="bg-card flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
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
        <span
          className={cn(
            "flex-shrink-0 rounded px-1.5 py-0.5 text-[11px]",
            verdict.badge
          )}
        >
          {verdict.label}
        </span>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-2 pl-5 text-[11px]">
        <span className="bg-muted rounded px-1.5 py-0.5">
          {item.type === "ceremony" ? "session" : "dispatch"} · {item.state}
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
        <div className="flex flex-col gap-1.5 pl-5">
          {loadingFindings ? (
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading findings…
            </span>
          ) : findings.length === 0 ? (
            <span className="text-muted-foreground text-xs">
              No critic findings yet (the panel may still be reviewing).
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
              </div>
            ))
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pl-5">
        {canMerge && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={run(merge, "Merged")}
          >
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
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={run(
            dismiss,
            item.type === "ceremony" ? "Cancelled" : "Dismissed"
          )}
          className="text-muted-foreground"
        >
          {dismiss.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="mr-1.5 h-3.5 w-3.5" />
          )}
          {item.type === "ceremony" ? "Cancel" : "Dismiss"}
        </Button>
      </div>
    </div>
  );
}

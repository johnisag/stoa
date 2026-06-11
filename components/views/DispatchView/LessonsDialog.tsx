"use client";

import { toast } from "sonner";
import { Loader2, Brain, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useLessons, useClearLessons } from "@/data/dispatch/queries";
import { timeAgo } from "./shared";

const LENS_BADGE: Record<string, string> = {
  correctness: "bg-red-500/15 text-red-600 dark:text-red-400",
  conventions: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  simplicity: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
};

/**
 * Fleet memory, made visible: what the critic has flagged for this repo (newest
 * first) — the exact lessons injected into every new worker's prompt. You can forget
 * a stale finding, or wipe the whole ledger. The store stays the DB; this is the
 * window + the off switch.
 */
export function LessonsDialog({
  repoId,
  repoSlug,
  reviewGate,
  open,
  onOpenChange,
}: {
  repoId: string;
  repoSlug: string;
  reviewGate: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: lessons = [], isLoading } = useLessons(repoId, open);
  const clear = useClearLessons();

  const forget = (lessonId?: string) => {
    // Confirm the bulk wipe (irreversible — re-learned only when the critic blocks
    // again, mirroring the remove-repo confirm); a single forget is low-stakes.
    if (
      !lessonId &&
      !confirm(
        `Forget all ${lessons.length} lessons for ${repoSlug}? They're re-learned only when the critic blocks a PR again.`
      )
    ) {
      return;
    }
    clear.mutate(
      { repoId, lessonId },
      {
        onError: (e) =>
          toast.error(e instanceof Error ? e.message : "Couldn't forget"),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="space-y-1 px-6 pt-6 pb-3 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" /> What the fleet learned
          </DialogTitle>
          <DialogDescription>
            Blocking critic findings for{" "}
            <span className="font-medium">{repoSlug}</span> — injected into
            every new worker on this repo so it avoids the same mistakes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between px-6 pb-2">
          <span className="text-muted-foreground text-xs">
            {isLoading
              ? "…"
              : `${lessons.length} ${lessons.length === 1 ? "lesson" : "lessons"}`}
          </span>
          {lessons.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={clear.isPending}
              onClick={() => forget()}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Forget all
            </Button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {isLoading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : lessons.length === 0 ? (
            <div className="text-muted-foreground py-10 text-center text-sm">
              {reviewGate
                ? "Nothing learned yet — lessons appear after the critic blocks a PR."
                : "Turn on the critic for this repo first — lessons are the blocking findings it records."}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {lessons.map((l) => (
                <li
                  key={l.id}
                  className="bg-card flex items-start gap-2 rounded-md border p-2.5 text-sm"
                >
                  {l.lens && (
                    <span
                      className={cn(
                        "mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                        LENS_BADGE[l.lens] ?? "bg-muted text-muted-foreground"
                      )}
                    >
                      {l.lens}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block break-words whitespace-pre-wrap">
                      {l.text}
                    </span>
                    <span className="text-muted-foreground text-[11px]">
                      {timeAgo(l.created_at)}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label="Forget this lesson"
                    title="Forget this lesson"
                    className="text-muted-foreground hover:text-destructive -m-1.5 flex-shrink-0 p-1.5"
                    onClick={() => forget(l.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

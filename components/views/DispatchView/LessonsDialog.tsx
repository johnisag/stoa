"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Brain, Trash2, X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  useLessons,
  useClearLessons,
  useAddLesson,
} from "@/data/dispatch/queries";
import { timeAgo } from "./shared";

const LENS_BADGE: Record<string, string> = {
  correctness: "bg-red-500/15 text-red-600 dark:text-red-400",
  conventions: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  simplicity: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
};

/**
 * Fleet memory, made visible + curatable: the pitfalls injected into every new
 * worker (and interactive sessions) on this repo — auto-captured critic findings
 * PLUS rules you add yourself ("your rule"). Add a rule, forget a stale finding,
 * or clear all the findings (your rules survive). The store stays the DB.
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
  const add = useAddLesson();
  const [newRule, setNewRule] = useState("");

  const autoCount = lessons.filter((l) => l.source !== "manual").length;

  const remember = () => {
    const text = newRule.trim();
    if (!text) return;
    add.mutate(
      { repoId, text },
      {
        onSuccess: () => setNewRule(""),
        onError: (e) =>
          toast.error(e instanceof Error ? e.message : "Couldn't remember"),
      }
    );
  };

  const forget = (lessonId?: string) => {
    // The bulk action clears only the auto-captured FINDINGS (curated manual rules
    // survive — remove those individually). Confirm it (re-learned only when the
    // critic blocks again); a single forget is low-stakes.
    if (
      !lessonId &&
      !confirm(
        `Forget all ${autoCount} critic findings for ${repoSlug}? They're re-learned only when the critic blocks a PR again (your own rules are kept).`
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
            Pitfalls for <span className="font-medium">{repoSlug}</span> —
            injected into every new worker (and interactive sessions here) so it
            avoids the same mistakes. The critic adds findings automatically;
            you can add your own rules below.
          </DialogDescription>
        </DialogHeader>

        {/* Add an operator-curated rule (or endorse a finding so it's permanent). */}
        <div className="flex items-center gap-2 px-6 pb-2">
          <Input
            value={newRule}
            onChange={(e) => setNewRule(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !add.isPending) remember();
            }}
            placeholder="Add a rule, e.g. 'use execFile, never exec'"
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            disabled={add.isPending || !newRule.trim()}
            onClick={remember}
          >
            {add.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Remember
          </Button>
        </div>

        <div className="flex items-center justify-between px-6 pb-2">
          <span className="text-muted-foreground text-xs">
            {isLoading
              ? "…"
              : `${lessons.length} ${lessons.length === 1 ? "lesson" : "lessons"}`}
          </span>
          {autoCount > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={clear.isPending}
              onClick={() => forget()}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Forget findings
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
                ? "No lessons yet — add a rule above, or the critic adds findings when it blocks a PR."
                : "Add your own rules above. (The critic also records findings automatically once you turn it on for this repo.)"}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {lessons.map((l) => (
                <li
                  key={l.id}
                  className="bg-card flex items-start gap-2 rounded-md border p-2.5 text-sm"
                >
                  {l.source === "manual" ? (
                    <span className="mt-0.5 flex-shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
                      your rule
                    </span>
                  ) : (
                    l.lens && (
                      <span
                        className={cn(
                          "mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                          LENS_BADGE[l.lens] ?? "bg-muted text-muted-foreground"
                        )}
                      >
                        {l.lens}
                      </span>
                    )
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

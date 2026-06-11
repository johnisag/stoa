"use client";

import { Sparkles, X, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSessionDigest } from "@/data/sessions";

/**
 * One-tap "what did this agent do" digest for a long-running session. Read-only:
 * hits the summarize route's GET, which generates a summary WITHOUT forking or
 * compacting the session, so you can catch up on an autonomous run without
 * scrolling the whole transcript. Re-summarizes on every open (the run keeps
 * moving). Mirrors SessionDiffModal's full-screen, fetch-on-open shape.
 */
export function SessionSummaryModal({
  sessionId,
  name,
  onClose,
}: {
  sessionId: string;
  name: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useSessionDigest(sessionId, true);

  const summary = data?.summary?.trim();

  return (
    <div
      className="bg-background fixed inset-0 z-50 flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-border bg-background/95 flex items-center gap-2 border-b p-3 backdrop-blur-sm">
        <Sparkles className="text-muted-foreground h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">Summary · {name}</h3>
          <p className="text-muted-foreground truncate text-xs">
            Read-only digest of what this agent did. The session is not changed.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="h-9 w-9"
          aria-label="Re-summarize"
          title="Re-summarize"
        >
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="h-9 w-9"
          aria-label="Close summary"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Summarizing the
            session…
          </div>
        ) : isError ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm">
            <span>
              {(error as Error)?.message || "Couldn't summarize the session."}
            </span>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        ) : summary ? (
          <div className="mx-auto max-w-3xl text-sm leading-relaxed whitespace-pre-wrap">
            {summary}
          </div>
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Nothing to summarize yet.
          </div>
        )}
      </div>
    </div>
  );
}

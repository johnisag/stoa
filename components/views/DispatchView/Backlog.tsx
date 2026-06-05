"use client";

import { Check, X, Loader2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";
import {
  useDispatchAction,
  useDispatchReposQuery,
  usePendingQuery,
} from "@/data/dispatch/queries";
import { AGENT_BADGE, repoUrl, timeAgo } from "./shared";

export function Backlog({ open }: { open: boolean }) {
  const { data: pending = [], isLoading } = usePendingQuery(open);
  const { data: repos = [] } = useDispatchReposQuery(open);
  const action = useDispatchAction();
  const repoById = new Map<string, DispatchRepo>(repos.map((r) => [r.id, r]));

  const dispatchAction = (id: string, act: "approve" | "cancel") =>
    action.mutate(
      { id, action: act },
      {
        onSuccess: () =>
          toast.success(act === "approve" ? "Dispatched" : "Cancelled"),
        onError: (e) => toast.error((e as Error).message),
      }
    );

  if (isLoading)
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading backlog...
      </div>
    );

  if (pending.length === 0)
    return (
      <p className="text-muted-foreground py-10 text-center text-sm">
        No candidates waiting. Review-mode repos surface eligible issues here
        for one-tap approval; auto-mode repos dispatch them straight to the
        board.
      </p>
    );

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">
        {pending.length} candidate{pending.length === 1 ? "" : "s"} awaiting
        approval. Approving spawns a worker immediately (it bypasses the daily
        cap); cancelling drops the candidate.
      </p>
      {pending.map((d: IssueDispatch) => {
        const repo = repoById.get(d.repo_id);
        const busy = action.isPending && action.variables?.id === d.id;
        return (
          <div
            key={d.id}
            className="hover:bg-muted/40 flex items-center gap-3 rounded-md border px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {repo && (
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[11px] font-medium",
                      AGENT_BADGE[repo.agent_type]
                    )}
                  >
                    {repo.agent_type}
                  </span>
                )}
                <a
                  href={d.issue_url ?? (repo ? repoUrl(repo.repo_slug) : "#")}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-sm font-medium hover:underline"
                  title={d.issue_title ?? undefined}
                >
                  #{d.issue_number} {d.issue_title}
                </a>
                <ExternalLink className="text-muted-foreground h-3 w-3 shrink-0" />
              </div>
              <div className="text-muted-foreground mt-0.5 text-xs">
                {repo?.repo_slug ?? "unknown repo"}
                {d.issue_created_at && (
                  <> &middot; raised {timeAgo(d.issue_created_at)}</>
                )}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => dispatchAction(d.id, "approve")}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Approve
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Cancel candidate"
              disabled={busy}
              onClick={() => dispatchAction(d.id, "cancel")}
            >
              <X className="text-muted-foreground hover:text-destructive h-4 w-4" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

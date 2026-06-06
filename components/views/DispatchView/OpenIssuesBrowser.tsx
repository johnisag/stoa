"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DispatchRepo } from "@/lib/dispatch/types";
import {
  useOpenIssuesQuery,
  useTriageDispatch,
  type TriageIssue,
} from "@/data/dispatch/queries";
import { STATUS_META, timeAgo, repoUrl } from "./shared";

/**
 * On-demand triage panel: browse a repo's OPEN GitHub issues (the whole backlog,
 * even ones outside the standing label filter) and dispatch any not-yet-picked
 * issue with one tap. Rendered inline under a repo row in the allocation console.
 */
export function OpenIssuesBrowser({ repo }: { repo: DispatchRepo }) {
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const q = useOpenIssuesQuery(repo.id, applied, true);
  const triage = useTriageDispatch();
  const issues = q.data ?? [];

  const dispatch = (issue: TriageIssue) => {
    triage.mutate(
      {
        repoId: repo.id,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        createdAt: issue.createdAt,
      },
      {
        onSuccess: () => toast.success(`Dispatched #${issue.number}`),
        onError: (e) => toast.error((e as Error).message),
      }
    );
  };

  return (
    <div className="bg-muted/20 ml-2 space-y-2 rounded-md border border-dashed p-3 text-sm sm:ml-8">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Filter (gh search, e.g. label:bug sort:created-desc)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setApplied(search)}
          className="h-8 flex-1"
          aria-label={`Search open issues in ${repo.repo_slug}`}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setApplied(search)}
          disabled={q.isFetching}
        >
          {q.isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Search"
          )}
        </Button>
      </div>

      {q.isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading open issues…
        </div>
      ) : q.isError ? (
        <p className="text-destructive py-3 text-xs">
          Couldn&apos;t load issues — is gh installed &amp; authenticated for{" "}
          {repo.repo_slug}?
        </p>
      ) : issues.length === 0 ? (
        <p className="text-muted-foreground py-3 text-xs">
          No open issues{applied ? " match that search" : ""}.
        </p>
      ) : (
        <ul className="space-y-1">
          {issues.map((i) => {
            const meta = i.dispatchStatus
              ? STATUS_META[i.dispatchStatus]
              : null;
            return (
              <li
                key={i.number}
                className="hover:bg-muted/40 flex items-center gap-2 rounded px-2 py-1"
              >
                <a
                  href={i.url || repoUrl(repo.repo_slug)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground shrink-0 font-mono text-xs hover:underline"
                >
                  #{i.number}
                </a>
                <span className="min-w-0 flex-1 truncate" title={i.title}>
                  {i.title}
                </span>
                {i.createdAt && (
                  <span className="text-muted-foreground shrink-0 text-[11px]">
                    {timeAgo(i.createdAt)}
                  </span>
                )}
                {meta ? (
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[11px]",
                      meta.badge
                    )}
                  >
                    {meta.label}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0"
                    disabled={triage.isPending}
                    onClick={() => dispatch(i)}
                    aria-label={`Dispatch issue ${i.number}`}
                  >
                    <Send className="mr-1 h-3 w-3" /> Dispatch
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

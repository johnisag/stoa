"use client";

import { Loader2, GitPullRequest, ExternalLink, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  DispatchRepo,
  DispatchStatus,
  IssueDispatch,
} from "@/lib/dispatch/types";
import { useBoardQuery, useDispatchReposQuery } from "@/data/dispatch/queries";
import { AGENT_BADGE, STATUS_META, repoUrl, timeAgo } from "./shared";

function Card({
  d,
  repo,
}: {
  d: IssueDispatch;
  repo: DispatchRepo | undefined;
}) {
  const meta = STATUS_META[d.status];
  return (
    <div className="bg-card flex flex-col gap-1.5 rounded-md border p-3 text-sm">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[11px] font-medium",
            meta.badge
          )}
        >
          {d.status === "dispatched" && (
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
          )}
          {meta.label}
        </span>
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
        <span className="text-muted-foreground ml-auto text-[11px]">
          {d.dispatched_at
            ? `dispatched ${timeAgo(d.dispatched_at)}`
            : timeAgo(d.created_at)}
        </span>
      </div>

      <a
        href={d.issue_url ?? (repo ? repoUrl(repo.repo_slug) : "#")}
        target="_blank"
        rel="noopener noreferrer"
        className="line-clamp-2 font-medium hover:underline"
        title={d.issue_title ?? undefined}
      >
        #{d.issue_number} {d.issue_title}
      </a>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {repo && (
          <a
            href={repoUrl(repo.repo_slug)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:underline"
          >
            {repo.repo_slug}
            <ExternalLink className="h-3 w-3 opacity-60" />
          </a>
        )}
        {d.branch_name && (
          <span
            className="inline-flex items-center gap-1"
            title="worktree branch"
          >
            <GitBranch className="h-3 w-3" />
            {d.branch_name}
          </span>
        )}
        {d.issue_created_at && (
          <span>raised {timeAgo(d.issue_created_at)}</span>
        )}
      </div>

      {d.pr_url && (
        <a
          href={d.pr_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground inline-flex w-fit items-center gap-1.5 rounded bg-emerald-500/10 px-2 py-1 text-xs font-medium hover:bg-emerald-500/20"
        >
          <GitPullRequest className="h-3.5 w-3.5" />
          PR #{d.pr_number}
          {d.pr_status && (
            <span className="text-muted-foreground">
              ({d.pr_status.toLowerCase()})
            </span>
          )}
        </a>
      )}
    </div>
  );
}

const GROUPS: {
  key: string;
  title: string;
  match: (s: DispatchStatus) => boolean;
}[] = [
  {
    key: "active",
    title: "In flight",
    match: (s) => s === "dispatched" || s === "pr_open",
  },
  { key: "merged", title: "Merged", match: (s) => s === "merged" },
  { key: "failed", title: "Failed", match: (s) => s === "failed" },
];

export function InFlightBoard({ open }: { open: boolean }) {
  const { data: board = [], isLoading } = useBoardQuery(open);
  const { data: repos = [] } = useDispatchReposQuery(open);
  const repoById = new Map<string, DispatchRepo>(repos.map((r) => [r.id, r]));

  if (isLoading)
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading board...
      </div>
    );

  if (board.length === 0)
    return (
      <p className="text-muted-foreground py-10 text-center text-sm">
        Nothing dispatched yet. Approve a candidate in the Backlog (or flip a
        repo to auto mode) and workers will show up here with their PRs.
      </p>
    );

  return (
    <div className="space-y-4">
      {GROUPS.map(({ key, title, match }) => {
        const items = board.filter((d) => match(d.status));
        if (items.length === 0) return null;
        return (
          <section key={key} className="space-y-2">
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              {title} ({items.length})
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {items.map((d) => (
                <Card key={d.id} d={d} repo={repoById.get(d.repo_id)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

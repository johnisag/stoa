"use client";

import { memo, useState } from "react";
import {
  Loader2,
  GitPullRequest,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitCompare,
  RotateCcw,
  RefreshCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmProvider";
import { Button } from "@/components/ui/button";
import { SessionDiffModal } from "@/components/SessionDiffModal";
import type {
  DispatchRepo,
  DispatchStatus,
  IssueDispatch,
} from "@/lib/dispatch/types";
import {
  useBoardQuery,
  useDispatchAction,
  useDispatchReposQuery,
  useMergeDispatch,
} from "@/data/dispatch/queries";
import { AGENT_BADGE, STATUS_META, repoUrl, timeAgo } from "./shared";
import { taskLabel } from "@/lib/dispatch/task-label";

const Card = memo(function Card({
  d,
  repo,
}: {
  d: IssueDispatch;
  repo: DispatchRepo | undefined;
}) {
  const meta = STATUS_META[d.status];
  const [showDiff, setShowDiff] = useState(false);
  const merge = useMergeDispatch();
  const action = useDispatchAction();
  const confirm = useConfirm();
  const isPrOpen = d.status === "pr_open";
  const isFailed = d.status === "failed";
  // Merge lands the PR on its base branch — irreversible from the UI, so confirm
  // first (every other destructive action in the repo routes through useConfirm).
  const doMerge = async () => {
    if (
      !(await confirm({
        title: `Merge PR #${d.pr_number}?`,
        description: "This merges the pull request into its base branch.",
        confirmLabel: "Merge",
        destructive: false,
      }))
    )
      return;
    merge.mutate(d.id, {
      onSuccess: () => toast.success(`Merged PR #${d.pr_number}`),
      onError: (e) => toast.error((e as Error).message),
    });
  };
  const doFailedAction = (act: "retry" | "dismiss") =>
    action.mutate(
      { id: d.id, action: act },
      {
        onSuccess: () =>
          toast.success(act === "retry" ? "Re-dispatched" : "Dismissed"),
        onError: (e) => toast.error((e as Error).message),
      }
    );
  // Re-check this PR against GitHub. If it was merged/closed out of band (someone
  // landed it on github.com), the row resolves; if still open, a no-op. `probe`
  // separates "still open" from "gh unreachable" so we don't claim a false truth.
  const doReconcile = () =>
    action.mutate(
      { id: d.id, action: "reconcile" },
      {
        onSuccess: (data) => {
          const { resolution, probe } = data as {
            resolution?: string;
            probe?: string;
          };
          if (resolution === "merged")
            toast.success(
              `PR #${d.pr_number} was merged on GitHub — moved to Merged`
            );
          else if (resolution === "cancelled")
            toast.success(
              `PR #${d.pr_number} was closed without merging — cleared from the board`
            );
          else if (probe === "error")
            toast.error(
              `Couldn't reach GitHub to check PR #${d.pr_number} — check gh auth/network. Stoa retries automatically.`
            );
          else toast.message(`PR #${d.pr_number} is still open on GitHub`);
        },
        onError: (e) => toast.error((e as Error).message),
      }
    );
  const reconciling =
    action.isPending && action.variables?.action === "reconcile";
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
        {taskLabel(d)}
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
          PR{d.pr_number != null ? ` #${d.pr_number}` : ""}
          {d.pr_status && (
            <span className="text-muted-foreground">
              ({d.pr_status.toLowerCase()})
            </span>
          )}
        </a>
      )}

      {/* Reviewer-gate verdict (advisory) — the critic panel's aggregated verdict.
          Shows "pending" while a gated repo's panel hasn't all weighed in yet. */}
      {(d.review_decision || (repo?.review_gate === 1 && isPrOpen)) && (
        <span
          className={cn(
            "inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
            d.review_decision === "APPROVED"
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : d.review_decision === "CHANGES_REQUESTED"
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                : "bg-muted text-muted-foreground"
          )}
        >
          review:{" "}
          {d.fixer_session_id
            ? "fixing…"
            : d.review_decision === "CHANGES_REQUESTED"
              ? "changes requested"
              : d.review_decision
                ? d.review_decision.toLowerCase().replace(/_/g, " ")
                : "pending"}
          {d.fix_rounds > 0 && ` (round ${d.fix_rounds})`}
        </span>
      )}

      {/* CI auto-fix (advisory) — a fixer is/has been working this PR's red checks
          on a ci_autofix repo. Shows the round count so a stuck PR is visible. */}
      {repo?.ci_autofix === 1 && isPrOpen && d.ci_fixer_session_id && (
        <span className="inline-flex w-fit items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          ci-fix: fixing…
          {d.ci_fix_rounds > 0 && ` (round ${d.ci_fix_rounds})`}
        </span>
      )}

      {/* Auto-rebase (advisory) — the author is rebasing this ready-but-conflicting
          PR back to mergeable. The fixer id is cleared when it finishes, so this
          only shows during an active rebase (not a stuck one). */}
      {repo?.merge_train === 1 && isPrOpen && d.rebase_fixer_session_id && (
        <span className="inline-flex w-fit items-center rounded bg-orange-500/15 px-1.5 py-0.5 text-[11px] font-medium text-orange-600 dark:text-orange-400">
          rebasing…
          {d.rebase_rounds > 0 && ` (round ${d.rebase_rounds})`}
        </span>
      )}

      {/* Verify harness (advisory) — Stoa ran the repo's verify command in the
          worktree. Evidence on the card; gates auto-merge when armed. Output tail
          (fail/error only) is one tap away. */}
      {repo?.verify_gate === 1 && isPrOpen && d.verify_status && (
        <div className="flex flex-col gap-0.5">
          <span
            title={
              d.verify_ran_at
                ? `verified ${timeAgo(d.verify_ran_at)}`
                : undefined
            }
            className={cn(
              "inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
              d.verify_status === "pass"
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : d.verify_status === "fail"
                  ? "bg-red-500/15 text-red-600 dark:text-red-400"
                  : d.verify_status === "error"
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    : "bg-muted text-muted-foreground"
            )}
          >
            {d.verify_status === "pass"
              ? "verified"
              : d.verify_status === "fail"
                ? "verify failed"
                : d.verify_status === "error"
                  ? "verify error"
                  : "verifying…"}
          </span>
          {(d.verify_status === "fail" || d.verify_status === "error") &&
            d.verify_output && (
              <details className="text-xs">
                <summary className="text-muted-foreground cursor-pointer">
                  output
                </summary>
                <pre className="text-muted-foreground bg-muted/50 mt-1 max-h-48 overflow-auto rounded p-2 text-[10px] leading-relaxed whitespace-pre-wrap">
                  {d.verify_output}
                </pre>
              </details>
            )}
        </div>
      )}

      {/* Armed to auto-merge: the reconciler will merge this PR once it's ready
          (no conflicts, checks green, critic-approved if the repo is gated). */}
      {d.auto_merge === 1 && isPrOpen && (
        <span className="inline-flex w-fit items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
          <GitMerge className="h-3 w-3" /> auto-merge
        </span>
      )}

      {/* Review the diff + merge the PR, right from Stoa. Merge is your tap unless
          this row armed auto-merge (badge above). Only while the PR is open. */}
      {isPrOpen && (
        <div className="mt-1 flex items-center gap-2">
          {d.session_id && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowDiff(true)}
            >
              <GitCompare className="h-3.5 w-3.5" /> Review
            </Button>
          )}
          {d.pr_number != null && (
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              onClick={doReconcile}
              title="Re-check this PR on GitHub — resolves the card if it was merged or closed elsewhere"
            >
              {reconciling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Re-check
            </Button>
          )}
          {d.pr_number != null && (
            <Button
              size="sm"
              onClick={doMerge}
              disabled={merge.isPending}
              className="ml-auto"
            >
              {merge.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitMerge className="h-3.5 w-3.5" />
              )}
              Merge
            </Button>
          )}
        </div>
      )}

      {/* Failed rows: retry (re-dispatch fresh) or dismiss (hide; stays parked). */}
      {isFailed && (
        <div className="mt-1 flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={action.isPending}
            onClick={() => doFailedAction("retry")}
          >
            {action.isPending && action.variables?.action === "retry" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            Retry
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Dismiss failed dispatch"
            disabled={action.isPending}
            className="ml-auto"
            onClick={() => doFailedAction("dismiss")}
          >
            <X className="text-muted-foreground hover:text-destructive h-4 w-4" />
          </Button>
        </div>
      )}

      {showDiff && d.session_id && (
        <SessionDiffModal
          sessionId={d.session_id}
          name={taskLabel(d)}
          onClose={() => setShowDiff(false)}
        />
      )}
    </div>
  );
});

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
  const { data: board = [], isLoading, isError } = useBoardQuery(open);
  const { data: repos = [] } = useDispatchReposQuery(open);
  const repoById = new Map<string, DispatchRepo>(repos.map((r) => [r.id, r]));

  if (isLoading)
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading board...
      </div>
    );

  if (isError)
    return (
      <p className="py-10 text-center text-sm text-red-500">
        Failed to load the board. Retrying...
      </p>
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

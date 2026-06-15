"use client";

import { useEffect, useState } from "react";
import { Check, X, Loader2, ExternalLink, Rocket, Clock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DispatchRepo, IssueDispatch } from "@/lib/dispatch/types";
import {
  useCreateIssue,
  useDispatchAction,
  useDispatchReposQuery,
  usePendingQuery,
  useScheduledQuery,
} from "@/data/dispatch/queries";
import { AGENT_BADGE, repoUrl, timeAgo } from "./shared";
import {
  isLocalTask,
  taskLabel,
  maintainerWhy,
} from "@/lib/dispatch/task-label";
import {
  RECURRENCE_OPTIONS,
  recurrenceLabel,
  type Recurrence,
} from "@/lib/dispatch/recurrence";

/** Create a GitHub issue or a local task and either queue it to the backlog or
 * dispatch a worker for it immediately. */
function NewIssueForm({ repos }: { repos: DispatchRepo[] }) {
  const create = useCreateIssue();
  const [repoId, setRepoId] = useState("");
  const [source, setSource] = useState<"github" | "local">("github");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>("once");
  const isLocal = source === "local";
  const [pending, setPending] = useState<
    null | "backlog" | "now" | "scheduled"
  >(null);

  // Keep repoId valid: default to the first repo and re-sync if the list changes
  // (avoids the controlled-Select desync where state and the shown value drift).
  useEffect(() => {
    if (repos.length && !repos.some((r) => r.id === repoId)) {
      setRepoId(repos[0].id);
    }
  }, [repos, repoId]);

  if (repos.length === 0)
    return (
      <p className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-xs">
        Add a repo in the Allocation tab to create and dispatch issues.
      </p>
    );

  const submit = (disposition: "backlog" | "now" | "scheduled") => {
    if (!repoId) return;
    if (!title.trim()) {
      toast.error("A title is required");
      return;
    }
    if (disposition === "scheduled" && Number.isNaN(Date.parse(scheduledAt))) {
      toast.error("Pick a date & time to schedule");
      return;
    }
    if (disposition === "scheduled" && Date.parse(scheduledAt) <= Date.now()) {
      toast.message(
        "That time is in the past — it'll dispatch on the next tick"
      );
    }
    setPending(disposition);
    const taskTitle = title.trim();
    create.mutate(
      {
        repoId,
        source,
        title: taskTitle,
        body,
        // Labels are a GitHub-issue concept only; a local task has none.
        labels: isLocal
          ? []
          : labels
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
        disposition,
        autoMerge,
        ...(disposition === "scheduled"
          ? {
              scheduledAt: new Date(scheduledAt).toISOString(),
              // Recurrence is local-only; the route ignores it for GitHub issues.
              ...(isLocal ? { recurrence } : {}),
            }
          : {}),
      },
      {
        onSuccess: (d) => {
          const what = d.issue ? `#${d.issue.number}` : `"${taskTitle}"`;
          const repeats =
            disposition === "scheduled" && isLocal
              ? recurrenceLabel(recurrence)
              : null;
          const action =
            disposition === "now"
              ? "dispatched"
              : disposition === "scheduled"
                ? `scheduled${repeats ? ` · ${repeats}` : ""}`
                : "added to backlog";
          toast.success(
            `${what} ${action}${autoMerge ? " · auto-merge on" : ""}`
          );
          setTitle("");
          setBody("");
          setLabels("");
          setAutoMerge(false);
          if (disposition === "scheduled") {
            setScheduledAt("");
            setRecurrence("once");
          }
        },
        onError: (e) => toast.error((e as Error).message),
        onSettled: () => setPending(null),
      }
    );
  };

  return (
    <div className="bg-muted/30 space-y-2 rounded-md border border-dashed p-3">
      <p className="text-muted-foreground text-xs">
        {isLocal
          ? "Queues a freeform task — no GitHub issue. A worker drains it through the same review → merge pipeline."
          : "Creates a real GitHub issue on the selected repo, then queues it or dispatches a worker immediately."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={source}
          onValueChange={(v) => setSource(v as "github" | "local")}
        >
          <SelectTrigger className="h-8 w-[130px]" aria-label="Task source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="github">GitHub issue</SelectItem>
            <SelectItem value="local">Local task</SelectItem>
          </SelectContent>
        </Select>
        <Select value={repoId} onValueChange={setRepoId}>
          <SelectTrigger className="h-8 w-[180px]" aria-label="Issue repo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {repos.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.repo_slug}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder={isLocal ? "Task title" : "Issue title"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-8 min-w-[200px] flex-1"
        />
      </div>
      <Textarea
        placeholder={
          isLocal
            ? "Task description — the worker reads this as its brief"
            : "Description (optional)"
        }
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="min-h-[56px] text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        {!isLocal && (
          <Input
            placeholder="Labels (comma-separated)"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            className="h-8 w-48"
          />
        )}
        <label
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
          title="Merge the worker's PR automatically once it's ready (no conflicts, checks green, critic-approved if the repo is review-gated)."
        >
          <Switch
            checked={autoMerge}
            onCheckedChange={setAutoMerge}
            aria-label="Auto-merge the PR when ready"
          />
          auto-merge
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              aria-label="Schedule time"
              className="h-8 w-[190px]"
            />
            {isLocal && (
              <Select
                value={recurrence}
                onValueChange={(v) => setRecurrence(v as Recurrence)}
              >
                <SelectTrigger
                  className="h-8 w-[100px]"
                  aria-label="Repeat"
                  title="Repeat this scheduled task (local tasks only)"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRENCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={create.isPending}
              onClick={() => submit("scheduled")}
            >
              {pending === "scheduled" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Clock className="h-4 w-4" />
              )}
              Schedule
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={create.isPending}
            onClick={() => submit("backlog")}
          >
            {pending === "backlog" && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Add to backlog
          </Button>
          <Button
            size="sm"
            disabled={create.isPending}
            onClick={() => submit("now")}
          >
            {pending === "now" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            Dispatch now
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One scheduled row. Owns its OWN dispatch mutation so its busy/spinner state is
 * per-row — a single shared mutation across rows reflects only the most recent
 * action, lighting the wrong row's spinner under concurrent actions. */
function ScheduledRow({ d, repo }: { d: IssueDispatch; repo?: DispatchRepo }) {
  const action = useDispatchAction();
  const cancel = () =>
    action.mutate(
      { id: d.id, action: "cancel" },
      {
        onSuccess: () => toast.success("Cancelled"),
        onError: (e) => toast.error((e as Error).message),
      }
    );
  return (
    <div className="hover:bg-muted/40 flex items-center gap-3 rounded-md border border-dashed px-3 py-2">
      <Clock className="text-muted-foreground h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-sm font-medium"
            title={d.issue_title ?? undefined}
          >
            {taskLabel(d)}
          </span>
          {isLocalTask(d) && (
            <span className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-[11px] font-medium">
              local
            </span>
          )}
        </div>
        <div className="text-muted-foreground mt-0.5 text-xs">
          {repo?.repo_slug ?? "unknown repo"}
          {d.scheduled_at && (
            <>
              {" "}
              &middot;{" "}
              {new Date(d.scheduled_at).toLocaleString(undefined, {
                timeZoneName: "short",
              })}
            </>
          )}
          {recurrenceLabel(d.recurrence) && (
            <> &middot; {recurrenceLabel(d.recurrence)}</>
          )}
        </div>
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Cancel scheduled"
        disabled={action.isPending}
        onClick={cancel}
      >
        <X className="text-muted-foreground hover:text-destructive h-4 w-4" />
      </Button>
    </div>
  );
}

/** One pending candidate row. Owns its OWN dispatch mutation (per-row busy). */
function PendingRow({ d, repo }: { d: IssueDispatch; repo?: DispatchRepo }) {
  const action = useDispatchAction();
  const busy = action.isPending;
  const act = (a: "approve" | "cancel") =>
    action.mutate(
      { id: d.id, action: a },
      {
        onSuccess: () =>
          toast.success(a === "approve" ? "Dispatched" : "Cancelled"),
        onError: (e) => toast.error((e as Error).message),
      }
    );
  return (
    <div className="hover:bg-muted/40 flex items-center gap-3 rounded-md border px-3 py-2">
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
          {isLocalTask(d) ? (
            <>
              <span
                className="truncate text-sm font-medium"
                title={d.issue_title ?? undefined}
              >
                {taskLabel(d)}
              </span>
              <span className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-[11px] font-medium">
                local
              </span>
              {d.maintainer_proposed === 1 && (
                <span
                  className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-300"
                  title="Proposed by the autonomous maintainer survey — review the rationale, then Approve or Cancel."
                >
                  maintainer
                </span>
              )}
            </>
          ) : (
            <>
              <a
                href={d.issue_url ?? (repo ? repoUrl(repo.repo_slug) : "#")}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-sm font-medium hover:underline"
                title={d.issue_title ?? undefined}
              >
                {taskLabel(d)}
              </a>
              <ExternalLink className="text-muted-foreground h-3 w-3 shrink-0" />
            </>
          )}
        </div>
        <div className="text-muted-foreground mt-0.5 text-xs">
          {repo?.repo_slug ?? "unknown repo"}
          {d.issue_created_at && (
            <> &middot; raised {timeAgo(d.issue_created_at)}</>
          )}
        </div>
        {maintainerWhy(d) && (
          <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs break-words italic">
            why: {maintainerWhy(d)}
          </div>
        )}
        {d.maintainer_proposed === 1 && d.task_body && (
          <details className="mt-0.5">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs select-none">
              view brief
            </summary>
            <pre className="text-muted-foreground bg-muted/50 mt-1 max-h-48 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap">
              {d.task_body}
            </pre>
          </details>
        )}
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => act("approve")}
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
        onClick={() => act("cancel")}
      >
        <X className="text-muted-foreground hover:text-destructive h-4 w-4" />
      </Button>
    </div>
  );
}

export function Backlog({ open }: { open: boolean }) {
  const { data: pending = [], isLoading, isError } = usePendingQuery(open);
  const { data: repos = [] } = useDispatchReposQuery(open);
  const { data: scheduled = [] } = useScheduledQuery(open);
  const repoById = new Map<string, DispatchRepo>(repos.map((r) => [r.id, r]));

  return (
    <div className="space-y-3">
      <NewIssueForm repos={repos} />

      {scheduled.length > 0 && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            {scheduled.length} scheduled — each dispatches automatically within
            ~1 min of its time.
          </p>
          {scheduled.map((d: IssueDispatch) => (
            <ScheduledRow key={d.id} d={d} repo={repoById.get(d.repo_id)} />
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading backlog...
        </div>
      ) : isError ? (
        <p className="py-10 text-center text-sm text-red-500">
          Failed to load the backlog. Retrying...
        </p>
      ) : pending.length === 0 ? (
        <p className="text-muted-foreground py-10 text-center text-sm">
          No candidates waiting. Review-mode repos surface eligible issues here
          for one-tap approval; auto-mode repos dispatch them straight to the
          board.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            {pending.length} candidate{pending.length === 1 ? "" : "s"} awaiting
            approval. Approving spawns a worker immediately (it bypasses the
            daily cap); cancelling drops the candidate.
          </p>
          {pending.map((d: IssueDispatch) => (
            <PendingRow key={d.id} d={d} repo={repoById.get(d.repo_id)} />
          ))}
        </div>
      )}
    </div>
  );
}

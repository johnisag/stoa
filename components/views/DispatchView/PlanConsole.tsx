"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useDispatchReposQuery,
  useStartPlan,
  usePlanPoll,
  useApprovePlan,
  useCancelPlan,
  type PlanTask,
} from "@/data/dispatch/queries";
import { claimsConflict } from "@/lib/dispatch/claims";

/** Editable task row in the proposed partition (claims as a comma/space string). */
interface DraftTask {
  title: string;
  body: string;
  claimsText: string;
}

const toClaims = (t: string): string[] =>
  t
    .split(/[\s,]+/)
    .map((c) => c.trim())
    .filter(Boolean);

/** Indices of tasks whose claims overlap another task's (client-side, via the same
 * pure claimsConflict the server guard uses). */
function overlappingIndices(drafts: DraftTask[]): Set<number> {
  const bad = new Set<number>();
  const claims = drafts.map((d) => toClaims(d.claimsText));
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      if (claimsConflict(claims[i], claims[j])) {
        bad.add(i);
        bad.add(j);
      }
    }
  }
  return bad;
}

/**
 * Plan tab: paste a spec → a planner agent proposes a partition of tasks that each
 * own a disjoint part of the codebase → review/edit (overlaps flagged red) → approve
 * → real issues + claimed dispatch rows. Overlapping tasks serialize automatically.
 */
export function PlanConsole({ open }: { open: boolean }) {
  const { data: repos = [] } = useDispatchReposQuery(open);
  const [repoId, setRepoId] = useState("");
  const [spec, setSpec] = useState("");
  const [taskCap, setTaskCap] = useState("8");
  const [planId, setPlanId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftTask[] | null>(null);

  const start = useStartPlan();
  const poll = usePlanPoll(planId);
  const approve = useApprovePlan();
  const cancel = useCancelPlan();

  // When the poll flips to "ready", seed the editable drafts once.
  const ready = poll.data?.status === "ready" ? poll.data.tasks : null;
  if (ready && drafts === null) {
    setDrafts(
      ready.map((t: PlanTask) => ({
        title: t.title,
        body: t.body,
        claimsText: t.claims.join(", "),
      }))
    );
  }

  const overlaps = useMemo(
    () => (drafts ? overlappingIndices(drafts) : new Set<number>()),
    [drafts]
  );

  const reset = () => {
    setPlanId(null);
    setDrafts(null);
  };

  const propose = async () => {
    if (!repoId || !spec.trim()) {
      toast.error("Pick a repo and paste a spec");
      return;
    }
    try {
      const id = await start.mutateAsync({
        repoId,
        spec: spec.trim(),
        taskCap: Number(taskCap) || 8,
      });
      setDrafts(null);
      setPlanId(id);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to start the planner"
      );
    }
  };

  const doApprove = async () => {
    if (!planId || !drafts) return;
    const tasks: PlanTask[] = drafts
      .map((d) => ({
        title: d.title.trim(),
        body: d.body,
        claims: toClaims(d.claimsText),
      }))
      .filter((t) => t.title && t.claims.length > 0);
    if (tasks.length === 0) {
      toast.error("Each task needs a title and at least one file claim");
      return;
    }
    try {
      const res = await approve.mutateAsync({ planId, tasks });
      toast.success(`Filed ${res.created?.length ?? tasks.length} task(s)`);
      setSpec("");
      reset();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to file the tasks");
    }
  };

  const doCancel = async () => {
    if (planId) await cancel.mutateAsync(planId).catch(() => {});
    reset();
  };

  const planning = !!planId && poll.data?.status !== "ready";

  return (
    <div className="space-y-4">
      {/* Entry form */}
      {!planId && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={repoId} onValueChange={setRepoId}>
              <SelectTrigger className="h-9 w-[260px]">
                <SelectValue placeholder="Repository" />
              </SelectTrigger>
              <SelectContent>
                {repos.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.repo_slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="text-muted-foreground flex items-center gap-1 text-xs">
              <Input
                type="number"
                min={1}
                max={20}
                value={taskCap}
                onChange={(e) => setTaskCap(e.target.value)}
                className="h-9 w-16"
              />
              max tasks
            </label>
          </div>
          <Textarea
            placeholder="Paste a spec, or describe a milestone. The planner will split it into tasks that each own a different part of the codebase, so several agents can work at once without colliding."
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            className="min-h-[140px]"
          />
          <Button onClick={propose} disabled={start.isPending}>
            {start.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-4 w-4" />
            )}
            Propose partition
          </Button>
        </div>
      )}

      {/* Planning in progress */}
      {planning && (
        <div className="flex items-center justify-between rounded-md border p-3 text-sm">
          <span className="text-muted-foreground flex items-center gap-2">
            {poll.data?.status === "failed" ? (
              <>
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                {poll.data.error}
              </>
            ) : (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Planning… the agent is reading the repo and proposing a split.
              </>
            )}
          </span>
          <Button size="sm" variant="ghost" onClick={doCancel}>
            Cancel
          </Button>
        </div>
      )}

      {/* Review the partition */}
      {drafts && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">
              Proposed partition ({drafts.length})
            </h3>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={doCancel}>
                Discard
              </Button>
              <Button
                size="sm"
                onClick={doApprove}
                disabled={approve.isPending}
                title={
                  overlaps.size > 0
                    ? "Overlapping tasks will be serialized, not co-scheduled"
                    : undefined
                }
              >
                {approve.isPending && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                {overlaps.size > 0 ? "Approve anyway" : "Approve & file"}
              </Button>
            </div>
          </div>

          {drafts.map((d, i) => (
            <div
              key={i}
              className={`space-y-2 rounded-md border p-3 ${overlaps.has(i) ? "border-red-500/50" : ""}`}
            >
              <div className="flex items-center gap-2">
                <Input
                  value={d.title}
                  onChange={(e) =>
                    setDrafts((ds) =>
                      ds!.map((x, k) =>
                        k === i ? { ...x, title: e.target.value } : x
                      )
                    )
                  }
                  className="h-8 flex-1 font-medium"
                  placeholder="Task title"
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove task"
                  onClick={() =>
                    setDrafts((ds) => ds!.filter((_, k) => k !== i))
                  }
                >
                  <Trash2 className="text-muted-foreground h-4 w-4" />
                </Button>
              </div>
              <label className="text-muted-foreground block text-xs">
                Owns (path prefixes, space/comma separated)
                <Input
                  value={d.claimsText}
                  onChange={(e) =>
                    setDrafts((ds) =>
                      ds!.map((x, k) =>
                        k === i ? { ...x, claimsText: e.target.value } : x
                      )
                    )
                  }
                  className={`mt-1 h-8 font-mono text-xs ${overlaps.has(i) ? "border-red-500/50" : ""}`}
                  placeholder="lib/dispatch/  lib/db/schema.ts"
                />
              </label>
              {overlaps.has(i) && (
                <p className="flex items-center gap-1 text-xs text-red-500">
                  <AlertTriangle className="h-3 w-3" /> Overlaps another task —
                  these will run one after another, not in parallel.
                </p>
              )}
              <details className="text-muted-foreground text-xs">
                <summary className="cursor-pointer">Body</summary>
                <Textarea
                  value={d.body}
                  onChange={(e) =>
                    setDrafts((ds) =>
                      ds!.map((x, k) =>
                        k === i ? { ...x, body: e.target.value } : x
                      )
                    )
                  }
                  className="mt-1 min-h-[80px] text-xs"
                />
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

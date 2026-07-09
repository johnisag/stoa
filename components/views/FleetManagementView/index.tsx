"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  GitBranch,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
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
import { useDispatchReposQuery } from "@/data/dispatch/queries";
import {
  useCreateFleetRun,
  useFleetRunQuery,
  useFleetRunsQuery,
} from "@/data/fleet/queries";
import { useProjectsQuery } from "@/data/projects/queries";
import type {
  FleetReviewPolicy,
  FleetRunDetailDto,
  FleetRunDto,
} from "@/lib/fleet/types";
import {
  FLEET_MODEL_MAX,
  FLEET_PROVIDER_MAX,
  FLEET_RUN_GOAL_MAX,
  FLEET_RUN_NAME_MAX,
} from "@/lib/fleet/engine";
import { cn } from "@/lib/utils";

const NONE = "__none__";

function labelDate(value: string) {
  return value.replace("T", " ").replace("Z", "");
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: FleetRunDto;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "hover:bg-accent/60 flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-border bg-background"
      )}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{run.name}</span>
        <span className="text-muted-foreground bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
          {run.status}
        </span>
      </span>
      <span className="text-muted-foreground line-clamp-2 text-xs">
        {run.goal}
      </span>
      <span className="text-muted-foreground flex items-center gap-2 text-[11px]">
        <span>{run.taskCount} tasks</span>
        <span>{run.workerCount} workers</span>
      </span>
    </button>
  );
}

function ApprovalPreview({ detail }: { detail: FleetRunDetailDto }) {
  const preview = detail.run.approvalPreview;
  return (
    <section className="rounded-md border p-3">
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" />
        <h3 className="text-sm font-medium">Approval preview</h3>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase">
            Required gates
          </div>
          <div className="flex flex-wrap gap-1.5">
            {preview.requiredGates.map((gate) => (
              <span
                key={gate}
                className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
              >
                {gate}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase">
            Disabled in draft
          </div>
          <div className="flex flex-wrap gap-1.5">
            {preview.blockedActions.map((action) => (
              <span
                key={action}
                className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300"
              >
                {action}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function RunDetail({ detail }: { detail: FleetRunDetailDto }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-4">
      <section className="grid gap-3 rounded-md border p-3 md:grid-cols-4">
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Status
          </div>
          <div className="text-sm font-medium">{detail.run.status}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Provider
          </div>
          <div className="text-sm">
            {detail.run.provider}
            {detail.run.model ? ` / ${detail.run.model}` : ""}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Concurrency
          </div>
          <div className="text-sm">{detail.run.maxConcurrency}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Budget
          </div>
          <div className="text-sm">
            {detail.run.budgetUsd == null
              ? "Unset"
              : `$${detail.run.budgetUsd.toFixed(2)}`}
          </div>
        </div>
      </section>

      <ApprovalPreview detail={detail} />

      <section className="rounded-md border">
        <div className="border-b px-3 py-2">
          <h3 className="text-sm font-medium">Task graph</h3>
        </div>
        <div className="grid gap-2 p-3">
          {detail.tasks.length === 0 ? (
            <p className="text-muted-foreground text-sm">No tasks</p>
          ) : (
            detail.tasks.map((task) => (
              <div
                key={task.id}
                className="grid gap-2 rounded border px-3 py-2 md:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {task.title}
                  </div>
                  {task.description && (
                    <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                      {task.description}
                    </div>
                  )}
                </div>
                <div className="flex items-start gap-1">
                  <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
                    {task.status}
                  </span>
                  <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
                    {task.taskType}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border">
          <div className="border-b px-3 py-2">
            <h3 className="text-sm font-medium">Workers</h3>
          </div>
          <div className="p-3">
            {detail.workers.length === 0 ? (
              <p className="text-muted-foreground text-sm">No workers</p>
            ) : (
              <div className="grid gap-2">
                {detail.workers.map((worker) => (
                  <div key={worker.id} className="rounded border px-3 py-2">
                    <div className="text-sm font-medium">{worker.status}</div>
                    <div className="text-muted-foreground text-xs">
                      attempt {worker.attempt}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-md border">
          <div className="border-b px-3 py-2">
            <h3 className="text-sm font-medium">Events</h3>
          </div>
          <div className="grid gap-2 p-3">
            {detail.events.map((event) => (
              <div key={event.id} className="rounded border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{event.eventType}</span>
                  <span className="text-muted-foreground text-xs">
                    {labelDate(event.createdAt)}
                  </span>
                </div>
                <div className="text-muted-foreground text-xs">
                  {event.actor}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export function FleetManagementView({ onClose }: { onClose?: () => void }) {
  const runs = useFleetRunsQuery(true);
  const repos = useDispatchReposQuery(true);
  const projects = useProjectsQuery();
  const createRun = useCreateFleetRun();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [repoId, setRepoId] = useState(NONE);
  const [projectId, setProjectId] = useState(NONE);
  const [budgetUsd, setBudgetUsd] = useState("");
  const [provider, setProvider] = useState("claude");
  const [model, setModel] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [reviewPolicy, setReviewPolicy] =
    useState<FleetReviewPolicy>("four_agent");

  const selectedRun = useMemo(
    () => (runs.data ?? []).find((run) => run.id === selectedRunId) ?? null,
    [runs.data, selectedRunId]
  );
  const detail = useFleetRunQuery(selectedRunId, selectedRunId != null);

  useEffect(() => {
    if (!selectedRunId && runs.data?.[0]) setSelectedRunId(runs.data[0].id);
  }, [runs.data, selectedRunId]);

  async function handleCreateRun() {
    try {
      const created = await createRun.mutateAsync({
        name,
        goal,
        repoId: repoId === NONE ? null : repoId,
        projectId: projectId === NONE ? null : projectId,
        budgetUsd: budgetUsd.trim() ? Number(budgetUsd) : null,
        provider,
        model: model.trim() || null,
        maxConcurrency,
        reviewPolicy,
      });
      setSelectedRunId(created.run.id);
      setName("");
      setGoal("");
      setBudgetUsd("");
    } catch {
      // React Query owns the rendered error state.
    }
  }

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <Network className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium">Fleet Management</span>
          <span className="text-muted-foreground text-xs">
            {runs.data?.length ?? 0} runs
          </span>
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh Fleet Management"
            onClick={() => {
              void runs.refetch();
              if (selectedRunId) void detail.refetch();
            }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close Fleet Management"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto border-t lg:grid-cols-[22rem_minmax(0,1fr)] lg:overflow-hidden">
        <aside className="flex min-h-0 flex-col gap-3 border-r p-4">
          <section className="rounded-md border p-3">
            <div className="mb-3 flex items-center gap-2">
              <Plus className="h-4 w-4" />
              <h3 className="text-sm font-medium">Draft run</h3>
            </div>
            <div className="grid gap-2">
              <Input
                aria-label="Fleet run name"
                placeholder="Name"
                maxLength={FLEET_RUN_NAME_MAX}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Textarea
                aria-label="Fleet run goal"
                placeholder="Goal"
                maxLength={FLEET_RUN_GOAL_MAX}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
              <Select value={repoId} onValueChange={setRepoId}>
                <SelectTrigger aria-label="Repository">
                  <SelectValue placeholder="Repository" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No repository</SelectItem>
                  {(repos.data ?? []).map((repo) => (
                    <SelectItem key={repo.id} value={repo.id}>
                      {repo.repo_slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger aria-label="Project">
                  <SelectValue placeholder="Project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No project</SelectItem>
                  {(projects.data ?? []).map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  aria-label="Budget USD"
                  inputMode="decimal"
                  placeholder="Budget"
                  value={budgetUsd}
                  onChange={(event) => setBudgetUsd(event.target.value)}
                />
                <Input
                  aria-label="Max concurrency"
                  type="number"
                  min={1}
                  max={40}
                  value={maxConcurrency}
                  onChange={(event) =>
                    setMaxConcurrency(Number(event.target.value))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  aria-label="Provider"
                  placeholder="Provider"
                  maxLength={FLEET_PROVIDER_MAX}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                />
                <Input
                  aria-label="Model"
                  placeholder="Model"
                  maxLength={FLEET_MODEL_MAX}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              </div>
              <Select
                value={reviewPolicy}
                onValueChange={(value) =>
                  setReviewPolicy(value as FleetReviewPolicy)
                }
              >
                <SelectTrigger aria-label="Review policy">
                  <SelectValue placeholder="Review policy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="four_agent">Four-agent</SelectItem>
                  <SelectItem value="four_agent_plus_red_team">
                    Four-agent + red-team
                  </SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
              <Button
                className="gap-2"
                disabled={!name.trim() || !goal.trim() || createRun.isPending}
                onClick={() => void handleCreateRun()}
              >
                {createRun.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Create draft
              </Button>
              {createRun.isError && (
                <div className="text-destructive flex items-center gap-2 text-xs">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {createRun.error.message}
                </div>
              )}
            </div>
          </section>

          <section className="lg:min-h-0 lg:flex-1 lg:overflow-auto">
            <div className="mb-2 flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              <h3 className="text-sm font-medium">Runs</h3>
            </div>
            {runs.isLoading ? (
              <div className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading
              </div>
            ) : runs.isError ? (
              <div className="text-destructive flex items-center gap-2 py-4 text-sm">
                <AlertCircle className="h-4 w-4" />
                {runs.error.message}
              </div>
            ) : runs.data?.length === 0 ? (
              <div className="text-muted-foreground py-4 text-sm">
                No fleet runs
              </div>
            ) : (
              <div className="grid gap-2">
                {(runs.data ?? []).map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    selected={selectedRun?.id === run.id}
                    onSelect={() => setSelectedRunId(run.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </aside>

        <main className="flex min-h-0 flex-col lg:overflow-hidden">
          {selectedRunId == null ? (
            <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
              Select or create a fleet run
            </div>
          ) : detail.isLoading ? (
            <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-6 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading
            </div>
          ) : detail.isError ? (
            <div className="text-destructive flex flex-1 items-center justify-center gap-2 p-6 text-sm">
              <AlertCircle className="h-4 w-4" />
              {detail.error.message}
            </div>
          ) : detail.data ? (
            <>
              <div className="px-4 py-3">
                <h2 className="truncate text-lg font-semibold">
                  {detail.data.run.name}
                </h2>
                <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                  {detail.data.run.goal}
                </p>
              </div>
              <RunDetail detail={detail.data} />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

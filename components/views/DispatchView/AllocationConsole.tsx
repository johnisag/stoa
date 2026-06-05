"use client";

import { useState } from "react";
import { Plus, Trash2, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AGENT_OPTIONS } from "@/components/NewSessionDialog/NewSessionDialog.types";
import type { AgentType } from "@/lib/providers";
import type { DispatchRepo } from "@/lib/dispatch/types";
import {
  useCreateRepo,
  useDeleteRepo,
  useDispatchReposQuery,
  useUpdateRepo,
  type CreateRepoInput,
  type UpdateRepoPatch,
} from "@/data/dispatch/queries";
import { AGENT_BADGE, repoUrl } from "./shared";

const EMPTY: CreateRepoInput = {
  repoPath: "",
  repoSlug: "",
  agentType: "claude",
  dailyQuota: 1,
  maxConcurrency: 1,
  labelFilter: null,
  baseBranch: "main",
  mode: "review",
  enabled: false,
};

function ModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: "auto" | "review";
  onChange: (v: "auto" | "review") => void;
  disabled?: boolean;
}) {
  return (
    <div className="bg-muted inline-flex rounded-md p-0.5 text-xs">
      {(["review", "auto"] as const).map((m) => (
        <button
          key={m}
          type="button"
          disabled={disabled}
          onClick={() => value !== m && onChange(m)}
          className={cn(
            "rounded px-2 py-0.5 capitalize transition-colors",
            value === m
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function RepoRow({ repo }: { repo: DispatchRepo }) {
  const update = useUpdateRepo();
  const del = useDeleteRepo();
  const [quota, setQuota] = useState(String(repo.daily_quota));
  const [conc, setConc] = useState(String(repo.max_concurrency));
  const [label, setLabel] = useState(repo.label_filter ?? "");

  const patch = (p: UpdateRepoPatch) =>
    update.mutate(
      { id: repo.id, patch: p },
      { onError: (e) => toast.error((e as Error).message) }
    );

  const commitNumber = (
    raw: string,
    current: number,
    key: "dailyQuota" | "maxConcurrency",
    min: number
  ) => {
    const n = Math.max(min, Math.floor(Number(raw)));
    if (Number.isFinite(n) && n !== current)
      patch(key === "dailyQuota" ? { dailyQuota: n } : { maxConcurrency: n });
  };

  return (
    <div className="hover:bg-muted/40 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-sm">
      {/* enabled */}
      <Switch
        checked={repo.enabled === 1}
        onCheckedChange={(v) => patch({ enabled: v })}
        aria-label={repo.enabled === 1 ? "Disable repo" : "Enable repo"}
      />

      {/* slug + path */}
      <div className="min-w-0 flex-1">
        <a
          href={repoUrl(repo.repo_slug)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium hover:underline"
        >
          {repo.repo_slug}
          <ExternalLink className="h-3 w-3 opacity-60" />
        </a>
        <div
          className="text-muted-foreground truncate text-xs"
          title={repo.repo_path}
        >
          {repo.repo_path}
        </div>
      </div>

      {/* agent */}
      <Select
        value={repo.agent_type}
        onValueChange={(v) => patch({ agentType: v as AgentType })}
      >
        <SelectTrigger className="h-8 w-[120px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AGENT_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* quota / day */}
      <label className="text-muted-foreground flex items-center gap-1 text-xs">
        <Input
          type="number"
          min={0}
          value={quota}
          onChange={(e) => setQuota(e.target.value)}
          onBlur={() => commitNumber(quota, repo.daily_quota, "dailyQuota", 0)}
          className="h-8 w-16"
        />
        / day
      </label>

      {/* concurrency */}
      <label className="text-muted-foreground flex items-center gap-1 text-xs">
        <Input
          type="number"
          min={1}
          value={conc}
          onChange={(e) => setConc(e.target.value)}
          onBlur={() =>
            commitNumber(conc, repo.max_concurrency, "maxConcurrency", 1)
          }
          className="h-8 w-16"
        />
        conc.
      </label>

      {/* label filter */}
      <Input
        placeholder="label filter"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => {
          const next = label.trim() || null;
          if (next !== repo.label_filter) patch({ labelFilter: next });
        }}
        className="h-8 w-28"
      />

      {/* mode */}
      <ModeToggle value={repo.mode} onChange={(m) => patch({ mode: m })} />

      {/* delete */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Remove repo"
        onClick={() => {
          if (
            confirm(
              `Stop tracking ${repo.repo_slug}? In-flight workers are unaffected.`
            )
          )
            del.mutate(repo.id, {
              onError: (e) => toast.error((e as Error).message),
            });
        }}
      >
        <Trash2 className="text-muted-foreground hover:text-destructive h-4 w-4" />
      </Button>
    </div>
  );
}

function AddRepoForm() {
  const create = useCreateRepo();
  const [form, setForm] = useState<CreateRepoInput>(EMPTY);
  const set = <K extends keyof CreateRepoInput>(k: K, v: CreateRepoInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    if (!form.repoPath.trim() || !form.repoSlug.trim()) {
      toast.error("Repo path and owner/name are required");
      return;
    }
    create.mutate(
      { ...form, labelFilter: form.labelFilter?.trim() || null },
      {
        onSuccess: () => {
          toast.success(`Tracking ${form.repoSlug}`);
          setForm(EMPTY);
        },
        onError: (e) => toast.error((e as Error).message),
      }
    );
  };

  return (
    <div className="bg-muted/30 space-y-3 rounded-md border border-dashed p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input
          placeholder="Local checkout path (e.g. C:\\repos\\app)"
          value={form.repoPath}
          onChange={(e) => set("repoPath", e.target.value)}
        />
        <Input
          placeholder="owner/name (for gh)"
          value={form.repoSlug}
          onChange={(e) => set("repoSlug", e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={form.agentType}
          onValueChange={(v) => set("agentType", v as AgentType)}
        >
          <SelectTrigger className="h-8 w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGENT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="text-muted-foreground flex items-center gap-1 text-xs">
          <Input
            type="number"
            min={0}
            value={form.dailyQuota}
            onChange={(e) =>
              set("dailyQuota", Math.max(0, Number(e.target.value)))
            }
            className="h-8 w-16"
          />
          / day
        </label>
        <label className="text-muted-foreground flex items-center gap-1 text-xs">
          <Input
            type="number"
            min={1}
            value={form.maxConcurrency}
            onChange={(e) =>
              set("maxConcurrency", Math.max(1, Number(e.target.value)))
            }
            className="h-8 w-16"
          />
          conc.
        </label>
        <Input
          placeholder="label filter (optional)"
          value={form.labelFilter ?? ""}
          onChange={(e) => set("labelFilter", e.target.value || null)}
          className="h-8 w-32"
        />
        <Input
          placeholder="base"
          value={form.baseBranch}
          onChange={(e) => set("baseBranch", e.target.value)}
          className="h-8 w-20"
        />
        <ModeToggle value={form.mode} onChange={(m) => set("mode", m)} />
        <label className="flex items-center gap-1.5 text-xs">
          <Switch
            checked={form.enabled}
            onCheckedChange={(v) => set("enabled", v)}
          />
          enabled
        </label>
        <Button
          size="sm"
          onClick={submit}
          disabled={create.isPending}
          className="ml-auto"
        >
          {create.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add repo
        </Button>
      </div>
    </div>
  );
}

export function AllocationConsole({ open }: { open: boolean }) {
  const { data: repos = [], isLoading } = useDispatchReposQuery(open);

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Allocate an agent to each repo and a daily issue quota. In{" "}
        <span className="font-medium">review</span> mode candidates wait for
        your approval in the Backlog; in{" "}
        <span className="font-medium">auto</span> mode they dispatch on the next
        tick up to the quota/concurrency caps. Disabled repos are skipped
        entirely.
      </p>
      <AddRepoForm />
      {isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading repos...
        </div>
      ) : repos.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          No repos tracked yet. Add one above to start dispatching.
        </p>
      ) : (
        <div className="space-y-2">
          {repos.map((r) => (
            <RepoRow key={r.id} repo={r} />
          ))}
        </div>
      )}
      {/* legend */}
      <div className="text-muted-foreground flex flex-wrap gap-3 pt-1 text-[11px]">
        {AGENT_OPTIONS.map((o) => (
          <span key={o.value} className="inline-flex items-center gap-1">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                AGENT_BADGE[o.value]?.split(" ")[0]
              )}
            />
            {o.label}
          </span>
        ))}
      </div>
    </div>
  );
}

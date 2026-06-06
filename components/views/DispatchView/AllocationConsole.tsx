"use client";

import { useRef, useState } from "react";
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
  useDiscoverQuery,
  useDispatchReposQuery,
  useGitHubReposQuery,
  usePrepareRepo,
  useResolveSource,
  useUpdateRepo,
  type CreateRepoInput,
  type UpdateRepoPatch,
} from "@/data/dispatch/queries";
import { useProjectsQuery } from "@/data/projects";
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
  reviewGate: false,
};

/** A small single-select segmented control (radiogroup). Shared by the mode
 * toggle and the add-repo source picker so they stay visually + a11y identical. */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="bg-muted inline-flex rounded-md p-0.5 text-xs"
    >
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          disabled={disabled}
          onClick={() => value !== o && onChange(o)}
          className={cn(
            "rounded px-2.5 py-0.5 capitalize transition-colors",
            value === o
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

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
    <SegmentedControl
      options={["review", "auto"] as const}
      value={value}
      onChange={onChange}
      ariaLabel="Dispatch mode"
      disabled={disabled}
    />
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

      {/* reviewer gate (opt-in): spawn a critic agent on each worker's PR */}
      <label
        className="text-muted-foreground flex items-center gap-1 text-xs"
        title="Spawn an independent critic agent to review each worker's PR"
      >
        <Switch
          checked={repo.review_gate === 1}
          onCheckedChange={(v) => patch({ reviewGate: v })}
          aria-label={
            repo.review_gate === 1
              ? "Disable reviewer gate"
              : "Enable reviewer gate"
          }
        />
        critic
      </label>

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

  // ── source picker ── (auto-fill path/slug/branch instead of typing them)
  const projectsQ = useProjectsQuery();
  const resolve = useResolveSource();
  const projects = (projectsQ.data ?? []).filter((p) => !p.is_uncategorized);
  const [source, setSource] = useState<
    "manual" | "project" | "scan" | "github"
  >("manual");
  // Scan + github are lazy: they only run while their source is selected.
  const discoverQ = useDiscoverQuery(source === "scan");
  const discovered = discoverQ.data ?? [];
  const githubQ = useGitHubReposQuery(source === "github");
  const githubRepos = githubQ.data?.repos ?? [];
  const cloneRoot = githubQ.data?.cloneRoot ?? null;
  const prepare = usePrepareRepo();

  // Track the latest pick so a slow earlier resolve can't clobber a newer one.
  const lastPickedRef = useRef<string | null>(null);

  // Prefill the path immediately, then resolve owner/name + default branch and
  // fill those too. Shared by the project + scan sources (keyed on the path so a
  // slow earlier resolve can't overwrite a newer pick).
  const fillFromPath = (dir: string, label: string) => {
    lastPickedRef.current = dir;
    set("repoPath", dir);
    resolve.mutate(dir, {
      onSuccess: (r) => {
        if (lastPickedRef.current !== dir) return; // superseded by a newer pick
        if (!r.isGitRepo) {
          toast.error(`${label} isn't a git repo — enter owner/name manually`);
          return;
        }
        if (r.slug) set("repoSlug", r.slug);
        if (r.defaultBranch) set("baseBranch", r.defaultBranch);
        if (!r.slug)
          toast.message("Couldn't detect owner/name — add it manually");
      },
      onError: (e) => {
        if (lastPickedRef.current !== dir) return;
        toast.error((e as Error).message);
      },
    });
  };

  const pickProject = (projectId: string) => {
    const p = projects.find((x) => x.id === projectId);
    if (!p) return;
    const dir = p.working_directory?.trim();
    if (!dir || dir === "~") {
      toast.error(`${p.name} has no checkout path — enter it manually`);
      return;
    }
    fillFromPath(dir, p.name);
  };

  // Pick a GitHub repo → fill slug + branch from the listing immediately, then
  // ensure it's cloned locally (clone-if-needed) and fill the resulting path.
  const pickGitHub = (slug: string) => {
    const repo = githubRepos.find((r) => r.slug === slug);
    lastPickedRef.current = slug;
    set("repoSlug", slug);
    if (repo?.defaultBranch) set("baseBranch", repo.defaultBranch);
    prepare.mutate(slug, {
      onSuccess: (p) => {
        if (lastPickedRef.current !== slug) return; // superseded by a newer pick
        set("repoPath", p.path);
        if (p.defaultBranch) set("baseBranch", p.defaultBranch);
        toast.success(p.cloned ? `Cloned ${slug}` : `Found ${slug} locally`);
      },
      onError: (e) => {
        if (lastPickedRef.current !== slug) return;
        toast.error((e as Error).message);
      },
    });
  };

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
      {/* Source picker — auto-fill from a Stoa project, a scanned local repo, or
          a GitHub repo (cloned locally on demand) instead of typing the path. */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          options={["manual", "project", "scan", "github"] as const}
          value={source}
          ariaLabel="Repo source"
          onChange={(s) => {
            setSource(s);
            // Drop any in-flight pick from the previous source so its late
            // resolve/clone can't write into the form or keep the spinner up.
            lastPickedRef.current = null;
            resolve.reset();
            prepare.reset();
          }}
        />
        {source === "project" && (
          <Select onValueChange={pickProject} disabled={projectsQ.isLoading}>
            <SelectTrigger
              className="h-8 w-[220px]"
              aria-label="Source project"
            >
              <SelectValue
                placeholder={
                  projectsQ.isLoading
                    ? "Loading projects…"
                    : projects.length
                      ? "Pick a project to auto-fill"
                      : "No projects yet"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {source === "scan" &&
          (discoverQ.isError ? (
            <span className="text-destructive text-xs">
              Scan failed — enter the path manually
            </span>
          ) : (
            <Select
              onValueChange={(dir) => {
                const hit = discovered.find((x) => x.path === dir);
                fillFromPath(dir, hit?.name ?? dir);
              }}
              disabled={discoverQ.isLoading || discovered.length === 0}
            >
              <SelectTrigger
                className="h-8 w-[260px]"
                aria-label="Scanned repo"
              >
                <SelectValue
                  placeholder={
                    discoverQ.isLoading
                      ? "Scanning…"
                      : discovered.length
                        ? "Pick a discovered repo"
                        : "No local repos found"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {discovered.map((r) => (
                  <SelectItem key={r.path} value={r.path}>
                    {r.name}
                    <span className="text-muted-foreground ml-2 text-xs">
                      {r.path}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
        {source === "github" &&
          (githubQ.isError ? (
            <span className="text-destructive text-xs">
              gh failed — is the GitHub CLI installed &amp; authenticated?
            </span>
          ) : (
            <Select
              onValueChange={pickGitHub}
              disabled={githubQ.isLoading || githubRepos.length === 0}
            >
              <SelectTrigger className="h-8 w-[260px]" aria-label="GitHub repo">
                <SelectValue
                  placeholder={
                    githubQ.isLoading
                      ? "Loading repos…"
                      : githubRepos.length
                        ? "Pick a GitHub repo"
                        : "No repos found"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {githubRepos.map((r) => (
                  <SelectItem key={r.slug} value={r.slug}>
                    {r.slug}
                    {r.isPrivate && (
                      <span className="text-muted-foreground ml-2 text-xs">
                        private
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
        {source === "github" && !githubQ.isError && githubRepos.length > 0 && (
          <span className="text-muted-foreground text-xs">
            {cloneRoot
              ? `clones to ${cloneRoot}`
              : "set STOA_CLONE_ROOT to clone"}
          </span>
        )}
        {source !== "manual" && (resolve.isPending || prepare.isPending) && (
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
        )}
      </div>
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
              set(
                "dailyQuota",
                Math.max(0, Math.floor(Number(e.target.value)) || 0)
              )
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
              set(
                "maxConcurrency",
                Math.max(1, Math.floor(Number(e.target.value)) || 1)
              )
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
            aria-label="Enable on create"
          />
          enabled
        </label>
        <Button
          size="sm"
          onClick={submit}
          disabled={create.isPending || resolve.isPending || prepare.isPending}
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
  const { data: repos = [], isLoading, isError } = useDispatchReposQuery(open);

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
      ) : isError ? (
        <p className="py-6 text-center text-sm text-red-500">
          Failed to load repos. Retrying...
        </p>
      ) : repos.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          No repos tracked yet. Add one above to start dispatching.
        </p>
      ) : (
        <div className="space-y-2">
          {repos.map((r) => (
            // composite key: remount the row (re-seeding its local input state)
            // when the server values change out from under it (another tab, the
            // reconciler), so the quota/concurrency/label fields don't go stale.
            <RepoRow
              key={`${r.id}:${r.daily_quota}:${r.max_concurrency}:${r.label_filter ?? ""}`}
              repo={r}
            />
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

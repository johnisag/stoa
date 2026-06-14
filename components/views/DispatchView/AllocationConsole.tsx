"use client";

import { useRef, useState } from "react";
import {
  Plus,
  Trash2,
  ExternalLink,
  Loader2,
  Inbox,
  Brain,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
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
import { RECURRENCE_OPTIONS } from "@/lib/dispatch/recurrence";
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
import { OpenIssuesBrowser } from "./OpenIssuesBrowser";
import { LessonsDialog } from "./LessonsDialog";

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
  ciAutofix: false,
  mergeTrain: false,
  verifyGate: false,
  verifyCommand: "",
};

// Survey cadences — the recurring options only ("once" makes no sense for a
// repeating maintenance survey). Reuses the cron picker's list so they stay in sync.
const MAINTAINER_CADENCE_OPTIONS = RECURRENCE_OPTIONS.filter(
  (o) => o.value !== "once"
);

/** Compact single-select strip — the same shared {@link SegmentedTabs} as the
 * fleet dialogs, but sized DOWN to sit inline among form fields: drop the
 * 40px touch-target min-height + roomy padding (right for the dialog tab strips,
 * chunky for these dense toggles) back to the original compact form. `onChange`
 * fires on every click, so callers guard same-value clicks to avoid a redundant
 * mutation/reset. */
const SEGMENTED_TAB_CLASS = "min-h-0 px-2.5 py-0.5 text-xs capitalize";

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
    <SegmentedTabs
      ariaLabel="Dispatch mode"
      value={value}
      onChange={(v) => value !== v && onChange(v)}
      disabled={disabled}
      tabClassName={SEGMENTED_TAB_CLASS}
      tabs={[
        { key: "review", label: "review" },
        { key: "auto", label: "auto" },
      ]}
    />
  );
}

function RepoRow({ repo }: { repo: DispatchRepo }) {
  const update = useUpdateRepo();
  const del = useDeleteRepo();
  const confirm = useConfirm();
  const [quota, setQuota] = useState(String(repo.daily_quota));
  const [conc, setConc] = useState(String(repo.max_concurrency));
  const [label, setLabel] = useState(repo.label_filter ?? "");
  const [verifyCmd, setVerifyCmd] = useState(repo.verify_command ?? "");
  const [maintainGoal, setMaintainGoal] = useState(
    repo.maintainer_survey_goal ?? ""
  );
  const [browsing, setBrowsing] = useState(false);
  const [showLessons, setShowLessons] = useState(false);

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
    <div className="space-y-2">
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
            onBlur={() =>
              commitNumber(quota, repo.daily_quota, "dailyQuota", 0)
            }
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

        {/* CI auto-fix (opt-in): spawn a fixer on a worker's PR with red checks */}
        <label
          className="text-muted-foreground flex items-center gap-1 text-xs"
          title="Auto-fix failing CI on each worker's PR (read the failures, fix, push)"
        >
          <Switch
            checked={repo.ci_autofix === 1}
            onCheckedChange={(v) => patch({ ciAutofix: v })}
            aria-label={
              repo.ci_autofix === 1
                ? "Disable CI auto-fix"
                : "Enable CI auto-fix"
            }
          />
          ci-fix
        </label>

        {/* Auto-rebase (opt-in): rebase-and-repair a ready-but-conflicting PR */}
        <label
          className="text-muted-foreground flex items-center gap-1 text-xs"
          title="Auto-rebase: once a PR is approved and green but conflicts with the base, its author rebases, resolves the conflicts, and force-pushes — a couple of tries, then it's flagged for you. (Not a merge queue — it keeps PRs landable; merging is still your tap or auto-merge.)"
        >
          <Switch
            checked={repo.merge_train === 1}
            onCheckedChange={(v) => patch({ mergeTrain: v })}
            aria-label={
              repo.merge_train === 1
                ? "Disable auto-rebase"
                : "Enable auto-rebase"
            }
          />
          rebase
        </label>

        {/* Verify harness (opt-in): run the repo's verify command in each worktree */}
        <label
          className="text-muted-foreground flex items-center gap-1 text-xs"
          title="Run this repo's verify command (typecheck/test/build) in each worker's PR worktree and attach the result to the review card; gates auto-merge on a local pass. Chain steps with && (your install step too, if the worktree needs deps)."
        >
          <Switch
            checked={repo.verify_gate === 1}
            onCheckedChange={(v) => patch({ verifyGate: v })}
            aria-label={
              repo.verify_gate === 1
                ? "Disable verify harness"
                : "Enable verify harness"
            }
          />
          verify
        </label>

        {/* Autonomous maintainer (opt-in): a survey agent proposes its own backlog
            on a cadence. Proposals are FENCED out of auto-dispatch — they land in
            the Backlog and wait for your one-tap Approve, even on an auto repo. */}
        <label
          className="text-muted-foreground flex items-center gap-1 text-xs"
          title="Autonomous maintainer: on a cadence, a read-only survey agent investigates this repo (runs the tests, checks issues/CI, npm outdated, TODOs) and proposes its own ranked backlog toward a goal you set. Proposals are NEVER auto-dispatched — they wait for your one-tap Approve in the Backlog."
        >
          <Switch
            checked={repo.maintainer_survey_enabled === 1}
            onCheckedChange={(v) => patch({ maintainerSurveyEnabled: v })}
            aria-label={
              repo.maintainer_survey_enabled === 1
                ? "Disable autonomous maintainer"
                : "Enable autonomous maintainer"
            }
          />
          maintain
        </label>

        {/* browse open issues for one-tap triage */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={browsing ? "Hide open issues" : "Browse open issues"}
          onClick={() => setBrowsing((b) => !b)}
        >
          <Inbox
            className={cn(
              "h-4 w-4",
              browsing ? "text-foreground" : "text-muted-foreground"
            )}
          />
        </Button>

        {/* fleet memory: what the critic has flagged for this repo */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="What the fleet learned (critic findings)"
          title="What the fleet learned"
          onClick={() => setShowLessons(true)}
        >
          <Brain className="text-muted-foreground h-4 w-4" />
        </Button>

        {/* delete */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remove repo"
          onClick={async () => {
            if (
              !(await confirm({
                title: `Stop tracking ${repo.repo_slug}?`,
                description: "In-flight workers are unaffected.",
                confirmLabel: "Stop tracking",
                destructive: true,
              }))
            )
              return;
            del.mutate(repo.id, {
              onError: (e) => toast.error((e as Error).message),
            });
          }}
        >
          <Trash2 className="text-muted-foreground hover:text-destructive h-4 w-4" />
        </Button>
      </div>
      {repo.verify_gate === 1 && (
        <div className="flex items-center gap-2 px-3 pb-1">
          <span className="text-muted-foreground text-xs">verify cmd</span>
          <Input
            placeholder="npm run verify   (or: npx tsc --noEmit && npm test && npm run build)"
            value={verifyCmd}
            onChange={(e) => setVerifyCmd(e.target.value)}
            onBlur={() => {
              const next = verifyCmd.trim() || null;
              if (next !== repo.verify_command) patch({ verifyCommand: next });
            }}
            className="h-8 flex-1 font-mono text-xs"
          />
        </div>
      )}
      {repo.maintainer_survey_enabled === 1 && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-1">
          <span className="text-muted-foreground shrink-0 text-xs">
            maintain goal
          </span>
          <Input
            placeholder="e.g. keep CI green, deps current, the issue backlog triaged"
            value={maintainGoal}
            onChange={(e) => setMaintainGoal(e.target.value)}
            onBlur={() => {
              const next = maintainGoal.trim() || null;
              if (next !== repo.maintainer_survey_goal)
                patch({ maintainerSurveyGoal: next });
            }}
            className="h-8 min-w-[200px] flex-1 text-xs"
          />
          <Select
            value={repo.maintainer_survey_cadence ?? "weekly"}
            onValueChange={(v) => patch({ maintainerSurveyCadence: v })}
          >
            <SelectTrigger
              className="h-8 w-[110px]"
              aria-label="Survey cadence"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MAINTAINER_CADENCE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span
            className="text-muted-foreground shrink-0 text-[11px]"
            title="When the survey last ran"
          >
            {!repo.maintainer_survey_goal
              ? "set a goal to start"
              : repo.maintainer_survey_last_at
                ? `last: ${new Date(repo.maintainer_survey_last_at).toLocaleString()}`
                : "not yet run"}
          </span>
        </div>
      )}
      {browsing && <OpenIssuesBrowser repo={repo} />}
      <LessonsDialog
        repoId={repo.id}
        repoSlug={repo.repo_slug}
        reviewGate={repo.review_gate === 1}
        open={showLessons}
        onOpenChange={setShowLessons}
      />
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
        <SegmentedTabs
          ariaLabel="Repo source"
          value={source}
          tabClassName={SEGMENTED_TAB_CLASS}
          tabs={[
            { key: "manual", label: "manual" },
            { key: "project", label: "project" },
            { key: "scan", label: "scan" },
            { key: "github", label: "github" },
          ]}
          onChange={(s) => {
            if (s === source) return;
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
              key={`${r.id}:${r.daily_quota}:${r.max_concurrency}:${r.label_filter ?? ""}:${r.maintainer_survey_goal ?? ""}`}
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

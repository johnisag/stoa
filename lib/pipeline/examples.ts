/**
 * Agent-pipeline EXAMPLES — a documentation catalog of workflow patterns.
 *
 * Where `templates.ts` ships the runnable, parameterized specs, this is the
 * authoring reference: the full set of 16 example patterns (their step shape +
 * when to use them), so a user can learn what pipelines are good for and design
 * their own. The patterns that ALSO ship as a runnable template carry a
 * `templateId` so the Examples UI can link straight to running them.
 *
 * Pure data (strings) — safe to import into a client component. Locked by
 * `test/pipeline-examples.test.ts` so a `templateId` can never dangle.
 *
 * Note: for a pattern that also ships as a template, the `description` here is
 * written in a TEACHING voice (what the pattern is, when to reach for it) and is
 * intentionally NOT a mirror of that template's runtime `description` — don't
 * "DRY" the two together; they serve different surfaces (browse-and-learn vs
 * fill-and-run). The integrity test guards the id link, not the prose.
 */

export interface WorkflowExample {
  /** Stable id (the pattern's number in the catalog). */
  id: string;
  /** Display title. */
  title: string;
  /** A compact ASCII sketch of the step DAG (rendered monospace). */
  diagram: string;
  /** What it does and when to reach for it. */
  description: string;
  /** If this pattern ships as a runnable template, its `PIPELINE_TEMPLATES` id —
   *  the Examples tab links it to the Templates tab. Omitted = docs-only pattern. */
  templateId?: string;
}

export const WORKFLOW_EXAMPLES: readonly WorkflowExample[] = [
  {
    id: "1",
    title: "Implement → review → fix",
    diagram: "implement (claude) → review (codex) → apply-fixes (claude)",
    description:
      "The simplest cross-provider chain: one agent implements, a different " +
      "provider reviews its diff, a third applies the fixes — review catches what " +
      "self-review misses. The 3-agent gate below generalizes it to three lenses.",
  },
  {
    id: "2",
    title: "3-agent review gate",
    diagram:
      "implement → ⟨correctness · conventions · simplicity⟩ → synthesize & fix",
    description:
      "The flagship. Three independent critics review the change in parallel, " +
      "each on a distinct lens, then one step folds their findings into a clean " +
      "final version. Automates Stoa's own merge rule.",
    templateId: "three-agent-review",
  },
  {
    id: "3",
    title: "Judge panel (best-of-3)",
    diagram: "⟨attempt-a · attempt-b · attempt-c⟩ → judge & pick the best",
    description:
      "The same task goes to three agents, each in its own worktree; a judge " +
      "step compares the attempts and reproduces the strongest (grafting good " +
      "ideas from the others). Showcases worktree isolation across providers.",
    templateId: "judge-panel",
  },
  {
    id: "4",
    title: "Spec-first feature build",
    diagram: "write-spec → implement → write-tests → run-and-fix → docs-update",
    description:
      "A linear chain where each stage runs on the agent best suited to it — a " +
      "strong model for the spec, a cheaper one for mechanical test scaffolding. " +
      "This is what the per-step model override is for.",
  },
  {
    id: "5",
    title: "Parallel migration / sweep",
    diagram: "plan → ⟨migrate-a · migrate-b · migrate-c⟩ → verify-build",
    description:
      "Big mechanical changes (an API rename, a lint-rule rollout, a dependency " +
      "upgrade) split by directory and run in parallel, then gated on a build. " +
      "Per-step workingDirectory can even span repos in one pipeline.",
  },
  {
    id: "6",
    title: "Bug: repro → fix → regression test",
    diagram: "reproduce (failing test) → diagnose & fix → verify green",
    description:
      "Reproduce a bug with a failing test first; the fix depends on it; a final " +
      "step confirms green. The failure-cascade is a feature — if the bug can't " +
      "be reproduced, the downstream fix steps skip instead of chasing a phantom.",
    templateId: "bug-repro-fix",
  },
  {
    id: "7",
    title: "Release prep",
    diagram: "⟨changelog · bump-deps · audit⟩ → smoke-test → draft-notes",
    description:
      "Three independent housekeeping tasks in parallel, gated into a smoke " +
      "test, then a release-notes draft. Pairs well with a scheduled trigger " +
      "later (and wants the human-approval gate once that ships).",
  },
  {
    id: "8",
    title: "Docs & consistency audit (read-only)",
    diagram: "⟨audit-readme · audit-api · audit-types⟩ → consolidate findings",
    description:
      "Three parallel read-only audits fan into one synthesis. Changes NO code — " +
      "the low-risk way to try pipelines on a repo for the first time.",
    templateId: "docs-audit",
  },
  {
    id: "9",
    title: "Issue → PR",
    diagram: "triage → plan → implement → test & verify",
    description:
      "Triage a GitHub issue, plan it, implement it, verify it — the highest-" +
      "leverage pattern for a repo with an issue tracker. The natural bridge to " +
      "the Dispatch system (Dispatch files the issue; a pipeline works it).",
    templateId: "issue-to-pr",
  },
  {
    id: "10",
    title: "Cross-platform regression hunt",
    diagram:
      "scope-diff → ⟨posix-lens · windows-lens · backend-seam⟩ → fix & verify",
    description:
      "Three reviewers read the same change through one lens each — POSIX-isms, " +
      "Windows-isms, and the backend-seam rules — then one step fixes the " +
      "findings and re-checks the build. Stoa's #1 regression source; great " +
      "dogfood demo.",
    templateId: "cross-platform-hunt",
  },
  {
    id: "11",
    title: "Test coverage booster",
    diagram: "map-gaps → ⟨write-tests per module⟩ → dedupe & run",
    description:
      "Map the coverage gaps, then a parallel writer per module fills them, and " +
      "a fan-in step removes overlap and confirms green. Clean fan-out/fan-in; a " +
      "cheap-model showcase for the mechanical writer steps.",
    templateId: "coverage-booster",
  },
  {
    id: "12",
    title: "Performance investigation",
    diagram: "benchmark → ⟨hypothesis-a · b · c⟩ → pick winner & re-bench",
    description:
      "A baseline writes the numbers; each hypothesis tries one optimization in " +
      "its own worktree; a judge re-runs the benchmark and keeps only what " +
      "actually moved them. Worktree isolation is what makes 'try three without " +
      "contamination' possible.",
  },
  {
    id: "13",
    title: "Security audit fan-out",
    diagram:
      "⟨scan-deps · scan-secrets · scan-injection⟩ → triage → fix-confirmed",
    description:
      "Three independent scanners, then a triage step that kills false positives " +
      "BEFORE anything gets 'fixed'. The triage gate stops an eager agent from " +
      "churning the codebase over non-findings.",
  },
  {
    id: "14",
    title: "Dead-code & dependency prune",
    diagram: "⟨unused-exports · unused-deps · stale-flags⟩ → remove → verify",
    description:
      "Three parallel scans, a conservative removal step, gated by a build+test " +
      "verify. Low-risk and satisfying — a red verify leaves the removal worktree " +
      "unmerged, so nothing breaks.",
    templateId: "dead-code-prune",
  },
  {
    id: "15",
    title: "Refactor with a safety net",
    diagram: "characterization-tests → refactor → verify behavior unchanged",
    description:
      "Lock current behavior in characterization tests FIRST, then refactor, then " +
      "prove nothing observable changed. The dependency edge is the discipline — " +
      "the refactor can't start until the tests exist and pass.",
    templateId: "refactor-with-net",
  },
  {
    id: "16",
    title: "Flaky test hunter",
    diagram: "detect-flakes → ⟨diagnose each⟩ → apply fixes & soak",
    description:
      "Run the suite N times to list the flakes; a parallel diagnoser takes each " +
      "(race? shared state? timing?); a fan-in applies the fixes and re-soaks. " +
      "Relevant to any project with an intermittent CI matrix.",
  },
];

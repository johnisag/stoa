/**
 * Agent-pipeline templates — a curated catalog of parameterized `PipelineSpec`s.
 *
 * A `PipelineSpec` needs concrete `task`/`workingDirectory` strings, but a
 * *template* wants slots (the issue number, the modules to cover, the repo path).
 * So each template carries `params` (rendered as a form by the UI) and a
 * `buildSpec(params)` that returns a real, engine-valid spec. Every template is
 * locked by `test/pipeline-templates.test.ts`, which runs `validateSpec` over
 * `buildSpec(sample)` so a template can never drift into something the engine
 * rejects (AGENTS.md: "lock anything easy to silently regress").
 *
 * Cross-step data flow: the engine has NO output channel between steps yet — a
 * dependent only knows its dependency SUCCEEDED, and each step runs in its own
 * worktree off the base branch. So multi-step templates pass context by
 * CONVENTION-BY-PROMPT: independent steps write findings to a named file, and a
 * fan-in step is told to inspect the sibling worktrees Stoa keeps for succeeded
 * steps. Closing this gap with an `outputs` channel is the tracked next engine
 * step (ROADMAP "Workflows") — until then these are strong authoring starting
 * points, not perfectly hands-off runs.
 */

import type { PipelineSpec, PipelineStep } from "./types";
import type { AgentType } from "../providers";

/** One fillable slot in a template (the UI renders a labelled input per param). */
export interface TemplateParam {
  /** Key in the params record passed to buildSpec. */
  name: string;
  /** Human label for the form field. */
  label: string;
  /** Example/placeholder text. */
  placeholder: string;
  /** Optional default value. */
  default?: string;
  /** UI hint: the form should require a value (the run is poor without it). */
  required?: boolean;
}

/** A parameterized pipeline the UI can offer and turn into a runnable spec. */
export interface PipelineTemplate {
  /** Stable id (used by the picker + as a registry key). */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description of what the pipeline does. */
  description: string;
  /** True if the pipeline modifies code (vs a read-only audit) — the UI badges this. */
  mutates: boolean;
  /** The slots the user fills before running. */
  params: TemplateParam[];
  /** Turn filled params into a concrete, engine-valid PipelineSpec. */
  buildSpec(params: Record<string, string>): PipelineSpec;
}

// The repository path slot every template needs (the pipeline-level workingDirectory).
const REPO_PARAM: TemplateParam = {
  name: "workingDirectory",
  label: "Repository path",
  placeholder: "~/repos/app",
  required: true,
};

// A trimmed value or a sensible fallback (keeps task prompts non-empty so the
// generated spec always passes validateSpec, even on a blank field).
const val = (params: Record<string, string>, key: string, fallback: string) => {
  const v = (params[key] ?? "").trim();
  return v || fallback;
};

// Reused note so a fan-in step can find what upstream steps produced, given the
// engine's missing data channel. Uses `git worktree list` (cross-platform, no
// hardcoded path) and identifies siblings by branch — each step ran in its own
// worktree on its own branch.
const SIBLINGS =
  "Each prior step ran in its OWN sibling git worktree of this repo, on its own " +
  "branch — run `git worktree list` to find them and read the relevant one's " +
  "files/commits (the engine has no direct output channel between steps yet).";

export const PIPELINE_TEMPLATES: readonly PipelineTemplate[] = [
  // ── #2 — flagship: the AGENTS.md 3-agent review gate ───────────────────────
  {
    id: "three-agent-review",
    name: "3-agent review gate",
    description:
      "Implement a change, then three independent critics (one per lens: " +
      "correctness/security, conventions/cross-platform, simplicity/scope) " +
      "review it in parallel; a final step drafts a revised version that folds " +
      "in their findings. Automates Stoa's own merge rule. Uses claude + codex + hermes.",
    mutates: true,
    params: [
      REPO_PARAM,
      {
        name: "task",
        label: "What to implement",
        placeholder: "Add a --json flag to the export command",
        required: true,
      },
    ],
    buildSpec(params) {
      const task = val(params, "task", "the requested change");
      const steps: PipelineStep[] = [
        {
          id: "implement",
          name: "Implement",
          agent: "claude",
          task: `Implement: ${task}. Make a focused, complete change in this worktree and commit it.`,
        },
        {
          id: "review-correctness",
          name: "Review — correctness & security",
          agent: "claude",
          dependsOn: ["implement"],
          task: `Review the implementation through the CORRECTNESS & SECURITY lens only — logic bugs, edge cases, error handling, injection. ${SIBLINGS} Write your findings to REVIEW-correctness.md in this worktree and commit. Do NOT change code.`,
        },
        {
          id: "review-conventions",
          name: "Review — conventions & cross-platform",
          agent: "codex",
          dependsOn: ["implement"],
          task: `Review the implementation through the CONVENTIONS & CROSS-PLATFORM lens only — house style, naming, and POSIX/Windows portability. ${SIBLINGS} Write your findings to REVIEW-conventions.md in this worktree and commit. Do NOT change code.`,
        },
        {
          id: "review-simplicity",
          name: "Review — simplicity & scope",
          agent: "hermes",
          dependsOn: ["implement"],
          task: `Review the implementation through the SIMPLICITY & SCOPE lens only — unnecessary complexity, scope creep, duplication, dead code. ${SIBLINGS} Write your findings to REVIEW-simplicity.md in this worktree and commit. Do NOT change code.`,
        },
        {
          id: "synthesize-and-fix",
          name: "Synthesize & fix",
          agent: "claude",
          dependsOn: [
            "review-correctness",
            "review-conventions",
            "review-simplicity",
          ],
          task: `Re-implement "${task}" here, incorporating the three reviewers' findings (their REVIEW-*.md files). ${SIBLINGS} Apply the fixes and commit a clean, final version in this worktree.`,
        },
      ];
      return {
        name: `3-agent review: ${task}`.slice(0, 80),
        workingDirectory: params.workingDirectory ?? "",
        steps,
      };
    },
  },

  // ── #3 — judge panel (competitive implementation) ──────────────────────────
  {
    id: "judge-panel",
    name: "Judge panel (best-of-3)",
    description:
      "Give the same task to three agents (each in its own worktree), then a " +
      "judge step compares the three attempts and reproduces the best. " +
      "Showcases worktree isolation across providers (claude + codex + hermes).",
    mutates: true,
    params: [
      REPO_PARAM,
      {
        name: "task",
        label: "The task (all three attempt it)",
        placeholder: "Implement a rate-limit backoff for the API client",
        required: true,
      },
    ],
    buildSpec(params) {
      const task = val(params, "task", "the requested change");
      const attempt = (id: string, agent: AgentType): PipelineStep => ({
        id,
        name: `Attempt — ${agent}`,
        agent,
        task: `Implement, independently: ${task}. Make your best complete attempt in this worktree and commit it.`,
      });
      const steps: PipelineStep[] = [
        attempt("attempt-a", "claude"),
        attempt("attempt-b", "codex"),
        attempt("attempt-c", "hermes"),
        {
          id: "judge",
          name: "Judge & pick the best",
          agent: "claude",
          dependsOn: ["attempt-a", "attempt-b", "attempt-c"],
          task: `Three agents each implemented "${task}" independently. ${SIBLINGS} Compare the three attempts on correctness, simplicity, and fit, then reproduce the best one (merging good ideas from the others) here and commit. Explain your pick in JUDGMENT.md.`,
        },
      ];
      return {
        name: `Judge panel: ${task}`.slice(0, 80),
        workingDirectory: params.workingDirectory ?? "",
        steps,
      };
    },
  },

  // ── #6 — bug repro → fix → regression test ─────────────────────────────────
  {
    id: "bug-repro-fix",
    name: "Bug: repro → fix → regression test",
    description:
      "Reproduce a bug with a failing test, diagnose it, fix it, and confirm a " +
      "regression test stays green. The failure-cascade is a feature: if the bug " +
      "can't be reproduced, the downstream fix steps skip instead of chasing a " +
      "phantom.",
    mutates: true,
    params: [
      REPO_PARAM,
      {
        name: "bug",
        label: "Bug description (symptom / repro hints)",
        placeholder:
          "CSV export drops the last row when the file has no trailing newline",
        required: true,
      },
    ],
    buildSpec(params) {
      const bug = val(params, "bug", "the reported bug");
      const steps: PipelineStep[] = [
        {
          id: "reproduce",
          name: "Reproduce (failing test)",
          agent: "claude",
          task: `Reproduce this bug with a NEW automated test that fails because of it: ${bug}. Commit the failing test. If you cannot reproduce it, say so clearly and stop.`,
        },
        {
          id: "diagnose-and-fix",
          name: "Diagnose & fix",
          agent: "claude",
          dependsOn: ["reproduce"],
          task: `A failing test reproducing "${bug}" was written by the previous step. ${SIBLINGS} Re-create that failing test here, diagnose the root cause, fix it, and make the test pass. Commit.`,
        },
        {
          id: "regression-verify",
          name: "Verify green",
          agent: "claude",
          dependsOn: ["diagnose-and-fix"],
          task: `Confirm the fix for "${bug}" holds: run the full test suite, ensure the regression test passes and nothing else broke, and report the result.`,
        },
      ];
      return {
        name: `Bug fix: ${bug}`.slice(0, 80),
        workingDirectory: params.workingDirectory ?? "",
        steps,
      };
    },
  },

  // ── #9 — issue → PR (dispatch tie-in) ──────────────────────────────────────
  {
    id: "issue-to-pr",
    name: "Issue → PR",
    description:
      "Triage a GitHub issue, plan it, implement it, and verify — the highest-" +
      "leverage template for a repo with an issue tracker. Pairs with the " +
      "dispatch system (dispatch files the issue; a pipeline works it).",
    mutates: true,
    params: [
      REPO_PARAM,
      {
        name: "repoSlug",
        label: "Repo (owner/name)",
        placeholder: "octo/app",
        required: true,
      },
      {
        name: "issue",
        label: "Issue number",
        placeholder: "123",
        required: true,
      },
    ],
    buildSpec(params) {
      const repo = val(params, "repoSlug", "the repository");
      const issue = val(params, "issue", "the issue");
      const ref = `issue #${issue} in ${repo}`;
      const steps: PipelineStep[] = [
        {
          id: "triage",
          name: "Triage",
          agent: "claude",
          task: `Read ${ref} (gh issue view ${issue} --repo ${repo}) and write a short PLAN.md in this worktree: the root problem, the proposed approach, and the files likely involved. Commit it.`,
        },
        {
          id: "implement",
          name: "Implement",
          agent: "claude",
          dependsOn: ["triage"],
          task: `Implement a complete, focused fix for ${ref}. Read the issue (gh issue view ${issue} --repo ${repo}); the previous step's PLAN.md is in a sibling worktree (${SIBLINGS}). Commit your change in this worktree.`,
        },
        {
          id: "verify",
          name: "Test & verify",
          agent: "claude",
          dependsOn: ["implement"],
          task: `Verify the fix for ${ref}: run the build and tests, confirm the issue's acceptance criteria are met, and summarize the evidence. ${SIBLINGS}`,
        },
      ];
      return {
        name: `Issue → PR: ${repo}#${issue}`.slice(0, 80),
        workingDirectory: params.workingDirectory ?? "",
        steps,
      };
    },
  },

  // ── #10 — cross-platform regression hunt (the Stoa special) ────────────────
  {
    id: "cross-platform-hunt",
    name: "Cross-platform regression hunt",
    description:
      "Three reviewers read the same change through one lens each — POSIX-isms, " +
      "Windows-isms, and backend-seam rules — then one step fixes the findings " +
      "and verifies the build. AGENTS.md calls cross-platform the #1 regression " +
      "source; great dogfood demo.",
    mutates: true,
    params: [
      REPO_PARAM,
      {
        name: "target",
        label: "What to audit",
        placeholder: "the changes on the current branch vs main",
        default: "the changes on the current branch vs main",
      },
    ],
    buildSpec(params) {
      const target = val(params, "target", "the current branch's changes");
      const lens = (
        id: string,
        agent: AgentType,
        title: string,
        focus: string
      ): PipelineStep => ({
        id,
        name: title,
        agent,
        task: `Audit ${target} ONLY through this lens: ${focus}. Write concrete findings (file:line) to ${id}.md in this worktree and commit. Do NOT change code.`,
      });
      const steps: PipelineStep[] = [
        lens(
          "audit-posix",
          "claude",
          "Audit — POSIX-isms",
          "process.env.HOME, hardcoded /tmp or /bin, path splitting on '/', lsof/which/sed/grep, shell-string exec with pipes"
        ),
        lens(
          "audit-windows",
          "codex",
          "Audit — Windows-isms",
          ".cmd/.exe shim resolution, missing windowsHide on spawns, backslash paths, ConPTY/pty-host assumptions"
        ),
        lens(
          "audit-seam",
          "hermes",
          "Audit — backend seam",
          "session/terminal work bypassing getSessionBackend(), status read from raw bytes instead of the rendered screen, client importing server-only modules"
        ),
        {
          id: "fix-and-verify",
          name: "Fix findings & verify build",
          agent: "claude",
          dependsOn: ["audit-posix", "audit-windows", "audit-seam"],
          task: `Three lens audits of ${target} produced audit-posix.md, audit-windows.md, audit-seam.md. ${SIBLINGS} Apply the valid fixes here, then run tsc + tests + build to verify, and commit.`,
        },
      ];
      return {
        name: "Cross-platform regression hunt",
        workingDirectory: params.workingDirectory ?? "",
        steps,
      };
    },
  },

  // ── #11 — test coverage booster (dynamic fan-out per module) ───────────────
  {
    id: "coverage-booster",
    name: "Test coverage booster",
    description:
      "Map coverage gaps, then a parallel writer per module fills them, and a " +
      "fan-in step removes overlap and confirms green. Clean fan-out/fan-in.",
    mutates: true,
    params: [
      REPO_PARAM,
      {
        name: "modules",
        label: "Modules to cover (comma-separated)",
        placeholder: "lib/parser, lib/format, lib/cli",
        required: true,
      },
    ],
    buildSpec(params) {
      const mods = (params.modules ?? "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      const targets = mods.length ? mods : ["the lowest-coverage modules"];
      const steps: PipelineStep[] = [
        {
          id: "map-gaps",
          name: "Map coverage gaps",
          agent: "claude",
          task: `Run the test suite with coverage and write GAPS.md in this worktree listing the biggest untested paths in: ${targets.join(", ")}. Commit it.`,
        },
      ];
      const writerIds: string[] = [];
      targets.forEach((m, i) => {
        const id = `write-tests-${i + 1}`;
        writerIds.push(id);
        steps.push({
          id,
          name: `Write tests — ${m}`.slice(0, 60),
          agent: "claude",
          dependsOn: ["map-gaps"],
          task: `Write focused unit tests for: ${m}. The coverage gap report (GAPS.md) is in a sibling worktree — ${SIBLINGS} Add tests in this worktree and commit; keep them passing.`,
        });
      });
      steps.push({
        id: "dedupe-and-run",
        name: "Dedupe & run",
        agent: "claude",
        dependsOn: writerIds,
        task: `Several steps wrote tests for ${targets.join(", ")} in sibling worktrees. ${SIBLINGS} Collect them here, remove overlapping/duplicate tests, run the full suite, and commit a clean, green result.`,
      });
      return {
        name: `Coverage booster: ${targets.join(", ")}`.slice(0, 80),
        workingDirectory: params.workingDirectory ?? "",
        steps,
      };
    },
  },

  // ── #14 — dead-code & dependency pruning ───────────────────────────────────
  {
    id: "dead-code-prune",
    name: "Dead-code & dependency prune",
    description:
      "Three parallel scans (unused exports, unused deps, stale flags), then a " +
      "removal step, gated by a build+test verify. Low-risk and satisfying — the " +
      "failure cascade means a red verify leaves the removal worktree unmerged.",
    mutates: true,
    params: [REPO_PARAM],
    buildSpec(params) {
      const scan = (id: string, title: string, what: string): PipelineStep => ({
        id,
        name: title,
        agent: "claude",
        task: `Find ${what}. Write a precise, conservative list (with file:line) to ${id}.md in this worktree and commit. Do NOT remove anything.`,
      });
      const steps: PipelineStep[] = [
        scan(
          "find-unused-exports",
          "Find unused exports",
          "exported symbols with no importer anywhere in the repo"
        ),
        scan(
          "find-unused-deps",
          "Find unused deps",
          "package.json dependencies that are never imported"
        ),
        scan(
          "find-stale-flags",
          "Find stale flags",
          "feature flags / env switches that are always on or always off"
        ),
        {
          id: "remove-safely",
          name: "Remove safely",
          agent: "claude",
          dependsOn: [
            "find-unused-exports",
            "find-unused-deps",
            "find-stale-flags",
          ],
          task: `Three scans produced find-unused-exports.md, find-unused-deps.md, find-stale-flags.md. ${SIBLINGS} Remove ONLY the items you can confirm are truly unused, here, and commit.`,
        },
        {
          id: "verify",
          name: "Verify build & tests",
          agent: "claude",
          dependsOn: ["remove-safely"],
          task: `Confirm the removals broke nothing: ${SIBLINGS} re-apply them here, run the build and full test suite, and report. If anything fails, revert that removal.`,
        },
      ];
      return {
        name: "Dead-code & dependency prune",
        workingDirectory: params.workingDirectory ?? "",
        steps,
      };
    },
  },

  // ── #15 — refactor with a safety net ───────────────────────────────────────
  {
    id: "refactor-with-net",
    name: "Refactor with a safety net",
    description:
      "Lock current behavior in characterization tests FIRST, then refactor, " +
      "then prove nothing observable changed. The dependency edge is the " +
      "discipline — the refactor can't start until the tests exist and pass.",
    mutates: true,
    params: [
      REPO_PARAM,
      {
        name: "target",
        label: "What to refactor",
        placeholder: "the OrderService pricing logic",
        required: true,
      },
    ],
    buildSpec(params) {
      const target = val(params, "target", "the target code");
      const steps: PipelineStep[] = [
        {
          id: "characterize",
          name: "Characterization tests",
          agent: "claude",
          task: `Write characterization tests that pin the CURRENT observable behavior of ${target} (don't fix bugs — capture what it does today). Make them pass, and commit.`,
        },
        {
          id: "refactor",
          name: "Refactor",
          agent: "claude",
          dependsOn: ["characterize"],
          task: `Refactor ${target} for clarity/structure WITHOUT changing observable behavior. The characterization tests are in a sibling worktree (${SIBLINGS}) — re-create them here first, then refactor with them green. Commit.`,
        },
        {
          id: "verify-unchanged",
          name: "Verify behavior unchanged",
          agent: "claude",
          dependsOn: ["refactor"],
          task: `Prove the refactor of ${target} changed nothing observable: ${SIBLINGS} run the characterization tests + the full suite and report. Any red means the refactor altered behavior.`,
        },
      ];
      return {
        name: `Refactor: ${target}`.slice(0, 80),
        workingDirectory: params.workingDirectory ?? "",
        steps,
      };
    },
  },

  // ── #8 — docs/consistency audit (READ-ONLY — the safe first run) ───────────
  {
    id: "docs-audit",
    name: "Docs & consistency audit (read-only)",
    description:
      "Three parallel read-only audits (README, public API surface, types/" +
      "exports) fan into one synthesis. Changes NO code — the low-risk way to " +
      "try pipelines on a repo for the first time.",
    mutates: false,
    params: [REPO_PARAM],
    buildSpec(params) {
      const audit = (
        id: string,
        title: string,
        what: string
      ): PipelineStep => ({
        id,
        name: title,
        agent: "claude",
        task: `Audit ${what} for inaccuracies, drift, and gaps. Write your findings (with file:line) to ${id}.md in this worktree and commit. Do NOT change any other code.`,
      });
      const steps: PipelineStep[] = [
        audit(
          "audit-readme",
          "Audit — README",
          "the README against what the code actually does (stale commands, wrong flags, missing setup steps)"
        ),
        audit(
          "audit-api",
          "Audit — public API",
          "the public API surface vs its documentation (undocumented endpoints/exports, documented-but-removed ones)"
        ),
        audit(
          "audit-types",
          "Audit — types & exports",
          "exported types and their doc comments (mismatches, missing JSDoc on public symbols)"
        ),
        {
          id: "consolidate",
          name: "Consolidate findings",
          agent: "claude",
          dependsOn: ["audit-readme", "audit-api", "audit-types"],
          task: `Three read-only audits produced audit-readme.md, audit-api.md, audit-types.md. ${SIBLINGS} Consolidate them into one prioritized FINDINGS.md in this worktree and commit. Do NOT change code — this is a report.`,
        },
      ];
      return {
        name: "Docs & consistency audit",
        workingDirectory: params.workingDirectory ?? "",
        steps,
      };
    },
  },
];

/** Look up a template by id (for the API/UI to build a spec from a picked id). */
export function getPipelineTemplate(id: string): PipelineTemplate | undefined {
  return PIPELINE_TEMPLATES.find((t) => t.id === id);
}

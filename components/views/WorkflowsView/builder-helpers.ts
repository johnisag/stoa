/**
 * Pure, I/O-free helpers for the visual workflow builder (WorkflowBuilder).
 *
 * Extracted verbatim from WorkflowBuilder.tsx so the builder shell stays small
 * and these small functions are unit-testable in isolation. NO behavior change —
 * every function is identical to its former inline definition.
 */
import {
  docFromSpec,
  outputRefToken,
  type BuilderDoc,
} from "@/lib/pipeline/builder-model";
import type { StoaWorktree } from "@/data/worktrees/queries";

export const EMPTY_DOC: BuilderDoc = {
  name: "My workflow",
  workingDirectory: "~/my-project",
  nodes: [],
  notes: [],
};

/** Format a stored ISO timestamp for display, falling back to the raw string
 * (rather than "Invalid Date") if a hand-edited/legacy row holds garbage. */
export function formatSnapshotTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// A wired 2-node DAG so a first-time user lands on something runnable to edit,
// rather than a blank canvas — mirrors the Custom tab's "Load example" (same spec).
export const EXAMPLE_DOC: BuilderDoc = docFromSpec({
  name: "My workflow",
  workingDirectory: "~/my-project",
  steps: [
    {
      id: "research",
      agent: "claude",
      task: "Investigate the auth flow and write your findings to the output file.",
    },
    {
      id: "implement",
      agent: "claude",
      task: `Using these findings:\n${outputRefToken("research")}\nimplement the fix.`,
      dependsOn: ["research"],
      exitCriteria: "The change MUST pass the test suite. Open a PR when done.",
    },
  ],
});

export function worktreeBaseName(p: string) {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

export function worktreeLabel(w: StoaWorktree) {
  return `${w.branch || worktreeBaseName(w.path)}${w.attached ? " (in use)" : ""}`;
}

export function availableWorktrees(
  doc: BuilderDoc,
  worktrees: StoaWorktree[],
  projectDir?: string
): StoaWorktree[] {
  // When a project is selected, only show worktrees that belong to the same repo.
  if (!doc.projectId) return worktrees;
  const base = projectDir || doc.workingDirectory;
  return worktrees.filter((w) => w.projectId === base);
}

export type PastePreview =
  | { ok: null; count: number; name: string }
  | { ok: false; count: number; name: string }
  | { ok: true; count: number; name: string };

/**
 * Workflow builder — single-step snippets. Pre-wired tasks a user can tap to add
 * to the canvas and avoid a blank step. Each snippet supplies a default agent,
 * a task, and optional exit criteria; the id is made unique when the step is
 * added.
 */

import type { AgentType } from "@/lib/providers";

export interface WorkflowSnippet {
  /** Stable id for the snippet. */
  id: string;
  /** Display title. */
  title: string;
  /** One-line description. */
  description: string;
  /** Default agent for the added step. */
  agent: AgentType;
  /** Pre-filled task prompt. */
  task: string;
  /** Optional pre-filled exit criteria. */
  exitCriteria?: string;
}

export const WORKFLOW_SNIPPETS: readonly WorkflowSnippet[] = [
  {
    id: "research",
    title: "Research",
    description:
      "Investigate the codebase and write findings to a file in the step's worktree.",
    agent: "claude",
    task:
      "Research the current code, architecture, and relevant context for the " +
      "requested change. Write a concise summary of your findings to RESEARCH.md " +
      "in this worktree and commit it.",
  },
  {
    id: "implement",
    title: "Implement",
    description: "Make a focused, complete code change.",
    agent: "claude",
    task:
      "Implement the requested change in this worktree. Keep the change focused, " +
      "complete, and well-tested. Commit your work when done.",
    exitCriteria: "The change MUST pass the test suite.",
  },
  {
    id: "test",
    title: "Write tests",
    description: "Add or strengthen tests for a behavior.",
    agent: "codex",
    task:
      "Write focused unit/integration tests that pin the requested behavior. " +
      "Run them to confirm they pass (or fail for the right reason). Commit.",
  },
  {
    id: "review",
    title: "Review",
    description: "Review a change through one lens and write findings.",
    agent: "hermes",
    task:
      "Review the current worktree's changes through the lens of correctness, " +
      "security, and edge cases. Write concrete findings (with file:line) to " +
      "REVIEW.md and commit. Do NOT change code.",
  },
];

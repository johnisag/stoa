/**
 * One source of truth for "is this dispatch row a local (GitHub-free) task?" and
 * how to label it. Local tasks (intake source 'local') have issue_number 0 and no
 * GitHub issue, so they must NOT be shown or described as "#N". Pure — shared by
 * the server (prompts, verdict inbox) and the UI (board, backlog).
 */
import type { IssueDispatch } from "./types";

/** True for a local/freeform task (source 'local'); false for a GitHub issue. */
export function isLocalTask(d: Pick<IssueDispatch, "source">): boolean {
  return d.source === "local";
}

/** Display label: "#42 Title" for a GitHub issue, the bare title for a local task. */
export function taskLabel(
  d: Pick<IssueDispatch, "source" | "issue_number" | "issue_title">
): string {
  return isLocalTask(d)
    ? (d.issue_title ?? "(untitled task)")
    : `#${d.issue_number} ${d.issue_title ?? "(untitled issue)"}`;
}

/** Inline reference for a worker/critic prompt: `issue #42: "Title"` for a GitHub
 * issue, `task: "Title"` for a local one (no misleading "#0"). */
export function taskRef(
  d: Pick<IssueDispatch, "source" | "issue_number" | "issue_title">
): string {
  return isLocalTask(d)
    ? `task: "${d.issue_title ?? ""}"`
    : `issue #${d.issue_number}: "${d.issue_title ?? ""}"`;
}

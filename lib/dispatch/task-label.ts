/**
 * One source of truth for "is this dispatch row a local (GitHub-free) task?" and
 * how to label it. Local tasks (intake source 'local') have issue_number 0 and no
 * GitHub issue, so they must NOT be shown or described as "#N". Pure — shared by
 * the server (prompts, verdict inbox) and the UI (board, backlog).
 */
import type { IssueDispatch } from "./types";

/** Prefix the maintainer prepends to a proposed task body so the rationale rides
 * inline (`[maintainer] <rationale>\n\n---\n<body>`). Single source of truth: the
 * server formats with it (buildMaintainerTaskBody), the UI strips it (maintainerWhy).
 * Defined here — a client-safe, types-only module — so the Backlog can import it
 * without pulling in maintainer.ts's server-only deps. */
export const MAINTAINER_BODY_PREFIX = "[maintainer] ";

/** True for a local/freeform task (source 'local'); false for a GitHub issue. */
export function isLocalTask(d: Pick<IssueDispatch, "source">): boolean {
  return d.source === "local";
}

/** The maintainer's rationale for a proposed task (the "why", shown at the approve
 * point), or null for a non-maintainer row. Extracts the first line of task_body
 * and strips the `[maintainer] ` prefix. Pure — safe in the client. */
export function maintainerWhy(
  d: Pick<IssueDispatch, "maintainer_proposed" | "task_body">
): string | null {
  if (d.maintainer_proposed !== 1 || !d.task_body) return null;
  const first = d.task_body.split("\n")[0].trim();
  const why = first.startsWith(MAINTAINER_BODY_PREFIX)
    ? first.slice(MAINTAINER_BODY_PREFIX.length)
    : first;
  return why.trim() || null;
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

/**
 * Dispatch — merge a worker's PR via gh (user-initiated only).
 *
 * Plain `gh pr merge --<method>` merges NOW and fails if the PR isn't mergeable
 * (e.g. required checks red) — it deliberately does NOT use `--auto`, so Stoa
 * never enables GitHub auto-merge. Merging is always an explicit user action.
 * execFile with an argv array — no shell.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { resolveBinary } from "../platform";

const execFileAsync = promisify(execFile);
const gh = resolveBinary("gh") || "gh";

export type MergeMethod = "squash" | "merge" | "rebase";

/** Pure argv builder (testable). Note: no `--auto` — see file header. */
export function buildMergeArgs(
  prNumber: number,
  method: MergeMethod = "squash"
): string[] {
  return ["pr", "merge", String(prNumber), `--${method}`];
}

/** Merge a PR by number from a checkout. Throws on failure (not mergeable, gh
 * missing/unauth, etc.) so the route surfaces the reason. */
export async function mergePR(opts: {
  cwd: string;
  prNumber: number;
  method?: MergeMethod;
}): Promise<void> {
  await execFileAsync(gh, buildMergeArgs(opts.prNumber, opts.method), {
    cwd: opts.cwd,
    encoding: "utf-8",
    timeout: 60000,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getDb, queries } from "@/lib/db";
import { mergePR } from "@/lib/dispatch/merge";
import { expandHome } from "@/lib/platform";
import type { IssueDispatch } from "@/lib/dispatch/types";
import { requireLocalhost } from "@/lib/api-security";

/**
 * POST /api/dispatch/dispatches/[id]/merge
 *
 * Merge the worker's PR (squash) — a deliberate user action from the cockpit.
 * Plain merge (no GitHub auto-merge); fails loudly if the PR isn't mergeable.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireLocalhost(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    const db = getDb();
    const d = queries.getDispatch(db).get(id) as IssueDispatch | undefined;
    if (!d) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (d.pr_number == null) {
      return NextResponse.json(
        { error: "This dispatch has no PR yet" },
        { status: 409 }
      );
    }
    if (d.status !== "pr_open") {
      return NextResponse.json(
        { error: `Can't merge a dispatch in '${d.status}'` },
        { status: 409 }
      );
    }
    // Merge repo-explicitly (--repo) from the stable main checkout; the worker's
    // worktree is only a fallback when the repo row is gone (a reclaimed worktree
    // cwd otherwise makes gh's spawn throw a misleading ENOENT).
    const repo = queries.getDispatchRepo(db).get(d.repo_id) as
      | {
          repo_path: string;
          repo_slug: string;
          review_gate: number;
          judge_gate: number;
        }
      | undefined;
    const cwd = expandHome(repo?.repo_path || d.worktree_path || "");
    if (!cwd) {
      return NextResponse.json(
        { error: "No checkout to merge from" },
        { status: 409 }
      );
    }
    // On a review-gated repo the merge MUST be pinned to the reviewed head, or a
    // commit pushed after the panel's APPROVED could slip in. A missing review_sha
    // means there's nothing to pin to, so refuse (mirrors auto-merge's wait). A
    // non-gated repo has no verdict and legitimately merges unpinned.
    if (repo?.review_gate && d.review_sha == null) {
      return NextResponse.json(
        {
          error:
            "This repo is review-gated but the PR has no pinned review SHA yet — re-run the review, then merge.",
        },
        { status: 409 }
      );
    }
    // #26: a judge-gated repo requires the rubric judge's PASS before ANY merge —
    // the manual button must not bypass what auto-merge enforces. A stale verdict
    // is already cleared by judgePass when the head moves, and the SHA pin below
    // makes gh refuse a merge onto an unjudged head.
    if (repo?.judge_gate === 1 && d.judge_status !== "pass") {
      return NextResponse.json(
        {
          error:
            "This repo is judge-gated but the rubric judge hasn't passed this PR — wait for (or fix) the judge verdict, then merge.",
        },
        { status: 409 }
      );
    }
    await mergePR({
      cwd,
      prNumber: d.pr_number,
      repoSlug: repo?.repo_slug,
      // SHA-pin: refuse the merge if the PR head moved after the gate verdicts —
      // pin to whichever gate validated a head (auto-merge's chain minus its
      // headRefOid tail: this route reads no readiness, and an ungated repo
      // legitimately merges unpinned — a deliberate manual action).
      matchHeadCommit: d.review_sha ?? d.verify_sha ?? d.judge_sha,
    });
    queries.updateDispatchStatus(db).run("merged", id);
    return NextResponse.json({
      dispatch: queries.getDispatch(db).get(id) as IssueDispatch,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Merge failed";
    // gh exits non-zero if the PR was already merged (a sweep or a 2nd tap got
    // there first) — reconcile the row to 'merged' rather than erroring.
    if (/already merged/i.test(msg)) {
      try {
        queries.updateDispatchStatus(getDb()).run("merged", id);
      } catch {
        // best-effort reconcile
      }
      return NextResponse.json({ reconciled: true });
    }
    console.error("dispatch merge failed:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

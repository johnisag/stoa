import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { expandHome } from "@/lib/platform";
import { readReviewerFindings } from "@/lib/dispatch/reviewer";
import type { IssueDispatch } from "@/lib/dispatch/types";

/**
 * GET /api/verdict-inbox/findings?type=&id=&session=&pr= — the per-lens critic
 * findings (verdict + prose) for one inbox item, read live from the PR. The
 * worktree (cwd for gh) is resolved server-side from the dispatch/session row;
 * the caller passes the PR number it already has. Empty on any failure.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const type = sp.get("type");
  const id = sp.get("id");
  const session = sp.get("session");
  const pr = Number(sp.get("pr"));
  if (!Number.isInteger(pr) || pr <= 0) {
    return NextResponse.json({ findings: [] });
  }

  const db = getDb();
  let cwd: string | null = null;
  if (type === "dispatch" && id) {
    const d = queries.getDispatch(db).get(id) as IssueDispatch | undefined;
    cwd = d?.worktree_path ? expandHome(d.worktree_path) : null;
  } else if (type === "ceremony" && session) {
    const s = queries.getSession(db).get(session) as Session | undefined;
    cwd = s?.worktree_path ? expandHome(s.worktree_path) : null;
  }
  if (!cwd) return NextResponse.json({ findings: [] });

  const findings = await readReviewerFindings(cwd, pr);
  return NextResponse.json({ findings });
}

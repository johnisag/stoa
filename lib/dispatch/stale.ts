/**
 * Dispatch — reconcile rows stuck at 'pr_open' against the PR's REAL GitHub state.
 *
 * `sweepActiveWorkers` only re-checks 'dispatched' rows; once a row reaches
 * 'pr_open' nothing ever re-probes GitHub. So a PR merged or closed OUT OF BAND (a
 * human merges it on github.com, or closes it without merging) leaves its dispatch
 * row stranded at 'pr_open' forever — the "stale merge" the board shows
 * indefinitely. This pass (and the manual board action) close that gap:
 *
 *   merged → 'merged'    (landed out of band)
 *   closed → 'cancelled' (abandoned without merging)
 *   open   → leave it     (legitimately in flight)
 *   error  → leave it     (gh hiccup — INDETERMINATE; FAIL OPEN, retry next tick)
 *
 * The PR is read by NUMBER via the already-armored `getPrReadiness` (--repo + a
 * stable main-checkout cwd) — a never-deletable PR number always reads back a
 * definite state, and a genuinely unreachable PR (deleted repo, revoked token)
 * reads `state: null` → probe "error" → the row is deliberately LEFT pr_open
 * rather than risk failing a live row on a transient gh outage.
 *
 * This pass resolves STATUS only; it never touches the worktree. The normal merge
 * paths (autoMergePass, the manual Merge button) reclaim the worktree under their
 * own gates — but an out-of-band merge has NO gate, and a force-remove could land
 * on a worktree a live ci/review/rebase fixer is still coding in. Leaving the
 * directory is the safe choice (and strictly better than today, where the row both
 * sticks AND leaks the worktree).
 *
 * `probeFromState` + `nextStaleAction` are pure (unit-tested); `reconcileOneStale`
 * / `reconcileStaleDispatches` do the gh I/O.
 */

import { getDb, queries } from "../db";
import { expandHome } from "../platform";
import { getPrReadiness } from "./auto-merge";
import type { DispatchRepo, IssueDispatch } from "./types";

/** A PR's resolved state for the stale pass.
 *   open   — still in flight (OPEN, or any other live state)
 *   merged — landed (possibly out of band)
 *   closed — closed WITHOUT merging (abandoned)
 *   error  — gh couldn't determine it (missing PR / network / auth): INDETERMINATE,
 *            so the caller MUST fail open (never resolve a row on it). */
export type PrProbe = "open" | "merged" | "closed" | "error";

/** What reconcile resolved a row to ('noop' = left untouched). 'merged'/'cancelled'
 * are terminal dispatch statuses. */
export type StaleResolution = "merged" | "cancelled" | "noop";

/** The full reconcile outcome: the resolution applied PLUS the raw probe, so the
 * manual action can tell "still open" (open) apart from "gh unreachable" (error) —
 * both of which resolve to 'noop'. */
export interface StaleOutcome {
  resolution: StaleResolution;
  probe: PrProbe;
}

/** Map a gh PR `state` (as `getPrReadiness` returns it — null when gh failed or the
 * payload had no string state) to a probe. Pure + unit-tested. */
export function probeFromState(state: string | null): PrProbe {
  if (state == null) return "error"; // gh failed / indeterminate
  const s = state.toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return "open"; // OPEN (or any other live state) → still in flight
}

/** Resolve a probe to the status to write. Pure + unit-tested.
 *   merged → 'merged'    (landed out of band)
 *   closed → 'cancelled' (closed without merging — abandoned)
 *   open   → 'noop'      (legitimately in flight — leave it)
 *   error  → 'noop'      (gh indeterminate — FAIL OPEN, retry next tick) */
export function nextStaleAction(probe: PrProbe): StaleResolution {
  if (probe === "merged") return "merged";
  if (probe === "closed") return "cancelled";
  return "noop"; // open | error → leave it
}

/**
 * Reconcile ONE row against GitHub. Returns the outcome ('noop' when the PR is still
 * open or gh was indeterminate; the `probe` distinguishes the two). Shared by the
 * periodic pass and the manual board action. The status write is GUARDED on the row
 * still being 'pr_open' (`resolveStaleDispatch`), so a concurrent auto-merge/sweep
 * that already moved the row wins and a manual tap can't double-resolve a racing
 * tick. STATUS only — see the file header on why the worktree is left in place.
 */
export async function reconcileOneStale(
  db: ReturnType<typeof getDb>,
  d: IssueDispatch
): Promise<StaleOutcome> {
  // Defensive: callers (the route via isActionAllowed, the loop via listPrOpen)
  // only ever hand us pr_open rows with a PR. Treat anything else as indeterminate.
  if (d.status !== "pr_open" || d.pr_number == null) {
    return { resolution: "noop", probe: "error" };
  }

  const repo = queries.getDispatchRepo(db).get(d.repo_id) as
    | DispatchRepo
    | undefined;
  // Armored: read from the STABLE main checkout + --repo, never the per-task
  // worktree (which may have been reclaimed → a misleading gh ENOENT).
  const probeCwd = repo
    ? expandHome(repo.repo_path)
    : expandHome(d.worktree_path ?? "");
  const { state } = await getPrReadiness(
    probeCwd,
    d.pr_number,
    repo?.repo_slug
  );
  const probe = probeFromState(state);
  const resolution = nextStaleAction(probe);

  if (resolution !== "noop") {
    queries.resolveStaleDispatch(db).run(resolution, d.id);
    console.log(
      `dispatch: stale PR #${d.pr_number} reconciled → ${resolution} (${d.id})`
    );
  }
  return { resolution, probe };
}

/**
 * Periodic pass: reconcile every 'pr_open' row against GitHub so out-of-band merges
 * and closes don't strand rows on the board. Run early in the tick (right after the
 * worker sweep) so the downstream review / CI / verify / auto-merge passes all skip
 * a row this pass just resolved. A single row's failure never aborts the rest.
 */
export async function reconcileStaleDispatches(): Promise<void> {
  const db = getDb();
  const rows = queries.listPrOpen(db).all() as IssueDispatch[];
  if (rows.length === 0) return;
  for (const d of rows) {
    try {
      await reconcileOneStale(db, d);
    } catch (err) {
      console.error(
        `dispatch: stale reconcile of ${d.id} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
